---
title: "UCM 的极致性能路线：四条反直觉设计，和它们各自的代价"
description: 把「UCM v1 为极致性能而设计」拆成四条可证伪的假设，逐条用代码验证并追问：省下了什么、代价由谁在付，以及 v2 为什么把删掉的元数据又加了回来。
publishedAt: "2026-10-23"
category: 项目笔记
tags:
  - UCM
  - KV Cache
  - 性能优化
  - 架构设计
draft: false
---

UCM 的 v1 里有一批设计，第一次读会觉得不太合理：共享内存缓存里没有 LRU，淘汰顺序由一根只增不减的游标决定；落盘格式里没有索引文件，一个块在不在，靠目录名和文件名拼出来的路径去 `access()` 一下；缓冲区分配不做 free list，节点号直接就是环形计数器取模。单独看每一条，都像是某种偷懒；四条放在一起，才看得出它们指向同一个目标。

作者对这套设计的归纳是四句话：**Pipeline 配合 layerwise 尽力掩盖读取耗时；定长 IO 加环状内存块保障内存寻址的速度；为此抛弃 LRU 改用 FIFO、再到 CLOCK；无元数据管理，用文件夹名加文件名做哈希索引。** 这篇文章不打算复述这四句话——复述没有信息量。我要做的是把它们当成四条**可证伪的假设**，逐条到代码里找证据，给每条下一个判定（成立 / 部分成立 / 不成立），然后对每条补上同一个问题的答案：**这么做省下的是什么开销，这笔开销被搬到了谁头上。**

三条前置说明。其一，所有代码证据都来自只读的 bare 镜像，旧实现基线是 `dev-cache-mp-test`（分支头 `de517d5`，2026-03-28），v2 契约在 `dev-ucm-v2`（分支头 `fa84383`，2026-10-23），介于两者之间的性能改造在 `debug-perf-2609-mag1c`（分支头 `4223e25`，2026-09-11）；vLLM 侧的接入代码在 `ucm/integration/vllm/ucm_connector.py`，另有一份 vllm-ascend 的源码副本用来对照。其二，片段取自本地源码，行尾的中文注释是我为阅读方便加的，删掉的部分用 `// ...` 标注；凡是引用了函数名、字段名、配置键的地方，都能指回某个文件，**这份镜像里找不到对应实现的，我会直接写"没找到"，不用想象补全。** 其三，本文不引用任何性能倍数。官方设计文档里那些"2–4x""10–15x"属于文档口径，我在 [019 篇](/posts/019-ucm-pipeline-store) 已经逐条核对过它们的出处，这里只把机制本身当作证据。

## 一张表：四个假设的判定

| #   | 假设                                 | 判定                       | 关键证据                                                                                                                                         | 省下的开销                                                      | 代价付在谁身上                                                                   |
| :-- | :----------------------------------- | :------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------- | :------------------------------------------------------------------------------- |
| 1   | Pipeline 配合 layerwise 掩盖读取耗时 | **部分成立**               | `UCMLayerWiseConnector`（`ucm_connector.py`）+ 提交 `fcbb273`；`PipelineStore::Stack` 是组件栈而非时间流水                                       | 下一层的 KV 读延迟藏在上一层的计算后面                          | 首层气泡、提交动作落在临界路径、层数必须等于分片数；store 层 `Prefetch` 是空实现 |
| 2   | 定长 IO + 环状内存块保障寻址速度     | **成立**（且两半互为因果） | `io.offset = shard.index * shardSize_`（`io_engine_aio.h`）；`FetchNode()` 自增取节点、到顶归零（`trans_buffer.cc`）；`CheckConfig` 的整除不变式 | 一次乘法代替一次查表；没有 malloc、没有 free list、没有指针追逐 | 局部性（错杀热块）、隐含要求"容量远大于在途引用"、分片粒度被三层尺寸锁死         |
| 3   | LRU → FIFO → CLOCK 都是为了速度      | **成立**                   | `HotnessSet` 定时批量 `utime`；v1 `BufferMetaNode` 无访问位；`debug-perf` 分支 `accessed_` + 二次机会扫描                                        | 热路径上零链表维护、零跨进程指针、零时钟调用                    | 命中率（FIFO 会赶走刚装好的块）、热度精度退化到定时器周期                        |
| 4   | 无元数据，目录名 + 文件名当哈希      | **成立**（最彻底的一条）   | `DataFileName` / `FileShardName` / `SpaceManager::Lookup`；`.tmp` 后缀 + rename                                                                  | 一份常驻索引、一次查表、"元数据与数据不一致"整类 bug            | 淘汰/统计要全量扫目录；"查不到"与"崩了一半"不可区分；每块一次 open 的租金        |

四条里三条成立，一条部分成立——而且那条部分成立的，恰恰是最容易被归功于"架构"的一条。这是我认为最值得写下来的地方。

## 假设一：Pipeline 配合 layerwise，把读取藏进计算里

### 先拆词：这里的"Pipeline"不是流水线

UCM 的 Store 叫 Pipeline，很容易让人以为它内部有一条时间意义上的流水线：块 A 在压缩时块 B 正在查缓存，块 B 在落盘时块 C 正在压缩。官方文档确实这么描述，但那描述的是**异步任务并发**的观感，不是 Pipeline 这个类做的事。`PipelineStore` 真正做的事只有一件——把组件一层层压栈：

```cpp
// ucm/store/pipeline/cpy/pipeline_store.py.cc
void Stack(const std::string& name, const std::string& path, const py::dict& dict)
{
    Detail::Dictionary config;
    ThrowIfFailed(ConfigParser::Parse(config, dict));
    config.Set<StoreV1*>("store_backend", StoreBack());   // 上一层把下一层当后端
    StoreLoader loader{path, "Make" + name + "Store"};
    ThrowIfFailed(loader.LoadLibrary());
    auto store = loader.CreateObject();
    // ...
}
```

每压一层，就把当前栈顶当作新层的 `store_backend` 塞进配置。于是 `Cache` 层查不到就往 `Compress` 层问，`Compress` 层再问 `Posix`。数据流是**拦截式**的、自顶向下的，层与层之间是"命中就返回，不命中就下传"，没有"上一层在处理块 A、下一层在处理块 B"这种时间重叠。`CacheStore::Lookup` 的实现印证了这点：

```cpp
// ucm/store/cache/cc/buffer_manager.h
Expected<std::vector<uint8_t>> LookupFast(const Detail::BlockId* blocks, size_t num)
{
    // ... 先在 TransBuffer 里逐块 Exist
    Lookup(blocks, num, results, missBlk, missIdx);
    if (missBlk.empty()) { return results; }
    auto res = backend_->Lookup(missBlk.data(), missBlk.size());   // 只有 miss 才下传
    // ...
}
```

所以"Pipeline 掩盖读取耗时"这个说法里，Pipeline 贡献的是**缩短了一次读的路径**（命中就停在共享内存里，不进磁盘），而不是**让另一次读同时进行**。真正的重叠在另一个地方。

### 重叠在 connector 里，而且只有一层深

`ucm/integration/vllm/ucm_connector.py` 里的 `UCMLayerWiseConnector` 把重叠写在了类注释里，这是全仓库最直白的一处自述：

```python
class UCMLayerWiseConnector(UCMDirectConnector):
    """
    This Connector means overlap:
    load l0 -> forward l0 -> save l0
               load l1    -> forward l1 -> save l1
                             load l2    -> forward l2 -> save l2
    """
```

实现机制是 vLLM V1 connector 契约提供的两个钩子：`start_load_kv`（进 forward 之前调一次）和 `wait_for_layer_load(layer_name)`（进每一层 attention 时调）。UCM 的用法很克制——**一次只提交一层**：

```python
def _submit_request_load_tasks_for_layer(self, layer_id, local_row, metadata):
    for request_id, ucm_block_ids, total_ptrs in self.request_data:
        # ...
        shard_indexs = [layer_id] * len(ucm_block_ids)      # 层号就是分片号
        layer_ptrs = total_ptrs[local_row]
        task = self.store.load_data(ucm_block_ids, shard_indexs, layer_ptrs)
        self.load_tasks[layer_id][request_id] = task

def start_load_kv(self, forward_context, **kwargs):
    # ... 收集 request_data
    if self.need_load:
        self._submit_request_load_tasks_for_layer(self.first_layer_id, 0, metadata)

def wait_for_layer_load(self, layer_name: str) -> None:
    current_layer_id = self.layer_name_to_id[layer_name]
    for request_id, task in self.load_tasks.get(current_layer_id, {}).items():
        self.store.wait(task)                                # 等本层读完
    next_layer_id = current_layer_id + 1
    if next_layer_id not in self.layer_ids:
        return
    next_local_row = next_layer_id - self.first_layer_id
    self._submit_request_load_tasks_for_layer(                 # 提交下一层
        next_layer_id, next_local_row, metadata)
```

注意 `shard_indexs = [layer_id] * len(ucm_block_ids)` 这一行：**层号被直接当作 shard 下标**传进 store。这不是随手写的，它和第二个假设是同一套内存布局的两面——一个块的 KV 数据在文件里按"分片 = 层"切开，所以"读第 3 层"就等于"读这个块的第 3 个分片"。这条对应关系让 layerwise 在 store 层不需要任何新概念：它只是把一次大 Load 拆成了 N 次小 Load。

时序上，实际发生的是这样：

```text nocollapse
时间轴 ─────────────────────────────────────────────────────▶

load L0       ████
              └─ wait L0：首层没有可重叠的计算，这段读延迟纯暴露

load L1             ██████████
compute L0          ████████████████████        ← L1 的读与 L0 的计算重叠

load L2                        ██████████
compute L1                     ████████████████████

                                       ...
                                       └─ wait LN 之后直接 return（不提交 L(N+1)）
                                          wait_for_save 阻塞，等所有 dump 写完
```

### 这条假设的边界在哪

判定"部分成立"的四条理由，都能在代码里指出来。

**第一，首层没有东西可以重叠。** `start_load_kv` 提交 L0 之后，模型进第 0 层立刻 `wait` 它——这段读延迟是纯暴露的。流水线的填充时间（fill）等于一层的读耗时，排空时间（drain）等于最后几层的写耗时，这两段拿不回来。

**第二，"提交下一层"发生在 `wait` 之后，站在临界路径上。** 上面那段代码的顺序是：等完 L0 → 才提交 L1。也就是说，L1 的读只能和 L0 的**计算**重叠，不能和 L0 的**读**重叠。要再深一层流水（预取到 L(i+2)），就得把这个提交挪到 `wait` 之前，代码里没有这么做。

**第三，这个优化是配置开关，而且有后端直接不支持。** `use_layerwise` 是 `kv_connector_extra_config` 里的一项，`UCMDirectConnector` 在开启 pipeline parallel 时反过来强制要求它（`"Pipeline parallelism is not supported in UCMDirectConnector, please set use_layerwise=True."`）；而测试套件里对 NFS 后端是显式跳过的（`Skipping: UcmNfsStore does NOT support use_layerwise=True`）。换句话说，重叠能力绑在"块在本地盘上按层可切分"这个前提上。

**第四，也是我最想强调的一点：store 层的 `Prefetch` 接口是空的。** `StoreV1` 里它被郑重声明为"非阻塞、fire-and-forget、实现可以忽略"，注释写着 `Default implementation does nothing`。而实际上：

```cpp
// ucm/store/posix/cc/posix_store.cc
void Prefetch(const Detail::BlockId* blocks, size_t num) override {}
// ucm/store/cache/cc/cache_store.cc 同样是空实现，Ds3fsStore 亦然
```

我在这份镜像里**没找到**任何 store 层真正执行预取的实现。所以"Pipeline 配合 layerwise 掩盖读取耗时"更准确的说法是：**接口为预取留了位置，但预取是上层做的；Pipeline 自己掩盖不了任何读取耗时。**

### 提交 `fcbb273`：一次"太贪心反而破坏重叠"的修复

这条假设的历史证据特别干净。2026-03-28 的提交 `fcbb273`，标题就是 `[fix]Submit layerwise KV load tasks one layer at a time (#783)`，提交信息写着：

> UCMLayerwise connector previously submitted async KV load tasks for every layer inside start_load_kv. In some cases, it may interrupt the intended load → forward → load-next overlap.

旧实现是在 `start_load_kv` 里一个 `for layer_name in self.kv_caches` 循环，把**所有层**的读任务一次性全提交；新实现改成只提交首层、在 `wait_for_layer_load` 里滚动提交下一层，同时把 `load_tasks` 从 `{request_id: {layer_name: Task}}` 翻成 `{layer_name: {request_id: Task}}` 以便按层查，并给 `extract_block_addrs` 加了 `layer_first` 参数来匹配内存布局。

这个修复本身就是对"性能假设"的一次校准：**把所有读一次性放出去，看起来更激进、更能重叠，实际上把"读"从"计算后面"挪到了"计算前面"，反而堵住了流水。** 重叠是按层对齐的，不是按总量对齐的。

至于这条假设省下的东西：一层 KV 的读耗时（对远端或慢盘后端尤其明显），代价是首层的气泡和末尾 `wait_for_save` 的收尾——快路径的收益集中在中间那几十层。

## 假设二：定长 IO 加环状内存块，寻址全靠乘法

这条的判定最干脆：**成立**。而且它的两半不是并列关系，是因果链——定长 IO 逼出了环状内存块。

### 定长是先被"约束"出来的，不是被"设计"出来的

`PosixStore` 的配置校验里有一段很扎眼的整除检查：

```cpp
// ucm/store/posix/cc/posix_store.cc（CheckConfig）
if (config.tensorSize == 0 || config.shardSize < config.tensorSize ||
    config.blockSize < config.shardSize || config.shardSize % config.tensorSize != 0 ||
    config.blockSize % config.shardSize != 0) {
    return Status::InvalidParam("invalid size({},{},{})", config.tensorSize,
                                config.shardSize, config.blockSize);
}
```

三层尺寸必须严格整除：`tensor_size | shard_size | block_size`。`CacheStore` 那边有一份同样精神的检查（`tensorSizes` 之和必须等于 `shardSize`，`blockSize` 必须被 `shardSize` 整除）。这条不变式一旦成立，**偏移量就变成了乘法**：

```text nocollapse
一个块 = 一个文件（定长 block_size）
┌──────────────┬──────────────┬─────┬────────────────┐
│  shard 0     │  shard 1     │ ... │  shard n-1     │   n = block_size / shard_size
│  (= layer 0) │  (= layer 1) │     │  (= layer n-1) │
└──────────────┴──────────────┴─────┴────────────────┘
  offset = shard_index × shard_size          length = shard_size
```

读写在两个 IO 引擎里都是这两行：

```cpp
// ucm/store/posix/cc/io_engine_aio.h（OnOpenCallback<dump>）
AioImpl::Io io;
io.fd = result.fd;
io.offset = shard.index * shardSize_;
io.length = shardSize_;
io.buffer = shard.addrs.front();
```

```cpp
// ucm/store/posix/cc/trans_queue.cc（psync 路径的 S2H / H2S）
auto offset = shardSize_ * ios.shard.index;
for (const auto& addr : ios.shard.addrs) {
    s = file.Read(addr, ioSize_, offset);
    // ...
    offset += ioSize_;
}
```

省下的是什么？**一次索引查表，以及索引本身的容量开销。** 变长记录的文件里，想读第 k 片必须先知道前 k−1 片的长度——要么维护一张偏移表（每块多一份元数据），要么顺序扫过去。定长把这件事降成一次整数乘法，而且这个乘法在编译期就能被强度削减掉。分片数 `nShardPerBlock_ = config.blockSize / config.shardSize` 也是同一个常数（`io_engine_aio.h`、`trans_queue.cc`、`ds3fs/trans_queue.cc` 三处都是这么算的），连计数都不需要维护。

还有一个细节值得单独说：AIO 引擎的打开标志是**无条件**带 `O_DIRECT` 的（`const auto flags = O_DIRECT | (dump ? (O_CREAT | O_WRONLY) : O_RDONLY);`），psync 引擎则在配置里 `ioDirect` 为真时才加。`O_DIRECT` 要求缓冲区地址与长度都按设备扇区/页对齐——**这就是"定长"和"环状内存块"之间的那根钉子**：既然每次 IO 的长度恒为 `shardSize`，那么把缓冲区切成 `shardSize` 大小的节点，每个节点天然对齐一次 IO。

### 环状内存块：节点号就是地址

`TransBuffer` 的分配路径就这两个函数：

```cpp
// ucm/store/cache/cc/trans_buffer.cc（LocalBufferStrategy）
struct BufferHeader {
    size_t buckets[nHashTableBucket];   // 哈希桶首节点，nHashTableBucket = 16411
    size_t freeHead;
    size_t nodeSize;
    size_t nNode;
};

size_t FetchNode() override
{
    auto head = header_.freeHead++;
    if (header_.freeHead == header_.nNode) { header_.freeHead = 0; }   // 回绕
    return head;
}
void* DataAt(size_t iNode) override
{
    return ((std::byte*)data_.get()) + header_.nodeSize * iNode;       // 下标即偏移
}
```

没有 free list，没有 best-fit，没有碎片整理。`freeHead` 自增、到顶归零，取到的下标就是地址。共享内存版本（`SharedBufferStrategy`）逻辑一模一样，只是把 `freeHead++` 包进了 `header_->lock`——因为它是跨进程共享的。

更关键的是，环游标**顺便就是淘汰策略**：`Alloc` 拿到节点后发现它还被引用（`reference > 0`）就丢掉、继续往后取下一个，取到一个 `reference == 0` 的节点就占用它、覆盖旧内容：

```cpp
// ucm/store/cache/cc/trans_buffer.cc
size_t TransBuffer::Alloc(const Detail::BlockId& blockId, size_t shardIdx, size_t iBucket)
{
    for (;;) {
        auto iNode = strategy_->FetchNode();
        auto meta = strategy_->MetaAt(iNode);
        strategy_->NodeLock(iNode);
        if (meta->reference > 0) {           // 被钉住就跳过
            strategy_->NodeUnlock(iNode);
            continue;
        }
        // ... 从旧桶摘除、挂到新桶、填 block/shard/ready
        return iNode;
    }
}
```

环形位置即"年龄"：游标从 0 走到 `nNode` 再回到 0，最早被占用的节点必然最先被再次到达。**FIFO 不需要实现，它是环形结构的副产品。** 这就是第三个假设的前半段。

顺带解释一个配置项：`CacheStore::Config::bufferCapacity` 默认值是 `256ULL << 30`（256 GiB），`nNode = bufferCapacity / shardSize`，节点大小取的就是 `config.shardSize`。所以"一个节点 = 一个块的一层 KV"，和 layerwise 的一次读恰好一一对应。定长、环、layerwise 三者在这里咬合成一个整体。

### 代价：局部性、隐含前提、被锁死的粒度

**第一，局部性彻底让位给位置。** 环形覆盖是纯粹按位置淘汰，不看热度。一个刚被读了三次的热块，只要它在环上的位置老，照样被覆盖。这在 021 篇里有个具体的名字——"环形淘汰把刚装好的格子赶走"，那是多 rank 场景下最先暴露的瓶颈。

**第二，这份 `Alloc` 没有"全被钉住"的出口。** `for (;;)` 里唯一的进展条件是撞上一个 `reference == 0` 的节点。如果所有节点的引用都不为零，它会一直转下去——没有退避、没有报错、没有超时。代码里没有这个分支，说明设计上默认"节点数远大于在途引用数"。这是一个**隐含前提**而不是一条被检查的断言；容量配小了，症状不会是错误码，而是挂在 `Alloc` 里。

**第三，分片粒度被三层尺寸同时锁死。** `shard_size` 一旦定下，同时决定了：文件 IO 的长度（吞吐/延迟的粒度）、缓冲区节点的大小（内存放大率）、以及 `nShardPerBlock`（layerwise 的流水深度必须等于它，因为层号直接当 shard 下标用）。想给 IO 更大的块，就会让 layerwise 的一层读得更久；想给 layerwise 更细的粒度，就得付更多次 open/syscall。三个目标共用一个旋钮，这是"定长"最实在的代价。

## 假设三：LRU → FIFO → CLOCK，三次降级都是为了速度

这条假设**成立**，但过程不是一次跳跃，而是**三次降级**，每次降级的动机都能从代码里读出来。而且第一次降级发生在一个很容易被忽略的地方：文件后端的"LRU"根本不在内存里。

### 第一级：用文件系统的时间戳当 LRU 链表（nfsstore）

`nfsstore` 命中一个块的时候，做的是这件事：

```cpp
// ucm/store/nfsstore/cc/api/nfsstore.cc
bool Lookup(const std::string& block) override
{
    auto found = this->spaceMgr_.LookupBlock(block);
    if (found) { this->hotnessMgr_.Visit(block); }     // 记一次"访问"
    return found;
}
```

`Visit` 并不维护任何"最近使用"的有序结构，它只是把 blockId 塞进一个带锁的 `std::unordered_set`：

```cpp
// ucm/store/nfsstore/cc/domain/hotness/hotness_manager.h
void Visit(const std::string& blockId)
{
    this->hotnessSet_.Insert(blockId);
    auto old = this->serviceRunning_.load(std::memory_order_acquire);
    if (old) { return; }
    if (this->serviceRunning_.compare_exchange_weak(old, true, std::memory_order_acq_rel)) {
        auto updater = std::bind(&HotnessSet::UpdateHotness, &this->hotnessSet_, this->layout_);
        // ... 起一个定时器线程
    }
}
```

真正的"刷新热度"在一个定时线程里批量做，落到文件系统上一个 `utime()` 调用：

```cpp
// ucm/store/nfsstore/cc/domain/hotness/hotness_set.cc
for (const std::string& blockId : blocksToUpdate) {
    auto blockPath = spaceLayout->DataFilePath(blockId, false);
    auto file = File::Make(blockPath);
    // ...
    auto status = file->UpdateTime();     // → utime(path, nullptr)
}
```

`UpdateTime` 的实现就是 `utime(this->Path().c_str(), nullptr)`，把 atime/mtime 一起刷成"现在"。淘汰时再把这些时间戳读回来，用一个小顶堆取最老的一批：

```cpp
// ucm/store/nfsstore/cc/domain/space/space_recycle.cc
size_t GetFileTimestamp(const std::string& path) {
    IFile::FileStat st;
    if (File::Stat(path, st).Failure()) { return 0; }
    return st.st_mtim.tv_sec;
}
// ...
auto it = layout->CreateFilePathIterator();
while (it) {
    auto filePath = layout->NextDataFilePath(it);
    if (filePath.empty()) { break; }
    auto timestamp = GetFileTimestamp(filePath);
    if (timestamp == 0) { continue; }
    earliestHeap->Push({filePath, timestamp});
}
```

这就是一个**摊销到文件系统元数据里的近似 LRU**：热路径上只做一次哈希集合插入（一次锁 + 一次 insert），零链表维护、零跨进程指针；重活交给定时线程和 `stat`。代价也明确——热度精度等于定时器周期（`hotnessInterval` 默认 **60** 秒），60 秒内的两次访问和一次访问在淘汰看来没有区别；而淘汰本身要**遍历整个目录树并逐文件 `stat`**，复杂度是 O(容量)。

顺带说，`pcstore` 用 `st_mtime`、`nfsstore` 用 `st_atime` 判"块是否还在活跃"——同一个技巧：把状态寄存在文件系统的元数据里。这一点到第四个假设会变成主线。

### 第二级：共享内存里连"最近使用"这个词都不存在（v1 TransBuffer）

到了内存缓存，v1 的节点元数据一共七个字段：

```cpp
// ucm/store/cache/cc/trans_buffer.cc
struct BufferMetaNode {
    Detail::BlockId block;
    size_t shard;
    size_t reference;   // 引用计数
    size_t hash;        // 所在桶（invalidIndex = 未挂载）
    size_t prev;
    size_t next;
    bool ready;
};
```

`block`/`shard` 是键，`reference` 是防覆盖，`hash`/`prev`/`next` 是桶内双向链表的钩子，`ready` 是"数据填好了"。**没有一个字段和"热度"有关：没有访问时间、没有访问计数、没有 LRU 位、没有时钟指针。** 我在 `dev-cache-mp-test` 的 `trans_buffer.{h,cc}` 里 grep 不到 `accessed`，也找不到任何记录访问顺序的字段——这个"没有"本身就是证据。

为什么内存缓存里连近似都不做？把 LRU 做进跨进程共享内存，账是这么算的：

| 做法                        | 读路径上的代价                                                                  |
| :-------------------------- | :------------------------------------------------------------------------------ |
| 双向链表 + splice 到头      | 每次命中都要**写**两个邻居的 `next/prev` 和自身 → 跨进程共享页 → 缓存行互相失效 |
| 存时间戳（`clock_gettime`） | 每次命中一次时钟系统调用（或 vDSO），再加一次共享内存写                         |
| 存访问计数 + 后台扫描       | 每次命中一次原子自增，只解决 LFU 不解决 LRU；仍需定期扫描                       |

三条路都要在**命中路径**上写共享状态。而这条路径的设计目标恰恰是"命中就返回"——`TransBuffer::Get` 拿锁、`FindAt` 走桶链、`++reference`、解锁，能省的全省了。于是选择是：**不记录访问，让环形游标决定生死。** FIFO 是"没有策略"的策略，它的全部实现代价为零。

代价转移到命中率上：FIFO 会赶走刚被用过但位置老的块（这正是 021 篇里"环形淘汰把刚装好的格子赶走"的含义），也会保留位置新但再也不用的块。在"一次请求的块基本连续使用、容量远大于工作集"的假设下，这个损失可以忽略；一旦多 rank 共享把有效容量压下来，它就开始变成主要瓶颈。

### 第三级：CLOCK——用一位访问位买回一半 LRU

`debug-perf-2609-mag1c` 分支上出现了一个中间态：`freeHead` 改名 `nodeCursor`，旁边多了一个 `accessed_` 位图，`FetchNode` 从"取下一个"变成"扫两圈找没被访问过的"：

```cpp
// debug-perf-2609-mag1c: ucm/store/cache/cc/trans_buffer.cc
size_t FetchNode(bool allowReserved) override
{
    const auto total = header_.nNode - (allowReserved ? 0 : base_.reservedNumber);
    for (size_t i = 0; i < 2 * total; ++i) {
        auto cur = header_.nodeCursor++ % total;
        uint8_t expected = 1;
        if (accessed_[cur].compare_exchange_strong(expected, 0, std::memory_order_relaxed,
                                                   std::memory_order_relaxed)) {
            continue;      // 访问过 → 清位，给第二次机会
        }
        return cur;        // 没访问过 → 就你了
    }
    return header_.nodeCursor++ % total;   // 两圈都没找到 → 强制推进
}
void MarkAccessed(size_t iNode) override { accessed_[iNode].store(1, std::memory_order_relaxed); }
```

这就是教科书上的二次机会（second chance）/ CLOCK：**一位访问位换掉一条有序链表。** 语义上接近 LRU——刚访问过的块会被跳过一轮；成本上只有一次 `compare_exchange_strong`（失败就直接 `continue`，不需要写回），淘汰路径被限定在 `2 × total` 次探测内，最坏情况退化成 FIFO。

但请注意 `MarkAccessed`：读路径上仍然要写一次（共享模式下这一位就住在共享内存里）。这是 CLOCK 相对 FIFO 的"税收"，也是它继续演化的动力——按 rank 拆开、每个 rank 一根自己的手，才有了 021 篇讲的 `clockHands[rank]` 和无锁读路径。到这里可以看出一条清晰的轨迹：

| 代            | 数据结构                    | 读路径写共享内存？         | 淘汰质量                | 出处                                         |
| :------------ | :-------------------------- | :------------------------- | :---------------------- | :------------------------------------------- |
| 文件后端"LRU" | 文件系统 mtime + 全目录堆   | 否（异步 `utime`）         | 周期性近似              | `nfsstore/hotness_*`                         |
| v1 内存缓存   | 环游标，无访问信息          | **否**                     | 纯 FIFO                 | `trans_buffer.cc`（`dev-cache-mp-test`）     |
| 中间态        | 环游标 + 一位访问位         | 是（`accessed_.store(1)`） | CLOCK 近似 LRU          | `trans_buffer.cc`（`debug-perf-2609-mag1c`） |
| v2            | 每 rank 槽位段 + 可插拔策略 | 取决于策略                 | LRU / CLOCK / FIFO 可选 | `ucm/v2/store/cache/policy/*`                |

**三次降级的次序都是"先去掉信息，再加回最便宜的那一位"。** 这条假设的判定是"成立"，但要补一句：真正省的不是"某种淘汰算法"，而是**读路径上的写**。谁能少写一次共享状态，谁就赢。

## 假设四：没有元数据，路径就是索引

最后一条是最彻底的，判定**成立**，而且我认为它是整套设计的"地基"——前三条都在某个局部省开销，这一条把整个索引都删掉了。

### 文件名就是把哈希摊开写在磁盘上

`BlockId` 是 16 字节（`std::array<std::byte, 16>`，内容哈希），`DataFileName` 把它逐字节格式化成 32 个十六进制字符：

```cpp
// ucm/store/posix/cc/space_layout.cc
static const std::string DATA_ROOT = "data";
static const std::string ACTIVATED_FILE_EXTENSION = ".tmp";

inline std::string DataFileName(const Detail::BlockId& blockId)
{
    return fmt::format("{:02x}", fmt::join(blockId, ""));
}

std::string SpaceLayout::DataFilePath(const Detail::BlockId& blockId, bool activated) const
{
    const auto& backend = StorageBackend(blockId);
    const auto& file = DataFileName(blockId);
    const auto& shard = dataDirShard_ ? FileShardName(file) : DATA_ROOT;   // 取前 N 个 hex 字符
    if (!activated) { return fmt::format("{}{}/{}", backend, shard, file); }
    return fmt::format("{}{}/{}{}", backend, shard, file, ACTIVATED_FILE_EXTENSION);
}
```

`FileShardName(fileName)` 就是 `fileName.substr(0, dataDirShardBytes_)`——**取哈希的前 N 个十六进制字符当目录名**。配置项 `dataDirShardBytes` 默认 3，也就是 16³ = 4096 个分片目录，启动时用 `GenerateHexStrings(3)` 把 4096 个目录一次建好；上限是 5（`dataDirShardBytes > 5` 直接 `InvalidParam`，4096 → 约 100 万）。多后端时再用 `BlockIdHasher` 对后端数取模选盘。

同一套思路在另外两个后端上换了个切法，反而更贴合作者那句"文件夹名 + 文件名"：`nfsstore` 把 16 字节 id 拆成前后两个 `uint64_t`，**前半当目录、后半当文件名**：

```cpp
// ucm/store/nfsstore/cc/domain/space/space_shard_layout.cc
std::string SpaceShardLayout::DataFilePath(const std::string& blockId, bool activated) const
{
    uint64_t front, back;
    this->ShardBlockId(blockId, front, back);
    return fmt::format("{}{}/{:016x}/{:016x}.{}", this->StorageBackend(blockId),
                       this->DataFileRoot(), front, back,
                       activated ? activatedFileSuffix : archivedFileSuffix);   // "act" / "dat"
}
```

而 `pcstore` 干脆把"是否提交"编码成**父目录**：写入中的块在 `.temp/` 下，归档后的块在 `data/<hash[0:8]>/` 下，`Commit` 就是一次跨目录 `rename`：

```cpp
// ucm/store/pcstore/cc/domain/space/space_layout.cc
std::string SpaceLayout::DataParentName(const std::string& blockFile, bool activated) const
{
    if (activated) { return TempFileRoot(); }            // ".temp"
    if (!shardDataDir_) { return DataFileRoot(); }       // "data"
    return blockFile.substr(0, 8);                       // 哈希前 8 个 hex 字符
}
```

三个后端，三种切法，同一个原则：**键、值、状态全部编码在路径字符串里，不需要任何旁路文件。**

于是"块在哪"这个问题不再需要查表，它就是一个纯函数：

```text nocollapse
BlockId（16 字节内容哈希）
        │
        ├─ 前 3 个 hex 字符 ──▶ 目录名      <backend>/a7f/
        └─ 全部 32 个 hex 字符 ─▶ 文件名     <backend>/a7f/a7f3c1...e9
                                            （写入中则同名 + .tmp 后缀）

Lookup(blockId)  ==  access("<backend>/<hash[0:3]>/<hash>")
```

`SpaceManager::Lookup` 的实现就是这句话的直译：

```cpp
// ucm/store/posix/cc/space_manager.cc
uint8_t SpaceManager::Lookup(const Detail::BlockId* block)
{
    const auto& path = layout_.DataFilePath(*block, false);
    PosixFile file{path};
    constexpr auto mode =
        PosixFile::AccessMode::EXIST | PosixFile::AccessMode::READ | PosixFile::AccessMode::WRITE;
    auto s = file.Access(mode);
    if (s.Failure()) {
        if (s != Status::NotFound()) { UC_ERROR("Failed({}) to access file({}).", s, path); }
        return false;
    }
    return true;
}
```

注意 `PosixFile::Access`——它底下就是一次 `access(2)` 系统调用（`ENOENT` 直接映射成 `Status::NotFound()`）。**索引就是文件系统本身，查询就是问内核"这个路径存在吗"。**

还不止是键，连**状态**都存在路径里：写入中的块用 `.tmp` 后缀（`ACTIVATED_FILE_EXTENSION`），写完 `CommitFile` 用 `rename()` 改成无后缀，落盘成功才可见；失败则 `Remove()`。`nfsstore` 换成 `.act` / `.dat` 后缀，`pcstore` 换成 `.temp/` 父目录——编码方式不同，思路一致。块文件的可见性因此获得原子性，而这个原子性**不需要任何日志或元数据来保证**——它由 `rename(2)` 的原子语义提供。

再补一个细节：`CommitFile` 只在最后一个分片写完后调用（AIO 引擎里是 `OnIoCallback` 的 `if (last)`，`last = shard.index + 1 == nShardPerBlock_`；psync 引擎里是 `DumpWorker` 的同一个判断）。所以 layerwise 顺带钉死了一个语义：**一个块的 N 层全部写完，它才算存在。**

### 省下了什么

一份常驻索引的账大概是这样：每块 16 字节 id + 8 字节偏移（如果变长）+ 若干状态位，乘以容量。容量上到百万块，这就是几十 MB 级别的常驻结构，还要保鲜、要并发、要防丢。删掉它换来三样东西：

1. **零常驻元数据**：进程重启不需要加载/校验索引，冷启动就是 `mkdir` 4096 个目录。
2. **零查表**：`Lookup` 从"哈希表查找 + 返回偏移"变成"拼字符串 + 一次系统调用"。注意这里并没有省掉"计算哈希"——`BlockId` 本身就是哈希，路径是它的**无损展开**，不是二次编码。
3. **整类 bug 直接消失**：不会出现"索引说在、文件不在"或"文件在、索引不在"的不一致，也不需要崩溃恢复重放。

### 代价：全量扫描、不可区分、系统调用租金

**第一，淘汰和统计必须全量扫描。** 没有索引就没法按热度排序，只能遍历——前面贴过的 `DoRecycle` 就是"遍历整个目录树 + 逐文件 `stat` + 小顶堆取最老的 N 个"。`recyclePercent = 0.1f`（回收 10%）、`maxRecycleNum = 10240`（单次最多扫/删这么多个），这两个常量暴露出它是**批处理式**回收：成本 O(容量)，靠"一次多删点"摊薄。`nfsstore` 的 `SpaceShardLayout::DataIterator` 还要用 `opendir`/`readdir64` 递归走子目录、跳过 `.act` 临时文件，代码量不小。

**第二，"查不到"和"崩了一半"不可区分。** 因为"完成"这件事只表达为一次 `rename`，任何中断都表现为"文件不存在"——读者看到的就是 miss。这在缓存语义下是可接受的（miss 就重算），但也就意味着**没有"块损坏"这个概念可以表达**：错误与不存在被压成了同一个返回值 `false`。

**第三，每块一次 `open` 的租金。** 定长让单次 IO 很便宜，但寻址本身是一次路径解析 + 一次 `access(2)`，实际读还要一次 `open`。`PosixStore` 为此专门配了三档并发：`lookupConcurrency`（默认 16）、`openConcurrency`（32）、`commitConcurrency`（4），并且把 `open` 从 IO 线程里拆出去交给独立的 worker 池（`BlockOperator` 里的 `OpenWorkerLoop`/`CommitWorkerLoop` 两条队列）。**这些并发参数就是"无元数据"的账单**：既然每次查询都是一次系统调用，那就只能靠并行度把 syscall 摊平。

**第四，前缀查询被迫并行化。** `LookupOnPrefix` 要返回"最长命中前缀"，串行查就是 O(n) 次系统调用。实现是把它切成 `nWorker` 段、跨步分配、用 `Latch` 汇合、用 `atomic<ssize_t> firstFail` 做 CAS 收敛：

```cpp
// ucm/store/posix/cc/space_manager.cc
for (size_t begin = 0; begin < nWorker; begin++) {
    prefixLookupSrv_.Push({blocks, begin, num, nWorker, firstFail, status, waiter});
}
waiter->Wait();
auto s = status->load();
// ...
return firstFail->load() - 1;
```

这段代码之所以必须存在，纯粹是因为"存在性"只能一个个问。有索引的话，前缀查询只是对一张有序表做二分。

**第五，局部性交给哈希。** 目录分片是哈希前 12 位，这意味着相邻的块（前缀相邻、几乎同时写入）会散到 4096 个不同目录里。对 SSD 无所谓，对机械盘/远端文件系统就是随机 IO。这也解释了为什么需要有 `dataDirShardBytes` 这个旋钮：0（不分片，全平铺，目录项爆炸）到 5（100 万目录，元数据开销大）之间要按实际文件系统调；默认 3 是"目录项别太多、层级别太深"的折中。

把这一节的账合成一句话：**无元数据设计把索引外包给了文件系统，代价是把"内存里一次哈希查找"换成"一次系统调用 + 一份别人替你维护的索引"。** 这在单机、本地盘、块不可变的场景下是稳赚的；换到网络文件系统或者需要 TTL/pin 的场景，利息就高起来了——而这正是 v2 的起点。

## 反例与转向：v2 把删掉的东西一件件加回来

如果前四条只是"古人很聪明"的复述，这篇文章就没必要写。真正有意思的是：**同一条性能路线，在 v2 里被自己推翻了。** 不是推翻结论，而是推翻"这些省略可以一直省下去"这个前提。

### 反例一：槽位元数据回来了，而且是一整套

v1 的一个节点是 7 个字段的 `BufferMetaNode`。v2 的 `ReplacementPolicy` 基类里，光"槽位状态"就有三份并行数组：

```cpp
// dev-ucm-v2: ucm/v2/store/cache/policy/replacement_policy.h
std::size_t capacity_{0};
/** Head of the intrusive free list; kNone when the pool has no free slot. */
std::size_t freeHead_{kNone};
/**
 * Dual-purpose state per slot: kNone when occupied (reserved or
 * committed), a self-link when free at the tail of the free list,
 * otherwise the next free slot.
 */
std::vector<std::size_t> nextFree_;
/** Per-slot reservation flag: 1 between AcquireSlot() and CommitSlot()/AbortSlot(). */
std::vector<std::uint8_t> reserved_;
std::vector<std::size_t> pinCounts_;
```

`CacheBuffer` 再加一层业务元数据：

```cpp
// dev-ucm-v2: ucm/v2/store/cache/cache_buffer.h
std::size_t capacity_{0};
std::unique_ptr<ReplacementPolicy> policy_;
std::unordered_map<BlockId, CommittedEntry> committed_;
std::unordered_map<BlockId, PendingEntry> pending_;
std::vector<BlockId> occupants_;          // 槽位 → 块的反向映射
std::size_t reservedSlots_{0};
std::vector<DeadlineEntry> expiryHeap_;   // TTL 小顶堆
std::vector<DeadlineEntry> deferredExpiry_;  // 过期但被 pin，暂存
```

对照一下就很清楚：v1 是"环游标 + 7 字段节点"，v2 是"空闲链 + 预留位 + 钉住计数 + 两张表 + 反向映射 + 两个过期数组"。槽位从"一个下标"变成了一个**三状态机**（FREE → RESERVED → COMMITTED，见 `replacement_policy.h` 的类注释），每一次状态迁移都要被校验：

```cpp
Status CommitSlot(std::size_t slot)
{
    if (!IsSlotReserved(slot)) { return Status::InvalidParam("slot {} is not reserved", slot); }
    reserved_[slot] = 0;
    OnSlotAdmitted(slot);
    return Status::Ok();
}
```

v1 的 `Alloc` 没有这些。它拿了节点就用，没有"预留"，没有"提交"，没有"失败回滚"——因为它的语义里根本不允许失败。

### 反例二：两阶段准入与回滚日志

v2 的 `Reserve` 被拆成两段，注释写得比任何文档都清楚：

```cpp
/**
 * @brief Phase 1 of Reserve(): settles every already-known block --
 *        pending ones join their reservation, committed ones open a
 *        re-admission -- before any newcomer is placed, so batch
 *        members can never be displaced by their own batch.
 */
void SettleKnownBlocks(const std::vector<BlockId>& blockIds, const RequestContext& context,
                       ReserveBatch& batch);

/**
 * @brief Phase 2 of Reserve(): reserves a slot for one new block --
 *        expired blocks are swept before the eviction discipline is
 *        consulted once the pool is full, and a displaced victim is
 *        journaled for rollback.
 */
Expected<std::size_t> PlaceNewcomer(const BlockId& blockId, const RequestContext& context,
                                    ReserveBatch& batch, TimePoint now);
```

"批成员不会被自己的批次逐出""先扫过期、再咨询淘汰纪律""被逐出的受害者进日志以便原位恢复"——这三条要求，每一条都需要 v1 刻意省掉的那种元数据。`Rollback` 里那句 `policy_->CommitSlot(it->slot)` 把受害者的槽位原地提交回去、截止时间原样恢复，靠的就是批量写还没开始，"槽里还是旧数据"。**这种精细度在"路径即索引"的世界里无法表达。**

### 反例三：淘汰策略变成可配置的三选一

v2 把淘汰纪律抽成 `ReplacementPolicy`，用编译期注册表按字符串名注册：

| 策略    | 数据结构                  | 准入时       | `Touch()` 时    | 选受害者                            | 出处                     |
| :------ | :------------------------ | :----------- | :-------------- | :---------------------------------- | :----------------------- |
| `lru`   | `std::list` + 迭代器 map  | `push_front` | `splice` 到表头 | 从表尾起第一个未 pin                | `policy/lru_policy.cc`   |
| `clock` | 环形手 + `referenced_` 位 | 置位         | 置位            | 手扫 `2 × capacity`，清位给二次机会 | `policy/clock_policy.cc` |
| `fifo`  | 队列 + 迭代器向量         | 尾入         | **空实现**      | 队首起第一个未 pin                  | `policy/fifo_policy.cc`  |

三个类都用同一行宏注册：`UC_STORE_REGISTER_REPLACEMENT_POLICY(FifoPolicy, "fifo")`。CLOCK 的核心就是这个循环，和前面那份中间态几乎同构，只是把"环游标"换成了"策略自己的手"：

```cpp
// dev-ucm-v2: ucm/v2/store/cache/policy/clock_policy.cc
std::optional<std::size_t> SelectVictimSlot() override
{
    for (std::size_t i = 0; i < 2 * capacity_; i++) {
        const std::size_t slot = hand_;
        hand_ = (hand_ + 1) % capacity_;
        if (!IsSlotCommitted(slot) || IsSlotPinned(slot)) { continue; }
        if (referenced_[slot]) {
            referenced_[slot] = 0;
            continue;
        }
        return slot;
    }
    return std::nullopt;      // 两圈都没有候选：报 NoSpace，而不是强行返回
}
```

请注意和中间态的差别：那一版在"两圈没找到"时返回 `nodeCursor++ % total`（**强行推进，覆盖别人**），v2 返回 `std::nullopt`（**放弃，把决定权交回上层**）。几行代码的差别，背后是两种哲学：前者认为"缓存可以随时丢数据"，后者认为"丢数据是要经过准入规则的"。

这里必须做一次事实校准：**这个镜像里，策略名的选择还没有接到存储层配置上。** `dev-ucm-v2` 的 `CacheStore::Setup` 仍然是 `return Status::Unsupported("CacheStore::Setup is not implemented")`，也就是说 `"policy": "lru"` 这类配置参数目前是接口口径；真正跑通"按名字选策略"的地方是测试（`ReplacementPolicyRegistry::Instance().Create(name)`）。[018 篇](/posts/018-ucm-v2-interface-design) 里那张配置示例表描述的是设计意图，不是已落地的解析代码——这一点我核过分支，如实标出来。

### 为什么当年能省、现在不能省

把三件被加回来的东西放在一起看，会发现它们共享同一个前提。v1 的省略之所以成立，靠的是一组**没有被写进代码的假设**：

| 被省掉的东西               | v1 成立的前提                                            | 什么时候失效                                                              |
| :------------------------- | :------------------------------------------------------- | :------------------------------------------------------------------------ |
| 无 recency（纯 FIFO）      | 缓存容量远超工作集；块的生命周期≈请求生命周期            | 多 rank 共享同一份缓存，有效容量被摊薄；块跨请求复用 → 错杀可测量         |
| 无槽位状态（即取即用）     | 分配不失败；一次 Load 的块数远小于槽位总数；没有并发准入 | 需要 load-exclusive 保留区、需要多 rank 分区、需要批量原子准入 → 三状态机 |
| 无 TTL / 无 pin / 无重纳入 | 块只有"有/无"两态，写失败就丢弃                          | 需要过期语义、需要"在途重写期间不被淘汰"、需要批次失败回滚 → 完整元数据   |
| 无索引（路径即索引）       | 单机、本地文件系统、块不可变、无 TTL                     | TTL/引用计数/批次日志装不进文件名；跨节点共享需要集中视图                 |

这张表也可以反过来读：**v1 把复杂度外包给了四个外部系统**——文件系统（索引与原子性）、配置里的整除约束（定长）、环形结构（淘汰顺序）、以及"不做"（准入、TTL、pin 的语义）。四种外包里，前三种非常成功（它们至今还在 v2 的 Posix 层里），第四种是欠账：省掉的是**语义**，不是**开销**，所以迟早要还。

而 v2 加回元数据的方式也很值得注意：它没有丢掉"快"。每 rank 独立槽位段、每 rank 一根 CLOCK 手、`accessed` 用 `std::atomic<uint8_t>` 且以 `static_assert(std::atomic<uint8_t>::is_always_lock_free, "accessed/ready must be lock-free")` 把"必须无锁"钉成编译期约束——**加回语义的同时，用结构调整（分片、分 rank）把新增的开销从热路径上挪开。** 这不是"退回 v1 之前"，而是把 v1 省掉的语义，用不违反 v1 性能纪律的方式重新长出来。这条演进线在 [020 篇](/posts/020-ucm-cache-concurrency) 和 [021 篇](/posts/021-ucm-multi-rank-load) 里有更细的并发与多 rank 视角。

## 小结：性能是条件性的，不是绝对的

四条假设的判定分别是：**部分成立、成立、成立、成立**。但只记这个结论就白读了。四条合起来说明五件事：

1. **"为极致性能而设计"是准确的，但"性能"的具体含义是"读路径上的开销"。** 四条设计里，被省掉的东西几乎全部位于读路径：没有链表维护、没有空闲链、没有访问位写入、没有索引查找。写路径和后台路径反而很贵（全目录扫描、定时线程刷 `utime`、`open`/`close` 每块一次）。

2. **这套设计的核心手法是"把状态变成位置"。** 环形游标把"年龄"变成下标；`offset = index × size` 把"偏移"变成乘法；`<hash[0:N]>/<hash>` 把"索引"变成路径；`.tmp` 后缀把"是否提交"变成文件名。**位置是不需要维护的状态**——这是四处省略共同的技术内核。

3. **每一次省略都有明确的收款人。** 省略索引 → 文件系统收租（syscall、全量扫描、不可区分）；省略 recency → 命中率付款；省略准入 → 语义欠账；省略 free list → 隐含要求"容量 ≫ 在途引用"。判断一个性能设计好不好，不是看它省了多少，而是看**收款人是不是恰好能便宜地提供这项服务**。v1 选对了前三个收款人，第四个收款人是未来的自己。

4. **"部分成立"的那条最值得警惕。** 把收益归给"Pipeline 架构"是归错的：Pipeline 做的是拦截式分层，缩短单次读的路径；真正的时间重叠来自 connector 的 layerwise 调度，深度只有一层，首尾都有气泡，而且 store 层的 `Prefetch` 至今是空实现。**架构名字容易吸收它不该得的功劳。**

5. **性能路线的边界是"不变量能不能被外部系统维持"。** v1 的三个外部依赖（文件系统的原子 rename、配置里的整除约束、环形结构的位置序）都非常稳；第四个"不做语义"不稳，因为它依赖使用场景不提出新要求。当多 rank 共享、TTL、批量准入出现时，路径和位置都装不下这些语义，只能回到元数据——但 v2 的做法说明，**加回元数据不等于放弃速度：可以用分片把新增开销移出热路径，再用编译期断言把"必须无锁"焊死。**

最后一句判断，也是我读完这批代码最想说的一句：**UCM v1 的性能不是靠"算得更快"得来的，是靠"少知道一些事情"得来的。** 它不问块有多热、不问块在哪、不问这次分配会不会失败——这些"不问"换来了极短的读路径。而 v2 之所以要把这些问题一个个问回来，不是因为 v1 错了，是因为**用户开始需要答案**。工程上很少有纯粹的性能选择，多数是"你愿意在什么时候、向谁付这笔钱"的选择。

## 参考来源

- 代码证据（bare 镜像只读，分支与提交见正文）：
  - 旧实现基线 `dev-cache-mp-test`（`de517d5`）：`ucm/store/cache/cc/trans_buffer.{h,cc}`、`ucm/store/posix/cc/{space_layout,space_manager,posix_store,io_engine_aio,trans_queue,block_operator}.{h,cc}`、`ucm/store/nfsstore/cc/domain/{hotness/*,space/space_recycle.cc,space/space_manager.cc}`、`ucm/store/pipeline/cpy/pipeline_store.py.cc`、`ucm/store/detail/type/types.h`、`ucm/integration/vllm/ucm_connector.py`
  - 性能改造分支 `debug-perf-2609-mag1c`（`4223e25`）：`ucm/store/cache/cc/trans_buffer.cc`（`nodeCursor` + `accessed_`）、`cache_buffer.h`、`cache_types.h`、`ctrl_layout.h`
  - v2 契约 `dev-ucm-v2`（`fa84383`）：`ucm/v2/store/cache/cache_buffer.h`、`ucm/v2/store/cache/policy/{replacement_policy.h,replacement_policy_registry.h,lru_policy.cc,clock_policy.cc,fifo_policy.cc}`、`ucm/v2/store/cache/cache_store.h`
- 关键提交：`fcbb273`（2026-03-28，`[fix]Submit layerwise KV load tasks one layer at a time (#783)`）、`9dd9ba8`（2026-09-10，`[feat] new cache buffer`）、`1c5f958`（2026-09-10，`[feat] replace TransBuffer with new Buffer`）、`4223e25`（2026-09-11，`[feat] prefetch on lookup`）
- vLLM 侧接入：`vllm_ascend/distributed/kv_transfer/kv_pool/ucm_connector/connector.py`（`wait_for_layer_load` / `save_kv_layer` 的契约注释）
- 官方设计文档（英文，Pipeline/压缩/异步任务口径）：[Store Architecture](https://ucm--954.org.readthedocs.build/en/954/_sources/design-doc/store_architecture.md)
- 站内同系列：[UCM v2 接口设计契约](/posts/018-ucm-v2-interface-design)、[UCM Store 的 Pipeline 架构](/posts/019-ucm-pipeline-store)、[共享内存缓存的并发控制](/posts/020-ucm-cache-concurrency)、[多 rank 共享加载](/posts/021-ucm-multi-rank-load)、[UCM 演进史](/posts/022-ucm-evolution)
