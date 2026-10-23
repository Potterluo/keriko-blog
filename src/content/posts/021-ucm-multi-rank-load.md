---
title: "多 rank 共享 KV Cache：UCM 加载路径的重构"
description: "多 rank 共享同一份 KV 缓存时，UCM 的加载路径卡在锁步争用、环形淘汰与等待开销上。本文拆解四次重构：旋转访问、CLOCK 二次机会、无锁状态与下一格预热。"
publishedAt: "2026-10-23"
category: 项目笔记
tags:
  - UCM
  - KV Cache
  - 多进程
  - 性能优化
draft: false
---

一台 8 卡 TP 节点上跑着 8 个 rank，每个 rank 有自己的推理流水线、自己的显存、自己的一份 KV Cache。但主机内存里那层「最近用过的 KV 分片」缓存只有一份：8 个进程把同一块共享内存映射进来，看到的是同一套哈希桶、同一套锁、同一份字节。这个设计省掉了 N−1 次回源和 N 份主机内存，代价是把两条本来可以各自独立跑的加载路径，焊死成了一个 8 进程的公共临界区。

于是出现一种反直觉的退化：TP 从 2 加到 4、从 4 加到 8，理论算力翻倍，端到端吞吐却可能不升反降。加进来的 rank 没有带来更多并行，反而都变成了同一把锁上的排队者。钱不是花在搬数据上，而是花在「等」上。

这篇笔记拆的是 [Issue #12](https://github.com/mag1c-h/unified-cache-management/issues/12) 里描述、并且在代码里已经落地的那一轮重构。四条改动分别对准四种等待：**锁步争用**（所有 rank 同时抢同一个分片）、**环形淘汰**（刚装好的分片被下一轮 miss 赶走）、**元数据锁**（一次就绪查询要加解一次自旋锁）、**空闲窗口**（dispatcher 推完任务后干等下一单）。先说清一个前提，免得读者带着错误的期待读下去：这个问题不是「重复加载」——owner/等待者模型早就把重复回源消掉了；真正的浪费是**并发度只剩下 1**。

## 多 rank 现场：一份缓存，N 个消费者

UCM（Unified Cache Manager）把 KV Cache 定义成等大的小段，每段叫一个 **shard（分片）**。定位一个分片需要两个量：块 ID（16 字节内容哈希）加块内分片序号，`(block, shard)` 就是缓存的键。主机内存里那层缓存由固定数量的**槽位（node / slot）**组成，槽位满了要装新分片时按某种策略挑一个旧槽位腾出来。

多卡节点上，节点内卡数就是 `localRankSize`。关键设计是节点内各 rank 共享**同一份** `TransBuffer`：控制面（哈希桶、桶锁、节点锁、引用计数、状态位、淘汰游标）和数据面（真正的字节）都在同一块 POSIX 共享内存里。

代码里的形态比「拆成两个类」更朴素，也更省事：一块 shm 用三段偏移切成三个区，控制面在前、数据面在最后，中间用 64 字节和页大小做对齐：

```text nocollapse
shm: /dev/shm/uc_shm_cache_<uuid>
 0
   ┌───────────────────────────────────────────┐
   │ BufferHeader                              │
   │   magic（共享缓冲魔术字）                 │
   │   nNode                                   │
   │   alignas(64) atomic<size_t> nodeCursor   │  ← 淘汰游标，跨进程 fetch_add
   │   pad[fill]，填满同一 cache line          │
   │   buckets[16411]                          │  ← 哈希桶头（16411 为质数）
   │   bucketLocks[16411]                      │  ← PTHREAD_PROCESS_SHARED 自适应锁
   │   nodeLocks[0]  ← 变长                    │  ← 每节点一把进程间自旋锁
   ├─ AccessedOffset（64 字节对齐）────────────┤
   │   accessed[nNode]   每个节点 1 字节       │  ← CLOCK 访问位
   ├─ MetaOffset（按 BufferMetaNode 对齐）─────┤
   │   meta[nNode]  block/shard/reference/     │
   │                atomic<State>/atomic<err>  │
   ├─ DataOffset（页对齐）─────────────────────┤
   │   data[nNode * nodeSize]                  │  ← 真正的字节，已注册给设备
   └───────────────────────────────────────────┘
```

谁当 owner 由引用计数决定，而不是另设一套所有权协议：`FindAt` 在桶锁保护下找到节点，`owner = (reference == 0)`，然后 `++reference`。第一个把 `reference` 从 0 抬起来的 rank 就是 **owner**，由它向后端 `Load` 回源；其他 rank 发现 `reference > 0`，以**非 owner 等待者**身份等就绪。

这里就能看出本文标题里那个「重复加载」到底重复在哪、不重复在哪：

- **回源（S2H）不重复。** 一个 `(block, shard)` 只有一个 owner，向后端只发一次 `Load`。这是共享设计的核心收益。
- **拷到设备（H2D）必须重复。** 每个 rank 的显存里都要有一份这段 KV，所以 N 个 rank 各做一次 H2D。这是 TP 的物理事实，省不掉也不该省。
- **但仲裁必须串行。** N 个 rank 要在同一套哈希桶、同一套节点锁上抢同一个 `(block, shard)`。**这才是在多 rank 时真正花钱的地方。**

`deviceId < 0` 的第三种角色也值得一提：`SharedBufferWatcherStrategy` 只映射控制面（`totalSize_ = DataOffset()`），`DataAt` / `DeviceDataAt` 直接返回 `nullptr`，`MarkAccessed` 是空实现——它是一个只问「在不在」、不搬字节的观察者。调度侧（Scheduler）在共享缓存上做存在性查询时走的就是这条路径，代价是一份元数据的内存映射，不是一个 rank 的数据面。

## 旧加载路径：一个任务，两段流水

旧实现（镜像里的 `dev-cache-mp-test` 分支，没有 `localRankSize`）每个 rank 跑一个 `LoadQueue`，两条线程用两个 SPSC 环形队列串起来：

- `DispatchStage`（线程名 `ucm_load_disp`）：从 `waiting_` 取任务，在缓存里定位/申请槽位，需要回源的交给后端，然后全部推给 `running_`；
- `TransferStage`（线程名 `ucm_load_xfer`）：从 `running_` 取分片，等后端就绪，DMA 到设备显存。

旧 `DispatchOneTask` 的形状值得原样看一眼，因为后面四条改动全都改的是这段：

```cpp nocollapse
// dev-cache-mp-test: ucm/store/cache/cc/load_queue.cc（节选）
for (size_t i = 0; i < nShard; i++) {
    auto& shard = task->desc[i];                       // ← 自然序，所有 rank 一样
    auto& shardTask = shardTasks[i];
    shardTask.bufferHandle = buffer_->Get(shard.owner, shard.index);
    if (shardTask.bufferHandle.Owner() && !shardTask.bufferHandle.Ready()) {
        backendTaskDesc.push_back(...);                // ← 先攒齐
        backendTaskIndex.emplace_back(i);
    }
    ...
}
if (!backendTaskDesc.empty()) {
    auto res = backend_->Load(std::move(backendTaskDesc));   // ← 一次批量提交
    ...
}
for (size_t i = 0; i < nShard; i++) { running_.Push(std::move(shardTasks[i])); }
```

三个特征叠在一起，正好指向后面的几处开销：**所有 rank 用同一个自然序遍历分片**（锁步争用）；**回源任务攒齐后一次性批量提交**（并发度被攒批卡住）；**就绪状态是 `BufferMetaNode` 里的一个普通 `bool ready`，且只在节点锁下读写**（查询代价）；再加上**淘汰是纯环形 FIFO**（局部性）。

两段拆分的意图本身是对的，值得先说清楚，否则容易在读后面的改动时误以为要把流水拆掉。dispatcher 做的是**仲裁**——哈希定位、抢 owner、向后端下单，全是短、多变、带锁的动作；copier 做的是**搬运**——等后端就绪、DMA 到显存，全是长、阻塞、不该持锁的动作。把两类动作放在一条线程里，持锁时间和阻塞时间会互相污染；拆成两条线程、中间用 SPSC 环形队列（`waitingQueueDepth` / `runningQueueDepth` 两个配置项决定深度）传递 `ShardTask`，就能让 copier 在等后端的时候 dispatcher 继续推进下一个分片。后面四条改动全都保留了这个骨架，改的是骨架里每一跳的代价。

## 瓶颈一：锁步争用，后端并发被压成 1 路

设想 4 个 rank 处理一个含 12 个分片的加载任务。所有 rank 都按 `0,1,2,…` 走，于是每一步都挤在同一个分片上——也就是挤在保护该分片的同一把桶锁上。锁是排他的，分发被串行化；更要命的是每一步只有抢到 owner 的那一个 rank 去回源，其余三个登记成等待者干等。慢速后端全程只有 **1 路并发**。

```text nocollapse
旧：自然序 0,1,2,…（4 rank × 12 shard，每一步所有 rank 抢同一个 shard）

step 0    r0→S0    r1→S0    r2→S0    r3→S0     同一把桶锁；1 个 owner，3 个等待
step 1    r0→S1    r1→S1    r2→S1    r3→S1     同上
  ⋮
step 11   r0→S11   r1→S11   r2→S11   r3→S11
         后端并发度 = 1            总步数 = 12
```

修法简单到有点反高潮：让每个 rank 从不同偏移起步。偏移取 `deviceId % localRankSize`，然后以 `localRankSize` 为步幅从自己的偏移扫，扫完轮转到下一个偏移。`RearrangeIndex` 就是这几行：

```cpp nocollapse
// develop: ucm/store/cache/cc/load_queue.cc
static std::vector<size_t> RearrangeIndex(size_t n, size_t iProc, size_t nProc)
{
    std::vector<size_t> order;
    order.reserve(n);
    for (size_t r = 0; r < nProc; ++r) {
        size_t slice = (iProc + r) % nProc;
        for (size_t j = 0;; ++j) {
            size_t i = slice + j * nProc;
            if (i >= n) { break; }
            order.push_back(i);
        }
    }
    return order;
}
```

`DispatchOneTask` 里就是两行的改动——先算一份 `indexes`，遍历时用 `task->desc[indexes[i]]` 取值：

```text nocollapse
新：RearrangeIndex，偏移 = deviceId % localRankSize

step 0    r0→S0    r1→S1    r2→S2    r3→S3     4 把不同的桶锁；4 个 owner
step 1    r0→S4    r1→S5    r2→S6    r3→S7     4 路后端 Load 同时在飞
step 2    r0→S8    r1→S9    r2→S10   r3→S11
         后端并发度 = 4            总步数 = 3
```

按 issue 给出的口径，这就是「12-shard 任务从『12 步串行』变『3 步、每步 4 路并发』」，而且**吞吐随 TP 线性提升**——同一份分片不再被 N 个 rank 在同一时刻争抢，同时各 rank 都成了自己那一片的 owner，所有权在 rank 间均衡，后端带宽被吃满。

注意这两句话是同一个效应的两面，容易漏掉后者：旋转不仅消除了 `Get()` 内部的锁争用，还把「回源」从串行变成了 N 路并发。前者是锁的账，后者是后端并发的账，收益叠乘。

这个改动对应提交 `859948c`（`[opt] Reorder shard access by deviceId to reduce lock contention between TPs`）。它引入了一个配置项 `local_rank_size`（int，默认 `8`），`global_config.h` 里对应 `size_t localRankSize{8};`。**这个默认值是本文唯一一个「配错了会静默掉收益」的地方**：如果实际本地设备数是 8 而你填了 4，就有两个设备从同一个 slice 起步，收益被削掉一部分，但不会报错、不会崩——commit 说明里写得很直白：`reducing (but not breaking) the benefit`。

支撑「旋转后落到不同桶」这个前提的是哈希本身。分片键的桶号由块 ID 哈希与分片序号哈希混合后对 `16411` 取模——`16411` 是质数，`Hash()` 用的是 `h1 ^ (h2 + goldenSection + (h1 << 6) + (h1 >> 2))` 这种常见的位混合写法。同一 block 内相邻分片（`shard` 相差 1）经 `h2` 变化后基本落在不同桶，所以 4 个 rank 在 step 0 拿到 `S0..S3` 时，命中的是 4 把互不相关的桶锁，而不是同一把锁上的 4 个排队者。

## 瓶颈二：环形淘汰把刚装好的格子赶走

旧淘汰是纯粹的环形 FIFO：`FetchNode()` 把 `freeHead` 加一取模，谁在游标上谁死，冷热不分。

```cpp nocollapse
// dev-cache-mp-test: 共享模式下的 FetchNode
size_t FetchNode() override
{
    header_->lock.Lock();                    // ← 每次分配都要拿一把进程间自旋锁
    auto iNode = header_->freeHead++;
    if (header_->freeHead == nNode_) { header_->freeHead = 0; }
    header_->lock.Unlock();
    return iNode;
}
```

在批量加载多 block 分片的场景里，这很伤：一个刚装好、马上要被 copier 读走的分片，很可能在下一轮 miss 的淘汰扫描里就被当成牺牲者腾出去——等于白装一次，把好不容易挣来的局部性又吐回去。

新实现换成 **CLOCK 二次机会（second chance）**：每个节点配一个访问位 `accessed_[iNode]`（共享映射里的 `std::atomic<uint8_t>` 数组），游标逐格扫——位为 1 就清 0 跳过，位为 0 就选为牺牲者：

```cpp nocollapse
// develop: ucm/store/cache/cc/trans_buffer.cc，LocalBufferStrategy::FetchNode
size_t FetchNode(bool allowReserved) override
{
    const auto total = header_.nNode - (allowReserved ? 0 : base_.reservedNumber);
    for (size_t i = 0; i < 2 * total; ++i) {
        auto cur = header_.nodeCursor++ % total;
        uint8_t expected = 1;
        if (accessed_[cur].compare_exchange_strong(expected, 0,
                                                   std::memory_order_relaxed,
                                                   std::memory_order_relaxed)) {
            continue;                          // 位为 1：清 0 跳过，给第二次机会
        }
        return cur;                            // 位为 0：选为牺牲者
    }
    return header_.nodeCursor++ % total;       // 全置位：退化回裸游标，保证终止
}
```

共享实现里游标改成 `header_->nodeCursor.fetch_add(1, std::memory_order_relaxed) % total`，因为跨进程不能用非原子的自增；`total` 的算法一致。几条性质值得点出来：

- **扫描上界是 `2 * total`**，最多扫两圈。一圈清位、一圈选人，所以最坏情况下也只是把全表的位清一遍再退化成裸游标，不会无限自旋。
- **置位时机有两处**，这在 issue 里被强调过，代码里也对得上：`FindAt`（命中的分片续命）和 `Alloc`（新装的分片拿到一个豁免窗口，保证在被 copier 读走之前不会被扫掉）。前者让 CLOCK 近似 LRU，后者防「加载完立刻被驱逐」的活锁。
- **`allowReserved` 参数**把池子切成常规池 + 保留池：`total = nNode - (allowReserved ? 0 : reservedNumber)`。常规池满时预热才启用保留池，不挤占正常容量。
- **共享模式的节点分配也顺手去锁了**：旧的 `header_->lock` + `freeHead` 换成 `alignas(64)` 的 `std::atomic<size_t> nodeCursor` 加 `fetch_add`，每分配一个节点少一次进程间自旋锁。

这轮改动对应提交 `d7f2d7d`（`perf(cache/cc): lock-free TransBuffer state, CLOCK eviction, and next-shard preallocation`），标题里四件事，CLOCK 是第二件。

issue 的场景 C 给了一个 4 格容量的走查，值得照着跑一遍，因为它解释了什么叫「近似 LRU 但便宜」。缓存 4 格，先后装入 A/B/C/D，每次装入都把该格访问位置 1，游标停在格 0。此时来一次 miss：

1. 格 0 位=1 → 清 0，跳过；
2. 格 1 位=1 → 清 0，跳过；
3. 格 2 位=1 → 清 0，跳过；
4. 格 3 位=1 → 清 0，跳过；
5. 游标回到格 0，此时位已被上一轮清成 0，`compare_exchange_strong` 的期望值 1 与实际的 0 不符，于是返回格 0 作为牺牲者，E 装进格 0 并置位，游标停在格 1。

此刻格 0 = E（位 1），格 1/2/3 = B/C/D（位 0，刚被扫清），游标停在格 1。接着有人 `Get` 命中 B（格 1），命中路径把格 1 的位重置为 1。又来一次 miss，游标从格 1 起：格 1 位=1 → 清 0 跳过（B 存活）；格 2 位=0 → 选为牺牲者，F 装进格 2。刚被摸过的 B 活下来，一直没人摸的 C 被腾走。整个过程没有链表重排、没有时间戳比较，只有一个字节的位和一次自增。

而如果没有第二处置位（新装时置位），一步就退化成最初的问题：E 刚装进格 0、copier 还没读，下一次 miss 的游标恰好从格 0 起，E 就成了牺牲者，本次加载白做。这也是为什么「命中置位」和「新装置位」缺一不可——前者给局部性，后者给生命周期。

顺带说明 `2 * total` 这个上界为什么不是死代码：它只在「一圈扫完仍没选中」这种理论上不该发生的情况下兜底——比如所有位恰好在扫描过程中又被别的线程置位。真走到这里就直接用裸游标取一格，代价是一次盲淘汰，而不是挂住。

## 瓶颈三：等待、元数据锁与跨 rank 失败

非 owner 想知道「这格好了没」，旧实现只能轮询。而每一次轮询的代价被低估了——看看旧的 `Ready()`：

```cpp nocollapse
// dev-cache-mp-test
bool TransBuffer::Ready(Index pos)
{
    strategy_->NodeLock(pos);                 // ← 加锁
    auto ready = strategy_->MetaAt(pos)->ready;   // ← 读一个普通 bool
    strategy_->NodeUnlock(pos);               // ← 解锁
    return ready;
}
```

`LoadQueue::WaitBackendTaskReady` 的等待循环是 `for (;;) { ... if (bufferHandle.Ready()) break; std::this_thread::yield(); }`。也就是说：**每轮自旋要加解一次进程间自旋锁，只为读一个字节**。TP 数越大，等待者越多，这份空耗越可观；而且普通 `bool` 在跨进程共享内存里没有同步语义，跨进程的加载状态本就不可靠。

新实现把就绪/失败两个布尔合成一个原子状态机，并把访问路径彻底去锁：

```cpp nocollapse
// develop: trans_buffer.cc（节选）
enum class State : uint8_t { LOADING, READY, FAILED };
static_assert(std::atomic<TransBuffer::State>::is_always_lock_free, "state must be lock-free");

TransBuffer::State TransBuffer::GetState(Index pos)
{
    return strategy_->MetaAt(pos)->state.load(std::memory_order_acquire);   // 无锁
}

void TransBuffer::MarkFailed(Index pos, const Status& status)
{
    auto meta = strategy_->MetaAt(pos);
    meta->errorCode.store(status.Underlying(), std::memory_order_release);  // 先写错误码
    meta->state.store(State::FAILED, std::memory_order_release);            // 后写状态
}
```

三个细节是这个设计的承重点：

1. **`state` 用 `alignas(64)` 独占一条 cache line**，避免和相邻节点的 `reference` 伪共享——等待者在另一颗核上高频读 `state`，如果它和「写者正在更新的 `reference`」共享 cache line，去锁的意义会被缓存一致性协议吃掉。
2. **`errorCode` 先写、`state` 后写，两者都是 `release`**。于是任何观察到状态跃迁的读者，一定也观察到对应的错误码；`FailureStatus()` 只需要一次 `acquire` 读，不需要重试。
3. **`GetState()` 取代了「等待接口 + 再查就绪 + 再查失败」三次访问**。等待者一轮循环只做一次 acquire load，而不是一次加锁、一次读、一次解锁。

状态机还有一次「回退跃迁」值得记一笔：`MarkNotReady()` 把 `errorCode` 清成 OK、把 `state` 打回 `LOADING`。它被 `TransBuffer::Get` 的第四个参数 `isLoad` 触发——当配置项 `cacheLoadBackendOnly` 打开时（`Setup` 里记为 `bypassHitOnLoad_`），一个命中且已就绪的节点会被强制打回未就绪，让这次 `Load` 真的穿一遍后端。这条路径是「只用共享缓存做一致性、数据仍然回源」的模式，也解释了为什么新签名从旧的两参 `Get(owner, index)` 变成四参 `Get(owner, index, allowReserved, isLoad)`：`allowReserved` 给预热开保留池，`isLoad` 给回源模式开强制刷新。

失败语义也随之变了。旧的共享缓存只有 `ready` 一个位：owner 回源失败时，共享缓存永远是 not ready，其他 rank 看不见 owner 进程内的失败，只能一直等到任务超时。提交 `01cbf9b`（`[Bugfix] Propagate shared cache load failures across ranks`）把后端失败状态写进共享元数据、发布 `FAILED`，非 owner 观察到 `FAILED` 立刻带状态返回；并且在所有引用释放之后允许 `FAILED → LOADING` 重试。这就是新代码里那段分支的来源：

```cpp nocollapse
// develop: LoadQueue::WaitBackendTaskReady
if (task.backendTaskHandle != 0) {
    auto s = backend_->Wait(task.backendTaskHandle);   // owner：等自己的后端任务
    ...
    task.bufferHandle.MarkReady();
    return Status::OK();
}
for (;;) {                                             // 非 owner：只读原子状态
    auto state = task.bufferHandle.GetState();
    if (state == TransBuffer::State::READY) { return Status::OK(); }
    if (state == TransBuffer::State::FAILED) { return task.bufferHandle.FailureStatus(); }
    if (failureSet_->Contains(task.task->id)) { return task.task->FailureStatus(); }
    std::this_thread::yield();
}
```

还有一处不显眼但很值的改动：提交 `5e1427d`（`[opt] cache: drop redundant node locks in TransBuffer::FindAt/ExistAt traversal`）把 `FindAt` 里逐节点加的锁收进了「命中」分支——遍历过程中不匹配的节点直接无锁读，因为整段本来就在桶锁保护下。单次查找的加解锁次数从 O(L)（L 为桶链长度）降到 O(1)。

把等待这条路径压成一张对照图，两个版本的差别就很直白了：

```text nocollapse
旧：等待者每一轮都要进一次临界区
  rank2                    共享内存 meta                         rank0 (owner)
    │                          │                                      │
    ├─ BucketLock ────────────▶│                                      │
    ├─ FindAt: ref>0 → waiter │                                      │
    ├─ BucketUnlock ◀─────────│                                      │
    ├─ NodeLock ─────────────▶│  ← 每轮一次进程间自旋锁，只为读 1 字节
    ├─ 读 bool ready          │                                      │
    ├─ NodeUnlock ◀───────────│                                      │
    ├─ yield ─────────────────┼─────── 空转 ────────────────────────┤
    │  ⋮ 循环直到 ready 变真    │                                      ├─ 搬完
    │                          │◀── ready = true（MarkReady 也在锁下）┤
    ├─ ...再一整轮加解锁...    │                                      │

新：等待者只做一次 acquire load，写者先后有序
  rank2                    共享内存 meta                         rank0 (owner)
    │                          │                                      │
    ├─ GetState() ── acquire ─▶│ atomic<State> == LOADING             │
    ├─ yield ─────────────────┼─────── 空转 ────────────────────────┤
    │  ⋮                       │                                      ├─ MarkReady()
    │                          │◀── release: state = READY ───────────┤
    ├─ GetState() ── acquire ─▶│ atomic<State> == READY → 退出        │
    │   （无锁、无临界区）      │                                      │
```

**这里必须说清一处 issue 与代码的差额。** issue 的 §3.2 提出「等待接口用 futex 阻塞唤醒、零空耗」，但我在只读镜像里对全部 10 个分支逐个做了 `git grep -i futex`，**没有任何命中**；落地的等待仍然是 `std::this_thread::yield()` 自旋。真正被消掉的是「自旋一轮要加解一次自旋锁」，而不是「自旋本身」。也就是说 issue 描述的目标里，**跨进程可见性、一次分支到位** 已经做到，**零 CPU 空耗** 还没做到。这不是挑刺——它直接决定了下面「代价」一节里那条遗留项。

## 瓶颈四：dispatcher 的空闲窗口

dispatcher 把当前任务的所有分片推给 copier 之后，要等下一个任务到达才有事做。这段空闲完全可以拿来预热「下一格」：块内分片通常按序流式推进，下一任务很可能要同一块的 `shard.index + 1`。

```cpp nocollapse
// develop: LoadQueue::DispatchOneTask 末尾
for (size_t i = 0; i < nShard; i++) {
    auto& shard = task->desc[indexes[i]];
    if (shard.index + 1 != nShardPerBlock_) {          // 不越过块边界
        buffer_->Prealloc(shard.owner, shard.index + 1, true);   // allowReserved = true
    }
}
```

`Prealloc` 本身只有五行，语义是「分配再立刻释放」——节点留在桶链上、引用计数归零、状态回到 `LOADING`：

```cpp nocollapse
void TransBuffer::Prealloc(const Detail::BlockId& blockId, size_t shardIdx, bool allowReserved)
{
    auto iBucket = Hash(blockId, shardIdx);
    strategy_->BucketLock(iBucket);
    if (!ExistAt(iBucket, blockId, shardIdx)) {
        size_t pos = Alloc(blockId, shardIdx, iBucket, allowReserved);
        Release(pos);
    }
    strategy_->BucketUnlock(iBucket);
}
```

预热省掉的到底是什么？看 `Alloc` 的重试循环就明白了：它要 `FetchNode` 找一个牺牲者，节点锁下检查 `reference > 0` 就重来，跨桶时还要 `BucketTryLock` 旧桶，抢不到又 `continue`。预热留下的节点让后续 `Get` 直接走「桶链命中 + `reference == 0` → 接管为 owner」的快路径，跳过整套「淘汰—摘链—重挂」。

而且它和 CLOCK 是咬合的：预热的节点因为走过 `Alloc`，`accessed == 1`，CLOCK 天然会保护它，直到真正的 `Get` 到来。`nShardPerBlock_`（`config.blockSize / config.shardSize`）用来避免越过块边界去预热一个不存在的下一格。

```text nocollapse
dispatcher（ucm_load_disp）          copier（ucm_load_xfer）          后端
    │                                    │                             │
    ├─ Get(B0.s) ── owner ───────────────┼── Load(B0.s) ───────────────▶│
    ├─ Get(B1.s) ── owner ───────────────┼── Load(B1.s) ───────────────▶│
    ├─ Get(B2.s) ── owner ───────────────┼── Load(B2.s) ───────────────▶│
    ├─ push 3 × ShardTask ──────────────▶│                             │
    │                                    ├─ Wait(backend) ────────────▶│
    │                                    ├─ MarkReady ◀────────────────┤
    │                                    ├─ H2D → 本 rank 的显存      │
    ├─ 空闲窗口：Prealloc(B0, s+1)       │                             │
    ├─ 空闲窗口：Prealloc(B1, s+1)       │                             │
    ├─ 空闲窗口：Prealloc(B2, s+1)       │   ← 3 个空闲槽挂好，ref=0   │
    │   ⋯ 等下一个任务                   │                             │
```

## 前后对照与代价

### 一张表看完四条改动

| 维度                 | 旧（`dev-cache-mp-test`）       | 新（`develop`）                                                      | 提交                  |
| :------------------- | :------------------------------ | :------------------------------------------------------------------- | :-------------------- |
| 分片访问序           | 自然序 `0..n-1`，所有 rank 锁步 | `RearrangeIndex` 按 `deviceId % localRankSize` 旋转                  | `859948c`             |
| 后端提交粒度         | 攒齐后一次批量 `Load`           | 定位一个提交一个（边定位边回源）                                     | `859948c`             |
| 槽位元数据           | `bool ready`                    | `atomic<State>`（LOADING/READY/FAILED）+ `atomic<int32_t> errorCode` | `01cbf9b` / `d7f2d7d` |
| 状态读取             | 节点锁下读普通 `bool`           | `acquire` 原子读，无锁                                               | `d7f2d7d`             |
| 淘汰纪律             | `freeHead++` 环形 FIFO          | CLOCK 二次机会 + 每节点访问位                                        | `d7f2d7d`             |
| 节点分配（共享模式） | `header_->lock` 保护 `freeHead` | `alignas(64) atomic nodeCursor` + `fetch_add`                        | `d7f2d7d`             |
| 桶链遍历加锁         | 每跳一次 `NodeLock`             | 仅命中节点加锁，O(L) → O(1)                                          | `5e1427d`             |
| 后端失败可见性       | 仅 owner 进程内可见             | `FAILED` 写入共享元数据，跨 rank 可见并可重试                        | `01cbf9b`             |
| 下一格               | 无                              | dispatcher 空闲窗口 `Prealloc`                                       | `d7f2d7d`             |

### 代价：内存、兼容性与退化场景

四条改动都不是白拿的：

- **内存。** 每节点多一个访问位（1 字节 / 节点），但三段区各要按自己的边界起算：`accessed` 段 64 字节对齐（一条 cache line），`meta` 段按 `alignof(BufferMetaNode)` 对齐，`data` 段按页对齐。于是三个区之间各留一段不足一线 / 一结构 / 一页的 padding。对小容量、大分片的配置，这部分比例开销可以忽略；对「容量大、分片小」的配置，元数据（含每节点的 `meta` 结构与访问位）占比会上升。
- **共享内存布局不兼容。** `d7f2d7d` 的提交说明明确写了：`SharedBufferStrategy` 的共享内存布局变了（去掉共享 `ShareLock`，加入 `nodeCursor` 与 padding，加入 `accessed_` 段），但**魔术字没变**。所以新旧版本进程共享同一块缓冲是危险的，滚动升级期间必须避免混跑。`01cbf9b` 则选择把共享元数据版本号抬一格，用不兼容把旧进程挡在外面。两处对同一件事给了两种处理，是这轮重构里最容易踩的坑。
- **`local_rank_size` 配错是静默的。** 默认 `8`；填得比实际本地设备数小，两个设备会从同一个 slice 起步，收益下降但不报错。
- **单 rank 退化。** `localRankSize = 1` 时 `RearrangeIndex` 退化成自然序，还白算一次 `order` 向量（`reserve(n)` 一次分配 + n 次 push）。绝对开销很小，但收益为零——归零，不是负数。
- **后端提交次数变多。** 这是我在代码里读到的、issue 没展开的一处权衡：旧实现把任务里所有需要回源的分片攒成一个批量 `TaskDesc` 一次提交，新实现是循环里定位一个、`backend_->Load` 一个。好处是 owner 一确定就能立刻发起回源、不必等整轮定位完（这正是 N 路并发的前提），代价是后端 `Load` 的调用次数从「每任务一次」变成「每分片一次」。如果后端插件对批量提交有摊销优化（issue 的术语是「摊薄任务提交/队列推进的开销」），这部分收益会被吃掉一点，需要靠后端侧的批量能力补回来。
- **等待仍在自旋。** 如上一节所说，issue 的 futex 方案没有落地，非 owner 依旧是 `yield` 自旋。原子读 + 独占 cache line 把单轮成本压到了很低，但「等待者不烧 CPU」这个目标还是空白。

至于收益，必须按口径说清楚：**issue 没有给出任何实测性能数字**。它给的是结构性口径——「后端并发度从 1 提到 N」、「12-shard 任务从 12 步串行变 3 步、每步 4 路并发」。这两句可以直接引用，因为它们只依赖「每步落不同桶、不同 rank 同时当 owner」这个结构事实。至于端到端延迟降了多少、吞吐提升几个百分点，本文不给数字，来源里也没有。

### issue 的方案与落地代码的差额

issue 是一份设计提案，代码是它的一个子集。逐条对完，差额如下——把这条差额摊开写，比假装两者一致更有用：

| issue §3 里的说法                         | 代码里确认到                                                                                                                           | 结论                |
| :---------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------- | :------------------ |
| 3.1 `RearrangeIndex` 旋转访问             | `load_queue.cc` 有同名静态函数，`DispatchOneTask` 调用                                                                                 | 已落地（`859948c`） |
| 3.2 拆成 `BufferCtrl` / `BufferData` 两类 | 无这两个类；同一块 shm 用 `MetaOffset` / `AccessedOffset` / `DataOffset` 三段偏移分区，另有 `SharedBufferWatcherStrategy` 只映射控制面 | 目标一致，形态不同  |
| 3.2 单状态机（空闲/就绪/失败）            | `State{LOADING, READY, FAILED}`；「空闲」对应 `reference == 0`，不是一个独立状态                                                       | 已落地，命名不同    |
| 3.2 等待接口直接返回状态                  | `GetState()` 直接返回 `State`，`FailureStatus()` 直接返回错误码                                                                        | 已落地              |
| 3.2 槽位定址 2 的幂位移/掩码快速路径      | 未在 `trans_buffer.*` 中找到对应实现                                                                                                   | 未落地              |
| 3.2 非 owner 等待改 futex 阻塞唤醒        | 全分支 `grep -i futex` 无命中；等待是 `GetState()` 自旋 + `yield`                                                                      | **未落地**          |
| 3.3 CLOCK 二次机会淘汰                    | `accessed_` 位数组 + `FetchNode` 的 `2 * total` 扫描 + `MarkAccessed` 两处置位                                                         | 已落地（`d7f2d7d`） |
| 3.3 块级 `Touch` 一次刷新一批 block       | 未找到 `Touch` 符号                                                                                                                    | 未落地              |
| 3.4 空闲窗口 `Prealloc` 预热下一格        | `TransBuffer::Prealloc` 存在，`DispatchOneTask` 末尾调用，`nShardPerBlock_` 控边界                                                     | 已落地（`d7f2d7d`） |

### 与站内其它 UCM 优化的关系

这一轮改的是**共享缓存的仲裁路径**，另外三篇改的是它的上下游与同一套锁模型的正面拆解，值得放在一起看：

- [UCM Store 的 Pipeline 架构](/posts/019-ucm-pipeline-store) 讲分级链上「上一层装满、下一层接手」的搬运编排。本文的 `Prealloc` 预热下一个分片，优化的正是那条流水**在缓存层内部的入队延迟**；两者都靠「提前一步」换延迟。
- [把共享内存缓存的锁拆掉](/posts/020-ucm-cache-concurrency) 从锁模型正面讲桶锁乐观化与节点锁无锁化。本文的 `5e1427d`（去掉 `FindAt` 的冗余节点锁）与它是同一件事的两个视角：那边问「这把锁还需不需要」，这边问「一次等待要付几次加解锁」。真正删锁的机制细节看那一篇，本文只算它在加载路径上的账。
- [UCM 演进之路](/posts/022-ucm-evolution) 从 commit 史看系统怎么长出来。本文的 `859948c`、`d7f2d7d`、`01cbf9b`、`5e1427d` 四个提交，基本都是「从单进程缓存走向节点级共享缓存」那一步走完之后付出的「共享税」的偿还记录——共享省下了内存和回源，但把单进程里根本不存在的问题（锁步、跨进程可见性、跨 rank 失败传播）变成了必须还的账。

## 小结

多 rank 共享 KV Cache 的性能问题，很容易被描述成「重复加载」——好像每个 rank 都在傻乎乎地拉同一份数据。读完 issue 和代码会发现事实不是这样：owner/等待者模型早就把重复回源消掉了，一个 `(block, shard)` 只有一个 owner。钱花在别处，而且是三种不同性质的「等」：

1. **锁步的等**——所有 rank 用同一个顺序抢同一个分片，把本该 N 路的后端并发压成 1 路。修法是 `RearrangeIndex`，一行偏移换来 N 路并发。
2. **淘汰的等**——环形 FIFO 把刚装好的分片当牺牲者，白装一次。修法是 CLOCK 二次机会加两处置位，顺带把共享节点分配去锁。
3. **查询的等**——一次就绪查询要加解一次进程间自旋锁。修法是把 `bool ready` 换成独占 cache line 的原子状态机，并把错误码排到状态之前写。

再加一条「不等的等」：dispatcher 推完任务后那段空闲窗口，本来就闲着，拿它预热下一格是纯收益。

有两点值得留在心上。第一，**issue 是设计，代码是子集**：futex 唤醒、块级 `Touch`、`BufferCtrl`/`BufferData` 二分、2 的幂定址快路径，在 `develop` 上都没找到对应符号。读设计文档时不要把「计划」当成「现状」。第二，**共享的收益和共享税是一体两面**：省掉 N−1 次回源和 N 份主机内存的同时，也换来了锁步争用、跨进程可见性和跨 rank 失败传播三张账单。这一轮重构付掉了前两张的大半，第三张（等待者的 CPU）还挂着。

## 参考来源

- Issue：[`[Feature]: 多 rank 共享缓存加载路径的性能优化` #12](https://github.com/mag1c-h/unified-cache-management/issues/12)（已 closed；本文问题描述、方案与结构性收益口径均出自该文，含场景 A–E）
- 上游关联 issue：[ModelEngine-Group/unified-cache-management#1265](https://github.com/ModelEngine-Group/unified-cache-management/issues/1265)（issue 正文首行引用）
- 代码基线：主仓 [ModelEngine-Group/unified-cache-management](https://github.com/ModelEngine-Group/unified-cache-management) 的 `develop` 分支（新实现），与作者镜像 [mag1c-h/unified-cache-management](https://github.com/mag1c-h/unified-cache-management) 的 `dev-cache-mp-test` 分支（旧基线，该分支只存在于镜像）
  - `ucm/store/cache/cc/load_queue.{h,cc}`：`RearrangeIndex`、`DispatchOneTask`、`WaitBackendTaskReady`、`nShardPerBlock_`
  - `ucm/store/cache/cc/trans_buffer.{h,cc}`：`TransBuffer::State`、`GetState`/`MarkReady`/`MarkFailed`/`MarkNotReady`、`Prealloc`、`FetchNode`、`accessed_`、`BufferHeader`、`LocalBufferStrategy`/`SharedBufferStrategy`/`SharedBufferWatcherStrategy`
  - `ucm/store/cache/cc/global_config.h`：`localRankSize{8}`
  - `ucm/store/cache/cc/posix_shm.h`：`PosixShm`
- 相关提交：
  - `859948c` `[opt] Reorder shard access by deviceId to reduce lock contention between TPs`
  - `d7f2d7d` `perf(cache/cc): lock-free TransBuffer state, CLOCK eviction, and next-shard preallocation`
  - `01cbf9b` `[Bugfix] Propagate shared cache load failures across ranks`
  - `5e1427d` `[opt] cache: drop redundant node locks in TransBuffer::FindAt/ExistAt traversal`
- 站内延伸：[UCM v2 接口设计文档](/posts/018-ucm-v2-interface-design)、[UCM Store 的 Pipeline 架构](/posts/019-ucm-pipeline-store)、[把共享内存缓存的锁拆掉](/posts/020-ucm-cache-concurrency)、[UCM 演进之路](/posts/022-ucm-evolution)
