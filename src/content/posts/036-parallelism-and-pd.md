---
title: "切分方式决定部署形态：并行通信账与 PD 分离的 KV 传输"
description: "把 TP、DP、EP、PP、PCP、DCP 落到每层每 token 的通信字节上，用算例比较它们的代价，再讨论这些账如何决定 PD 部署该对称还是非对称，以及 KV 从 P 池到 D 池的几种传输形态。"
publishedAt: "2026-11-14"
category: 技术分享
tags:
  - 分布式推理
  - 并行策略
  - PD 分离
  - KV Cache
  - 通信
draft: false
---

PD 分离的集群扩完容、吞吐却没涨，是一种常见现象：P 池的 GPU 利用率不到一半，D 池的 TPOT 在抖，两边卡不少，链路监控上 RDMA 端口已经跑满。

这种形态问题很难从"再加几台"里找到答案。P 池和 D 池是否该用同一套并行布局，取决于两件事：每种切分在每一步要搬多少字节，以及这些字节在什么介质上搬。把这两笔账算清楚，对称部署与非对称部署的分界线就出来了，KV 从 P 传给 D 的形态也跟着定下来。

## 口径

数据来源：

- vLLM 的并行文档：[Parallelism and Scaling](https://docs.vllm.ai/en/latest/serving/parallelism_scaling/)、[Data Parallel Deployment](https://docs.vllm.ai/en/latest/serving/data_parallel_deployment/)、[Expert Parallel Deployment](https://docs.vllm.ai/en/latest/serving/expert_parallel_deployment/)、[Context Parallel Deployment](https://docs.vllm.ai/en/latest/serving/context_parallel_deployment/)、[Decoder Context Parallelism 博客](https://vllm.ai/blog/2026-08-07-decode-context-parallelism)。
- SGLang 的 [PD Disaggregation](https://lmsysorg.mintlify.app/docs/advanced_features/pd_disaggregation) 与 [Prefill Context Parallelism](https://lmsysorg.mintlify.app/docs/advanced_features/prefill_cp) 文档，里面写清了异构 TP 的 staging buffer、传输后端与超时参数。
- 论文：DistServe（OSDI'24，[arXiv 2401.09670](https://arxiv.org/abs/2401.09670)）、Splitwise（[arXiv 2311.18677](https://arxiv.org/abs/2311.18677)）、Mooncake（[arXiv 2407.00079](https://arxiv.org/abs/2407.00079)）、DeepSeek 的 ISCA'25 复盘（[arXiv 2505.09343](https://arxiv.org/abs/2505.09343)）。

记号统一如下：B 是一个 step 的请求数，S 是每个请求贡献的 token 数（decode 时为 1），H 是 hidden 维度，L 是层数，H_kv 是 KV 头数，d 是 head 维度，s 是字节数。激活字节数记作：

$$
M = B \cdot S \cdot H \cdot s
$$

一层 KV 的字节数记作：

$$
K = 2 \cdot B \cdot S \cdot H_{kv} \cdot d \cdot s
$$

硬件口径取 H800 节点：卡间 NVLink 双向 400 GB/s（单向约 200，实测有效约 160），机间 8 张 400 Gbps IB 网卡，单卡 50 GB/s，按有效 40 GB/s 算。所有耗时都是按公式估的，没有真机复现；字节数可以照着复算。

## 六个切分轴

![图 1 六种策略各切张量的一个维度，每张卡片下方是该切分每层需要的通信原语](/img/036-parallelism-and-pd/fig-01.svg)

并行策略切的对象不同，通信原语也就不同。把 [T, H] 的激活看成一个矩阵：

| 策略 | 切什么          | 每层通信            | 通信量随什么增长  |
| :--- | :-------------- | :------------------ | :---------------- |
| TP   | 权重矩阵、head  | all-reduce 两次     | 激活大小          |
| DP   | 请求            | 稠密模型无          | 无                |
| PP   | 层              | stage 边界 P2P      | 激活大小          |
| EP   | 专家            | all-to-all 两次     | token 数 × 专家数 |
| PCP  | prompt 的 token | KV 环/all-gather    | prompt 长度       |
| DCP  | KV 的序列维     | Q gather + out 合并 | 激活大小          |

真正的差别在切完之后谁必须等谁。TP 每一层都要等一次全局归约，所以它绑定在 NVLink 域里；DP 对稠密模型各卡独立跑，只受调度器负载均衡影响，MoE 的 DP attention 每步要向 EP 组同步；PP 只在 stage 边界同步一次，但把一次前向拉成了串行；EP 的 all-to-all 是按 token 路由的，稀疏模型才划算；PCP 和 DCP 切的是序列，一个换来 TTFT，一个换来 KV 显存。

## 通信量的统一写法

TP 的账最好算。每层 attention 的输出投影和 MLP 的 down 投影各一次 all-reduce，ring 实现下每个 rank 的收发量是：

$$
V_{\text{TP}} = 2 \times 2\frac{n-1}{n}M = 4\frac{n-1}{n}M
$$

代入 70B 稠密模型（H=8192，L=80，bf16，TP=8）和 B=256 的 decode：

- M = 256×8192×2 = 4 MiB；
- 每层每卡 4×7/8×4 = 14 MiB；
- 80 层合计 1.12 GiB/卡/step。

这 1.12 GiB 就是那个著名的数字：在 NVLink 上按 400 GB/s 走是 2.8ms，在 IB 上按 50 GB/s 走是 22.4ms。同一个模型、同一个 batch，TP 只要跨出机柜，单 step 就要多花 20ms，而单 step 本身（读权重加读 KV）也就 20ms 量级。这就是 TP 不出机柜的算术原因，不是习惯问题。

EP 的账 DeepSeek 在 ISCA'25 里给了一个可以直接抄的算法。单卡持有 1 个专家、每步处理约 32 个 token、每个 token 路由到 8 个路由专家加 1 个共享专家、hidden 约 7K：

$$
\text{Comm} = \frac{(1 + 2)\ \text{B} \times 32 \times 9 \times 7\text{K}}{50\ \text{GB/s}} \approx 121\ \mu s
$$

其中 dispatch 用 FP8（1 字节），combine 用 BF16（2 字节）。61 层乘两次 all-to-all，得到 14.76ms 的 TPOT 上界，约 67 token/s。同一套算法换成 900 GB/s 的 NVL72，单层掉到 6.72μs，上界变成 0.82ms。DeepSeek 用这个式子说明 MoE 推理的速度上限由互联带宽决定，也顺手说明了他们为什么把 FP8 dispatch 当成一等公民：字节数少一半，时间就少一半。

PCP 的账是 KV 环。C 个 rank 各持有 1/C 的 KV，每个 rank 要把自己那块发给其余 C-1 个 rank，每层收发量是：

$$
V_{\text{PCP}} = \frac{C-1}{C} \cdot 2 T_{\text{in}} H_{kv} d s
$$

70B 模型、32k prompt、C=4：单层 KV 是 134 MB，每 rank 约 100 MB，80 层合计约 8 GB，NVLink 上 20ms。同一份 prompt 的 prefill 计算是 1.45 秒量级，传输占 1.4%。PCP 划算的前提就在这里：prefill 的算力密度足够高，KV 环流的开销被计算盖住。

DCP 的账要分两段。KV 显存按 D 分之一切，序列维分片，每层 attention 变成：先 all-gather query（decode 时 query 只有 1 个 token，字节数很小），再在本地 KV 分片上算部分结果，最后 all-gather 加 reduce-scatter 合并输出与 LSE。合并这一步的量级等于一次 all-reduce，即每层多出约 2(D-1)/D·M 的通信。换来的收益是 KV 复制倍数从 n/H_kv 降到 n/(H_kv·D)：DeepSeek-R1 的 MLA 只有 1 个 KV 头，TP=8 就是 8 倍复制，加上 DCP=8 才能把这 8 倍消掉；Qwen3-235B 有 4 个 KV 头，TP=8 只有 2 倍复制，DCP 最多开到 2。

PP 的账最简单也最容易被忽略。每个 stage 边界每 microbatch 传一次 M，字节数不大，问题是延迟：decode 每生成一个 token 都要把整条流水线走一遍，stage 之间只能串行。所以 PP 在 prefill 侧容易用（chunk 大、算力密集），在 decode 侧必须有 micro-batch 或动态 chunk 把流水填满，否则每多一级就多一次往返。

## 通信量怎样挑并行策略

把上面的式子放在一起，能推出几条硬约束。

TP 的通信量对 n 不敏感（(n-1)/n 趋近 1），但介质敏感。跨机 IB 比 NVLink 慢一个数量级，所以 TP 的实际上界是机内卡数。vLLM 文档给多机部署的默认配比也是 TP 等于单机卡数、PP 等于节点数，而不是把 TP 拉到跨机。

EP 的通信量按 kH/E 缩放。专家越多、单卡分到的 token 越少，通信占比越高；反过来，batch 越大，单卡分到的 token 越多，all-to-all 的固定延迟被摊薄。DeepSeek 的 32 token/卡就是这个平衡点：再小，通信占比上升；再大，MoE 的计算密度收益下降。

PP 不能提高单请求速度，只能提高可放置的模型规模，以及用 chunk 填满流水。decode 侧用 PP 需要额外的调度技巧，vLLM 社区里 Dynamic Chunked Pipeline Parallelism 这类工作就是为这个场景做的。

CP 的收益有明确边界。PCP 的传输随 prompt 长度线性增长，收益随 TTFT 需求增长；DCP 的传输随激活大小增长，收益是 KV 显存。两件事不要混：PCP 解决"prefill 太慢"，DCP 解决"KV 放不下"。SGLang 文档里把 PCP 和 DCP 明确写成两个独立优化，vLLM 的 DCP 文档也写了 DCP 不增加卡数，只减少 KV 复制。

## PD 分离的收益来自解耦

DistServe 的结论是：prefill 和 decode 放在不同 GPU 上，消除相互干扰，再按各自的 TTFT 和 TPOT 目标独立分配资源和并行策略，在满足延迟约束的前提下，每张卡能服务的请求数最多提升 7.4 倍。Splitwise 从硬件角度给出另一半：prefill 是算力密集，decode 是访存密集，两类阶段可以用不同代际、不同成本的卡，在同等成本与功耗下吞吐提升 2.35 倍。Mooncake 在 Kimi 的生产负载上把这个思路推到 KV 缓存池化，比基线多接 75% 的请求。

这些收益都来自解耦，不来自通信。vLLM 的文档写得很直接：disaggregated prefill does not improve throughput。它改善的是 goodput 和尾延迟，代价是多了一次 KV 传输和一套路由。传输算不过来的时候，PD 分离是负收益，短 prompt、低并发的场景尤其明显。

## 对称与非对称

![图 2 上排是对称部署：两侧同一套 TP 布局，KV 按相同分片直接对接；下排是非对称：P 池用 TP8，D 池用 TP16 加 DCP8，KV 要先经过 staging buffer 重排再散列](/img/036-parallelism-and-pd/fig-02.svg)

对称部署指 P 池和 D 池用同一套并行布局。好处是 KV 分片一一对应，P 侧算完第 i 层，直接按块地址写给 D 侧同一 rank 的同一分片，不需要重排。实现上就是逐层 P2P：NIXL、UCX、Mooncake 这些连接器把 KV 块的地址发给对端，对端把数据 RDMA 写进自己的块池。

坏处是两侧被绑死。P 池和 D 池必须同构扩容，P 池的算力冗余不能挪给 D 池，D 池的显存冗余也不能挪给 P 池。而这两侧的瓶颈根本不是一回事：P 池看 TTFT，靠算力和 chunk 调度；D 池看 TPOT 和并发，靠显存和带宽。

非对称部署把这层绑定拆开，有三种拆法：

第一种是并行度不同。P 池用 TP8 甚至 EP32 冲 prefill 吞吐，D 池用 TP16 加 DCP8 把 KV 复制压下去，换更大的并发。代价是两侧的 KV 布局不一致：TP8 时每个 rank 持有一部分 head 切片，TP16 时切片更细，块内地址对不上。SGLang 的做法是在 P 侧加一块 GPU staging buffer，把 KV head 切片聚成连续缓冲，整块 RDMA 过去，再在 D 侧散回各自的页。按它的文档，异构 TP 下这条路比逐 token 切片快 2–5 倍，和同构基线的差距在 5% 左右；MLA 模型不要开这个选项，因为 latent 只有一份，切片语义不同。

第二种是硬件不同，Splitwise 的方案。P 池用高算力卡，D 池用大显存、低功耗的卡，代价是跨代际传输与两套镜像。这一条在自建集群里少见，在云上按实例类型混布时常见。

第三种是数量不同，也就是 P 与 D 的数量比。这个比例由负载形状决定，不是拍脑袋定的。设单实例 prefill 吞吐为 V_P、decode 吞吐为 V_D（都按 token/s 计），单请求 prompt 长度 T_in、输出长度 T_out，则需要的实例数之比是：

$$
\frac{N_P}{N_D} = \frac{T_{\text{in}}}{T_{\text{out}}} \cdot \frac{V_D}{V_P}
$$

用 [上一篇](/posts/035-llm-inference-anatomy) 估的 70B 数字（8 卡 TP8）：V_P≈22.7k token/s，V_D≈12k token/s，V_D/V_P≈0.53。三类负载的结果：

| 负载       | 输入/输出 | P 比 D      | 形态       |
| :--------- | :-------- | :---------- | :--------- |
| 对话       | 2k / 500  | 约 2.1 : 1  | P 池为主   |
| 长文 agent | 64k / 400 | 约 85 : 1   | P 池压倒性 |
| 推理模型   | 1k / 16k  | 约 0.03 : 1 | D 池压倒性 |

这张表解释了一个常见困惑：为什么有的团队 PD 比例是 1 比 4，有的却是 8 比 1。负载形状不同，比例就没有通用值。DeepSeek 在生产里对 prefill 和 decode 用不同规模的 EP 组，也是同一个逻辑：两侧的目标函数不一样，不该共用一套布局。

V_D 这一项还有一层变化：上下文越长，decode 每步读的 KV 越多，V_D 越低。带 prefix cache 命中时又反过来。所以比例要按 P50 和 P99 分别算，用平均值会偏。

## P2D 的三种落点

![图 3 P2D 传输的三种落点：同节点走 NVLink 或共享显存，跨节点走 GPUDirect RDMA，绕远路则经过 KV store 或分层缓存](/img/036-parallelism-and-pd/fig-03.svg)

KV 从 P 池到 D 池，物理上有三种落点：

| 落点   | 介质与带宽                 | 典型实现          | 适用     |
| :----- | :------------------------- | :---------------- | :------- |
| 同节点 | NVLink，数百 GB/s          | NIXL、CUDA IPC    | P/D 同机 |
| 跨节点 | IB + GPUDirect，50 GB/s/卡 | NIXL、Mooncake    | 主力形态 |
| 中转   | DRAM 或 SSD，毫秒级        | Mooncake、LMCache | 缓存复用 |

跨节点这条是主力。它要求两侧把 KV 块注册成可 RDMA 的内存，P 侧按块把数据写进 D 侧的显存地址。GPUDirect RDMA 让网卡直接读写显存，绕过 CPU 和主机内存；没有它，数据要先落主机内存再拷进显存，带宽和延迟都会掉一档。vLLM 的 NIXL 连接器、Mooncake 的连接器都是这个路子，NIXL 默认走 UCX，可以切到 libfabric；Ascend 上还有 memfabric 这条路。

同节点这条容易被忽略，但它决定了"一个 PD 实例装几台机器"。P 和 D 在同一台机器上时，KV 走 NVLink 或 CUDA IPC，带宽比跨机高一个数量级，首 token 的传输尾巴可以忽略；SGLang 里对应 `INTRA_NODE_NVLINK` 这类内存池配置。代价是 P 和 D 争同一台机器的显存和网卡，扩容粒度变粗。

中转这条不适合首 token 路径。KV 池的价值在复用：同一个前缀被多个请求命中时，D 池不必等 P 池重算，直接从池里取。它的延迟是毫秒到几十毫秒级，适合放在缓存层，不适合每一次 P2D 都绕一圈。

## 逐层流水与首 token

![图 4 逐层流水的 P2D 时序：P 侧每算完一层就发一层 KV，传输与下一层计算重叠，D 侧等最后一层到齐才开始 decode](/img/036-parallelism-and-pd/fig-04.svg)

P 侧不是等所有层算完才开始传。KV 连接器挂在 attention 层上，第 i 层的 K/V 一写完就可以发，传输与第 i+1 层的计算重叠。这就是 vLLM 文档里那张 layer-by-layer 示意图描述的行为，SGLang 的 Mooncake 后端也提供逐层传输的路径。

于是首 token 的时间可以拆成：

$$
\text{TTFT} = t_{\text{queue}} + t_{\text{prefill}} + t_{\text{tail}} + t_{\text{decode\_step}}
$$

其中 t_tail 是最后一层 KV 的传输时间加握手，前面各层已经被 prefill 计算盖住了。这个拆分有两个推论：

第一，首 token 的成本主要是 prefill 计算，传输只贡献尾巴。70B 模型 8k prompt 的 KV 是 2.62 GB，单卡 50 GB/s 走 52ms，8 卡 400 GB/s 走 6.5ms；同一次 prefill 的计算是 0.36 秒。传输占 2% 到 14%，不改变量级。

第二，持续带宽才是硬约束。设 QPS 为 q，每个请求的 KV 字节数为 T_in·κ（κ 是每 token 的 KV 字节），则 P2D 方向需要持续承载：

$$
\text{BW} = q \cdot T_{\text{in}} \cdot \kappa
$$

70B、8k prompt、κ=320 KiB 时，单个请求 2.62 GB。8 卡节点 400 GB/s 的链路最多承载约 150 请求/秒，单卡 50 GB/s 只能承载约 19 请求/秒。到了这个量级，再扩 P 池没有意义，瓶颈在链路上；这时要么换更大带宽的网卡，要么把 P 和 D 放到同一台机器用 NVLink，要么干脆不分离。

DeepSeek 的 MLA 在这个账上优势明显：κ 只有 70.3 KB，8k prompt 的 KV 是 573 MB，比 70B 稠密模型小 4.6 倍，同样带宽能多承载 4.6 倍的请求。这也是为什么长上下文 PD 部署更偏爱 MLA 类模型。

## 参数与失败模式

SGLang 的 PD 文档里有几个参数会直接影响传输行为：

- 块分配策略 `early` 和 `prefill_complete`。默认是 early，D 侧在 prefill 还没算完时就预留目的块，长 prefill 会占住 D 池的 KV 空间；改成 `prefill_complete` 后，P 侧算完才通知 D 侧预留，代价是 P 侧多留一会儿 KV，chunked prefill 和传输的重叠也没了。
- 超时与心跳。bootstrap 阶段默认等 300 秒，等待 KV 也是 300 秒，心跳 5 秒一次，连续失败 2 次判离线。传输链路抖动时，这些数字决定了请求是重试还是失败。
- 传输队列。P 侧默认对多个 D 实例的请求做分片，队列数默认 4，线程数按 CPU 核数算。队列太浅，多个 D 实例会互相等。
- 异构 TP 的 staging buffer。开了之后 D 侧分配 4 GiB 的环形池，P 侧聚合再发。MLA 模型不要开，开了反而错。

还有两个容易踩的点。一个是块对齐：传输按块走，最后一个块可能没填满，D 侧要么补齐要么按实际长度传，块边界和 DCP 的序列分片叠加后，有效块跨度是 b×DCP，两边必须按同一个跨度对齐。另一个是失败重传：P 侧发完就释放 KV 的话，D 侧失败后无法重试，只能让请求回 P 池重算；连接器要保证发送完成的确认和清理顺序。

## 决策清单

先算三笔账，再决定形态：

1. 单 step 的通信量除以介质带宽。TP 的 1.12 GiB/step 在 NVLink 上是 2.8ms，在 IB 上是 22ms。前者可以接受，后者说明 TP 不该跨机。
2. P2D 的持续带宽 q·T_in·κ。它超过链路能力时，PD 分离的收益会被传输吃掉，此时优先同机 NVLink 或放弃分离。
3. P 与 D 的比例 (T_in/T_out)·(V_D/V_P)。对话、长文 agent、推理模型的比例差两个数量级，不要照抄别人的配比。

三笔账都算完，形态基本就定了：两侧布局一致、比例接近 1 比 1 时用对称部署，实现简单、传输零重排；比例悬殊或两侧瓶颈不同时用非对称，接受 staging buffer 的重排成本，换各自的最优并行度。KV 传输优先走同节点 NVLink，其次 GPUDirect RDMA，KV 池只放在缓存路径上。

这些数字都是按公式和公开口径估的，真实值取决于卡的型号、NCCL 的实现、网卡与交换机配置，以及负载的上下文分布。上线前用目标模型在目标集群上跑一轮，把 V_P、V_D、κ 和实际链路带宽量出来，再套上面的式子，比任何推荐值都可靠。
