---
title: "极致性能 vs 极致兼容：UCM 与 LMCache 的两种形状"
description: LMCache 用引擎、可插拔后端与自描述键换来近乎无底线的后端兼容，UCM v1 用定长分片和文件名索引把延迟压到极限。本文核实两边的后端清单与代价落点。
publishedAt: "2026-10-23"
category: 技术分享
tags:
  - LMCache
  - UCM
  - KV Cache
  - 架构对比
draft: false
featured: true
---

同一个问题（GPU 显存装不下的 KV Cache 该卸到哪、又该怎么取回来），两个系统给了两种几乎相反的回答。

UCM（Unified Cache Manager）的回答是：把"卸载"这件事本身做成一条定长的流水线，任何存储介质挤进这条流水线的同一格，代价是你要照它的规矩来。LMCache 的回答是：把"存储"抽象成一个可以无限替换的接口，你想接什么后端都行，代价是这个接口要足够宽、足够慢得下来。

站内前面几篇已经把 UCM 的 Pipeline、共享内存锁模型、多 rank 加载和演进史拆过一遍（[019](/posts/019-ucm-pipeline-store)、[020](/posts/020-ucm-cache-concurrency)、[021](/posts/021-ucm-multi-rank-load)、[022](/posts/022-ucm-evolution)）。这篇换个方向：从 LMCache 的代码出发，看一个"兼容优先"的系统具体长成了什么样，再把两条路线的成本摊开对照。作者的原话是「LMCache 似乎是为了极致的兼容性，兼容了很多很多的存储后端」。

## 0. 调研口径：我读了什么，没读什么

先把纪律说清楚，后面每一个类名、字段名、文件名都能指回具体位置。

- LMCache：`git clone --depth 1 https://github.com/LMCache/LMCache.git`，默认分支 `dev`，HEAD = `ff9185d419e1ce55c9f4f1ad84a4f4f1f06af7be`（提交时间 2026-10-23 05:58:11 UTC）。所有路径引用都是相对这个 commit 的。
- 官方文档：仓库内 `docs/source/`（Sphinx 源，398 个文件），对应线上 `docs.lmcache.ai`。设计文档在 `docs/design/`。
- UCM：本地检出 `D:\Vibe_Workspace\unified-cache-management`，commit `2542854`（2026-09-02）。只读，没有改动。
- 没有复现任何性能数字。全文不含"LMCache 快 X 倍"这类断言，我既没跑 benchmark，仓库里也没有可对照的公开口径。文中的量化只有两类：代码里的常量（如 `chunk_size` 默认 256），和可以直接数出来的东西（后端个数、文件行数）。

有一件事要先讲明白，否则后面的表会读错：LMCache 现在有两套存储模式，代码里并存，抽象层不是一套。

| 模式            | 进程关系                                              | 引擎侧类                                          | 存储侧入口                                                      | 现状                               |
| --------------- | ----------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------- |
| in-process 模式 | LMCache 跑在 vLLM 进程内                              | `LMCacheEngine`（`inprocess/v1/cache_engine.py`） | `StorageManager`（`v1/storage_backend/storage_manager.py:221`） | 支持，但文档把 MP 标为 recommended |
| MP 模式         | LMCache 是独立守护进程，vLLM 通过 ZMQ / gRPC 请求访问 | 无本地引擎，请求走 `lmcache server`               | `StorageManager`（`v1/distributed/storage_manager.py:102`）     | 官方推荐                           |

`quickstart.rst` 写得很直接：「LMCache supports two deployment modes with vLLM」，MP 是 recommended。两套模式共享一部分底层（`MemoryObj`、`CacheEngineKey`、`LocalCPUBackend`），但存储后端的注册方式完全不同，这一点是理解"兼容优先"的关键，下面会展开。

## 1. 后端清单：先把"很多很多"数清楚

我原本以为这句话有点夸张。数完之后，不夸张。

### 1.1 MP 模式：21 个注册在案的 L2 适配器类型

MP 模式的 L2 存储走一套注册表。`v1/distributed/l2_adapters/factory.py` 里有 `register_l2_adapter_factory(name, factory)`，每个适配器模块在 import 时自己登记：

```python
def register_l2_adapter_factory(
    name: str,
    factory: L2AdapterFactory,
) -> None:
    """Register an adapter factory for the given type name."""
    if name in _L2_ADAPTER_FACTORY_REGISTRY:
        raise ValueError("L2 adapter factory already registered: %s" % name)
    _L2_ADAPTER_FACTORY_REGISTRY[name] = factory
```

调用点长这样，每个文件一行，人和机器都好读：

```python
register_l2_adapter_factory("fs", _create_fs_adapter)
register_l2_adapter_factory("resp", _create_resp_l2_adapter)
register_l2_adapter_factory("mooncake_store", _create_mooncake_store_l2_adapter)
# ... 共 21 个
```

我把 `grep register_l2_adapter_factory` 的结果按介质归了类：

| `--l2-adapter` type                 | 代码文件（`lmcache/v1/distributed/l2_adapters/`）               | 介质类别                 |
| ----------------------------------- | --------------------------------------------------------------- | ------------------------ |
| `fs`                                | `fs_l2_adapter.py`                                              | 本地文件系统             |
| `fs_native`                         | `fs_native_l2_adapter.py`                                       | 本地文件系统（原生实现） |
| `raw_block`                         | `raw_block_l2_adapter.py`（底层 Rust）                          | 裸块设备                 |
| `dax`                               | `dax_l2_adapter.py`                                             | Device-DAX / CXL 内存    |
| `nixl_store` / `nixl_store_dynamic` | `nixl_store_l2_adapter.py` / `nixl_store_dynamic_l2_adapter.py` | NIXL Store               |
| `nixl_native`                       | `nixl_native_l2_adapter.py`                                     | NIXL（原生 connector）   |
| `p2p`                               | `p2p_l2_adapter.py`                                             | 跨节点 CPU 内存直传      |
| `s3`                                | `s3_l2_adapter.py`                                              | 对象存储                 |
| `hfbucket`                          | `hfbucket_l2_adapter.py`                                        | 对象存储（HF Bucket）    |
| `hf3fs`                             | `hf3fs_l2_adapter.py`                                           | 分布式文件系统           |
| `mooncake_store`                    | `mooncake_store_l2_adapter.py`                                  | Mooncake 传输/store      |
| `resp`                              | `resp_l2_adapter.py`                                            | Redis / Valkey（RESP）   |
| `valkey`                            | `valkey_l2_adapter.py`                                          | Valkey（专用客户端）     |
| `aerospike`                         | `aerospike_l2_adapter.py`                                       | Aerospike                |
| `bigtable`                          | `bigtable_l2_adapter.py`                                        | Google Bigtable          |
| `sagemaker-hyperpod`                | `sagemaker_hyperpod_l2_adapter.py`                              | SageMaker HyperPod       |
| `plugin`                            | `plugin_l2_adapter.py`                                          | 第三方 Python 包         |
| `native_plugin`                     | `native_plugin_l2_adapter.py`                                   | 第三方 C++ connector     |
| `mock`                              | `mock_l2_adapter.py`                                            | 测试                     |
| `fault_inject`                      | `fault_inject_l2_adapter.py`                                    | 故障注入测试             |
| （桥接，不单独注册 type）           | `native_connector_l2_adapter.py`                                | 复用单进程 connector     |

官方文档 `docs/source/mp/l2_storage/supported_storages.rst` 里还有一项 `wqs` / `wqs_store`，标注为「Remote & Distributed (vendor-provided)」：这一项在仓库里没有对应实现，属于厂商侧提供，我没能核实其代码位置，所以上表没有收录。

### 1.2 in-process 模式：16 个 connector 适配器 + 10 类内置 backend

单进程模式的后端分两层。第一层是 `CreateStorageBackends()`（`v1/storage_backend/__init__.py:111`），它按配置拼出一张有序的后端表：

```text nocollapse
CreateStorageBackends() 的装配顺序（OrderedDict，先入者优先）
  ├─ PDBackend / PDBackendAsync        enable_pd 时
  ├─ LocalCPUBackend                   max_local_cpu_size > 0
  ├─ P2PBackend                        enable_p2p
  ├─ NixlStorageBackend                extra_config.enable_nixl_storage
  ├─ LocalDiskBackend                  local_disk && max_local_disk_size > 0
  ├─ GdsBackend                        gds_path is not None
  ├─ MaruBackend                       maru_path is not None（CXL 共享内存）
  ├─ RemoteBackend-<plugin>            remote_storage_plugins 里每个插件一个
  ├─ RemoteBackend                     legacy remote_url
  ├─ <storage_plugins>                 storage_plugin_launcher 动态加载
  └─ AuditBackend(...)                 可选，包在除 LocalCPU 外的每个后端外面
```

第二层是远端存储的连接实现，`v1/storage_backend/connector/` 下有 16 个 `*_adapter.py`（另有 17 个 `*_connector.py` 提供底层协议实现），每个适配器认领一个 URL scheme：

| URL scheme                                     | 适配器文件                      | 目标系统                                         |
| ---------------------------------------------- | ------------------------------- | ------------------------------------------------ |
| `redis://` / `rediss://` / `redis-sentinel://` | `redis_adapter.py`              | Redis                                            |
| `valkey://`                                    | `valkey_adapter.py`             | Valkey                                           |
| `infinistore://`                               | `infinistore_adapter.py`        | InfiniStore                                      |
| `mooncakestore://`                             | `mooncakestore_adapter.py`      | Mooncake Store                                   |
| `s3://`                                        | `s3_adapter.py`                 | S3 / S3-Express                                  |
| `azure://`                                     | `azure_adapter.py`              | Azure Blob                                       |
| `bigtable://`                                  | `bigtable_adapter.py`           | Google Bigtable                                  |
| `hf3fs://`                                     | `hf3fs_adapter.py`              | HF3FS                                            |
| `plugin://hfbucket`                            | `hfbucket_adapter.py`           | HF Bucket（走插件路由）                          |
| `fs://`                                        | `fs_adapter.py`                 | 本地/挂载文件系统                                |
| `sagemaker-hyperpod://`                        | `sagemaker_hyperpod_adapter.py` | SageMaker HyperPod                               |
| `audit://`                                     | `audit_adapter.py`              | 审计包装层                                       |
| `blackhole://`                                 | `blackhole_adapter.py`          | 丢弃（测试）                                     |
| `mock://`                                      | `mock_adapter.py`               | 带延迟注入的假后端                               |
| `external://`                                  | `external_adapter.py`           | 用户模块动态加载                                 |
| `eic://`                                       | `eic_adapter.py`                | EIC（仓库内仅见 `EICConnector`，未找到公开说明） |
| `plugin://<name>`                              | 运行时注册                      | 第三方插件                                       |

这些 scheme 列在 `CreateConnector()` 的 docstring 里（`connector/__init__.py` 第 373–399 行），并用 `grep` 在各自的 `super().__init__("<scheme>")` 里逐条核对过。注意 `hfbucket` 不在 `CreateConnector` 的 scheme 清单里：它注册成 `plugin://hfbucket`，走插件路由而不是独立 scheme，这类不一致只有读代码才会发现。

把两套模式合起来，LMCache 实际能落的介质是 20 种上下：CPU DRAM、本地 POSIX 盘、裸块设备、Device-DAX/CXL、GDS（GPUDirect Storage）、Maru CXL、NIXL（三种形态）、P2P、文件系统（fs / fs_native / hf3fs）、对象存储（S3 / Azure / HF Bucket / Bigtable / Aerospike）、内存数据库（Redis / Valkey / InfiniStore）、Mooncake、SageMaker HyperPod，加上一堆测试桩。

而 UCM 那边，`ucm/store/` 下的介质目录是 9 个：`dram`、`posix`、`nfsstore`、`pcstore`、`ds3fs`、`mooncakestore`、`yuanrongstore`、`fake`、`empty`（后两个是桩）。这个数量差是后面所有分析的起点。

### 1.3 L1 是封闭集合，L2 是开放注册表：一句代码注释把路线讲完了

`v1/distributed/api.py` 里 `L1BackendType` 的 docstring 比数量更有说服力：

```python
class L1BackendType(str, enum.Enum):
    """The storage medium backing the L1 tier (a closed set, unlike L2
    backends, which are an open adapter-type registry)."""

    DRAM = "dram"
    DEVDAX = "devdax"
    GDS = "gds"
```

L1 是三个值的封闭枚举，L2 是开放的适配器类型注册表。LMCache 自己把这个不对称写进了类型系统：它认定"离 GPU 最近的那一层"只可能在这三种介质上，所以宁可写死；而"远端的那些层"什么都可以是，所以做成注册表。

这句话几乎就是"兼容优先"路线的自我描述：兼容性是有边界条件的，边界画在延迟最敏感的地方。

## 2. 抽象层：三层半，和两套不同宽度的接口

### 2.1 组件图

```text nocollapse
                     vLLM（Scheduler + Worker）
                                │
                  KVConnectorBase_V1（官方插件接口）
                                │
        ┌───────────────────────┴────────────────────────┐
        │ 模式 A：in-process（vLLM 进程内）               │ 模式 B：MP（独立进程）
        ▼                                                ▼
┌──────────────────────────┐              ┌──────────────────────────────┐
│ LMCacheEngine            │              │ lmcache server               │
│  ├ StorageManager        │              │  ├ MPCacheServer             │
│  │   ├ LocalCPUBackend   │              │  │   ├ StorageManager(dist.) │
│  │   ├ LocalDiskBackend  │              │  │   │   ├ L1: DRAM/DEVDAX/  │
│  │   ├ GdsBackend        │              │  │   │   │        GDS        │
│  │   ├ MaruBackend(CXL)  │              │  │   │   └ L2: 21 种适配器   │
│  │   ├ Nixl/P2P/PD       │              │  │   └ L1Manager（位图索引）│
│  │   └ RemoteBackend ────┼──▶ 16 种     │  └ 请求走 ZMQ / gRPC        │
│  │        └ Connector    │    connector │                              │
│  └ CacheEngineKey ⇒ dict │              └──────────────────────────────┘
└──────────────────────────┘
```

### 2.2 后端接口：6 个必须实现，一批可选

单进程这一侧的契约很轻。`StorageBackendInterface`（`abstract_backend.py:27`）要求 `contains` / `exists_in_put_tasks` / `batched_submit_put_task` / `get_blocking` / `batched_get_blocking` 等方法，真正写一个远端后端时，你面对的是 `RemoteConnector`（`connector/base_connector.py`）：

```python
class RemoteConnector(metaclass=abc.ABCMeta):
    @abc.abstractmethod
    async def exists(self, key: CacheEngineKey) -> bool:
        raise NotImplementedError

    @abc.abstractmethod
    def exists_sync(self, key: CacheEngineKey) -> bool:
        raise NotImplementedError

    @abc.abstractmethod
    async def get(self, key: CacheEngineKey) -> Optional[MemoryObj]:
        raise NotImplementedError

    @abc.abstractmethod
    async def put(self, key: CacheEngineKey, memory_obj: MemoryObj):
        raise NotImplementedError

    @abc.abstractmethod
    async def list(self) -> List[str]:
        raise NotImplementedError

    @abc.abstractmethod
    async def close(self):
        raise NotImplementedError

    # ... 可选能力：support_ping / ping / support_batched_get / batched_get
    # ...           support_batched_put / batched_put / support_batched_contains
    # ...           默认全部返回 False，基类给 batched_* 提供基于 gather 的兜底实现
```

注意这个设计的味道：六个方法，两个是同步/异步成对的 `exists`（因为 lookup 路径要同步、加载路径可以异步），其余全带"可选能力探测"：`support_batched_get()` 返回 `False` 时，基类用 `asyncio.gather` 逐个 `get` 兜底。这就是"兼容"的第一层体现：不要求后端够快，只要求它能被正确地退化。

基类还顺手替后端干了三件它自己不容易干对的事：算 `full_chunk_size_bytes`、算 `single_token_size`、把 chunk 的形状/dtype/格式作为元数据一起写进远端（`save_chunk_meta` 开关，默认 `True`）。后面第 4 节会讲这个开关为什么是兼容性的核心。

### 2.3 MP 模式的接口：宽得多

到了 MP 模式，L2 适配器的契约陡然变宽。`L2AdapterInterface`（`v1/distributed/l2_adapters/base.py:85`）的抽象方法清单是：

- 三个 event fd：`get_store_event_fd` / `get_lookup_and_lock_event_fd` / `get_load_event_fd`（文档明说必须三个互不相同的 fd，重复会导致事件误路由）
- 写路径：`submit_store_task`、`pop_completed_store_tasks`
- 查路径：`submit_lookup_and_lock_task`、`query_lookup_and_lock_result`、`submit_unlock`
- 读路径：`submit_load_task`、`query_load_result`
- 属性与运维：`get_memory_tags`、`close`（这两个是抽象方法；`delete` / `list_l2_keys` / `get_usage` / `report_status` / `register_listener` / `submit_touch` 有默认实现，按需覆盖）

而且文档（`developer_guide/extending_lmcache/storage_plugins.rst`）额外要求：必须线程安全，因为 `StoreController` 和 `PrefetchController` 会从不同线程并发调用；必须接受 `**kwargs` 以保持向前兼容；`__init__` 要自己起 asyncio 事件循环和后台线程。

对比一下：

| 维度       | 单进程 `RemoteConnector` | MP 模式 `L2AdapterInterface`                      |
| ---------- | ------------------------ | ------------------------------------------------- |
| 必须方法数 | 6                        | 12（其中 3 个是 event fd getter）                 |
| 返回值形态 | `bool` / `MemoryObj`     | `Bitmap`（按 chunk 的位图）                       |
| 并发模型   | asyncio 协程 + 线程池    | 三个 event fd + 控制器线程，要求线程安全          |
| 失败语义   | 返回 `None` / 抛异常     | 位图缺位 + 显式 unlock                            |
| 写代码量级 | 百行级                   | 千行级（参考 `nixl_storage_backend.py` 的 92 KB） |

这就是"兼容优先"的第二层代价：越靠近生产、越并发的路径，接口就越宽；接口越宽，接一个后端的门槛越高。文档甚至专门为这件事准备了两条捷径：`plugin`（写完整 `L2AdapterInterface`）和 `native_plugin`（如果你的后端是 C++ pybind 的，只需要实现 6 个 connector 方法，复用内置桥接）。

## 3. 键与元数据：LMCache 把"自描述"做到了底

### 3.1 `CacheEngineKey`：五个字段，字符串序列化

`lmcache/utils.py:507`：

```python
@dataclass(slots=True)
class CacheEngineKey:
    model_name: str
    world_size: int
    worker_id: int
    chunk_hash: int
    dtype: torch.dtype
    request_configs: Optional[dict] = field(default_factory=dict)
    tags: Optional[tuple] = field(init=False, default=None)
    _dtype_str: str = field(init=False, default="")
```

序列化形态（`to_string()`）：

```python
    def to_string(self):
        s = (
            f"{self.model_name}@{self.world_size}"
            f"@{self.worker_id}@{self.chunk_hash_hex}@{self._dtype_str}"
        )
        if self.tags is not None and len(self.tags) != 0:
            tags = [f"{k}%{v}" for k, v in self.tags]
            s += "@" + "@".join(tags)
        return s
```

于是磁盘上每个 chunk 的文件名就是 `model_name@world_size@worker_id@chunk_hash@dtype[@tag%value...].pt`（`local_disk_backend.py:224`，`key.to_string().replace("/", "-") + ".pt"`）。

有意思的地方在 `dtype` 也在键里。这意味着同一个模型、同一段文本，用 fp16 算出来的 chunk 和用 bf16 算出来的 chunk 是两个不同的键，互不污染。这种做法把"缓存有效性"的判定条件显式编码进键，不靠配置或约定。同理，`request_configs` 里 `lmcache.tag.*` 开头的项会被折叠成 `tags` 参与哈希，用来让某些请求级参数（比如采样参数影响 KV 的场景）自动分流。

还有个子类 `LayerCacheEngineKey`（同文件 672 行），在键尾再追加一个 `layer_id`。解析时靠"第 6 段是不是纯数字"来区分（`if len(parts) >= 6 and parts[5].isdigit()`）。这个判定方式我读到时愣了一下：如果将来某个 tag 名恰好是纯数字，就会解析错。这是个真实的小脆弱点，不影响主旨，但值得记一笔。

### 3.2 MP 模式换了键：`ObjectKey` + 位打包的 `kv_rank`

MP 模式不用 `CacheEngineKey`，用 `v1/distributed/api.py` 里的 `ObjectKey`：

| 字段              | 类型    | 含义                                                                  |
| ----------------- | ------- | --------------------------------------------------------------------- |
| `chunk_hash`      | `bytes` | 该 chunk 的内容哈希（注意是 bytes，不是 int）                         |
| `model_name`      | `str`   | 模型名；docstring 明写不许含 `@`，因为 L2 适配器用 `@` 做序列化分隔符 |
| `kv_rank`         | `int`   | 该 KV 切片的 rank                                                     |
| `object_group_id` | `int`   | 对象组下标（full attention / sliding window / recurrent 等）          |
| `cache_salt`      | `str`   | 每用户隔离盐；不许含 `@` `/` `\` NUL，上限 128 字符                   |

`kv_rank` 的算法与 `worker_id` 无关，它把并行拓扑塞进一个 32 位整数：

```python
        # 每个数占 8 bit，拼在一起
        return (
            (world_size << 24)
            | (global_rank << 16)
            | (local_world_size << 8)
            | local_rank
        )
```

注释里留了个 `TODO(ApostaC)`：长远希望能支持"不同 TP/PP 配置之间共享缓存"的非对称并行，现在先简单区分。这个 TODO 本身就是兼容性成本的化石：为了让缓存跨配置可用，键的设计要预留到能表达"并行形态"的层面。

`cache_salt` 那段 docstring 更是把"兼容旧部署"写进了设计：

> Defaults to empty string, in which case serialized keys and filenames match the pre-cache_salt shape (no trailing salt field) — no migration is needed for un-salted deployments.

加了个新字段，但序列化形态在默认值下逐字节等于旧形态，所以老缓存不用迁移。这是"兼容优先"路线里最见功力的一类操作：新能力用默认值关闭，形态向前向后都兼容。

### 3.3 元数据存在哪：全在内存，规模 O(缓存块数)

LMCache 的元数据全在进程内存里。本地盘后端用一个 Python dict 存每个 chunk 的档案（`lmcache/utils.py:426`）：

```python
@dataclass
class DiskCacheMetadata:
    path: str
    size: int  # in bytes
    shape: Optional[torch.Size] = None
    dtype: Optional[torch.dtype] = None
    cached_positions: Optional[torch.Tensor] = None
    fmt: Optional[MemoryFormat] = None
    pin_count: int = 0
```

`path`、`size`、`shape`、`dtype`、`fmt`、`pin_count`：磁盘上有什么、多大、什么形状、被谁 pin 住，全部在内存里有一份副本。一个 `CacheEngineKey`（slots dataclass，5 个字段）加一个 `DiskCacheMetadata`（6 个字段，其中一个还是 `torch.Size` 和可能的 `Tensor`），再算上 dict 本身的桶开销。

这就是"元数据内存占用"这一栏的答案：它随缓存 chunk 数线性增长，而 UCM 那一侧这个数字接近零（后面第 6 节会给出证据）。如果一块 5 GB 的 CPU 缓存按 `chunk_size=256` 的 KV chunk 装，chunk 数量是万级到十万级，元数据本身占几十到几百 MB 是完全可能的；这部分内存是不"缓存 KV"的。

另外还有一层：`RemoteBackend` 默认会把 chunk 的形状元数据一起写到远端（`save_chunk_meta` 默认 `True`）。这是用每个 chunk 的额外字节换"任何引擎配置写进去的缓存，别的配置也读得出来"。兼容性在这里是按字节付费的。

## 4. 数据面：拷贝路径与序列化

一次 `put` 的完整路径（in-process 模式，目标为本地盘）：

```text nocollapse
GPU KV tensor
   │  ① GPU→CPU 拷贝（必然发生）
   ▼
MemoryObj（CPU 固定内存池里的一块，带引用计数）
   │  ② 可能的一次内部拷贝（allocate_and_copy_objects）
   ▼
另一个 MemoryObj（allocator backend 分配）
   │  ③ byte_array（零拷贝视图，但拿到的是 buffer 对象）
   ▼
write_file(buffer, path)
   │  ④ buffered write  或  O_DIRECT write
   ▼
本地盘上的 <key>.pt（其实是裸字节，不是 torch 存档）
```

几个可以敲实的点：

① GPU→CPU 的拷贝是绕不过去的。`StorageManager` 里 `allocate_and_copy_objects()` 干的事就是显式拷贝：

```python
        with torch_dev.stream(stream):
            memory_obj.tensor.copy_(src_memory_obj.tensor, non_blocking=True)
```

用 GPU stream 异步做，但仍然是拷贝。这不是 LMCache 的缺陷，任何卸载系统都要付这一笔。

② 序列化在默认路径上不存在。写盘用的是 `memory_obj.byte_array` 直接写字节，文件后缀叫 `.pt`，内容却是裸 buffer。这一点很容易误读，我第一次看到 `_key_to_path` 返回 `.pt` 时也以为是 `torch.save`。

③ 零拷贝的边界很清楚。CPU 内存池内部的搬动靠 `MemoryObj` 的引用计数（`ref_count_up` / `ref_count_down`）避免复制；但跨介质一定有一次真实拷贝。默认的 `NaiveSerializer` 干脆是个空操作：

```python
class NaiveSerializer(Serializer):
    def serialize(self, memory_obj: MemoryObj) -> MemoryObj:
        memory_obj.ref_count_up()
        return memory_obj

class NaiveDeserializer(Deserializer):
    def deserialize(self, memory_obj: MemoryObj) -> MemoryObj:
        return memory_obj
```

`config.remote_serde` 默认就是 `"naive"`。也就是说默认不开压缩、不开量化、不做额外序列化，这一层留着给 `cachegen`、`kivi` 这些可选的 serde 实现。

④ O_DIRECT 是条件开启的，条件跟"兼容"直接相关。这是我觉得最能说明问题的一段代码（`local_disk_backend.py:778`）：

```python
    def write_file(self, buffer, path):
        start_time = time.time()
        size = len(buffer)
        if size % self.os_disk_bs != 0 or not self.use_odirect:
            with open(path, "wb") as f:
                f.write(buffer)
        else:
            fd = os.open(path, os.O_CREAT | os.O_WRONLY | os.O_DIRECT, 0o644)
            os.write(fd, buffer)
            os.close(fd)
```

读路径上还有对应的告警：`"Cannot use O_DIRECT for this file, size is not aligned to disk block size."`

翻译一下：LMCache 允许任意大小的 chunk（`save_unfull_chunk`、任意 `chunk_size`、layerwise 3D 形状、MLA 2D 形状都行），但 O_DIRECT 要求文件大小对齐块大小。两者的冲突它选了"兼容优先"：大小不对齐就静默退回 buffered write，性能不要了，正确性保住。

这就是"兼容优先"在数据面上最具体的一笔账：为了容纳任意形状的 chunk，最快的 IO 路径变成了有条件可用。

## 5. 控制面：谁淘汰、怎么失效

### 5.1 淘汰策略：两边都是可插拔的

in-process 模式在 `v1/storage_backend/cache_policy/` 下有四个实现：`lru`、`lfu`、`fifo`、`mru`，`config.cache_policy` 默认 `"LRU"`。MP 模式在 `v1/distributed/eviction_policy/` 下四个：`lru`、`arc`、`isolated_lru`、`noop`，由 `CreateEvictionPolicy()` 分发。

值得注意 `isolated_lru`：隔离式 LRU，配合 `MemoryTags`（`MemorySegment` = VRAM/DRAM/CXL/GDS/STORAGE，`MemoryResidency` = LOCAL/REMOTE/DUMMY）做分层隔离淘汰。这套 tag 系统的 docstring 还很诚实地写着「只有 prefetch 目标过滤和 L1-L2 亲和性会用，别处要用得先找 @ApostaC 同意」，一个还在生长中的抽象，作者自己标了边界。

两个模式的淘汰策略都是"策略模式 + 工厂"，说明"可替换"这件事在 LMCache 里是一种默认审美，不只是后端。

### 5.2 失效与一致性：没有分布式事务，靠幂等和自描述

LMCache 没有做跨节点的强一致。它的做法是：

1. 键唯一确定。`chunk_hash` 由内容算出，同内容同键，天然幂等。
2. 每个 chunk 自带元数据（远端路径）。读到就能自己解释自己，不需要外部索引。
3. in-process 模式靠 `LMCacheWorker` → cache controller 广播事件（`inprocess/v1/cache_controller/`，有 `worker.py`、`locks.py`、`full_sync_sender.py`）。这是"尽力而为的跨实例可见性"，不是一致性协议。
4. MP 模式靠位图。`PrefetchResult` 的 `hit_cells` 是"每行一个位图"，`bitmap_ops.fold_unfold_grouped` 在 Rust 侧折叠；`L2AdapterListener` 通过 `_notify_keys_stored` / `_notify_keys_accessed` / `_notify_keys_deleted` 把 L2 的增删告知驱逐控制器。

这套设计的直接后果：**看不看得见一个缓存，和"该不该相信它"是两件事**。位图给的是"在不在"，而"内容对不对"由键和自带元数据保证。这就是为什么它能容纳 20 种后端：它根本没要求后端提供任何事务语义。

反面就是：延迟上限被最慢的那条链路决定。一次 lookup 要逐层问（L1 DRAM → 本地盘 → 每个 L2 适配器），每一问都是异步的、都要走事件循环、都要等超时。`lookup_timeout_ms` 默认 3000ms，这个默认值本身就是在说"我不假设后端快"。

## 6. UCM 的一面：四个选择，都是把"不确定性"删掉

为了让后面的对照有据，把 UCM 一侧的四个关键选择复述一遍。这四条在 [024](/posts/024-ucm-performance-first) 里被逐条追到代码，[019](/posts/019-ucm-pipeline-store) 和 [021](/posts/021-ucm-multi-rank-load) 分别拆了其中的 Pipeline 与多 rank 部分。这里只取跟本篇对照相关的部分，并补一条我自己核到的细节。

一、定长分片。`BlockId` 是 `std::array<std::byte, 16>`，16 字节定长。这样哈希从 O(n) 变 O(1)、结构体内嵌免动态分配、批量操作有稳定的内存布局；省内存不是目的。

二、文件名就是索引。这条我之前只在转述里见过，这次在 `ucm/store/posix/cc/space_layout.cc` 里找到了实现：

```cpp
inline std::string DataFileName(const Detail::BlockId& blockId)
{
    return fmt::format("{:02x}", fmt::join(blockId, ""));
}

std::string SpaceLayout::DataFilePath(const std::string& backend, const Detail::BlockId& blockId,
                                      bool activated) const
{
    const auto& file = DataFileName(blockId);
    const auto& shard = dataDirShard_ ? FileShardName(file) : DATA_ROOT;
    if (!activated) { return fmt::format("{}{}/{}", backend, shard, file); }
    return fmt::format("{}{}/{}{}", backend, shard, file, ACTIVATED_FILE_EXTENSION);
}
```

`DataFileName` = 16 字节的十六进制串（32 个字符），没有前缀、没有扩展名、没有 model 名。目录名是 `FileShardName(file) = fileName.substr(0, dataDirShardBytes_)`，也就是文件名的一个前缀。所以"这个 block 在哪"这个问题，答案是纯函数：`backend + 文件名前 N 位 + "/" + 文件名`。

这就是"几乎不维护元数据"的机制来源：不需要一张"键 → 路径"的表，因为路径是键的函数。要检查存在性就是一次 `stat`。要判冷热就看 `mtime`（`GetOldestFiles` / `GetColdestCandidates` 都在用 `time_t mtime`）。

提交语义也在这段代码里：`CommitFile()` 把 `.activated` 后缀的文件 `Rename` 成正式名，用 rename 的原子性代替元数据写入。没有索引要更新，所以也没有索引不一致的可能。

三、淘汰用环形游标。021 里拆过：早期是纯 `freeHead++` 环形 FIFO，后来改成 CLOCK 二次机会 + 每节点访问位。它是"在一个预分配的共享内存环上转游标"，不是"在 dict 里找最久未用的键"。

四、Pipeline + layerwise。019 拆过：`Cache|Compress|Posix` 这种组合名把存储动作分层，每层一个 `.so`，核心层只负责加载和逐层下传。

四条合起来指向同一个效果：UCM 的每次读，固定开销是一个字符串拼接 + 一次 `stat`；LMCache 的每次读，固定开销是一次 dict 查找 + 一次策略更新 + 一层协程调度。前者的下限更低，后者的上限更灵活。

## 7. 对照表：代价到底落在谁身上

| 维度               | LMCache                                                                                       | UCM v1                                                                         |
| ------------------ | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 抽象层数           | 3–4 层（引擎 / StorageManager / backend / connector），另有 MP 模式的控制器层                 | 2 层主要（`StoreV1` 契约 + `.so` 组件），核心层不含策略                        |
| 后端数量           | 20 种上下（21 个 L2 type + 16 个 connector adapter）                                          | 9 个 `ucm/store/` 介质目录，另有 3 个 Pipeline 组件插件                        |
| 接一个后端的成本   | 单进程：实现 6 个必选方法（百行）；MP：实现 12 个方法（含 3 个 event fd）+ 线程安全（千行）   | 实现 `StoreV1` 的六个方法（`Setup/Lookup/Load/Dump/Wait/Check`），编译成 `.so` |
| 单次读取的固定开销 | dict 查找 + 淘汰策略更新 + 协程/线程切换；跨层 lookup 要逐层问，`lookup_timeout_ms` 默认 3000 | 字符串拼路径 + `stat`（或 TransBuffer 共享内存命中，文档口径微秒级）           |
| 元数据内存占用     | O(chunk 数)：每个 chunk 一份 `CacheEngineKey` + `DiskCacheMetadata`，全在进程内存             | 接近 0：靠文件名 + `mtime`，不需要键→路径表                                    |
| 数据面额外开销     | 至少一次 GPU→CPU 拷贝；O_DIRECT 需大小对齐，否则静默退回 buffered                             | 定长分片，空间预分配，对齐是设计前提而非运气                                   |
| 部署复杂度         | 两种模式：in-process 嵌进 vLLM；MP 独立守护进程（ZMQ/gRPC）+ CLI + K8s operator               | 一个 Python 包 + `.so` 插件，随推理引擎进程起                                  |
| 故障面             | 20 种后端 × 2 种模式，组合爆炸；但 MP 模式与引擎不共命（no fate-sharing）                     | 介质少，组合少；但适配层 219 个 monkey patch 文件是持续失血点（见 022）        |
| 兼容成本压给谁     | 写后端适配器的人（接口宽、要处理 partial chunk、要被位图语义约束）                            | 延迟与内存（键形态锁死在 16 字节、文件名即索引、不允许多余元数据）             |

但 UCM 那边还有一个不对称：UCM 并不是没有兼容成本，它只是把兼容成本挪到了另一个地方。

[022](/posts/022-ucm-evolution) 里数过：`ucm` 的适配层有 15 个按 vLLM 版本命名的目录、219 个 `.py` 文件，是目录式 monkey patch。也就是说 UCM 的"兼容"主要花在推理引擎版本上，而不是存储后端上。

LMCache 在这一点上走了反方向。我把全仓库（`*.py` / `*.rst` / `*.md`）里 "monkey" 的命中逐条归了类：总共 2142 次，其中 2137 次在 `tests/` 目录下（pytest 的 `monkeypatch` fixture），剩下 5 次是文档和注释里的字面词（`AGENTS.md`、`CONTRIBUTING.md`、`event_notifier.md` ×2、`lmcache/v1/platform/devices/npu/pin_memory.py:243`）。没有一处是"改上游源码"式的 monkey patch，而且 `Get-ChildItem -Recurse -Directory | Where-Object { $_.Name -match "patch" }` 在整个仓库里返回 0 个目录。它走的是 vLLM 官方的 KV connector 插件接口：`quickstart.rst` 里的启动参数就是 `--kv-transfer-config '{"kv_connector":"LMCacheConnectorV1","kv_role":"kv_both"}'`，类在 `lmcache/inprocess/integration/vllm/lmcache_connector_v1.py:32`（`LMCacheConnectorV1Dynamic(KVConnectorBase_V1)`），实现在 `vllm_v1_adapter.py:448`（`LMCacheConnectorV1Impl`）。版本适配这件事上，LMCache 把筹码押在了上游接口的稳定性上，自己只承担"跟上接口"的成本。这是我的判断，依据是它确实没有 patch 目录。

于是两边的兼容成本分布正好互补：LMCache 把成本花在存储后端的横切面上（20 种），UCM 把成本花在推理引擎的纵切面上（219 个 patch）。谁都没省下这笔钱，只是花在了不同的地方。

## 8. 为什么兼容优先更容易"活下来"

兼容优先是一条生态路线，收益落在三个地方：

一、可替换性本身就是卖点。`README.md` 里把这件事写成了产品定位：「LMCache is vendor-neutral」，以及「users can freely switch between serving engines and storage vendors, while reusing the stored KV caches」。这不是抽象口号，它对应具体机制：同一个 URL scheme 换一个字符串就能换后端；`plugin` / `native_plugin` / `storage_plugins` 三条不同门槛的扩展路径覆盖"我想自己接"的全部动机。

二、用户已有的基础设施可以直接复用。你的集群里已经有 Redis、有 S3、有 HF3FS、有 Mooncake，那我就不用要求你为 KV Cache 新建一套存储。这一条在真实落地里往往比"快 10%"值钱得多。表 1.2 里那张 URL scheme 表，本质上是一份"我们已经能接你现有东西"的清单。

三、与引擎解耦带来故障隔离。MP 模式的定位写得很清楚：`no fate-sharing with engines`，推理引擎崩了，缓存还在。这是一个运维属性，不是性能属性，但它同样只能在"缓存是一个独立服务"的前提下成立，而这个前提又要求后端足够多样才能在任何环境里部署。

代价也是真实的三笔：

1. 接口宽度换来的是维护成本。21 个 L2 适配器 + 16 个 connector adapter + 两套插件系统，每一套都要跟着上游 SDK 的版本走。`nixl_storage_backend.py` 一个文件 92 KB，这类文件不便宜。
2. 层级是写死的。`CreateStorageBackends()` 里那句注释很坦白：`# TODO(Jiayi): The hierarchy is fixed for now`。后端可以无限扩展，但"谁先谁后"是代码顺序决定的，用户改不了。兼容性长在了横切面上，纵切面（分层拓扑）反而被锁死。
3. 每个后端都要在"最弱的那一个"上妥协。O_DIRECT 的条件回退就是例子：为了容纳任意形状的 chunk，最快的路径变成了可选项。

## 9. 为什么性能优先更难"被替代"

UCM 那一侧，收益同样是三块：

一、延迟上限被设计锁死，不随介质退化。定长 `BlockId` + 文件名索引 + 环形游标，这三件事一起保证了"无论后端是内存还是磁盘，定位成本都是一个常数"，而不是"取决于后端实现得怎么样"。

二、与推理引擎同进程，能榨干共享内存和锁。 [020](/posts/020-ucm-cache-concurrency) 拆过那套 `TransBuffer` 共享内存 + 引用计数 + 环形队列的锁模型，[021](/posts/021-ucm-multi-rank-load) 拆过多 rank 共享加载的 CLOCK 二次机会。这些优化的前提都是"缓存和推理在同一个地址空间里、能看到同一块共享内存"，一旦像 LMCache MP 模式那样把缓存拆成独立进程，这套东西就没法做了。

三、接口窄，所以每次调用都能被优化到极致。`StoreV1` 只有六个方法，参数全是定长类型。窄接口的坏处是"想加能力要改契约"（019 里那两次加方法就是例子），好处是"每一次调用路径都是可预测的"。

代价同样明确：

1. 接一个新后端的成本压在实现者身上。你要理解 `BlockId`、`Shard`、`TaskDesc`、`Expected`，要自己管空间和 GC，要编译 `.so`。
2. 它放弃了"用用户已有的存储"这条路。想接一个不在列表里的系统，成本是写一个 C++ 组件，而不是填一个 URL。
3. 它放弃了"缓存跨引擎可用"这条路。定长 + 文件名索引意味着键的形态被固定，换个模型、换个 TP 配置、换个 dtype，缓存的可用性判定就得在别处解决。

两边其实各自接受了"另一种不兼容"：LMCache 不兼容"慢"，UCM 不兼容"没见过的介质"。

## 10. 两者正在互相靠近（有证据的部分）

我在两边代码里都找到了收敛的迹象，分开列，都给出位置。

LMCache 往"本地路径极限优化"走：

| 证据                             | 位置                                                       | 说明                                        |
| -------------------------------- | ---------------------------------------------------------- | ------------------------------------------- |
| `raw_block`（Rust）L2 适配器     | `v1/distributed/l2_adapters/raw_block_l2_adapter.py`       | 把裸块设备路径下沉到 Rust                   |
| `fs_native`                      | `fs_native_l2_adapter.py`                                  | 文件系统走原生实现，而不是 Python 逐文件    |
| `local_cpu_use_hugepages` 配置   | `v1/config.py`                                             | 大页，直指 TLB 开销                         |
| `numa_mode` 配置                 | `v1/config.py`                                             | NUMA 感知分配                               |
| `local_disk_path_sharding`       | `path_sharder.py`（`by_gpu` 策略）                         | 多盘按 GPU 分片，提升并行带宽               |
| MP 模式 L1 支持 Device-DAX / GDS | `api.py` 的 `L1BackendType`（DRAM/DEVDAX/GDS）             | L1 明确做"贴近 GPU 的三种介质"              |
| Chunk-Size Negotiation           | `docs/source/mp/chunk_size_negotiation.rst`                | 用 `lcm` 对齐各 KV group，把 chunk 边界锁死 |
| Chunk 大小协商后不可变           | 同上：「One MP server has one immutable final chunk size」 | 这是从"任意形状"往"定长"迈的一步            |

文档写的是：`--chunk-size` 只是下限，连接器会算出所有可缓存 KV group 的 token 跨度的最小公倍数，然后把 chunk size 抬到不小于配置值的那个倍数上。于是一个 MP server 有一个不可变的最终 chunk size，这就是 UCM 的"定长分片"思路，用另一种方式出现了。区别是 LMCache 的定长是"协商出来的"，UCM 的是"设计出来的"。

UCM 往"可插拔"走：这一侧的收敛在 [022](/posts/022-ucm-evolution) 里已有充分记录：P1 阶段六周接三种介质（DRAM / nfsstore / mooncake），后续把存储拆成 `.so` 插件、`Stack` 栈式组装、`Builder` 注册组合；我到本地检出（commit `2542854`）里核了一下当前形态：`ucm/store/` 下有 9 个介质目录，另有 `cache`、`compress` 两个 Pipeline 组件插件目录。"多后端"这件事 UCM 也在做，只是它把后端关在 Pipeline 的层里，而不是关在一个开放的注册表里。

但要说清楚：两个"插件化"不是同一件事。

- LMCache 的插件是数据面的 I/O 契约：你给我 `get` / `put` / `exists`，我不管你底下是什么。
- UCM 的插件是流水线的一层：你按 `Setup/Lookup/Load/Dump/Wait/Check` 插进已有的栈里，上下层由 Pipeline 决定。

前者兼容性更强（能接任何东西），后者可预测性更强（每层的位置是确定的）。这个区别是"把不确定性放在接口上，还是放在拓扑上"，跟谁更好无关。

## 11. 小结

「LMCache 为了极致的兼容性，兼容了很多很多的存储后端」这句话核实下来是真的，而且比"很多"还要多：21 个 MP 模式 L2 适配器类型、16 个单进程 connector 适配器、两套插件系统（`plugin` / `native_plugin`）、三条不同门槛的扩展路径（`storage_plugins` / `remote_storage_plugins` / `ConnectorAdapter` 自动发现）。代码里自己写着 `L1BackendType` 是 "a closed set, unlike L2 backends, which are an open adapter-type registry"，它把这条路线写进了类型系统的注释里。

两条路线的差别，我最后浓缩成一句话：

> UCM 把不确定性从类型系统里删掉（16 字节定长、文件名即索引），LMCache 把不确定性收进接口里（6 个 / 12 个方法、位图返回值、可选能力探测）。前者换来一个更低的延迟下限，后者换来一个更宽的介质覆盖面。

代价的落点也因此不同：LMCache 的账记在"写适配器的人"和"每个 chunk 的元数据 + 每层抽象"上，UCM 的账记在"延迟与内存"上：严格说，是记在"你必须按它的规矩来"上。

有一点我调研前没想到：UCM 并不是没有兼容成本，它是把兼容成本从存储后端挪到了推理引擎版本（15 个版本目录、219 个 monkey patch 文件），而 LMCache 在这件事上靠 vLLM 官方 connector 接口省了下来（2142 次 "monkey" 命中里 2137 次是测试 fixture，0 个 patch 目录）。于是两家的兼容账单在维度上正好互补，而不是"一个有、一个没有"。

还有一个必须留白的部分：两者正在互相靠近，但都还没走完。LMCache 的 chunk-size 协商只做到"每个 server 一个不可变大小"，跨 server 仍需"所有 server 返回同一个值"的人工约束；UCM 的多后端仍然长在 Pipeline 的层里，做不到"填个 URL 就多一个后端"。谁先把对方那一半补上，谁就在下一个阶段拿到优势。

至于"哪种形状更好"，取决于你在优化什么。如果你要的是一个能在任何客户机房里跑起来的缓存层，LMCache 的形状是对的；如果你要的是"取回来的时间必须可预测"，UCM 的形状是对的。两个系统都没有做错，它们只是把成本放在了不同的地方，并且都诚实地承认了那笔成本的存在。

## 参考来源

- LMCache 仓库：<https://github.com/LMCache/LMCache>，默认分支 `dev`，HEAD `ff9185d419e1ce55c9f4f1ad84a4f4f1f06af7be`（2026-10-23），本地只读 clone
- LMCache 文档：<https://docs.lmcache.ai/>；仓库内 `docs/source/`（398 个文件）与 `docs/design/`
- 本文引用并核对过的 LMCache 文件：
  - `lmcache/utils.py`（`CacheEngineKey:507`、`LayerCacheEngineKey:672`、`DiskCacheMetadata:426`）
  - `lmcache/inprocess/v1/cache_engine.py`（`LMCacheEngine:83`、`LMCacheEngineBuilder:2023`）
  - `lmcache/v1/storage_backend/storage_manager.py`（`StorageManager:221`）
  - `lmcache/v1/distributed/storage_manager.py`（`StorageManager:102`）
  - `lmcache/v1/storage_backend/__init__.py`（`CreateStorageBackends:111`）
  - `lmcache/v1/storage_backend/abstract_backend.py`（`StorageBackendInterface:27`、`AllocatorBackendInterface:325`、`StoragePluginInterface:424`）
  - `lmcache/v1/storage_backend/connector/`（`base_connector.py`、`__init__.py` 的 scheme 清单、16 个 `*_adapter.py`、17 个 `*_connector.py`）
  - `lmcache/v1/distributed/l2_adapters/`（`base.py:85`、`factory.py` 注册表、21 个注册类型 / 22 个 `*_l2_adapter.py` 文件）
  - `lmcache/v1/distributed/api.py`（`Tier`、`L1BackendType`、`MemorySegment`、`MemoryTags`、`ObjectKey`、`ComputeKVRank`）
  - `lmcache/v1/storage_backend/local_disk_backend.py`（`_key_to_path`、`write_file`、`async_save_bytes_to_disk`）
  - `lmcache/v1/storage_backend/naive_serde/naive_serde.py`
  - `lmcache/v1/storage_backend/maru_backend.py`、`gds_backend.py`、`nixl_storage_backend.py`、`p2p_backend.py`、`pd_backend.py`
  - `lmcache/v1/distributed/eviction_policy/factory.py`、`v1/storage_backend/cache_policy/`
  - `lmcache/inprocess/integration/vllm/lmcache_connector_v1.py:32`、`vllm_v1_adapter.py:448`
  - `docs/source/mp/l2_storage/supported_storages.rst`、`docs/source/mp/chunk_size_negotiation.rst`、`docs/source/getting_started/compatibility.rst`、`docs/source/getting_started/quickstart.rst`、`docs/source/developer_guide/extending_lmcache/storage_plugins.rst`
  - `README.md`、`lmcache/v1/config.py`、`lmcache/v1/storage_backend/path_sharder.py`
- UCM 仓库：本地检出 `D:\Vibe_Workspace\unified-cache-management`，commit `2542854`（2026-09-02），只读
  - `ucm/store/posix/cc/space_layout.cc`（`DataFileName`、`DataFilePath`、`CommitFile`）
  - `ucm/store/` 下 9 个介质目录 + `cache` / `compress` 组件目录
- 站内相关：[024 UCM 的极致性能路线](/posts/024-ucm-performance-first)、[019 UCM Store 的 Pipeline 架构](/posts/019-ucm-pipeline-store)、[020 共享内存锁模型](/posts/020-ucm-cache-concurrency)、[021 多 rank 共享加载](/posts/021-ucm-multi-rank-load)、[022 UCM 演进史](/posts/022-ucm-evolution)、[018 v2 接口设计](/posts/018-ucm-v2-interface-design)；横向评分矩阵见 [023 KVCache 卸载方案竞争力对比](/posts/023-kvcache-competitive-analysis)
- 未核实项：`wqs` / `wqs_store`（文档列为 vendor-provided，仓库无实现）；`eic://` 背后的具体产品（仓库内只有 `EICConnector`，未找到说明）；任何性能倍数（全文未引用）
