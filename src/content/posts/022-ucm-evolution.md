---
title: "UCM 演进之路：从 commit 史看一个 KV Cache 系统如何长出来"
description: 拆开 UCM 的 775 次提交，从 commit 记录还原一个 KV Cache 卸载系统走向 v2 契约的七个阶段，并点出哪些设计被反复修补、哪些被推翻。
publishedAt: "2026-10-23"
category: 项目笔记
tags:
  - UCM
  - KV Cache
  - 开源项目
  - 架构演进
draft: false
---

大多数开源项目的「架构介绍」都是回头写的：作者看着今天的代码，把结果讲成一个本来就想好的故事。这种叙述不算撒谎，但会丢掉最有信息量的部分——那些走错又走回来的路、那些当时只能这么写的妥协、那些后来被迫回头补的抽象。

这篇文章换个方向：不看文档，看 commit。我把 UCM（Unified Cache Manager）仓库的 775 条 `develop` 主线提交按时间摊开，重建每个阶段"当时在解决什么问题"，再用 `--stat` 去验证每一次架构跃迁到底动了多少文件。所有 hash、日期、文件数、行数都在本地 bare 镜像上现场跑过；凡是推断而不是记录的东西，我会明确标出来。

先说结论，三条：

1. **这个系统不是设计出来的，是被需求逼出来的，而且逼它的不是"介质多"。** 反直觉的一点：接 DRAM、NFS、Mooncake 三种介质的那六周里，抽象类一个方法都没加。真正让接口变长的是另外两类需求——算法特性（稀疏注意力要"按重要度筛选 KV"）和模型结构（混合模型的 Mamba 块要反向查找）。真正的接口契约（`StoreV1`）诞生于 2025-12，距第一行代码五个月；而中间那五个月，仓库里一直有一个"够用"的 Python 抽象类在顶着。
2. **它最强的设计习惯是"只增不改"。** `StoreV1` 从 2025-12 定稿到 2026-10，抽象方法从 7 个长到 11 个，一个都没删。代价是主接口越来越胖，最终 v2 把它拆成了能力 facet——这是一次真正的范式更换，不是版本号加一。
3. **它最弱的地方是适配层的忍让。** 对 vLLM 的 monkey patch 从 1 个版本目录涨到 15 个，最后不得不在一次提交里补三个版本。这是把上游不稳定性直接吸收进自己仓库的典型代价。

## 统计口径与数据源

先把尺子交代清楚，否则后面的数字没法对齐。

- 仓库：主仓 `ModelEngine-Group/unified-cache-management`；本地只读 bare 镜像取自作者的 `mag1c-h/unified-cache-management`。两者 `develop` HEAD 同一个提交（`4e47254`），主线历史完全一致；但 `feature/v2`、`dev-ucm-v2`、`dev-transport`、`dev-cache-mp-test`、`debug-perf-2609-mag1c` 这些分支**只存在于作者镜像**，所以文中涉及分支级的观察（v2 分叉、传输层划线、缓存多进程改造）要按镜像去看。
- 主线：`develop` 分支，`git rev-list --count develop` = **775**；镜像的 10 个分支去重后 **827**，差额来自 9 个非主线分支上未合入的提交。
- 统计区间：**2025-07-10**（首提交）至 **2026-10-22**（`4e47254`，主线末次提交）。
- 作者数按提交邮箱去重，`shortlog` 口径全期 **79** 人。
- 增删行数用 `git log --shortstat` 累加，包含文档与测试，不做剔重。
- 版本节点来自 GitHub Releases API（26 条，含 draft 与 nightly），因为镜像里**没有 tag**——`git tag` 返回空。这是个值得记住的坑：本地镜像能还原代码史，但发布史必须另找证据。
- 截止日：**2026-10-23**。

```text nocollapse
主线里程碑（日期 / commit / 事件）

2025-07-10  f0f9455  initial commit —— readme.md 一行
2025-07-24  94356b5  init repo and add intergration（17 文件 1394 行，vLLM connector + OceanStor）
2025-09-05  f939165  change code directory（unifiedcache → ucm，110 文件）
2025-09-25  35c81a1  redefine store interface and structure（118 文件 +4071/-1645）
2025-11-20  3127481  ucmtrans：统一 Device-Host 传输
2025-12-13  319421f  StoreV1 诞生（ucmstore_v1.h，122 行）
2025-12-19  d9dc59c  CacheStore / PosixStore / PipelineStore 一起落地
2026-01-16  cd4239f  PipelineStore 架构刷新（加 LookupOnPrefix）
2026-05-14  e418c03  dev-transport：14 个 0 字节文件，纯划线
2026-08-26  f031c5a  P2P transport 落地（21 文件 4124 行）
2026-09-21  3282983  传输层连接与内存生命周期重构（+2307/-2820）
2026-10-23  fa84383  UCM.v2 接口契约（64 文件 9825 行，仍未进 develop）
```

```text nocollapse
提交量按阶段（每 █ ≈ 10 次提交）

P0     1
P1    86  ████████▌
P2   165  ████████████████▌
P3   106  ██████████▌
P4   210  █████████████████████
P5   126  ████████████▌
P6    81  ████████
```

## 阶段划分：七段，每一段都有明确的"当时的问题"

| 阶段                     | 时间范围           | 提交量 | 代表 commit                             | 这阶段解决的核心问题                                                |
| ------------------------ | ------------------ | ------ | --------------------------------------- | ------------------------------------------------------------------- |
| P0 起点                  | 2025-07-10 ~ 07-23 | 1      | `f0f9455`                               | 占住仓库名和方向，还没有代码                                        |
| P1 Connector 扩张        | 2025-07-24 ~ 09-04 | 86     | `94356b5` `da7b0fd` `385325b`           | 证明"KV Cache 可以卸载到多种介质"，用 Python 抽象类接住全部厂商实现 |
| P2 目录重构与第一版接口  | 2025-09-05 ~ 10-31 | 165    | `f939165` `35c81a1` `d9b68aa`           | 多人并行时目录和接口必须先稳住，否则每次 PR 都撞车                  |
| P3 公共底座与 StoreV1    | 2025-11-01 ~ 12-31 | 106    | `3127481` `4efe8f5` `319421f` `d9dc59c` | 抽出设备-主机传输与基础设施，把"存储实现"变成"可组合的 Pipeline 层" |
| P4 Pipeline 化与 IO 引擎 | 2026-01-01 ~ 05-14 | 210    | `cd4239f` `5269d64` `b580d2a` `e418c03` | 让存储层能按配置拼装、能压缩、能换 IO 引擎，并提前给传输层划线      |
| P5 平台化                | 2026-05-15 ~ 08-31 | 126    | `127647c` `b3b3f29` `f031c5a` `c56c8f9` | 从"能跑"到"能运营"：指标、工具链、P2P 传输、委托层（Delegator）     |
| P6 v2 分叉与收敛         | 2026-09-01 ~ 10-23 | 81     | `003afe7` `fa84383`                     | v1 主接口已经装不下新语义，另写一份契约而不是继续加方法             |

七段相加 1 + 86 + 165 + 106 + 210 + 126 + 81 = 775，与主线总数吻合。这个吻合本身是个检查点：如果哪段数字对不上，说明我用错了时间边界。

## 起点：一行 readme，和一个 Python 抽象类

第一次提交是 2025-07-10 的 `f0f9455`，作者 Mag1c.H，提交信息只有 `initial commit.`。`git show --stat` 的结果是：**1 个文件，1 行内容**——`readme.md`，正文是 `# Unified Cache Manager`。

```text nocollapse
$ git show --stat f0f9455
 readme.md | 1 +
 1 file changed, 1 insertion(+)
```

两周后的 2025-07-24，`94356b5`「init repo and add intergration」一次性进了 **17 个文件、1394 行**，目录结构是这样的：

```text nocollapse
unifiedcache/
├── integration/vllm/
│   ├── uc_connector.py          # 144 行，继承 vLLM 的 KVConnectorBase_V1
│   └── uc_connector_impl.py
├── ucm_connector/
│   ├── base.py                  # UcmKVStoreBase，存储厂商实现这个
│   ├── factory.py
│   └── ucm_oceanstor.py         # 第一个真实介质：OceanStor
└── logger.py
examples/vllm_kv_offload.py
test/test_uc_connector_impl.py
```

第一天就分成两半：**左边贴 vLLM，右边贴存储**。这个划分后来一直没变，只是每半都膨胀了十倍。

当时想解决的问题写在 `base.py` 的 docstring 里，一句话："Storage vendor implements this interface to support KV Cache centric inference system." 接口有 7 个方法，我今天读还是觉得这版设计得相当克制：

```python
class UcmKVStoreBase(ABC):
    def create(self, block_ids: List[str]) -> int: ...
    def lookup(self, block_ids: List[str]) -> List[bool]: ...
    def prefetch(self, block_ids: List[str]) -> None: ...
    def load(self, block_ids, offset, dst_tensor) -> Task: ...
    def dump(self, block_ids, offset, src_tensor) -> Task: ...
    def wait(self, task) -> int: ...
    def commit(self, block_ids: List[str], is_success: bool = True) -> None: ...
```

注意最后那个 `commit` 的注释："if False, we need release block"。这句话是整篇文章里最值得留意的一行——它说明**两阶段准入（先占位、再确认）从第一版就被想到了**。一年后 v2 的接口文档把同一件事正式命名为「两阶段准入与原子性保证」，但语义没变。有些设计决策并不产生于深思熟虑的架构评审，而是产生于"我这个 dump 可能失败，那占的块得能退"这种朴素的工程直觉。

## P1：六周接三种介质，方法数没变

2025-07-24 到 09-04，86 次提交，主线从 1 个文件长到能跑起来的系统。这一段的主旋律是横向铺介质：

| 日期       | commit    | 事件                                                     | 规模                  |
| ---------- | --------- | -------------------------------------------------------- | --------------------- |
| 2025-07-26 | `aa6cb83` | adapt vllm v0.9.2，只改 1 个文件 8 增 7 删               | 微调                  |
| 2025-07-28 | `95413be` | 加 DRAM connector，313 行                                | 第 2 种介质           |
| 2025-07-30 | `da7b0fd` | nfsstore，**50 个文件 3317 行**，第一次引入真实 C++ 代码 | 第 3 种介质，且是重写 |
| 2025-07-31 | `01e8f66` | 合入 `0.0.1-release` 分支                                | 内部版本号起步        |
| 2025-08-13 | `385325b` | 合入 mooncake，493 行                                    | 第 4 种介质           |
| 2025-08-25 | `33b6fd9` | 合入 `dev_ucm_sparse`，1453 行，带来 ESA 稀疏注意力      | 第一次出现"上层特性"  |
| 2025-09-04 | `a2dce8a` | `0.0.2 release merge develop (#158)`                     | 第二个内部版本        |

有两件事需要点出来。

第一，**`da7b0fd` 是个转折点**。DRAM connector 是纯 Python，147 行；nfsstore 带了完整的 `csrc/ucmnfsstore` 目录，里面有 CMakeLists、`aclrt_device.cc`（昇腾）、`cuda_device.cc`（英伟达）、domain 分层。此前仓库里的 `csrc/` 只有一个占位的 `.gitkeep`，这是第一行真正的 C++。同一个功能，四天之内从 Python 抽象类跳到 C++ 工程结构，说明作者们很快意识到：卸载的瓶颈在拷贝，而拷贝必须下沉到 C++ 才有机会跑满带宽。这个判断后来被 `3127481` 的 ucmtrans 验证了——它把 Device↔Host 传输统一成一套 C++ API，然后所有 store 都不再自己管拷贝。

第二，**接口在这 86 次提交里没有长出新方法**。四种介质、一个抽象类，方法数从第一天到 P1 结束一直是 7 个。`base.py` 本身被改过三次，但三次都不加能力：`6aa8309`（08-01）补 MIT 头，`908a878`（08-08）修风格与注释，`a9ff92c`（09-02）把 `create` 的返回类型从 `int` 改成 `List[int]`——唯一一处语义改动，含义是"创建"从整体成败变成逐块结果。除此之外，介质之间的差异全被藏在了 `load`/`dump` 的实现里，契约层面看不出来。

这种"接口稳定"是虚的——它在等第一个不属于"介质差异"的需求出现。

那个需求在 2025-08-25 出现了：`33b6fd9` 合入的 `dev_ucm_sparse` 不是介质，是算法。稀疏注意力要的不是"存取 KV"，而是"按重要度筛选 KV"。抽象类没为这件事准备任何位置。

## P2：146 次提交的一个月，和第一次真正的接口

2025-09 是主线历史上最密集的一个月：**146 次提交、26 位作者**，而 8 月是 52 次 / 17 人、10 月只有 24 次 / 12 人。这个尖峰值得单独解释。

`git log --since=2025-09-01 --until=2025-10-01` 里能看到至少四条并行的工作流在同时推进：

1. **目录重构**。`f939165`（2025-09-05）「change code directory (#161)」把 `unifiedcache/` 整体改名成 `ucm/`，110 个文件受影响。这是一次纯机械操作，但它必须做——因为接下来要往里塞的东西太多了，`unifiedcache` 这个名字已经开始误导人（里面不只有 cache）。
2. **稀疏注意力开花**。`406c548`（09-18）「GSA (#190)」4100 行；`2e95e46`（09-28）「Support kvstar sparse attention algorithm (#193)」2626 行。同一个月里 ESA 之后又长了 GSA 和 kvstar 两个算法，说明"稀疏"不是一个特性，而是一个品类。
3. **接口第一次重写**。`35c81a1`（09-25）「redefine store interface and structure (#189)」，**118 个文件、+4071/-1645**。这是整部历史里第一次真正意义上的架构动作。
4. **CI 与构建**。这一块的提交占了相当比例，也是 9 月提交量虚高的原因之一——`df651a3`/`e3a377a`/`0816854` 连着三条都是 `dev_ci_928` 分支的 CI 修补。

`35c81a1` 干的事是：把 Python 的 `UcmKVStoreBase` 换成 C++ 的 `CCStore` 模板，并把文件从"按介质命名"改成"按角色命名"。

```cpp
// ucm/store/connector/ucmstore.h —— 35c81a1 新增，85 行
template <class T = Task>
class CCStore {
    using BlockId = std::string;
    using TaskId  = size_t;
public:
    virtual int32_t Alloc(const BlockId& block) = 0;
    virtual bool    Lookup(const BlockId& block) = 0;
    virtual void    Commit(const BlockId& block, const bool success) = 0;
    virtual std::list<int32_t> Alloc(const std::list<BlockId>& blocks) = 0;
    virtual std::list<bool>    Lookup(const std::list<BlockId>& blocks) = 0;
    virtual void    Commit(const std::list<BlockId>& blocks, const bool success) = 0;
    virtual TaskId  Submit(T&& task) = 0;
    virtual int32_t Wait(const TaskId task) = 0;
    virtual int32_t Check(const TaskId task, bool& finish) = 0;
};
```

和 Python 那版对比，三个变化很关键：**批量重载**（单块 / 列表各一套）、**Task 变成 `TaskId` 句柄**（原来是 Python 对象引用）、**`create` 改名 `Alloc`、`load/dump` 合并成 `Submit`**。

第三个变化后来被撤销了。2025-12 的 `StoreV1` 又把 `Load` 和 `Dump` 拆成两个方法——因为 `Submit(T&&)` 把方向藏进了 task 里，调用方和存储方都要多一层判断，反而更难读。这是一次真实的回退，`git log -S"Submit"` 能追到它消失的位置。我在"决策留痕"一节会再提。

同月还有一个小提交，信息量比它的大小高得多：`b99bd34`（09-27）「change store from singleton to object」，11 个文件、+289/-306。**净删除**。单例改对象是个老生常谈的重构，但在 KV 卸载系统里它意味着一个具体的能力：同一进程里可以同时存在两个不同配置的 store（比如一块 DRAM 池 + 一个 NFS 目录），Prompt 侧和 Decode 侧可以各自持有实例。没有这一步，后面 Pipeline 的"多层可组合"无从谈起。

P2 收尾的两个提交把"上层特性"正式接到了存储层：`d9b68aa`（10-20）「add store intf with tensor addr ptr (#288)」，`ucm/store/ucmstore.py` 增 44 行，给三种 store 都加了 tensor 地址指针参数；`b01501a`（10-31）「Toy proxy now supports PD-mixed round-robin scheduling (#316)」让 `ucm/pd/toy_proxy_server.py` 第一次有了调度逻辑。

值得一提的是 P2 阶段已经出现了同时并行的多条分支，从 merge commit 的 PR 来源就能读到：`dev_ucm_sparse`（8 月，`33b6fd9`）、`dev_esa_v2`（9 月，`a902a01`）、`dev_store_object`（9 月，`bd82eb9`）、`dev_ci_928`（9 月，`df651a3`/`e3a377a`/`0816854` 三条）。这一段仍然是 fork + merge commit 的工作流——`git log --merges` 显示最后一个 merge commit 停在 2025-09-30 的 `7a82557`（PR #269）。10 月之后，主线上的合并提交彻底消失，改成 squash 到一行的 `(#1547)` 风格。这个工作流切换没有对应的 commit，只能从日志形状里看出来，属于本文的**推断**。

## P3：公共底座，和一份 122 行的接口

2025-11 到 12 月，106 次提交，主线干了三件事：抽公共层、定接口、发首个公开版本。

**抽公共层。** `3127481`（11-20）「ucmtrans: Unify API for Device-Host Memory Transfers (#379)」，36 个文件 +1982 行，新建 `ucm/shared/trans/`，把 CUDA / 昇腾 / 仿真三种设备的拷贝统一成一套 `Buffer` + `trans` API。同一天 `5c66fc8` 补上 Ascend 实现（441 行）。四天后的 `4efe8f5`（11-24）「Share Infra implementation and unify status codes (#399)」更彻底：把原先散在 `ucm/store/infra/` 下的 logger、template、thread 全部搬到 `ucm/shared/infra/`，并且**统一了错误码**（`+123/-208`，又是净删除）。

这两步的意义在于**把"每个 store 自己实现一遍基础设施"变成"所有 store 共享一套基础设施"**。`4efe8f5` 的文件路径里那一串 `ucm/{store => shared}/infra/...` 的重命名，就是这个转变最直白的证据。

**定接口。** 2025-12-13 的 `319421f`「merge Feature_store_next to develop (#518)」带来了 `ucm/store/ucmstore_v1.h`，**122 行**，一个叫 `StoreV1` 的抽象类。这是 UCM 真正意义上的第一份存储契约——在它之前只有 `CCStore` 模板和 Python 抽象类，都算不上契约。

```text nocollapse
StoreV1 首版（319421f, 2025-12-13）   后续只增不改的追加
────────────────────────────────────────────────────────────────────
Readme()                              + Setup(Dictionary)    5269d64  2026-01-28
Lookup(blocks, num)                   + LookupOnPrefix       cd4239f  2026-01-16
Prefetch(blocks, num)                 + CheckHealth          17e3605  2026-07-23
Load(TaskDesc)  → TaskHandle          + LookupOnReverse      46dc9c9  2026-08-17
Dump(TaskDesc)  → TaskHandle
Check(TaskHandle) → bool
Wait(TaskHandle)  → Status
────────────────────────────────────────────────────────────────────
  7 个抽象方法                  →      11 个，删除 0 个
```

注意 `CheckHealth()` 的写法：`virtual Status CheckHealth() { return Status::OK(); }`——**带默认实现**。这是"只增不改"能持续八个月的技术前提。新方法只要给一个空默认体，所有已有 store 就不用动。代价是接口语义会变模糊：一个"返回 OK 但其实什么都没检查"的健康检查，在监控面板上和"真的检查过"长得一模一样。

六天后的 `d9dc59c`（12-19）「New Store Impl: CacheStore - PosixStore - PipelineStore (#553)」是 P3 的高潮：63 个文件、+4988 行，一次性落下三个新 store 实现，同时新增 `ucmstore_v1.h` 并**保留**了 `ucmstore.h`。v1 / 非 v1 并存的局面从这里开始——直到 2026-10，`ucm/store/` 目录下 `factory.py` 和 `factory_v1.py`、`ucmstore.py` 和 `ucmstore_v1.py` 依然成对存在。

发布节奏也对上了。GitHub Releases 显示首个公开版本 **v0.1.0rc1 发布于 2025-11-17**，比首提交晚 4 个月；随后是 v0.1.0（12-02）、v0.1.2（12-10）、v0.2.0rc1（12-13）。`v0.2.0rc1` 和 `319421f` 是同一天——接口落地就被打进了 RC。

## P4：把存储变成可组合的层，同时给传输层画空框

2026-01 到 05-14，210 次提交，是主线第二密集的阶段。这一段的关键词是**组合**。

Pipeline 的引入分三步，每一步都在修上一步暴露的问题：

| 日期       | commit    | 做了什么                                                                    | 规模                   |
| ---------- | --------- | --------------------------------------------------------------------------- | ---------------------- |
| 2026-01-07 | `269b8af` | 加 3FS Store，19 个文件                                                     | 新介质                 |
| 2026-01-16 | `cd4239f` | PipelineStore 架构刷新，加 `LookupOnPrefix`、新增 `empty` / `fake` store    | 62 文件 +2631          |
| 2026-01-28 | `5269d64` | 「Refactor PipelineStore for Enhanced Scalability」，加 `Setup(Dictionary)` | 49 文件 +711/**-1293** |

`5269d64` 的增删比最值得看：+711 行、-1293 行，**在"增强可扩展性"的名义下删掉了将近两倍于新增的代码**。这是 Pipeline 化第一次真正兑现红利——把重复的分支逻辑收进配置驱动。同一天还有 `9434a12`「Rename global rank and remove broadcast function (#685)」，8 个文件、+13/**-64**，把 connector 里的按 rank 广播彻底删掉。

`9434a12` 是整部历史里罕见的**删接口**。它删掉的东西是：`ucm_connector.py` 里那套"rank 0 拿到结果再广播给其他 rank"的逻辑。删掉的前提是前面已经有 `d9b68aa` 那样把 tensor 地址传进 store 的机制，每个 rank 可以各自寻址，不需要一个中心节点转发。**先建立独立寻址能力，再删广播**——顺序反了就删不掉。

同一阶段还落了压缩层：`b580d2a`（2026-05-07）「Add UCM store compression module」，33 个文件 **+9507 行**，`ucm/store/compress/cc/compress_lib/` 下是一整套 bitstream 编解码器。压缩在 Pipeline 里的位置是 Cache 和 Posix 之间，热数据不压缩、冷数据才压——这个位置选择在 `doc-store-architecture` 分支的设计文档里写得很清楚。

然后是本文最想指出的一个细节。2026-05-14，`dev-transport` 分支上出现了一个提交 `e418c03`：

```text nocollapse
$ git show --stat e418c03
[feat] New directories and files based on the 2026 H1 architecture
 ucm/connector/CMakeLists.txt                  | 0
 ucm/store/asu/CMakeLists.txt                  | 0
 ucm/store/dram/CMakeLists.txt                 | 0
 ucm/transport/CMakeLists.txt                  | 0
 ucm/transport/kv/CMakeLists.txt               | 0
 ucm/transport/kv/asu/client/.gitkeep          | 0
 ucm/transport/kv/asu/trans/.gitkeep           | 0
 ucm/transport/p2p/CMakeLists.txt              | 0
 ucm/transport/p2p/p2p_address.h               | 0
 ucm/transport/p2p/p2p_factory.h               | 0
 ucm/transport/p2p/p2p_protocol.h              | 0
 ucm/transport/p2p/p2p_registry.h              | 0
 ucm/transport/p2p/p2p_transport.h             | 0
 14 files changed, 0 insertions(+), 0 deletions(-)
```

**14 个 0 字节文件。** 一次没有任何代码的提交，提交信息是"基于 2026 上半年架构的新目录与文件"。它属于 `dev-transport` 分支——那个分支至今只领先 `develop` 一个提交，就是这一个。

这是我在这份 commit 史里看到的最有性格的一笔：先按架构图把目录和头文件名字占住，让所有人都知道"传输层在这里、它会有这些文件"，然后回去填。104 天后的 `f031c5a`（2026-08-26）「add P2P transport module (#1277)」填进来 21 个文件 4124 行。

但对比两份文件清单，结论并不温柔：**当初规划的 5 个 `p2p_*.h` 一个都没活下来。** 实际落地的是 `include/core/transport.h`、`include/core/transport_manager.h`、`include/protocols/tcp/tcp_transport.h`、`include/protocols/hixl/hixl_transport.h` 这套按「core / protocols」重新分层的名字。更彻底的是 `ucm/transport/kv/asu/client/` 和 `ucm/transport/kv/asu/trans/` 这两条规划的目录——到 `develop` 头部直接不存在了。14 个空文件里，只有 `ucm/transport/p2p/` 这一个路径活到了今天。

代价是那 104 天里 `ucm/transport/` 一直是个空壳，任何按目录结构判断进度的人都会被误导。

## P5：从"能跑"到"能运营"

2026-05-15 到 08-31，126 次提交。这一段没有大重构，全是横切面：可观测性、工具链、进程模型、第二种传输通道。

- `127647c`（06-23）「Integrate ucm metrics into vLLM connector metrics (#995)」，17 个文件 +6307 行。之前 UCM 的指标是 UCM 自己看的，这次并进 vLLM connector 的指标体系，意味着 Grafana 面板上终于能同时看到"vLLM 的 TTFT"和"UCM 的命中率"。
- `b3b3f29`（07-07）「Add ucm-toolkit: unified CLI for dev-sandbox, posix-aio, nic-monitor, and metrics-view (#1012)」，**+97855 行**——全历史最大单提交。这是把一堆散落的运维脚本收成一个 CLI 工具。这个数字主要是 vendored 依赖和生成文件，但方向是对的：系统开始有人伺候了。
- `f031c5a`（08-26）P2P transport 落地，兑现 104 天前画下的空目录。
- `5cc8fdf`（08-27）「Add DramPool (#1284)」+9556 行，`d828f89`（08-28）「Add DramStore (#1296)」+7227 行。两天内 DRAM 从"一个 connector"变成"一个池 + 一个 store"。
- `c56c8f9`（08-31）「Add Delegator (#1300)」，16 个文件 +2768 行。Delegator 是 store 之上的委托层，可以在不改调用方的情况下换掉后端。
- `46dc9c9`（08-17）「Add LookupOnReverse interface for hybrid model mamba block lookup (#1219)」，给 `StoreV1` 加了第 11 个方法。注意这个提交的动机：混合模型（full attention + Mamba）的 KV 布局不一样，前缀查找得支持反向扫描。**接口是被模型结构逼出来的，不是被存储介质逼出来的。**

发布线索也在这段变密：v0.5.0（2026-05-13）、v0.6.0（07-10）、v0.7.0（09-11）。

## P6：v2 不是"版本号加一"，是换契约

2026-09 到 10 月，81 次提交。这一段有两件事可以并列：

**一是外部输入变大了。** `003afe7`（09-09）「KV Client merges into develop (#1344)」——160 个文件、**+31689 行**，在仓库顶层新增了 `kv_semantics/` 目录。`b3d10c2`（09-04）「Feature/cicd merge into develop (#1324)」+41706 行，带来 `charts/`。`1369063`（09-17）「Connect UCM documentation with versioned releases (#1379)」+27016 行，把文档搬进 `docs/docs-site/` 并做了 en/zh 双语。三个提交加起来 10 万行，全部是"把别处的东西并进来"。

**二是 v2 分叉。** 2026-09-02 到 09-10，`feature/v2` 分支上有 15 个增量提交，从 `6899678`「init v2 workspace」开始，到 `a79feef`「route Scheduler Prefetch to workers via per-rank shared rings」结束。下面节选其中 8 条，能看出它是一个从目录骨架开始、逐层往上搭的过程：

```text nocollapse
a79feef [feat] store: route Scheduler Prefetch to workers via per-rank shared rings
a4b067b [feat] store: add optional targetDeviceId param to Prefetch for device-affinity
27135c4 [feat] store: add CacheBuffer
89d4231 [feat] store: add CacheStore
6fb8bfe [feat] v2/detail: add Stopwatch and Latch primitives
68c38c8 [feat] store v2 interface
a86ac22 [feat] scaffold v2 subdirs and set install layout with global RPATH
6899678 [feat] init v2 workspace
```

然后 2026-10-23（本文写作当天），`dev-ucm-v2` 分支上出现了 `fa84383`「[Refactor] Interface design for UCM.v2」：**64 个文件、+9825 行、单提交**，`ucm/v2/` 下 62 个文件，包含 `store/store.h`（253 行）、`store/prefetchable.h`（183 行）、`store/token_addressed.h`（153 行）、`proxy/` 下一整套编排层（`store_assembler` / `store_entry` / `store_peer` / `store_pipe` / `store_scheduler` / `store_worker`），以及 1047 行的接口设计文档。

这里必须谨慎，因为很容易讲错：**`fa84383` 不是 `feature/v2` 那 15 个提交的 squash。** 我对比过两个分支的 `ucm/v2` 目录，`git diff --stat a79feef:ucm/v2 fa84383:ucm/v2` 显示 93 个文件、+9354/-4246 的差异。也就是说 v2 在 9 月原型之后又重写了一遍，最后以**单提交**形式落在一个只领先 `develop` 一个提交的分支上，没有进主线。

这和我之前在 [UCM v2 接口设计文档](/posts/018-ucm-v2-interface-design) 里搬运的那份文档能对上：文档自己写明基线是 `commit 737a17d`、规模"生产代码 33 个文件 / 约 4656 行；测试代码约 3280 行；153 个用例全部通过"，并把自己定位成"接口设计仓（intf）"。它不是一份增量改造方案，是一份**从零重写的契约**。

v2 到底改了什么是下一节的事。这里先记一个结构事实：v2 选择了一条"不进主线也能被评审"的路径——独立分支、独立目录、独立文档、独立单测。对接 `develop` 时它要么整体合入，要么整体放弃，没有中间态。

## 决策留痕：五个能追到底的设计选择

这一节是全文的技术核心。所谓"决策留痕"，指的是一个设计选择在后续 commit 里留下的、可验证的修补与扩展轨迹。

### 一、`StoreV1` 只增不改，八个月长胖 4 个方法

前面列过表，这里补上"为什么"。看 `CheckHealth` 和 `LookupOnReverse` 的默认实现就知道策略：

```cpp
virtual Status CheckHealth() { return Status::OK(); }
virtual Expected<ssize_t> LookupOnReverse(const Detail::BlockId* blocks, size_t num) = 0;
```

`CheckHealth` 有空默认体，所以 2026-07-23 加它的时候，所有 store 一行都没改——符合"只增不改"。
`LookupOnReverse` 是纯虚，所以 2026-08-17 加它的时候，**所有 store 实现必须补一遍**——`46dc9c9` 一共动了 **28 个文件**，从 `ucmstore_v1.h` 到 `posix_store.cc`、`mooncake_store.cc`、`ds3fs_store.cc` 挨个补实现，连测试用的 `mock_store.h` 和 `fake_store_impl_test.cc` 都要改。

同一个接口，两个方法，两种兼容策略。这不是不一致，而是**能力分层**：健康检查是横切关注点，可以有"我不检查"的默认答案；反向查找是功能，不支持就是不支持，不能假装。这个区分在 v2 里被显式化了——`AsPrefetchable()` / `AsTokenAddressed()` 返回 `nullptr` 表示不支持该能力，取代了 v1 里"给个默认实现"的做法。

判断（非事实）：如果 2026-01 就引入 facet 模式，v1 主接口不会长到 11 个方法。但反过来说，2026-01 的团队还不知道"混合模型需要反向查找"这件事——facet 划分的依据只能来自 v1 踩过的坑。**这层抽象早不得。**

### 二、`Prefetch` 的形状改了三次：从空函数到三段作业

这条线最完整，四个节点全部可查：

| 阶段    | 日期       | 形态                                                                                                          | 出处                       |
| ------- | ---------- | ------------------------------------------------------------------------------------------------------------- | -------------------------- |
| v0      | 2025-07-24 | `def prefetch(block_ids) -> None`，纯 hint                                                                    | `94356b5` `base.py`        |
| v1      | 2025-12-13 | `virtual void Prefetch(const BlockId* blocks, size_t num)`，docstring 明写 "non-blocking and fire-and-forget" | `319421f`                  |
| v2 原型 | 2026-09-10 | 先加参数：`a4b067b`「add optional targetDeviceId param to Prefetch for device-affinity」                      | `feature/v2`               |
| v2 原型 | 2026-09-10 | 再改路由：`a79feef`「route Scheduler Prefetch to workers via per-rank shared rings」                          | `feature/v2`               |
| v2 契约 | 2026-10-23 | 拆成三段作业：`PreparePrefetch` / `CompletePrefetch` / `Prefetch(jobId, plan)`                                | `fa84383` `prefetchable.h` |

这就是那条典型的弧线：**先加参数、再加语义、最后拆分层**。

为什么会走到拆层？因为"预取"这件事本身包含三个必须分开的时刻：什么时候占住源和目标（准入）、什么时候真正搬（传输）、什么时候确认成败（提交）。`void Prefetch()` 把三者糊在一起，调用方拿不到任何回执，失败也无法回滚。到了要多 rank 协同、要指定目标设备的时候，一个 `void` 函数就再也装不下了。

顺带说一句：v2 的 `Prefetchable` facet 里连 `Lookup` 都重写了一遍，签名叫 `Expected<std::optional<std::vector<std::uint8_t>>> Lookup(...)`，比 `Store::Lookup` 多一层 `optional`。`optional` 的含义大概是"这次查询本身可能无意义"（比如该 store 不支持预取场景的查询）。这种靠返回类型表达语义的做法，是 v2 比 v1 更严格的地方，代价是签名变难读。

### 三、monkey patch 按 vLLM 版本复制：15 个目录，219 个文件

这是这批提交里最能说明代价趋势的一条。`ucm/integration/vllm/patch/` 下按上游版本分目录，目录的首次提交时间如下：

| 目录      | 首次提交  | 日期       | 触发原因                                             |
| --------- | --------- | ---------- | ---------------------------------------------------- |
| `0.9.2/`  | `a17df9f` | 2025-09-25 | 最早的版本目录，从 `ucm/patch/` 迁过来，仍是 diff 式 |
| `0.11.0/` | `f5261e9` | 2026-01-22 | 第二个版本，仍是 diff                                |
| `v0110/`  | `a1e0e67` | 2026-03-02 | 改用 `vXXXX` 命名 + 目录式 patch                     |
| `v0180/`  | `100a788` | 2026-04-17 | layerwise KV load patch                              |
| `v0191/`  | `d3fdeba` | 2026-06-12 | 新 connector 接口                                    |
| `v0202/`  | `dd56f7b` | 2026-06-15 | KV load 失败恢复                                     |
| `v0210/`  | `8e3a29e` | 2026-07-01 | `disable migratepage`                                |
| `v0221/`  | `22f0145` | 2026-07-09 | CPU 亲和性对齐                                       |
| `v0230/`  | `f43d716` | 2026-07-21 | 又一个 CPU 亲和性                                    |
| `v0240/`  | `bd627bb` | 2026-08-19 | **一次提交建三个目录**                               |
| `v0251/`  | `bd627bb` | 2026-08-19 | 同上                                                 |
| `v0260/`  | `bd627bb` | 2026-08-19 | 同上                                                 |
| `v0270/`  | `e354ce5` | 2026-08-20 | MLA + 线性注意力混合                                 |
| `v0271/`  | `d6cdeb3` | 2026-09-17 | MiniMax M3 KV 传输                                   |
| `v0300/`  | `124e0d1` | 2026-10-15 | GLM-5.3-Flash 混合 KV                                |

到 `develop` 头部，这些目录下共有 **219 个 `.py` 文件**，而早期的 `.patch` 文件只剩 12 个（其中 6 个在 2025-09 就已存在）。这个对比说明了一切：**从"打 diff"改成了"复制并改写上游模块"**。

`bd627bb`（2026-08-19）一次提交补 v0240/v0251/v0260 三个版本目录，是这条路线走到极限的信号——当适配工作变成"每个版本复制一份"，人就会开始批量复制。判断（非事实）：质量差异大概率也会随批量复制一起出现，但 commit 史证明不了这一点，只能说三个目录的补丁内容在全量文件里高度重叠。

### 四、传输层：空目录先占位，104 天后填实

前面已经引过 `e418c03` 的 14 个 0 字节文件。这里补完后续：

| 日期       | commit    | 事件                                               | 规模                    |
| ---------- | --------- | -------------------------------------------------- | ----------------------- |
| 2026-05-14 | `e418c03` | `dev-transport` 分支：14 个空文件、0 行代码        | +0/-0                   |
| 2026-08-26 | `f031c5a` | P2P transport 模块落地，含 tcp/hixl 协议、控制通道 | 21 文件 +4124           |
| 2026-09-21 | `3282983` | 集中化连接与内存生命周期管理                       | 46 文件 +2307/**-2820** |

`3282983` 又是净删除。新模块落地不到一个月就被重构掉 2820 行——这不是返工浪费，而是"先让它能跑，再让它能维护"的常规节奏。三个提交连起来看：**划线（0 行）→ 实现（4124 行）→ 收敛（净 -513 行）**，前后 130 天。

### 五、被推翻的：`Submit(T&&)`、broadcast、单例

只增不改不等于不会推翻。三个明确被推翻的设计：

1. **`Submit(T&&)` 合并 load/dump**（`35c81a1`，2025-09）→ `StoreV1` 拆回 `Load` / `Dump` 两个方法（`319421f`，2025-12）。合并的代价是方向信息藏在 task 里，两侧都要解包。
2. **按 rank 广播**（v0 就有）→ `9434a12`（2026-01-28）「remove broadcast function (#685)」彻底删除，+13/-64。
3. **store 单例**（v0 就有）→ `b99bd34`（2025-09-27）「change store from singleton to object」，+289/-306。

三个都是"先能跑、后能组合"的同类修正。它们的共同点：**在被推翻之前，都先有替代能力被建起来**（独立寻址、多实例），否则删不掉。

## 数据观察：节奏、分支与发布

### 月度提交量与作者数

| 月份    | 提交数  | 作者数 | 新增行      |
| ------- | ------- | ------ | ----------- |
| 2025-07 | 30      | 6      | +6522       |
| 2025-08 | 52      | 17     | +9169       |
| 2025-09 | **146** | **26** | +32075      |
| 2025-10 | 24      | 12     | +4759       |
| 2025-11 | 48      | 16     | +18251      |
| 2025-12 | 58      | 15     | +28458      |
| 2026-01 | 52      | 17     | +24492      |
| 2026-02 | 34      | 16     | +25353      |
| 2026-03 | 85      | 22     | +20785      |
| 2026-04 | 32      | 12     | +7200       |
| 2026-05 | 19      | 10     | +17778      |
| 2026-06 | 29      | 12     | +30978      |
| 2026-07 | 45      | 13     | **+120272** |
| 2026-08 | 40      | 17     | +51942      |
| 2026-09 | 53      | 24     | **+128990** |
| 2026-10 | 28      | 16     | +28288      |

这张表能读出三件事：

1. **提交量在 2025-09 见顶，之后再没回去过。** 146 次是团队规模第一次扩张（26 位作者）的产物，也是目录和接口最混乱的时刻。之后提交量下降但新增行数上升——从"多人小改"转向"少数人做大块"。
2. **2026-07 和 2026-09 的行数尖峰全部来自单笔巨型提交**（`b3b3f29` +97855、`b3d10c2` +41706、`003afe7` +31689、`1369063` +27016）。这两个月不是开发加速，是**资产并入**。看提交数完全看不出来（45 和 53），必须看行数。
3. **2026-04 到 05 是低谷**（32、19 次，12、10 人）。这两个月最有代表性的提交不是代码，而是两次"划线"：`4403ad1`（05-11，`doc-store-architecture` 分支，377 行设计文档）和 `e418c03`（05-14，14 个空文件）。这两件事都是判断而非承诺，所以提交数低。这个解释属于**推断**，commit 史只能证明时间重合，证明不了因果关系。

### 分支：长跑型 vs 发布型

| 分支                     | 提交数 | 领先 develop | 末次提交   | 类型          |
| ------------------------ | ------ | ------------ | ---------- | ------------- |
| `develop`                | 775    | 0            | 2026-10-22 | 主线          |
| `dev-ucm-v2`             | 776    | **1**        | 2026-10-23 | 单提交交付型  |
| `feature/v2`             | 718    | 15           | 2026-09-10 | 原型长跑型    |
| `feature_a5`             | 749    | 24           | 2026-09-28 | 特性长跑型    |
| `doc-store-architecture` | 565    | 1            | 2026-05-11 | 文档单提交型  |
| `dev-transport`          | 569    | 1            | 2026-05-14 | 划线单提交型  |
| `dev-cache-mp-test`      | 521    | 2            | 2026-03-28 | 实验型        |
| `debug-perf-2609`        | 708    | 2            | 2026-09-05 | 短期 debug 型 |
| `dev-v2`                 | 1      | 1            | 2026-08-25 | 废弃草稿      |

这张表的读法：**"领先 develop 的提交数"比"分支总提交数"有用得多。** 一个 749 次提交的分支只领先 24 个提交，说明它一直在跟主线同步；一个 776 次提交的分支领先 1 个，说明它是"基于最新主线的一次性交付"。真正的工作量藏在差值里。

`dev-v2` 只有 1 个提交（`831ed2a`「init」，2026-08-25），是一次没走通的尝试。它在 8 月出现，9 月就被 `feature/v2` 取代了。这类草稿分支通常不会出现在任何汇报里，但它是理解"v2 做了两遍"的关键证据。

### 发布节奏

从 GitHub Releases 取到的 26 条记录里，去掉 1 条 draft 与 6 条 nightly 后，是 **19 个正式/RC 版本**。下表只列节点版本，省略了 `v0.1.0rc2`、`v0.1.0rc4`、`v0.5.0rc1` 三个中间 RC：

| 版本      | 日期          | 间隔  | 备注                                  |
| --------- | ------------- | ----- | ------------------------------------- |
| v0.1.0rc1 | 2025-11-17    | —     | 首个公开版本，距首提交 4 个月         |
| v0.1.0    | 2025-12-02    | 15 天 | 与 `783ea0f`「Dev-ucm-v1 rebase」同日 |
| v0.1.2    | 2025-12-10    | 8 天  |                                       |
| v0.2.0    | 2026-01-05    | 26 天 | StoreV1 之后的第一次大版本            |
| v0.3.0    | 2026-01-30    | 25 天 | PipelineStore 重构之后                |
| v0.4.0    | 2026-03-20    | 49 天 | 间隔开始拉长                          |
| v0.5.0    | 2026-05-13    | 54 天 | 次日即 `dev-transport` 的 `e418c03`   |
| v0.6.0    | 2026-07-10    | 58 天 |                                       |
| v0.7.0    | 2026-09-11    | 63 天 |                                       |
| v0.8.0rc1 | 2026-09-20    | 9 天  | 转入 RC                               |
| v0.8.0    | 2026-09-30    | 10 天 |                                       |
| v0.9.0rc1 | 2026-09-30    | 同日  | **两条线并行**                        |
| v0.9.0rc2 | 2026-10-19    | 19 天 |                                       |
| v0.8.1    | 2026-10-20    | 1 天  | 回头给 0.8 打补丁                     |
| nightly   | 2026-10-16 起 | 每日  | 开始出每夜构建                        |

两个模式很清楚：**2025 年是发布型节奏**（8~~26 天一个版本，边发边改），**2026 年转向长跑型**（间隔拉到 50~~63 天）。2026-09 之后同时跑 `0.8.x` 和 `0.9.0rc` 两条线，10-16 起加 nightly，这是因为上游 vLLM 0.29 改了 KVCache 布局——这层因果关系不是我猜的，仓库里的 `version.ini` 自己写着：

```text nocollapse
# vLLM 0.29 changed the KVCache layout, which is incompatible with the layout
# used by earlier vLLM/vllm-ascend releases. develop and 0.9.0rc2 therefore
# support vLLM/vllm-ascend 0.30 and newer only; earlier releases stay on 0.8.x.
UCM_VERSION=0.9.0
UCM_SUPPORTED_VLLM_VERSIONS=0.30,0.31
UCM_SUPPORTED_VLLM_ASCEND_VERSIONS=0.30
UCM_SUPPORTED_SGLANG_VERSIONS=0.5.18,0.5.19,0.5.20
```

一个 KV Cache 系统的版本号，最终被上游的 KV Cache 布局绑死了。这句话几乎概括了这个项目的全部处境。

## 留下的与被推翻的

**留下长期影响的：**

- **两阶段准入（Alloc → Commit）**。从 2025-07-24 `base.py` 的 `commit(..., is_success)` 到 2026-10-23 v2 的 `TokenAddressed::Alloc` / `Commit`，15 个月一字未改地活下来了。这是整份 commit 史里最稳定的一个语义。
- **块级批量化**。v0 的 `create(block_ids: List[str])` 一开始就是批量语义；`35c81a1` 把它写成单块 / 列表双签名，v2 里换成 `std::vector<BlockId>`。形式变了，接口一直按"块"而不是"张量"计量。
- **设备-主机传输与存储解耦**。`3127481` 的 ucmtrans 划分出 `ucm/shared/trans/` 之后，存储实现再也不用管拷贝，这个边界一直保留到现在。
- **Configuration as Dictionary**。`5269d64`（2026-01-28）给 `StoreV1` 加了 `Setup(const Detail::Dictionary&)`，v2 里变成 `Setup(const Dictionary&)`，`Pipeline` 靠它递归组装层级。

**被推翻或边缘化的：**

- **`Submit(T&&)` 的统一提交**（拆回 `Load`/`Dump`）。
- **按 rank 广播**（`9434a12` 删除）。
- **store 单例**（`b99bd34` 改为对象）。
- **diff 式 patch**（`a17df9f` 的 `.patch` 文件 → 目录式 monkey patch，219 个 `.py`）。
- **`ucmstore.h` 的 `CCStore` 模板**。它没有被删，但被 `ucmstore_v1.h` 架空：两个文件在 `ucm/store/` 下并排躺了 10 个月，`factory.py` 和 `factory_v1.py` 也是。这是一种比删除更糟的状态——**它没死，但也没人敢动**。

还有一类东西我不打算评价，但得指出来：`doc-store-architecture` 分支上那份 377 行的设计文档（`4403ad1`，2026-05-11）里有大量性能倍数（"80-95% cache hit rate"、"10-15x throughput"、"3-5x performance improvement"）。这些数字没有对应的 benchmark 提交支撑，我倾向于把它们读作"作者的设计意图表述"而不是"实测结论"，所以在正文里一个也没有引用。

## 如果重来：三个可以更早抽象的地方（判断）

这一节全部是个人判断，不是 commit 能证明的事。我把依据一起写出来，方便反驳。

**一、`StoreV1` 应该一开始就分核心与能力。** 依据：`CheckHealth` 和 `LookupOnReverse` 两次追加用了两种兼容策略（默认实现 vs 纯虚），说明团队在加方法时就已经在权衡"这是不是所有 store 都该有的"。这种权衡如果在 2025-12 就固化成 facet，v2 的 `AsPrefetchable()` 会早 10 个月出现。反方观点我上面也写了：能力划分的依据来自踩坑，早不了。所以我的实际主张是"核心接口应该更小"——把"必须每层都实现"的方法压到最少（`Setup`、`Lookup`、`Load`、`Dump`、`Wait`、`GetFinished`），而不是靠默认实现把可选能力一项项塞进主接口。

**二、patch 目录应该在第一份 diff 之后就改成"按语义分模块"而不是"按上游版本分"。** 依据：15 个版本目录里，大量内容是重复的（`cpu_binding` 出现在 v0191、v0202、v0210、v0221、v0230、v0240、v0251 七个目录里，`platform` 补丁在七个目录里重复出现）。如果 2026-01 就按"CPU 亲和性 / 混合缓存 / 失败恢复"分成模块，再用一张版本→模块的映射表组装，219 个文件大概能压到 60 个以内。这是全文里我最确定的一条。

**三、传输层不该先画 0 字节空目录。** 依据：`e418c03` 的 14 个空文件从 2026-05-14 躺到 08-26，期间任何"按目录看架构"的判断都会失真；而真正落地时（`f031c5a`）的 21 个文件里，5 个规划的头文件名一个都没用上，`ucm/transport/kv/asu/` 两条目录被整体放弃。划线的收益（沟通）是短的，成本（误导 + 事后还得改一次名）是长的。更好的做法是写一份 20 行的 `README.md` 说明边界，而不是提交 14 个空文件。

反过来说，有一件事我做不出来更早的方案：**v2 的整体重写**。看 `dev-v2`（1 个提交后废弃）→ `feature/v2`（15 个提交）→ `fa84383`（重写后单提交）这条路径，v2 至少做了三遍。如果没有前两遍，第三遍不会在一个提交里同时给出接口、facet、插件加载、Proxy 编排和 153 个用例。这类"重写型抽象"没法用增量方式抵达，这是我读完 commit 史后最反直觉的一个结论。

## 小结

七个阶段，775 次提交，79 位作者，19 个正式/RC 版本，一条主线加九条分支。把这条曲线拉直了看，UCM 的演进有一个很稳定的形状：

**接介质（2025-08）→ 稳目录与接口（2025-09）→ 抽公共层（2025-11）→ 可组合（2026-01）→ 可运营（2026-06）→ 换契约（2026-09）**。

每一次抽象都不是被设计愿景驱动的，是被上一阶段的具体失败推出来的：`35c81a1` 被多人并行逼出来，`319421f` 被介质差异逼出来，`cd4239f` 被实现重复逼出来，`fa84383` 被 `StoreV1` 太胖逼出来。这个项目最值得学的地方不是它的架构，而是它**容许自己被推翻**的频率——三次明确的推翻（`Submit`、broadcast、单例）都发生在被推翻的东西有了替代品之后。

最该警惕的地方也很清楚：适配层的 219 个文件，和 `ucm/store/` 下那两套并排躺了 10 个月的新旧接口。前者是持续失血的成本，后者是持续降低可读性的债。如果 v2 真的合入主线，这两笔债才有可能一起清掉。

至于其他几个维度——Pipeline 内部怎么调度、多 rank 加载怎么保证一致性、缓存并发怎么处理——站内另外几篇讲得更细，我这里只提供时间轴的骨架：[Pipeline Store 的实现](/posts/019-ucm-pipeline-store)、[缓存并发](/posts/020-ucm-cache-concurrency)、[多 rank 加载](/posts/021-ucm-multi-rank-load)、[v2 接口设计](/posts/018-ucm-v2-interface-design)、[混合缓存设计](/posts/ucm-hybrid-cache-design)。

## 参考来源

- 仓库：[ModelEngine-Group/unified-cache-management](https://github.com/ModelEngine-Group/unified-cache-management)（上游，本次未直接访问）
- 本地数据源：bare 镜像 `repo.git`，只读，未做任何 fetch / pull / 改 ref
- 分析分支：`develop`（主线，775 次提交）；辅助分支 `dev-ucm-v2`、`feature/v2`、`feature_a5`、`dev-transport`、`dev-cache-mp-test`、`doc-store-architecture`、`debug-perf-2609`、`dev-v2`
- 版本信息：GitHub Releases API，26 条记录（含 draft 与 nightly），取数日 2026-10-23
- 统计口径：`git rev-list --count`、`git log --shortstat`、`git log --date=format:"%Y-%m"`、`git show --stat`、`git log -S<symbol>`；作者数按提交邮箱去重
- 统计区间：2025-07-10（`f0f9455`）至 2026-10-22（`4e47254`）
- 截止日期：2026-10-23
- 文中所有引用 commit 均在写入前用 `git show --stat` 或 `git log` 现场校验；镜像内无 tag，故版本节点单独取自 Releases API
