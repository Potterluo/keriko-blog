---
title: "把共享内存缓存的锁拆掉：UCM 桶锁乐观化与节点锁无锁化"
description: "UCM 跨进程共享内存缓存的并发控制重构：读路径改为无锁遍历、原子钉住与复验，桶锁退为慢路径兜底，槽位锁整片删除，并逐段对照 issue 设计与分支实现。"
publishedAt: "2026-10-23"
category: 项目笔记
tags:
  - UCM
  - 并发编程
  - 无锁
  - KV Cache
draft: false
---

缓存层最频繁的两个动作是"这个块在不在"和"命中，把槽位钉住"。在 UCM 的 CacheStore 里，它们都落在一张跨进程共享的哈希表上：块哈希映射到内存槽位，`BufferManager::Lookup` 对一批块**逐块**调 `Exist`，`LoadQueue` 在决定要不要搬数据之前先 `Get` 一次。这是典型的读多写少——查询是常态，插入、淘汰、槽位重配置只是偶发。

旧实现（`TransBuffer`）却把这两条读路径放在两级锁后面：每个桶一把进程间互斥锁，每个槽位节点再一把进程间自旋锁。要命的是这两把锁都住在共享内存的同一段映射里，于是"读一次缓存"的实质变成"跨进程写几个锁字"——真正的数据没动，缓存行先在核间弹了几轮。

issue 15 给出的重构思路很干净：把锁从"必经入口"挪到"状态变更点"，读路径乐观、写路径加锁兜底、节点协调完全无锁。本文按 issue 的设计加作者分支里的实现逐段对照：命中路径从"1 次桶锁 + 若干次自旋锁"变成 0 锁，槽位锁整片消失，锁只出现在分配与重配置上。

## 背景：一张跨进程共享的“块 → 槽位”表

旧结构很经典：`nHashTableBucket = 16411` 个桶，桶里挂双向链表，节点是 `BufferMetaNode`（键、shard、引用计数、所属桶、前后指针、`ready`）。共享模式由 `shareBufferEnable` 与 `uniqueId` 决定：第一个进程以 `O_CREAT|O_EXCL` 建 `/dev/shm/uc_shm_cache_<uuid>`，初始化所有锁与元数据后写 magic；后来的进程 open 到 `DuplicateKey`，走 `LoadShmBuffer` 轮询 magic 就绪，再映射同一段。

新实现把这张表重做了一遍：容器类叫 `Buffer`，槽位元数据叫 `SlotMeta`，布局定义在 `CtrlLayout` 里。布局注释先把结论说了——**"There are no slot locks"**。

```text nocollapse
共享控制面布局（CtrlLayout）
┌───────────────────────────────────────────────────────────────┐
│ Header      magic | maxRanks | nSlotsPerRank | nBuckets        │
│             rankDescs[128]（每 rank 的 ready）| clockHands[]    │
├───────────────────────────────────────────────────────────────┤
│ buckets[nBuckets]      链头数组，每桶一个 atomic<size_t>       │
├───────────────────────────────────────────────────────────────┤
│ 条带锁组[65536]        下标 = iBucket & (65536 - 1)            │
├───────────────────────────────────────────────────────────────┤
│ SlotMeta[totalSlots]   字段全原子，没有槽位锁                  │
├───────────────────────────────────────────────────────────────┤
│ PrefetchRing[128]      每 rank 一条 SPSC 预取环（深度 4096）   │
└───────────────────────────────────────────────────────────────┘
```

这张表有三个特征决定了协议该怎么设计。**第一，读多写少**：`BufferManager::Lookup` 逐块调 `Exist`，全是只读查询，写只发生在装入、淘汰与重配置。**第二，元数据小而热**：桶数组、锁组、槽位元数据全在跨进程可见的共享内存里，任何一次触碰都会引发跨核流量。**第三，引用计数天生要被多写者争抢**——这是后面一切麻烦的源头，也是无锁化真正的着力点。

## 旧实现贵在哪：两级锁、一把全局锁与共享内存里的缓存行

旧读路径是这样的：`Get` 先 `BucketLock(iBucket)`，再进 `FindAt` 沿链遍历，**每访问一个节点就取一次 `NodeLock`**、比键、`++meta->reference`、放锁；命中就解桶锁返回 `Handle`，未命中就在桶锁保护下 `Alloc`。`Exist` 那条更轻的路径也一样，`ExistAt` 对链上每个节点都取一次节点锁，只为读一个键。由于 `reference` 和 `ready` 都是普通字段，这两处自旋锁不是冗余，是必需。

于是一次命中展开成：1 次桶互斥锁，加链上被检查节点数那么多次自旋锁，再加 `Handle::Ready()` 一次、析构 `Release()` 一次；如果 `Handle` 被拷贝，`Acquire` 还要再来一次。而调用方那边，`BufferManager::Lookup` 的循环对每个块都完整走一遍这条路。

这些锁贵在四处，四处都和"共享内存"这个前提强相关。

**其一，锁字与数据同段，写锁就是写缓存行。** 桶锁数组、节点锁数组、元数据、数据区在同一段映射里，对锁字段的每次 lock/unlock 都是跨进程可见的写。真正的共享需求只是"节点状态"那几个字节，缓存行流量却主要来自锁字：P0 上的线程锁住一个桶，这条缓存行在 P0 是 Modified，P1 上任何想读该桶的线程都得先把行抢过来，哪怕它只是读。

**其二，robust 互斥锁本身很重，而且旧实现只用了它一半的能力。** 旧桶锁设了 `PTHREAD_PROCESS_SHARED`、`PTHREAD_MUTEX_ROBUST`、`PTHREAD_MUTEX_ADAPTIVE_NP` 三个属性。robust 是为了持锁进程崩溃后别人能接管，代价是锁字里要维护持有者簿记，每次加解锁都在写共享内存；adaptive 让它先自旋再进内核阻塞，竞争一起来就同时烧 CPU 和系统调用。更微妙的是：`pthread_mutex_lock` 在 robust 锁上会返回 `EOWNERDEAD` 表示"上一个持有者死了"，旧代码直接忽略了返回值——设了属性却没处理接管语义。

**其三，锁数组连续排布，带来伪共享。** `bucketLocks[16411]` 是紧密数组，相邻桶的锁字段落在同一条缓存行上：锁 A 桶会 invalidate 与 B 桶共享的那条行。`nodeLocks` 同理。团队显然是认这个坑的——后续分支里 `nodeCursor` 专门加了 `alignas(64)` 和 64 字节 padding 把它隔离出去。

**其四，自旋等不到人。** 节点锁是 `pthread_spinlock_t`，跨进程自旋意味着等待者在用户态死转，没有"持锁者被抢占就降级"的机制。持锁线程一旦被调度走，等待者空转的时间就是纯浪费。

还有一个容易漏掉的串行化点：共享模式下 `FetchNode` 要拿 `header_->lock`。这把锁与桶无关，却是**所有进程分配槽位的唯一出口**。新实现把它彻底拆了——每个 rank 拥有自己的一段槽位（`[rank * nSlotsPerRank, (rank + 1) * nSlotsPerRank)`），并配一个属于自己的 CLOCK 手 `clockHands[rank]`，分配与淘汰都不再跨进程争用。

### 新旧路径对照

| 维度     | 旧 `TransBuffer`                                             | 新 `Buffer`                                                              |
| -------- | ------------------------------------------------------------ | ------------------------------------------------------------------------ |
| 桶锁形态 | 16411 把进程间互斥锁，一桶一把                               | 65536 把条带锁，桶号按位与映射，锁数与桶数解耦                           |
| 槽位锁   | 每槽位一把进程间自旋锁                                       | 无（"There are no slot locks"）                                          |
| 读命中   | 1 次桶锁 + 链上逐节点自旋锁 + `Ready`/`Release` 各一次       | 0 锁：`LookupOptimistic` 遍历 + `PinHit` 的 CAS 与复验                   |
| 分配路径 | 全局锁取槽位 + 目标桶锁 + 旧桶 TryLock + 节点锁 + 邻居节点锁 | 每 rank 独立槽位段与 CLOCK 手；只碰目标条带锁与旧桶条带 TryLock          |
| 键比较   | 16 字节块哈希整体比较                                        | `MatchKey`：先比所属桶，再比 3 个 `size_t` 字                            |
| 句柄语义 | `Handle` 可拷贝，拷贝一次 Acquire、析构一次 Release          | `Handle` 只可移动（拷贝已删除），析构一次 `fetch_sub`                    |
| 状态发布 | `ready` 是普通 bool，靠节点锁保护                            | `state` 是原子，写端 release、读端 acquire                               |
| 崩溃兜底 | 设了 robust 却不检查 `EOWNERDEAD`                            | 条带锁换成 `UC::SharedMutex`，`EOWNERDEAD` 走 `pthread_mutex_consistent` |

一句话概括：旧路径把锁放在"必经入口"，新路径把锁放在"状态变更点"。读多写少时，这两者的差距不是常数倍微调，而是"每次访问都有共享写"和"只有变更才有共享写"的差别。

## 读路径：过滤 — 钉住 — 复验

新读路径的骨架在 `Buffer::Exist` / `Buffer::Get` 里，可以拆成五段：

```text nocollapse
读者快路径（全程不取桶锁）

  HashKey(blockId, nBuckets) -> iBucket        // 2 的幂掩码
           │
           ▼
  LookupOptimistic：head = buckets[iBucket].load(acquire)
           │
           ▼
  ┌─ 沿 next 无锁遍历 ───────────────────────────────┐
  │   每步 MatchKey：先比 hash（所属桶），再比 3 个字 │
  │   不匹配就 node = next，不取任何锁                │
  └────────────────────────┬─────────────────────────┘
                           │ 匹配候选
                           ▼
  PinHit：CAS(reference, r -> r + 1)        // acq_rel
           │                    │
        成功                  失败
           │                    │
           ▼                    ▼
  复验 MatchKey（重读键）   若 r == kSlotClaimed：yield 后重试
           │                    │ 超过 kPinSpinFast = 64
     ┌─────┴─────┐              ▼
   一致        不一致      回退慢路径：LockOf(iBucket)->Lock()
     │           │         → Lookup → PinHit(kPinSpinSlow)
     ▼           ▼              → 仍失败则 Alloc
    HIT      放回 pin，
            返回未命中
```

几个细节值得展开。

**"指纹过滤"在实现里就是所属桶过滤。** `MatchKey` 第一句是 `meta.hash.load(acquire) != iBucket` 就返回 false：节点被摘链时 `hash` 被置成 `kInvalidIndex`，正在重配置的槽位因此天然不匹配任何桶。过了这一关才比较键——而键也不是 `BlockId` 整体比较，而是拆成两个 `size_t` 字加一个 offset，逐字比、早退，这与整体比较等价但省掉了拷贝。

**钉住是 CAS 而不是自增。** `PinHit` 的循环里先做 `MatchKey` 过滤，再读 `reference`：若等于 `kSlotClaimed`（`SIZE_MAX`，写者独占的哨兵值）就 `yield` 后重试；否则用 `compare_exchange_weak` 做 `r -> r + 1`。这里的关键是 0 也是一个特殊值：`r == 0` 意味着这个槽位此前无人持有，调用者因此成为 owner，需要负责把数据装进来。

**复验不能省，它封的是一个真实窗口。** 读者在 t1 读到键（等于目标），在 t1 到 t2（CAS 成功）之间，写者可能已经把槽位独占、摘链、改写成了别的块，再把引用计数放回 0——读者的 CAS 正好落在这个空档里就会成功，但槽位内容已经换了。代码里这一段写得很直白：复验不匹配就 `fetch_sub(1, release)` 把 pin 放回去、返回未命中。反过来，若 CAS 落在写者独占期间，`reference` 是 `kSlotClaimed`，CAS 直接失败——所以真正需要复验兜住的只有"钉住成功但内容已换"这一种。

**两个自旋预算是有分工的。** 快路径用 `kPinSpinFast = 64` 次 `yield`，超了就回退；慢路径用 `kPinSpinSlow = SIZE_MAX`，也就是愿意一直等。理由写在注释里：在持有桶锁的情况下，链上槽位的独占声明必然是短暂的——声明者会尝试锁本桶、失败、然后回滚——所以慢路径可以放心地等它结束。这段论证很值得记：它把"什么时候可以自旋"从经验变成了结构性质。

**兜底路径的语义与旧实现完全一致。** `Get` 的顺序是：乐观查找 → 快速 `PinHit` → 不行就 `LockOf(iBucket)->Lock()` → 加锁查找 → 慢速 `PinHit` → 还不行就 `Alloc`。快路径只是"绕过锁的加速器"，不是一条新的语义路径。工程上这点比性能更重要：所有保险丝都通向一条已经跑过的老路，不会引入新的正确性分支。

顺带看一眼 `Touch`：它给一组块刷热度，实现里直接无锁走链——桶过滤加块字匹配通过就把 `accessed` 置 1，全程不 pin、不改引用计数，注释明说这是 best-effort：链上节点随时可能被摘走，漏标几个不影响正确性，只影响淘汰的准确度。这条路径最能说明读写的边界该怎么划：凡是"标错了也不影响正确性"的写，就可以和读一起留在无锁侧。

## 写路径：独占 — 隔离 — 改写 — 发布

写路径不能乐观，原因是硬性的：一次重配置要同时改键（两个 `size_t` 字加一个 offset）、所属桶、前后指针、状态位，它们分布在同一个 `SlotMeta` 里，没有任何一条指令能整体原子替换。所以顺序是"先让别人看不见，再慢慢改，最后重新发布"。

```text nocollapse
写者（Alloc：槽位重配置 / 分配）

  Get 已在目标桶锁内 ──> Alloc
           │
           ▼
  FetchNode：clockHands[rank] 环形扫描，
             accessed 位为 1 就清 0 继续（CLOCK 二次机会）
           │
           ▼
  [1] 独占声明：CAS(reference, 0 -> kSlotClaimed)
           │        失败 => 槽位仍被 pin 住，恢复 accessed 位，换一个
           ▼
  [2] 隔离：从旧桶链 Remove（需 TryLock 旧桶条带锁）
           │        同条纹带 TryLock 会打自己 => 回滚 claim，换一个再来
           │        摘除后 hash = kInvalidIndex，对无锁遍历者不可达
           ▼
  [3] 改写：StoreKey（3 个字）+ state = Loading + accessed = 1
           │        此刻不会有人看到半新半旧的键
           ▼
  [4] 发布：MoveTo —— 先接好 next/prev，
           │        再 hash.store(iBucket, release)，
           │        再 buckets[iBucket].store(iNode, release)
           ▼
  reference.store(1, release)：新键对 acquiring 读者可见
```

四个阶段的职责分得很清。

**独占声明是整套协议唯一的互斥点。** 读者的 pin 是 `0 -> 1` 的 CAS，写者的独占是 `0 -> kSlotClaimed` 的 CAS，两者从同一个值出发，硬件保证只有一个成功。这就是节点锁可以整片删掉的根因——不需要锁来协调，因为协调对象只有一个原子字段。

**隔离用"可达性"代替锁。** 跨桶重配置时，摘链之后 `hash` 置为 `kInvalidIndex`，`MatchKey` 的桶过滤立刻让它对所有遍历者失效，键的改写发生在不可达期间。同桶复用是唯一的例外——槽位留在链上，读者理论上能读到"三个字刚写了一半"的组合键；但那段时间 `reference` 是 `kSlotClaimed`，没人能 pin 成功，钉住后的复验又会重读一遍，所以它最多让读者白跑一次，不会变成假命中。这个例外正好说明复验为什么必须存在：光靠"摘链等于不可见"覆盖不到所有路径。

**发布靠顺序。** `MoveTo` 里 `hash` 用 release 写、链头也用 release 写，且必须在链头之前；读者读链头用 acquire，读 `MatchKey` 里的字段也用 acquire。于是"看到链头"就必然"看到完整键"。

**跨桶写靠 trylock 避免死锁。** 重配置一个槽位要同时涉及旧桶（摘除）和目标桶（链入），实现里只对旧桶用 `TryLock`，拿不到就回滚独占声明、换下一个 CLOCK 候选。注释点出了最微妙的一种情况：同一个条纹带上的 `TryLock` 会打到自己已经持有的目标桶锁，此时必然失败、必然回滚、必然换候选，所以这个退避循环一定能推进。这里没有"等一下"的路径，因此不存在持 A 等 B 的环。顺带说，这条规则旧代码里就有了——旧 `Alloc` 对旧桶用的就是 `BucketTryLock` 加 `continue`，新设计把这条已验证的顺序规则原样保留，只是把锁换成了条带。

还有一个细节值得记：`Alloc` 内部其实分两条路。旧桶与目标桶不同时，才走完整的"摘除—改写—链入"；相同时只做 `StoreKey` 加状态重置，因为槽位本来就挂在这条链上，链指针一根都不用动。这条分支平淡，却是 `MoveTo`/`Remove` 能被降频的关键——重配置大多数时候发生在同一个桶里，而跨桶那次才是真正要小心的一致性问题。

## 正确性：为什么节点锁可以整片删掉

先问一句：旧代码里的 `NodeLock` 到底保护了什么？`FindAt` 里保护"比键 + 读引用计数 + 自增"；`Alloc` 里保护"检查引用计数、改键、改状态"；`MoveTo`/`Remove` 里保护邻居节点的 `prev`/`next`；`Acquire`/`Release`/`Ready`/`MarkReady` 里保护引用计数与状态位。归纳起来就一句话——**它保护的几乎全是"可以被原子化的单字段读改写"，剩下的只有"多个字段之间的一致性"**。

于是论证可以拆成三条不变量。

**I1（互斥性）**：`reference` 是唯一的协调点，取值只有三种语义：0 表示可回收，`kSlotClaimed` 表示写者独占，中间值表示 n 个读者持有。读者要 `0 -> 1`，写者要 `0 -> kSlotClaimed`，都从 0 出发，CAS 保证只有一个成功。所以"任一时刻，槽位要么被读者钉住，要么被写者独占"，不存在同时。

**I2（不可见性）**：键的改写原则上发生在槽位摘链之后。16 字节的键没法一条指令改完，而"摘链"让槽位对遍历者不可达，于是半新半旧的状态没有观察者。发布用 release、消费用 acquire，保证看到指针就看到完整字段。同桶复用是这条不变量的边界情形，靠 `kSlotClaimed` 加复验补齐（见上节）。

**I3（命中可信）**：报告命中之前必须复验。复验对象是"钉住瞬间的键"，与候选阶段读到的快照一致才返回，否则放回 pin 返回未命中。这就排除了"读键是 A、钉住时已换成 B"的竞态。

还有一处容易写错的地方，代码注释特意解释过：`state` 由 `MarkReady`/`MarkFailed` 以 release 写，怎么保证后来的 pin 者看得见？答案是**引用计数上的 release 序列**——前一个持有者在析构时做 `fetch_sub(1, release)`，这个 RMW 操作延续了 release sequence，于是下一个 pin 者的 acquire-CAS 会和持有者 `Release` 之前做的一切同步。换句话说，"最后一个放手的人"顺手把可见性也交接了。这类论证在无锁代码里必须显式写出来，否则就是靠运气。

至于槽位复用带来的 ABA，实现的处理是不比较指针身份、只比较内容：`MatchKey` 的桶过滤加键字比较，让"指针值相同、内容已换"复用节点不会误报命中。读者沿旧 `next` 走到一个已被摘链的节点时，桶过滤会让它不匹配，最坏是白走几步。**需要说明的是，这里没有"基于版本号/宽限期"的回收机制**：槽位被摘链后立刻可以被复用，安全性完全建立在"读者不会跨过 pin 继续依赖内容"这一点上——所以 `Handle` 是移动语义、生命周期严格绑定一次 pin，这不是风格选择，是协议要求。

## 什么时候仍会退化

任何"把锁挪走"的方案，代价都会在别处出现。这套设计至少在下面几种情形下不划算，甚至更差。

**写比例上升时。** 容量吃紧、淘汰频繁、重配置多的时候，写路径占比变高，而写路径仍要条带锁、仍要改共享内存。锁没有消失，只是被挪到了一个稳态下不常被踩的位置。缓存越接近满，这个假设越不成立。

**全槽位被钉住时，分配会在持锁状态下空转。** `Alloc` 的注释自己承认：设计假设是"每 rank 的槽位数远多于同时被 pin 住的槽位数"，所以候选扫描不会饿死；但如果真出现所有槽位都被 pin 住，调用者会**持有桶锁一直转**。这是这套设计里最硬的一个边界，比"回退慢路径"严重得多。

**链长假设是写死的。** 桶数由 `CalcBucketCount` 按 `16 × nSlotsPerRank / 2` 估出来，注释里写明这个系数对应"99% 的部署里 rank 数小于 16、平均链长不超过 2"。rank 数一大就退化：注释自己举了例子，128 个 rank 时平均链长约 12。链一长，读路径的"过滤后走链"成本就线性上升——过滤只能免掉读键，免不掉走链。

**条带锁在桶数远大于锁数时会被共享。** 65536 条带、桶数上限 2 的 24 次方，意味着最多 256 个桶共用一个条带。命中路径不受影响（不取锁），但写路径的伪冲突会随桶数上升而变密，而"同一条带撞到自己"的回滚正是 `Alloc` 的重试来源。

**命中也并非零共享写。** 一次命中要写 `accessed`（CLOCK 位）、做一次引用计数 CAS、析构时再做一次 `fetch_sub`，三次都是跨进程可见的写，其中两次是 RMW。比起"加 robust 互斥锁再改两个字段"便宜太多，但不是免费。准确的说法是"命中路径几乎没有锁"，而不是"命中路径没有共享内存流量"。

**崩溃残留没有兜底。** 条带锁那侧还好：`UC::SharedMutex` 会在 `EOWNERDEAD` 时调用 `pthread_mutex_consistent`，持锁进程死掉不会锁死别人。但无锁那侧不行——`kSlotClaimed` 没有租约、没有超时、没有持主标记，一个进程如果在独占声明期间崩溃，那个槽位就永久停在 `kSlotClaimed`，`Alloc` 每次扫到它都只是跳过。遍历者的安全性没问题（摘链后 `hash` 无效，注释也提到 crash 残留会被桶过滤挡住），但容量会慢慢泄漏。这是我看本地镜像时最想补的一处。

**还有一个运维约束：所有 rank 必须跑同一个二进制。** 布局版本号 `kMagic` 变一次就不兼容，加入方校验失败就退出——这对"滚动升级"是硬限制。

## 代码侧现状：设计、实现与分支

写技术文章最容易犯的错是把设计当既成事实，所以把边界划清楚。

**旧实现的确认**（`dev-cache-mp-test` 分支，头提交 `de517d5`，2026-03-28）：`ucm/store/cache/cc/trans_buffer.h`、`trans_buffer.cc` 里的 `TransBuffer` 就是 issue 所说的纯悲观实现；`BufferStrategy` 接口暴露 `BucketLock`/`BucketTryLock`/`NodeLock`/`NodeUnlock`/`FirstAt`/`FetchNode` 等；`LocalBufferStrategy` 是 `LocalMutex bucketLocks_[16411]` 加 `LocalLock` 数组；`SharedBufferStrategy` 的 `BufferHeader` 里放着 `ShareMutex bucketLocks[16411]`、`ShareLock nodeLocks[0]` 和那把全局分配锁。这些类名、字段名与本文描述一一对应，没有一处是推测。

**新实现的确认**（`debug-perf-2609-mag1c` 分支，Mag1c.H 的三个提交 `9dd9ba8`/`1c5f958`/`4223e25`，2026-09-10 至 09-11）：`ucm/store/cache/cc/cache_buffer.h` 是新的 `Buffer`，`cache_types.h` 定义 `SlotMeta`/`kSlotClaimed`/`kLockStripes`/`CalcBucketCount`/`MatchKey`，`ctrl_layout.h` 定义共享内存布局与 `LockOf`，`ucm/shared/infra/mutex/shared_mutex.h` 是条带锁用的 `UC::SharedMutex`。issue 里的读写协议在这里都有对应的代码：乐观遍历是 `LookupOptimistic`，过滤—钉住—复验是 `MatchKey` 加 `PinHit`，独占—隔离—改写—发布是 `Alloc` 里的 claim/`Remove`/`StoreKey`/`MoveTo`。**但这套实现没有合进 `develop`**：`develop` 上仍然是 `TransBuffer` 加逐节点 `NodeLock`，`trans_buffer.cc` 里 `Get` 的第一步依旧是 `BucketLock`。它只在作者自己的调优分支上。

**时间线上有个小反转**：issue 15 创建于 2026-09-15，仍是 OPEN、零评论；而分支上的实现提交比 issue 早四五天。所以更准确的说法是——代码先跑起来，issue 随后把设计写成了文。

`develop` 上还有两笔"半步"改动方向一致但没走到位：`d7f2d7d`（2026-08-25，PR #1274）在旧 `TransBuffer` 上把 `state`/`errorCode` 原子化、上 CLOCK 位图、给 `nodeCursor` 做缓存行隔离；`5e1427d`（2026-09-01，PR #1315）去掉了遍历途中的节点锁，只在命中节点上取一次。它们改的是旧容器，而 `Buffer` 是另一个容器。

同一块系统的其他切面值得对着看：[019 的 Pipeline Store](/posts/019-ucm-pipeline-store) 讲这条共享内存通道在数据面上怎么被流水线化使用，本文讲它内部那张表的并发协议；[021 的多 rank 共享加载](/posts/021-ucm-multi-rank-load) 讲多个 rank 如何共享同一份缓存，正是"锁为什么跨进程"的来处，也是新实现里每 rank 槽位段与 fd 传递那一层的动因；[022 的演进记录](/posts/022-ucm-evolution) 把这类改动放回时间线；接口契约层看 [018 的 v2 接口设计](/posts/018-ucm-v2-interface-design)；混合模型下的分层设计看 [UCM 混合缓存设计](/posts/ucm-hybrid-cache-design)。

## 小结

**锁的位置比锁的数量更重要。** 旧实现不是"锁太多"这么简单——它把锁守在最热、最不该有共享写的入口上。同一批锁如果只出现在分配、淘汰、重配置，代价会小一个量级，因为那些操作本来就要改共享状态。

**读多写少的系统里，"不写"就是优化。** 命中只写三次共享内存——`accessed` 位、pin 的 CAS、析构的 `fetch_sub`——其余全是读；这是这套设计真正省下来的东西，而不是把互斥锁换成自旋锁之类的技巧。

**无锁化不是删锁，是换一种表达"看不见"的方式。** 节点锁能整片删掉，靠三层替代：用 CAS 表达"谁持有"（I1），用摘链的不可达性表达"别读"（I2），用复验表达"我确认过"（I3），再用 release/acquire 把可见性交接出去。缺任何一层，这套协议都不成立。

## 参考来源

- issue：[缓存管理并发控制优化：桶锁乐观化与节点锁无锁化](https://github.com/mag1c-h/unified-cache-management/issues/15)（mag1c-h/unified-cache-management #15，2026-09-15 创建，OPEN，零评论）
- 仓库：[mag1c-h/unified-cache-management](https://github.com/mag1c-h/unified-cache-management)；其 `develop` 与上游主仓 [ModelEngine-Group/unified-cache-management](https://github.com/ModelEngine-Group/unified-cache-management) 同一个 HEAD（`4e47254`），而本文引用的实验分支只存在于前者
- 旧实现：`ucm/store/cache/cc/trans_buffer.h`、`trans_buffer.cc`、`buffer_manager.h`，分支 `dev-cache-mp-test`（`de517d5`）
- 新实现：`ucm/store/cache/cc/cache_buffer.h`、`cache_types.h`、`ctrl_layout.h`、`ucm/shared/infra/mutex/shared_mutex.h`，分支 `debug-perf-2609-mag1c`（`9dd9ba8`、`1c5f958`、`4223e25`）
- 旧容器上的半步改动（`develop`）：`d7f2d7d`（2026-08-25，PR #1274）、`5e1427d`（2026-09-01，PR #1315）
- 站内相关：[019 Pipeline Store](/posts/019-ucm-pipeline-store)、[021 多 rank 共享加载](/posts/021-ucm-multi-rank-load)、[022 UCM 演进](/posts/022-ucm-evolution)、[018 UCM v2 接口设计](/posts/018-ucm-v2-interface-design)、[UCM 混合缓存设计](/posts/ucm-hybrid-cache-design)
