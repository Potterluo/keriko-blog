---
title: "推理引擎里的五层容器：request、step、chunk、block、layer"
description: "把 vLLM V1 从 HTTP 请求到 GPU 前向的路径拆成五层，逐层给出数据形状、token 预算的分配方式和 KV 块的地址换算，并用算例解释 prefill 与 decode 如何在同一个 step 里共处。"
publishedAt: "2026-11-14"
category: 技术分享
tags:
  - LLM 推理
  - vLLM
  - KV Cache
  - 调度
  - PagedAttention
draft: false
---

vLLM 每隔几秒打一行统计日志，字段大致长这样（数值是示意的，字段名和量纲取自 EngineCore 的统计日志）：

```text
Engine 000: Avg prompt throughput: 1204.6 tokens/s,
            Avg generation throughput: 88.2 tokens/s,
            Running: 37 reqs, Waiting: 12 reqs,
            GPU KV cache usage: 96.3%, Prefix cache hit rate: 41.2%
```

这行日志里的六个数字放在一起是矛盾的。等待队列在涨，说明请求进不来；KV 缓存用到 96%，说明块快分完了；可是 `generation throughput` 只有 88 token/s，GPU 利用率一查才六成出头。算力没吃满，显存先满了，队列在涨。

要把这句话解释清楚，先得知道一个请求在引擎内部被切成了哪些单位，每个单位由谁持有，边界在哪。request、step、chunk、block、layer 这五个词经常混着用，它们分别属于应用层、调度层、内存层和模型层，互相之间是正交的。下面按数据流的顺序把它们摆开，每一步给出具体的数据形状和数字。

## 口径

下面所有代码位置和默认值，都以 2026 年 11 月的 vLLM main 分支为准：

- 调度器 `vllm/v1/core/sched/scheduler.py`，调度输出结构 `vllm/v1/core/sched/output.py`，KV 块管理 `vllm/v1/core/kv_cache_utils.py`，配置项 `vllm/config/scheduler.py`、`vllm/config/cache.py`。
- 文档看四篇：[Paged Attention](https://docs.vllm.ai/en/latest/design/paged_attention/)、[Optimization and Tuning](https://docs.vllm.ai/en/latest/configuration/optimization/)、[Parallelism and Scaling](https://docs.vllm.ai/en/latest/serving/parallelism_scaling/)、[Context Parallel Deployment](https://docs.vllm.ai/en/latest/serving/context_parallel_deployment/)。
- V1 的设计动机看官方博客 [vLLM V1: A Major Upgrade](https://blog.vllm.ai/2025/01/27/v1-alpha-release.html)。

有两处版本差异必须先说，否则公式对不上现网：

1. `CacheConfig.DEFAULT_BLOCK_SIZE` 现在是 64，早期 V1 长期是 16。块大小不影响机制，只影响碎片与 kernel 形状。下文用 b 表示，示例按 16 算；改成 64 时每块的 token 数翻四倍，其余不变。
2. `max_num_batched_tokens` 的默认值不是固定数字。main 分支按显存和入口分档：H100/H200 这类 80 GiB 以上、160 GiB 以下的卡，在 OpenAI API server 下是 8192、离线 `LLM` 类是 16384；160 GiB 以上的卡统一 16384；其他设备 API server 是 2048。下文用 B_step 表示。

这些配置没有在真机上跑过，文中出现的耗时都是按 roofline 估的上界，KV 字节数和块数则是精确乘法，可以照着复算。硬件口径取 H100 80GB：HBM 3.35 TB/s，bf16 稠密算力 989 TFLOPS；跨机口径取 400 Gbps IB，即 50 GB/s。

## 五层容器

先把名词对齐。表格里"量级"一列是一般 LLM 服务下的典型值，不是定义的一部分。

| 单位     | 定义                          | 量级           |
| :------- | :---------------------------- | :------------- |
| request  | 一次 API 调用                 | 1 条 HTTP      |
| sequence | 请求的 token 序列与状态       | prompt + 输出  |
| step     | 一次调度加一次前向            | 毫秒级         |
| batch    | 一步里被选中的请求集合        | ≤ max_num_seqs |
| chunk    | 某请求 prefill 在一步里的一段 | ≤ 剩余预算     |
| block    | KV 的分配与寻址单位           | b 个 token     |
| layer    | 模型的一层                    | 几十到上百层   |
| token    | 计算与计费的原子              | 1              |

这八个单位各有归属：request 与 sequence 在 API server 和 EngineCore 各存一份状态，step 与 batch 由调度器决定，block 由 KV cache manager 管理，layer 由模型执行器按顺序遍历。包含关系只有一条主线：request 内部是 sequence，sequence 按 token 位置切成 block。step 与 batch 属于调度维度，一个 request 在一个 step 里可能只拿到 1 个 token（decode），也可能拿到几千个（prefill 的一个 chunk），还可能一个都没拿到（在 waiting 队列里）。layer 属于模型维度，和上面所有单位都正交：不管一个 step 里塞了多少 token，前向总要跑完 L 层。

vLLM V1 博客把调度决策写成一个字典 `{request_id: num_tokens}`，每个 step 决定每个请求这次处理多少个 token。prefill、chunked prefill、投机解码在这个表示下是同一件事，区别只在字典里的数字怎么来。

## 从 HTTP 到显存

![图 1 一条请求穿过三个进程，箭头旁标的是这一步传递的数据结构，盒子颜色对应进程边界](/img/035-llm-inference-anatomy/fig-01.svg)

图 1 把路径按进程切开。左边是 API server，负责 HTTP、chat template、tokenizer、多模态输入处理、detokenizer 和流式回包；中间是 EngineCore，负责排队、调度、块分配和采样；右边是每个 GPU 一个的 worker 进程。V1 把 EngineCore 单独隔离出来的原因写在官方博客里：GPU 快的时候单步只有 5ms，tokenizer 和 detokenizer 如果在同一个 Python 进程里，CPU 会直接挡住 GPU 循环。

一次请求的完整路径是这样的：

1. API server 渲染模板、分词，得到 `prompt_token_ids`。多模态请求在这一步把图片切成 encoder 输入。
2. 通过 ZMQ 把 `EngineCoreRequest` 发给 EngineCore 的 `add_request`，构造 `Request`：token ids、采样参数、`block_hashes`（用于前缀缓存）、最大输出长度。
3. 请求进入 `waiting` 队列。注意这一步只是排队，还没有分配 KV 块。
4. `Scheduler.schedule()` 被调用，返回 `SchedulerOutput`。里面有几个关键字段：`scheduled_new_reqs`（第一次调度的请求，带整段 prompt 和已分配的块）、`scheduled_cached_reqs`（之前调度过，只发增量）、`num_scheduled_tokens`（每个请求这次算几个 token）、`finished_req_ids`、`kv_connector_metadata`（PD 分离时用）。
5. KV cache manager 在调度过程中完成块的分配、复用和回收。前缀命中的部分通过 `num_computed_tokens` 直接跳过，不再参与前向。
6. ModelRunner 准备输入张量：`input_ids [T]`、`positions [T]`、`slot_mapping [T]`、`block_tables [R, max_blocks]`、`seq_lens [R]`、`query_start_loc [R+1]`。TP 组内广播这份增量。
7. 每层前向，attention 在算 QKV 的同时把新的 K/V 写进块，采样得到每个请求的下一个 token。
8. `EngineCoreOutput` 回到 OutputProcessor 做 stop 检查和 logprobs，再交给 detokenizer 流式返回。

记 T 为第 6 步里所有被调度 token 的总数，它也是这一次前向的实际 batch 维。T 不等于请求数，也不等于 `max_num_seqs`，更不等于 `max_num_batched_tokens`（后者是上限）。T = Σ n_r。

## 一个 step 里的预算怎么分

![图 2 三个连续 step 的 token 预算：decode 先占位，长 prompt 被切成三段，首 token 在最后一段结束时才采出，空闲预算被新请求填上](/img/035-llm-inference-anatomy/fig-02.svg)

vLLM 文档把顺序写得很直白：开 chunked prefill 之后，调度器先把所有待 decode 的请求排进这个 step，然后再用剩下的预算排 prefill；一个 prefill 装不下就按剩余预算切片。实现上是对 `running` 队列逐个算出本步还能加多少 token，每算一个扣一次 `token_budget`，预算耗尽就停；块不够时抢占优先级最低的请求。

预算约束是三条：

T_step = Σ n_r ≤ B_step，|batch| ≤ S_max，KV(r) ≤ 可用块 × b

拿一组数字走一遍。设 B_step=8192，S_max=512，此刻有 256 个请求在 decode，新来一个 prompt 长度 6000 的请求：

- decode 先占 256 个 token，剩 7936；
- 6000 小于 7936，prefill 一次吃完，这一步 T=6256；
- 这个 step 结束时，新请求才第一次被采样，TTFT 等于排队时间加这一步的时间。

如果 prompt 是 16000：

- 第一步 decode 占 256，prefill 拿 7936，剩 8064；
- 第二步同样拿 7936，剩 128；
- 第三步把 128 补完，这一步才采出第一个 token。三个 step 的 chunk 加起来是 16000。

chunk 的意义就在这里：单步被 prefill 拉长的时间有上界，已经在 decode 的请求不会被一个长 prompt 卡住几百毫秒。这也是 chunked prefill 最初的动机，FastGen 的 Dynamic SplitFuse（[arXiv 2401.08671](https://arxiv.org/abs/2401.08671)）和 SARATHI（[arXiv 2308.16369](https://arxiv.org/abs/2308.16369)）讲的是同一件事。

再看一个极端的分配：如果 256 个请求全在 decode 且没有新请求进来，T=256，一个 step 只算 256 个 token，此时 GPU 的算力几乎全空着，时间花在读权重和读 KV 上。这就是 decode 阶段"显存带宽决定一切"的来源，也是调度器为什么愿意把 prefill 塞进同一个 step：让算力密集的 prefill 和带宽密集的 decode 共享一次权重读取。

> [!NOTE]
> `max_num_batched_tokens` 约束的是 token 数，`max_num_seqs` 约束的是请求数。前者调大偏向 TTFT，后者调大偏向吞吐；两个都调大，KV 缓存会先撑不住。

## 前向内部：T 个 token 怎么摊到 L 层

![图 3 一个 step 的 hidden state 形状变化：T 个 token 拼成一批，逐层经过 attention 与 MLP，TP 组内每层两次 all-reduce，最后只对需要采样的位置算 lm_head](/img/035-llm-inference-anatomy/fig-03.svg)

模型执行器拿到的是拼好的一批 token，不是一个请求一个请求地算。所有请求的 token 按顺序首尾相接，形成长度 T 的一维序列，attention 用 `query_start_loc` 和 `seq_lens` 把因果掩码切开。chunked prefill 打开时，这一批里同时存在两种 query：长度为几千的 prefill 块，和长度为 1 的 decode token。attention 后端必须支持变长 query，这也是 V1 选 FlashAttention 3 这类后端的原因之一。

以 Llama-3.1-8B 的形状走一遍（L=32，H=4096，32 个 query head，8 个 KV head，d=128，词表 128k）：

| 阶段      | 形状                          | 说明                |
| :-------- | :---------------------------- | :------------------ |
| 输入      | `input_ids` / `positions` [T] | 这一步的 token 总数 |
| hidden    | `[T, 4096]`                   | bf16 下约 49 MiB    |
| QKV       | `[T, 4096+1024+1024]`         | K/V 各 8 头         |
| attention | 读 `block_tables` 指向的 KV   | 每层独立寻址        |
| MLP       | `[T, 14336]` 中间维           | 算力主要在这里      |
| logits    | `[R, 128000]`                 | 只算请求末位        |

三件事在这里同时发生，分清它们才能对上后面的账：

第一，KV 写入。attention 算出新的 K/V 后，按 `slot_mapping` 写到对应物理块的对应偏移。写多少由 T 决定，写到哪由块表决定。

第二，张量并行的通信。每层 attention 的输出投影和 MLP 的 down 投影各需要一次 all-reduce，消息大小与 T×H 成正比，单位 token 的通信量固定是 4H 字节；T 变大只摊薄固定延迟。

第三，采样。lm_head 只对需要出 token 的位置算，prefill 的中间 chunk 不采样，最后一个 chunk 和所有 decode 各采样一次。这一步决定了"每个 step 每个请求产出几个 token"。

## KV 的地址：block、page、slot

![图 4 三层地址换算：token 位置先落到逻辑块，逻辑块的 block_table 指向物理块，物理块内再按偏移定位；右侧注明多个块表指向同一块时即前缀共享](/img/035-llm-inference-anatomy/fig-04.svg)

PagedAttention 的论文把 KV cache 切成 page，vLLM 代码里统一叫 block。这里有个长期存在的歧义：CUDA 的 thread block 也叫 block，vLLM 的设计文档专门注明过两者的区别。下文说 block 都指 KV 块。

寻址是三层：

$$
i = \lfloor p / b \rfloor,\qquad \text{phys} = \text{block\_table}[i],\qquad \text{slot}(p) = \text{phys} \times b + (p \bmod b)
$$

`slot_mapping` 传的就是最后这个线性下标，attention kernel 用它写 K/V、读历史。每个物理块在每层的字节数是：

$$
\text{page\_bytes} = b \times L \times 2 \times H_{kv} \times d \times s
$$

其中 s 是 dtype 字节数，2 是 K 和 V 两份。三个真实模型的账：

| 模型          | 结构           | 每 token KV | 每块（b=16） | 24 GiB 块数 |
| :------------ | :------------- | :---------- | :----------- | :---------- |
| Llama-3.1-8B  | 32 层，8 KV 头 | 128 KiB     | 2 MiB        | 12,288      |
| Llama-3.3-70B | 80 层，8 KV 头 | 320 KiB     | 5 MiB        | 4,915       |
| DeepSeek-V3   | MLA，61 层     | 70.3 KiB    | 1.07 MiB     | 约 22,900   |

24 GiB 对应 12,288 个块，按 b=16 算就是 196,608 个 token，刚好装下 24 个 8k 请求。第三行来自 DeepSeek 的 ISCA'25 论文 Table 1，原文给的数字是 70.272 KB/token，同一张表里 Qwen-2.5-72B 是 327.68 KB、LLaMA-3.1-405B 是 516.1 KB。MLA 把 KV 压成一个共享的 latent，TP 切头时无处可切，这也解释了后面并行那篇要讲的 DCP。

块的另一个用途是共享。前缀缓存按 token 序列做 hash，命中之后两个请求的 `block_table` 指向同一个物理块，块里带引用计数；分叉时对要写的块做 copy-on-write。图 4 用一条 64 token 的序列演示这个换算：p=37 落在逻辑块 2 的偏移 5 上，块表把逻辑块 2 指向物理块 1。多个请求的块表指向同一个物理块时，前缀就只存一份，这是多轮对话里 system prompt 不重复占显存的原因。

块不够时 V1 的处理方式是抢占加重算：默认策略 `RECOMPUTE` 把请求踢回 waiting，释放全部块，重新调度时从头算 KV。V0 时代的 `SWAP`（换到 CPU）在 V1 里不再是默认，因为重算在 V1 的架构下更便宜。块大小 b 的选择也是折中：太小，元数据与 kernel 启动开销大，attention 每次只能读一小段；太大，一条序列末尾的内部碎片最多浪费 b-1 个 token 的显存。16 和 64 都是这个折中下的取值。

## 三种时间尺度对账

把上面几层合起来，可以写出一张对账单。以一个 70B 稠密模型、TP=8、B=256、平均上下文 4096 token 的 decode step 为例：

| 项            | 算法                         | 估算                          |
| :------------ | :--------------------------- | :---------------------------- |
| 读权重        | 140 GB / 8 卡 / 3.35 TB/s    | 5.2 ms                        |
| 读 KV         | 256×4096×320 KiB / 8 卡      | 12.8 ms                       |
| TP all-reduce | 每层 2 次，消息 256×8192×2 B | 1.12 GiB/卡，NVLink 约 2.8 ms |
| 单 step       | 上三项相加（未计重叠）       | 约 21 ms                      |

单 step 21ms 意味着 256 个请求合计 12k token/s，单请求 TPOT 21ms。同一台机器跑 prefill，8192 token 需要 2×70B×8192≈1.15 PFLOP，8 卡按 40% MFU 算 3.16 PFLOPS，约 0.36 秒，折合 22.7k token/s。两个数字放在一起看，decode 的瓶颈是 KV 读取，prefill 的瓶颈是算力，这决定了后面并行策略和 PD 分离怎么选。

再看 request 尺度：

$$
\text{TTFT} = t_{\text{queue}} + \left\lceil \frac{P}{B_{\text{step}} - B_{\text{dec}}} \right\rceil t_{\text{step}} + t_{\text{sample}}
$$

端到端时间再往后加每个输出 token 的时间：

$$
\text{E2E} = \text{TTFT} + (n_{\text{out}}-1) \times \text{TPOT}
$$

回到开头那行日志，每个字段都能落到一个容器上：

- `Waiting: 12` 和 `GPU KV cache usage: 96.3%` 一起出现，说明块池见底，新请求进不来，已有请求随时可能被抢占重算。此时增加并发只会让 TTFT 更糟。
- `Avg prompt throughput` 低，代表 prefill 的 token 被 decode 挤到了预算的零头，长 prompt 的 chunk 很多，TTFT 被 step 数放大。
- `Avg generation throughput` 低而 GPU 利用率不高，说明 step 之间有空隙，常见原因是 CPU 调度、采样同步或 TP 通信没有和计算重叠。
- `Prefix cache hit rate` 影响的是 `num_computed_tokens`，命中部分不参与前向，直接决定 prefill 的实际 token 数。

## 容易混的五组关系

`max_num_batched_tokens` 不是 batch size。它是这个 step 允许处理的 token 总数，batch size 由 `max_num_seqs` 和 KV 容量共同决定。把前者调到 16384 只意味着一个 step 能吃更长的 prompt，不意味着并发更高。

block 属于显存分配，和并行切分没有关系。TP 切的是 head 和权重矩阵，block 只是 KV 的分配与寻址粒度；DCP 会把一个逻辑块的跨度乘上 DCP 度数（文档里写作 physical block 16 tokens 在 DCP=4 下代表 64 tokens），那是缓存布局，也不进调度。

chunk 属于 prefill。一个请求的 prefill 可以横跨多个 step 的多个 chunk，decode 的 token 不进 chunk。

step 与 token 的产出比在 0 到多个之间。一个 step 可以产出 0 个 token（只做 prefill 中间块），也可以产出每请求 1 个（正常 decode），投机解码打开后可以更多。

prefill 和 decode 共处一个 step 是默认行为。V1 的调度器不区分阶段，只按 token 预算发牌；物理分离是 PD 部署要做的事，不是引擎的默认状态。

## 收尾

如果只能看一个指标判断瓶颈，先看 `GPU KV cache usage` 和 `Running/Waiting` 的比值，它决定"能不能再进请求"；再看 step 时间里权重读取和 KV 读取谁占大头，它决定"加卡有没有用"。这两件事都清楚了，再去动 `max_num_batched_tokens` 和块大小，否则调参只是在两个瓶颈之间来回搬。

[下一篇](/posts/036-parallelism-and-pd)接着算：当一个 step 里的 T 被切到多张卡、多个节点上时，每层要搬多少字节，以及这些字节如何反过来决定 PD 分离的部署形态。
