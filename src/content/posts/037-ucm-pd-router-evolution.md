---
title: "UCM PD Router 设计五易其稿：协调器如何被一笔笔删没"
description: "28 分钟内五轮问答，PD Router 从六个组件的请求编排器退成只管节点选择和请求生命周期的轻路由，协调域、缓存域、预取域相继移除的推导过程，以及定稿依赖的三个未验证前提。"
publishedAt: "2026-11-14"
category: 项目笔记
tags:
  - UCM
  - PD 分离
  - 架构设计
  - KV Cache
  - Router
draft: false
---

2026 年 11 月 14 日 14:42，我抛出第一个问题：「做一个最基础的 LLM PD 分离 router，应该怎么做？」

接下来的 28 分钟，我和模型围绕 UCM 的部署形态连问五轮。每一轮都建立在上一轮对 UCM 描述的补充上，每一轮都推翻了上一版的核心抽象。等 15:10 最后一轮收尾，第一版里六个 Router 内部组件只剩两个：节点选择和请求生命周期。

这篇文章按当时问答的顺序复盘：每版设计解决什么问题、在哪个事实上站不住、下一版因此切掉什么。文中的代码片段和配置数值都只是设计示意，没有落地实现，也没有实测数据。

## 材料与口径

讨论素材是一份 ChatGPT 对话导出（模型标注为 gpt-6-t-mini / gpt-6 / gpt-6-mini，导出未注明版本对应规则），五轮问答发生在 14:42 到 15:10 之间。

UCM 的背景词汇和接口口径来自站内几篇旧文，可以对照着看：

- [UCM v2 接口设计文档](/posts/018-ucm-v2-interface-design)：分级存储的整体语义和 Store 契约；
- [UCM 演进之路](/posts/022-ucm-evolution)：`StoreV1` 从 7 个抽象方法长到 11 个的过程；
- [切分方式决定部署形态](/posts/036-parallelism-and-pd)：传统 PD 分离中 P→D 的 KV 传输账。

讨论中关于 vLLM、SGLang 现有实现的说法，模型给了引用标记但我没有逐条回查源码。下文中这些内容按讨论口径写，并标明是外部实现的参照；凡是 UCM 的事实，按我在讨论中提供的前提写：

1. KVCache 以哈希值做文件名，落在共享文件系统上；
2. 系统去中心化，没有 master server；
3. Prefetch 没有独立 RPC，靠 Decode 请求中的关键字触发。

讨论里出现过的阈值、带宽、字节数（例如 `min_hit_tokens: 4096`、`max_prefetch_bytes_per_node: 17179869184`）都是接口形状的示例，数值没有校准。这套设计至今没有进入实现阶段，文末列出定稿依赖的待验证前提。

## v0：先按传统 PD 分离起步

第一问没有限定 UCM。模型给出的最小架构里，Router 是一个轻量请求编排器，内部有六个组成：P Selector、D Selector、Request Coordinator、Node Registry、状态机，外加一个 Backend Adapter 的抽象。

![图 1 五版设计的组件消长：从左到右五个阶段，色带是各版对 Router 的定位，下方黄色便签是触发改动的提问](/img/037-ucm-pd-router-evolution/fig-01.svg)

一次请求沿串行链路走七步：接收、选 P、选 D、Prefill、协调 KV 传输、Decode、透传结果。职责边界划得很清楚：

- P 节点算 Prompt 并产出 KVCache；
- D 节点加载 KVCache 并逐 token 生成；
- KV Transfer Backend 负责真正的数据搬运；
- Router 负责选节点、建关联、协调执行和处理异常。

Router 不自己搬运 GPU 上的 KV Tensor，也不实现底层传输协议。这里点出一个容易混的点：KV 传输完成和 Prefill 执行完成是两件事，不能因为 P 返回成功，就认为 D 可以开始 Decode。

节点管理先用静态 YAML，负载均衡先用 Round Robin，P 和 D 各自持有独立的轮询状态。模型同时给了一个当时看似顺带的判断：结合 UCM，KV 协调存在两种模式，Router 主动编排，或者 Decode 主动预取；它倾向后者。

这个倾向性判断成了后面四版所有改动的起点。

## v1：三层初稿，两个核心领域

第二问把场景限定到 UCM，要求按领域层、应用层、适配层设计。

v1 采用 DDD 分层加六边形架构。模型先收边界：这个 Router 的核心业务只有两件事，路由决策和请求协调；同时明确三件不属于它的事，不管理 KVCache 生命周期和存储策略，不实现 KVCache 的网络传输，不管理 Token 级别的 Batch、Sequence 和 GPU 调度。

领域层被切成两个子域。Routing 域回答「请求该由哪个 P 和哪个 D 处理」，核心对象包括：

| 对象            | 承担的事实                     |
| :-------------- | :----------------------------- |
| ServingGroup    | 一组 KV 兼容的 P/D 实例        |
| ServingNode     | 角色、地址、兼容配置、最大并发 |
| NodePool        | P、D 各自独立的节点池          |
| RouteAssignment | 一次冻结的 P/D 分配结果        |

ServingGroup 的存在理由是兼容性约束：模型版本、Tokenizer、KV 数据类型、KV Layout、并行配置和传输协议不一致的节点不能配成一对。

Coordination 域解决普通负载均衡器不管的事：保证 P 产生的 KV 能被对应的 D 使用。它引入了 RequestSession 和 PrefetchDirective，后者表达「哪个 D 从哪个 P 获取哪个请求的 KV」，有意不放任何具体传输协议的参数。

应用层是四个用例，其中最核心的 RouteCompletion 按十步串起整个流程：解析 ServingGroup、选 P、选 D、预占容量、建会话、提交 Prefill、协调预取、提交 Decode、代理流、清理。

v1 留下的一条关键规则是：路由策略只根据节点负载做决策，不根据 KVCache 命中率做决策。UCM Connector 在 Prefill 侧决定如何复用已有 KV，Router 只决定请求落到哪两个节点。

这条规则在三句话之后就被我自己的下一问推翻了。

## v2：集中式存储下，Router 转向缓存感知

第三问里我给出一个当时的判断：「UCM 的特殊点在于是集中式的 KVCache 存储，因此 PD 无需关心彼此。」接着问，Router 能否 lookup KVCache，在一定阈值下提前启动 D，把 SSD 到 DRAM 的预取藏在 Prefill 时间里。

模型认为这会改变整个请求生命周期。Router 的核心职责从 P/D 请求协调，转向缓存感知路由与预取编排，被重新定义成 Request Router 加 Cache-aware Scheduler 加 Prefetch Coordinator。

![图 2 v2 的并行生命周期：Cache Lookup 之后分成两条支路，左侧算未命中并写回，右侧提前提升已有 KV，汇合后做 Decode Admission](/img/037-ucm-pd-router-evolution/fig-02.svg)

用一个 32K 请求说明收益：24K Token 已有前缀缓存，8K Token 未命中。传统链路里 D 要等 P 算完、写完，才开始读全部 32K 对应的 KV。v2 把链路改成：

1. Router lookup，确认 24K 命中；
2. P、D 独立选出；
3. P 开始算 8K 未命中部分；
4. D 同时把 24K 的 KV 从 SSD 提升到本地 DRAM；
5. P 的新 KV 写入共享存储；
6. 全部所需 KV 可读取后，D 开始 Decode。

预取的 IO 被 Prefill 的计算时间盖住，这是 Router 真正能创造的性能价值。

领域层随之从两个子域扩到四个：Routing、Cache、Prefetch、Request。新增的关键对象是：

| 对象             | 表达的内容                       |
| :--------------- | :------------------------------- |
| CacheMatch       | 命中块数、命中 Token、估算字节数 |
| PrefetchDecision | 是否预取、目标节点、原因         |
| PrefetchTask     | 一次有状态的 SSD→DRAM 加载       |

请求状态机也从串行变成双分支汇合：P 支路走到 KV_PERSISTED，预取支路走到 PREFETCH_READY，汇合点是 Decode Admission，判断条件为：

$$
KV_{\text{required}} \subseteq KV_{\text{available}}
$$

两条规则保证优化不反噬主流程：预取失败不能让请求失败，退回普通按需加载即可；预取是优化路径，不是正确性路径。

v2 还有一条明确的工程边界：Router 不能自己重算 UCM 的 Block Hash。缓存 Key 必须遵循引擎的 Tokenization、Block 划分、Hash 和 Namespace 规则，因此 Cache Lookup 应由 UCM 提供能力，Router 只拿摘要结果。

正是顺着这条边界往实现细节追，v2 的四个子域在接下来被砍掉两个。

## v3：去中心化事实下，先删独立服务

第四问我纠正了第三问里的前提：UCM 实际是去中心化设计，没有 master server，命中判断依靠文件系统，哈希值直接做文件名。同时补充，Prefetch 没有单独接口，依靠请求中的关键字实现。

模型据此删掉两类组件：独立的 Cache 服务和独立的 Prefetch Controller。没有 master，就不该为了查询缓存再造一个中心化组件；预取既然依附请求存在，就不该先有一个独立的控制 RPC。

v3 的形状是「领域能力保留，执行方式改变」：

- Cache Awareness 仍是 Router 主动执行的查询，但实现路径是复用 UCM 的 Hash 公共逻辑加文件系统存在性检查，而不是调用一个 Cache 服务；
- Prefetch 决策仍是领域策略，但删掉 PrefetchTask 这个由 Router 自行管理的任务实体，决策结果随 Decode 请求下发；
- PrefetchDecision 只回答要不要、为什么、规模多大，不回答怎么发、怎么构造参数、怎么跟踪完成。

复用不能只拿一个 Hash 函数。Tokenizer 与 Token IDs、Block Size、前缀 Hash 算法、Namespace、文件命名与路径规则必须全部来自同一份 UCM 公共逻辑，否则 UCM 改一处，Router 就错一处。文件查询本身也有成本，连续前缀命中时应遇 Miss 即停，且 MISS 与 LOOKUP_ERROR 必须是两种结果，文件系统的短暂抖动不能被当成缓存未命中。

预取的执行时机有两种可能。理想方式是 Decode 请求提前提交，携带关键字，Connector 自己等待未就绪的 KV；退路是先发一次预取请求，再发正常 Decode。前者要求 Connector 能正确处理 P 尚未写入的部分。

应用层的 Port 被压到四个：

| Port              | 作用           | 第一版实现             |
| :---------------- | :------------- | :--------------------- |
| NodeProvider      | 获取节点与负载 | 静态 / K8s             |
| CacheLookup       | 查询前缀命中   | UCM Hash + 文件系统    |
| EngineClient      | 提交 P/D 请求  | vLLM / MindIE / SGLang |
| SessionRepository | 请求上下文     | 内存                   |

PrefetchPort 被明确删除。未来 UCM 如果增加独立预取 API，可以新增 Port，不需要改 Domain 和 Application 的核心逻辑。

v3 看似已经收敛。但它仍然要求 Router 持有一份 UCM 公共逻辑，下一问直接质疑这份持有是否值得。

## v4：Router 完全不感知 Hash

第五问我点破 v3 的两个具体负担：Router 如果要做 Cache Awareness，是否需要持有 Tokenizer？没有 Tokenizer，请求无法转成 Block 哈希；即使能转，Router 是否还要感知 UCM 的 Hash 逻辑，包括模型名、部署方式对命名的影响？随后给出方向：Router 能否完全不感知哈希，直接把请求发给 P 和 D，D 的启动时机完全由 UCM 控制。

模型给出了肯定答案，v4 把 Cache 和 Prefetch 两个子域整体移出 Router。

![图 3 命中判断所需四样知识的归属：Tokenizer 属于引擎，Block 规则、Namespace、文件状态属于 UCM；两条自建路线都被否定](/img/037-ucm-pd-router-evolution/fig-03.svg)

判断依据是知识的归属。命中一次前缀需要四样东西：与引擎严格一致的 Tokenizer、UCM 的 Block 划分与 Hash 版本、由模型名和部署方式决定的 Namespace、共享文件系统上的实时文件状态。这四样知识原本就分布在引擎和 UCM 手里，Router 为做一次判断把它们复制进来，等于主动承担 UCM 内部实现细节的长期维护责任。

v4 的职责重划如下：

- Router 决定请求去哪个 P、哪个 D，并管理请求生命周期；
- P 执行 Prefill，通过 UCM 持久化 KV；
- D 尽早收到 Decode 请求；
- D 侧 UCM Connector 判断 KV 是否可用、是否需要 SSD→DRAM 提升、是否等待 P 尚未写入的部分，全部就绪后放行 Decode。

这里要分开两个概念：D 节点选择仍是 Router 的职责，Decode 的实际执行时机属于引擎和 UCM Connector。Router 不感知缓存，也能尽早把请求送到 D，等待发生在 D 侧。

![图 4 v4 定稿的分层与进程边界：Router 进程内只剩 Routing 和 Request 两个领域，命中判断在 D 节点的 Connector 中](/img/037-ucm-pd-router-evolution/fig-04.svg)

Port 从四个再降到三个：NodeProvider、EngineClient、SessionRepository。CacheLookup 也删除，Router 不需要调用任何缓存查询能力。

未来如果 Router 确实需要利用缓存信息优化调度，正道是 UCM 暴露一个高层能力，例如带置信度的 Cache Scheduling Hint（估算可复用 Token 数与预取代价），而不是让 Router 引入 Tokenizer 和 Hash 细节。

## 五版共同的错误假设

回头看，五版之间的反复返工可以归到四个错误假设上，比逐版罗列更有信息量。

第一个假设是「设计可以脱离部署事实先行」。v1 的两域、v2 的四域都建立在我对 UCM 形态的口头描述上，而这些描述直到第四、第五问才补全。架构图先于事实定稿，返工就是必然。讨论中真正稳定的信息只有最朴素的三条：哈希做文件名、无 master、请求关键字触发预取。

第二个假设是「为了优化路径，值得复制一份判断知识」。v2 和 v3 都让 Router 向缓存判断靠近，代价是持有 Tokenizer、复制 Hash 规则、跟随 UCM 版本升级。检验一个抽象该不该留，可以直接问删掉它之后谁会变形：删掉 Router 的缓存感知后，变形的是 UCM Connector，而它本来就持有全部判断知识；保留它，变形的反而是 Router。

第三个假设是「每个能力都该对应一个独立服务或接口」。v2 设计了独立 Lookup 服务，v2、v3 一度保留独立 Prefetch 接口。实际实现里预取依附 Decode 请求存在，独立接口与真实触发方式相冲突。抽象应该对应业务能力，不对应机械的 RPC 切分。Cache Lookup 最终连业务能力也不再需要，因为 Router 不做缓存决策。

第四个假设是「性能收益的位置决定职责的位置」。既然 SSD→DRAM 预取能降低 TTFT，似乎 Router 就该亲自编排。v4 的结论恰好相反：正因为收益来自 KV 状态，而最了解 KV 状态的是 UCM Connector，职责才更该留在那里。谁掌握数据，谁负责数据就绪。

五版里始终没变的只有底层三条边界：Router 做路由与生命周期，Engine 做推理，UCM 做缓存管理与数据移动。定稿的三句话版本是，Router 决定请求去哪里，UCM 决定 KV 如何准备好，Engine 决定什么时候执行计算。

## 定稿依赖的待验证前提

v4 还停留在纸面，成立与否取决于三个前提，这些都没有在真机上验证：

1. D 侧 UCM Connector 具备请求级的 KV 就绪判断和等待能力，能处理 P 尚未写入的 KV，而不仅仅是响应关键字发起一次预取；
2. Decode 请求提前到达 D 时，Connector 的等待不会占住引擎的 Decode 槽位造成新的队头阻塞，预取容量与 Decode 并发之间需要有明确的准入控制；
3. 文件系统层面「哈希文件可见」与「KV 数据可完整读取」之间的时间差，由 Connector 的就绪语义兜住，Router 提前提交请求不会让引擎读到半成品。

这三条里任何一条不成立，Router 仍然可以不感知 Hash，但需要在 D 侧补足等待与准入机制，而不是把判断逻辑搬回 Router。

落地顺序也按这个边界安排：先用单 P 加单 D 跑通无缓存感知的端到端请求，确认 Connector 的就绪等待可靠；再扩多 P、多 D 和独立选择策略；缓存预取的阈值、收益判断、去重与资源水位，全部作为 UCM 侧能力验证，不进 Router 的领域模型。
