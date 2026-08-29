---
title: "LLM 注意力机制与架构演进"
description: "从 Transformer 的每个零件开始，到 KV Cache、MLA、FlashAttention 与混合模型：一份注意力机制与架构演进的系统笔记"
publishedAt: '2026-08-22'
category: "学习笔记"
tags:
  - "LLM"
  - "Transformer"
  - "Attention"
  - "KV Cache"
  - "推理优化"
draft: false
---

## 全文结构

| 大章  | 主题                             | 优化对象                    |
| --- | ------------------------------ | ----------------------- |
| 第一章 | LLM 如何推理：Transformer 的结构与运行    | —                       |
| 第二章 | 非注意力组件的优化                      | 归一化/激活/FFN/残差           |
| 第三章 | 注意力机制优化（模型层 + 推理层 + 硬件层 + 机制层） | KV Cache 的本质大小/精度/计算/复用 |
| 第四章 | 现代推理实践                         | vLLM / SGLang / 混合模型服务  |
| 第五章 | UCM 实践：从前缀缓存到混合模型 | 跨请求持久化 / 混合模型缓存语义 |
## 第一章　LLM 如何推理：从文本到注意力

这一章从头拆解 Transformer 的每个零件：文本怎么变成数字、位置信号怎么注入、token 之间怎么互相"看"、深层网络怎么稳定、知识存在哪里。理解这些地基，才能看懂后面所有优化为何有效。
### 1.1　从双塔到单塔：Decoder-Only 与因果掩码

2017 年的原始 Transformer 是一个**双塔架构** ：左边是 Encoder（编码器），右边是 Decoder（解码器）。
- **Encoder** 用双向注意力看完整输入，把每个位置编码成上下文向量。
- **Decoder** 自回归生成，用**因果掩码（Causal Mask）** 遮住未来 token，只允许看历史。

但现代大语言模型（GPT、DeepSeek、Qwen、GLM）几乎**全员 Decoder-Only**。为什么？
![](/img/attention/Pasted-image-20260822144928.png)
>[arXiv:2304.13712](https://arxiv.org/abs/2304.13712)

> **核心原因**：生成任务本质是自回归的。单塔结构在海量无监督数据上预训练时参数效率更高——砍掉 Encoder，把所有输入输出拼成一个长序列，统一用因果掩码实现自回归：第 i 个 token 只能看到 j ≤ i 的位置。

**什么是因果掩码？** 想象考试时你只能看到已写的答案，不能偷看后面的题。因果掩码就是实现这个约束的矩阵：第 i 行只有前 i 列为 0（可见），后面的列为 −∞（不可见）。softmax 遇到 −∞ 自动把权重压到零。
***

### 1.2　一个完整的 Transformer Block 的全貌

* 先给整体：
> 输入 embedding Token → 嵌入+位置编码 → 多头注意力 → 残差+归一化 → FFN → 残差+归一化 → 输出
![](/img/attention/Pasted-image-20260822145130.png)

这个 Block 堆叠 N 次（LLaMA-2 7B 是 32 层，DeepSeek-V3 是 61 层）。每层做同样的事：先让 token 互相"看"（注意力），再独立"思考"（FFN），中间用残差和归一化保稳定。

***

### 1.3　从文字到向量：Token 化与词嵌入
模型不认识文字，只认识数字。入口三步：

1. **分词（BPE）**：把文本切成子词 token。BPE 不在"字"和"词"之间二选一，而是根据频率自动学习最优切分。比如 "unbelievable" 可能被切成 "un" + "believ" + "able"。高频组合保留为完整 token，低频部分拆成更小子词。词表通常 3 万\~15 万。
2. **查表得 ID**：每个 token 对应一个整数 ID。
3. **嵌入（Embedding）**：嵌入层是一个**可学习的查找表**，行数 = 词表大小，列数 = d\_model。给定 ID i，直接取第 i 行，就得到这个 token 的初始向量。嵌入维度 d\_model 通常为 4096（7B 模型）到 8192（70B 模型）。

> 嵌入矩阵大小 = 词表大小 × d\_model × 2 bytes，如 128000 × 4096 × 2 ≈ 1 GB（FP16）。在 Decoder-Only 模型中，**嵌入矩阵和输出头经常共享权重**（tied embeddings），省一半参数。

![](/img/attention/Pasted-image-20260822145500.png)

- tiktoken：OpenAI 的一种快速 BPE 分词器。
	- GitHub：[https://github.com/openai/tiktoken](https://github.com/openai/tiktoken)
	- CookBook：[https://github.com/openai/openai-cookbook/blob/main/examples/How_to_count_tokens_with_tiktoken.ipynb](https://github.com/openai/openai-cookbook/blob/main/examples/How_to_count_tokens_with_tiktoken.ipynb)
- Word2Vec：[https://arxiv.org/abs/1301.3781](https://arxiv.org/abs/1301.3781)
	- 可视化：[https://projector.tensorflow.org/](https://projector.tensorflow.org/)
- nn.torch.Embedding：[https://docs.pytorch.org/docs/2.11/generated/torch.nn.Embedding.html](https://docs.pytorch.org/docs/2.11/generated/torch.nn.Embedding.html)
***

### 1.4　梦开始的地方：自注意力 Q/K/V 与缩放点积

Attention（注意力机制）是现代深度学习中最重要的创新之一，它使模型能够在处理序列数据时动态地关注不同位置的信息。

在 Transformer 架构中，Attention 机制的核心思想是：**让每个位置的 token 根据其与其他 token 的相关性，对它们进行加权求和**。

核心操作是**缩放点积注意力**，把每个 token 变成三个向量：

| 向量            | 直觉             | 类比          |
| ------------- | -------------- | ----------- |
| **Query (Q)** | 当前 token 想找什么  | "我要找会做辣面的人" |
| **Key (K)**   | 每个 token 的属性标签 | "四川炒面"的招牌   |
| **Value (V)** | 每个 token 的实际内容 | 实际端上的菜      |

> **注意力公式**：Attention(Q, K, V) = softmax(Q × K^⊤ / √d_k) × V

当前 token 拿自己的 Q 去和所有历史 token 的 K 做点积，得分越高越相关；softmax 把分数变成权重（和为 100%），最后按权重混合所有 V。

> RNN 处理序列时，第n个位置的信息要传到第m个位置，必须经过∣m−n∣步递推，路径越长信号衰减越严重，而且这些步骤天然串行、无法并行。Attention 把这条路径压到常数：任意两个位置之间只隔一次点积。代价是计算量从O(N)变成 **O(n²)**，显存也随序列长度平方增长。这笔交易是后面 FlashAttention、GQA、KV cache 等一整条优化线索的起点。
>
> Vaswani, A. et al. "Attention Is All You Need." [arXiv:1706.03762](https://arxiv.org/abs/1706.03762)
> 
> [Transformer学习笔记一：Positional Encoding（位置编码） - 知乎](https://zhuanlan.zhihu.com/p/454482273)
---
## 第二章　非注意力组件的优化（非主线，但也很重要）

> 这些不是注意力本身，但每个都在影响注意力的效果与成本：位置编码、归一化、FFN/MoE、残差连接、激活函数。

### 2.1　位置编码
> 在[self-attention模型](https://zhida.zhihu.com/search?content_id=189127040&content_type=Article&match_order=1&q=self-attention%E6%A8%A1%E5%9E%8B&zd_token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJ6aGlkYV9zZXJ2ZXIiLCJleHAiOjE3ODc1NTc2MDYsInEiOiJzZWxmLWF0dGVudGlvbuaooeWeiyIsInpoaWRhX3NvdXJjZSI6ImVudGl0eSIsImNvbnRlbnRfaWQiOjE4OTEyNzA0MCwiY29udGVudF90eXBlIjoiQXJ0aWNsZSIsIm1hdGNoX29yZGVyIjoxLCJ6ZF90b2tlbiI6bnVsbH0.t4slFXZsn1Bdnr8LLYGlVuxs0D8aHRTYNeaKk4QKhb4&zhida_source=entity)中，输入是一整排的tokens，对于人来说，我们很容易知道tokens的位置信息，比如：  
（1）[绝对位置信息](https://zhida.zhihu.com/search?content_id=189127040&content_type=Article&match_order=1&q=%E7%BB%9D%E5%AF%B9%E4%BD%8D%E7%BD%AE%E4%BF%A1%E6%81%AF&zd_token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJ6aGlkYV9zZXJ2ZXIiLCJleHAiOjE3ODc1NTc2MDYsInEiOiLnu53lr7nkvY3nva7kv6Hmga8iLCJ6aGlkYV9zb3VyY2UiOiJlbnRpdHkiLCJjb250ZW50X2lkIjoxODkxMjcwNDAsImNvbnRlbnRfdHlwZSI6IkFydGljbGUiLCJtYXRjaF9vcmRlciI6MSwiemRfdG9rZW4iOm51bGx9.HPEq3uSnmjFTF4MtLmJbFZGZsPsXDIxQZwUxp-v4Uxc&zhida_source=entity)。a1是第一个token，a2是第二个token......  
（2）相对位置信息。a2在a1的后面一位，a4在a2的后面两位......  
（3）不同位置间的距离。a1和a3差两个位置，a1和a4差三个位置....  
但是这些对于self-attention来说，是无法分辩的信息，因为self-attention的运算是无向的。因为，我们要想办法，把tokens的位置信息，喂给模型。
![](/img/attention/Pasted-image-20260822155513.png)
- 正弦/余弦绝对位置编码（Sinusoidal PE）
- RoPE 旋转位置编码：[https://arxiv.org/abs/2104.09864](https://arxiv.org/abs/2104.09864)（RoFormer: Enhanced Transformer with Rotary Position Embedding）
	- 可视化： https://www.kapilsharma.dev/rope/ 
- NoPE 无位置编码： https://arxiv.org/abs/2305.19466（The Impact of Positional Encoding on Length Generalization in Transformers）
- YaRN： https://arxiv.org/abs/2309.00071（YaRN: Efficient Context Window Extension of Large Language Models）

### 2.2　归一化层，训练更稳定
![](/img/attention/Pasted-image-20260822155633.png)

- LayerNorm 论文： https://arxiv.org/abs/1607.06450  （Layer Normalization）
- RMSNorm 论文： https://arxiv.org/abs/1910.07467    （Root Mean Square Layer Normalization）
	- LayerNorm、RMSNorm对比： https://magazine.sebastianraschka.com/p/from-gpt-2-to-gpt-oss-analyzing-the?utm_source=publication-search
- QKNorm / KVNorm：注意力层 QKV 归一化： https://arxiv.org/abs/2010.04245
- Pre-Norm、 Post-Norm ： https://arxiv.org/abs/2002.04745

### 2.3　MoE：FFN 那么大干什么
![](/img/attention/Pasted-image-20260822155919.png)
- MOE： https://arxiv.org/abs/1701.06538   （Outrageously Large Neural Networks: The Sparsely-Gated Mixture-of-Experts Layer）
	- https://arxiv.org/abs/2101.03961（Switch Transformers: Scaling to Trillion Parameter Models with Simple and Efficient Sparsity）
- DeepSeekMOE： https://arxiv.org/abs/2401.06066 （DeepSeekMoE: Towards Ultimate Expert Specialization in Mixture-of-Experts Language Models）


### 2.4　Residual 残差连接
- ResNet https://arxiv.org/abs/1512.03385  （Deep Residual Learning for Image Recognition）
- HC https://arxiv.org/abs/2409.19606  （Hyper-Connections）
- mHC https://arxiv.org/abs/2512.24880 （mHC: Manifold-Constrained Hyper-Connections）
- AttnResidual：注意力残差 https://arxiv.org/abs/2603.15031 （Attention Residuals）

### 2.5　激活函数
- GELU： https://arxiv.org/abs/1606.08415
- SiLU： https://arxiv.org/abs/1702.03118
- Swish： https://arxiv.org/abs/1710.05941v1
***

## 第三章　注意力机制优化（模型层 + 推理层 + 硬件层 + 机制层）

> 本章是核心。先讲清楚"为什么慢"，再给一张优化地图，然后按层次逐个展开。


### 3.1　慢啊慢，为什么是注意力？（KV Cache 与内存瓶颈）

#### 3.1.1 为什么计算慢？——从 O(N) 到 O(N²) 的代价

第一章讲过，Attention 把 RNN 中 |m−n| 步的信息传递压到了常数：任意两个位置之间只隔一次点积。但这笔交易有代价。

**RNN 的计算复杂度是 O(N)**——每步只看上一个隐状态，线性增长。
而 Self-Attention 中，**每个 token 都要和所有其他 token 做一次点积**。N 个 token 两两交互，计算量是 N × N = **O(N²)**。
![](/img/attention/Pasted-image-20260822163429.png)

假设它已经写了 "The cat sat on the"，现在需要第 6 个 token。它对 token 1–5 做注意力。然后第 7 个 token 对 1–6 做注意力。第 8 个对 1–7。没有缓存的话，模型不断为已处理过的旧 token 重新计算 Key 和 Value 向量。数学上没有任何问题，只是重复，而且重复会累积。

#### 3.1.2 为什么 KV 可以复用？——KV Cache 的诞生

理解 KV Cache，需要先看清楚推理的两个阶段：

**Prefill 阶段（处理提示词）**：用户发来一段 prompt，模型**一次性并行处理全部 token**，每层都计算出每个 token 的 K 和 V。这个阶段是**计算密集**的，GPU 利用率高（\~90%），持续时间短。

**Decode 阶段（逐 token 生成）**：模型开始自回归生成——一次前向传播产出一个 token。每生成一个新 token，它需要**回看所有已处理的 token**（包括 prompt 和已生成的部分），用 Q 去和它们的 K 做点积。

关键观察：**在 Decode 阶段，历史 token 的 K 和 V 向量不会变**。

为什么？因为 K\_t = W\_K × h\_t，V\_t = W\_V × h\_t。模型权重 W\_K、W\_V 是固定的（推理时不更新），历史 token 的隐藏状态 h\_t 在生成新 token 时也不会改变。所以第 1 个 token 的 K₁、V₁ 在生成第 2、3、...N 个 token 时，值完全相同。

**没有 KV Cache 时**：生成第 N 个 token，模型需要重新计算前面 N-1 个 token 的 K 和 V——这完全是重复劳动，因为它们的值没变。
**有了 KV Cache**：每个 token 的 K 和 V 在 Prefill 阶段计算一次后就存起来。Decode 阶段每生成一个新 token，只需：

1. 计算这个新 token 的 Q、K、V
2. 把新 K、V 追加到缓存
3. 用新 Q 去和缓存里所有 K 做点积（读缓存，不重算）
4. softmax → 加权混合缓存里所有 V

> ![](/img/attention/02-attention-mha.png)
>
> *图：Transformer 原文 MHA 注意力——每个 token 的 K/V 计算后缓存，后续 token 直接读取。来源：[Attention Is All You Need, arXiv:1706.03762](https://arxiv.org/abs/1706.03762)*

用第一章的类比：KV Cache 就是模型旁边的**笔记本**。每个 token 的"索引"（K）和"内容"（V）只算一次记下来，下一个 token 到来时翻笔记本读旧条目，而不是从头重算。

**KV Cache 的本质是"用空间换时间"**——用 GPU 内存存储历史 K/V，避免每步重复计算。这个想法简单到几乎"无聊"，但它的内存代价很容易被低估。

#### 3.1.3 KV Cache 有多大？——内存墙

> **KV Cache 内存公式（FP16）**
>
> Memory = 2 × num_hidden_layers × num_kv_heads × head_dim × 2 bytes × num_tokens × batch_size
> * 第一个"2"：K 和 V 各一份
> * num_hidden_layers：Transformer 层数（如 32、61、80）
> * num_kv_heads：KV 头数（MHA = Q 头数，GQA = 组数）
> * head_dim：每头维度（通常 128）
> * seq_len / num_tokens：序列长度（2K → 128K → 1M）
> * 最后的"2 bytes"：FP16 精度
> * batch_size：并发请求数

以 LLaMA-1 65B（纯 MHA、128K 上下文）为例：
* 80 层 × 64 个 KV 头 × 128 维 × 2(K+V) × 2 bytes(FP16) = **2,560 KB/token**
* 128K tokens → 2,560 KB × 131,072 ≈ **320 GB**

而模型权重才 130 GB。**用来记住提示词的内存比模型本身还大**。这就是**内存墙**。

> UCM KVCache计算器 ：[KV Cache Size Calculator — Unified Cache Manager](https://ucm.readthedocs.io/en/latest/getting-started/kv_cache_calculator.html)

#### 3.1.4 三个压力点与五大优化方向

KV Cache 带来三个反复出现的压力：

1. **内存墙**——GPU 内存还没处理完长文档就被填满。7B 模型在 128K 上下文下仅缓存就需要 64 GB
2. **带宽瓶颈**——从 GPU 内存读取大缓存拖慢生成速度。Decode 阶段每步都要把整个 KV Cache 从 HBM 搬出来
3. **批量限制**——每个用户请求需要自己的 KV Cache，内存使用成倍增加，同时能服务的用户更少

还有来自管理上的浪费：旧系统预留固定大小内存块，PagedAttention 测量到 **60–80% 碎片浪费**。

> 来源：Kwon, W. et al. "Efficient Memory Management for Large Language Model Serving with PagedAttention." SOSP 2023. [arXiv:2309.06180](https://arxiv.org/abs/2309.06180)

后续所有优化技术都在回应这三个压力点。下一节给出完整的优化地图。

***

### 3.2　优化方向总览

|杠杆|代表技术|解决什么|
|---|---|---|
|更少 KV 头|MQA、GQA、MLA|减少存储多少份 K/V|
|更小的数字|KIVI、TurboQuant|每个数字用更少 bit|
|算得更快|FlashAttention|改变内存访问模式|
|缓存更少 token|H₂O、SnapKV|不缓存所有内容|
|更短注意力跨度|SWA、局部-全局|限制回看多远|

|层次|优化对象|章节|
|---|---|---|
|模型架构层|KV Cache 的本质大小（存什么）|3.3|
|存储表示层|每个数字的 bit 数（存多小）|3.4|
|硬件执行层|怎么算（算多快）|3.5|
|系统服务层|缓存怎么存、复用、调度|3.6（详见第四章）|
> **全是乘法因子，可以叠加**。GQA(4–8×) × 局部-全局(3–5×) × TurboQuant(4–7×) × PagedAttention(消碎片) × SnapKV(再缩减) → 理论 **≈160×** 缩减（相对朴素 FP16 MHA 基线）。实际部署比幻灯片上的乘法复杂，但方向明确：新系统使用不止一个杠杆。

***

### 3.3　模型架构层：四维正交（本讲义主线亮点）

> 模型架构层的优化只干一件事：改变 KV Cache 的**本质大小**（存什么）。四个维度彼此正交，可同时使用。

| 维度       | 动刀对象 | 代表技术             | 解决什么瓶颈               |
| -------- | ---- | ---------------- | -------------------- |
| **通道压缩** | 特征通道 | MQA → GQA → MLA  | KV Cache 体积（带宽）      |
| **序列稀疏** | 序列长度 | SWA → DSA        | O(n²) 计算量            |
| **时变递推** | 计算顺序 | 线性 → Mamba → KDA | 消灭 KV Cache（O(1) 状态） |
| **层间混合** | 网络深度 | 3:1 KDA:MLA      | 精度与效率的黄金配比           |

>这些技术不是竞争关系，而是**合纵连横**。现代大模型不是在 MLA/KDA/DSA/SWA 之间"二选一"，而是四个维度同时动刀。
##### 3.3.1　通道压缩：MHA → MQA → GQA → MLA

**MHA：128 份 KV 的昂贵基准**
![](/img/attention/Pasted-image-20260822163305.png)
原始 Transformer：每个头有独立 K 和 V。32 头 × 128 维 × 32 层 → 每 token 512 KB（LLaMA-2 7B）。每个头可以自由特化（语法、指代、否定……），但代价是 64 份缓存向量/token/层。

**MQA：所有头共享 1 份 KV**（Shazeer, 2019）
![](/img/attention/Pasted-image-20260822163232.png)
所有注意力头共享同一组 K/V → KV cache 缩小 n 倍（如 32 倍）。速度飞升——Decode 带宽减少 32 倍。但代价是：**表征多样性丧失**，长代码、多步推理、密集文档分析上精度明显退化。PaLM、Falcon-7B 使用。
>
> Shazeer, N. "Fast Transformer Decoding: One Write-Head is All You Need." [arXiv:1911.02150](https://arxiv.org/abs/1911.02150)

**GQA：分组共享**（Ainslie et al., 2023）
MHA 太贵、MQA 太极端？GQA 把 query 头分组，组内共享 K/V。32 头分 8 组 → 缓存减 4 倍，精度损失极小。**行业标配**：LLaMA-3、Qwen2、Gemma 2、Mistral。
![](/img/attention/Pasted-image-20260822163537.png)
转换方法极具实用价值：训练好的 MHA 模型用约 **5% 预训练计算量**即可升级为 GQA，不需要从头训练。

> 每 token KV Cache = 2 × n_layers × **G** × d_head × 2 bytes
> 其中 G = KV 头组数（MHA: G = n_heads，MQA: G = 1）
> Ainslie, J., Lee-Thorp, J., de Jong, M., et al. "GQA: Training Generalized Multi-Query Transformer Models from Multi-Head Checkpoints." _EMNLP 2023_. arXiv: [2305.13245](https://arxiv.org/abs/2305.13245)

**MLA：DeepSeek 的低秩潜压缩**（2024）
GQA 只是"砍头数"，没触及压缩本质。MHA、MQA、GQA 都在问"存多少份 K/V？"——MLA 问了一个更激进的问题：**"我们真的需要存完整的 K 和 V 吗？"**
> ![](/img/attention/arxiv-deepseek-v2-fig1.png)
>
> *图：DeepSeek-V2 论文原文——MLA 低秩联合 KV 压缩。不存完整 K/V，只存压缩的潜在向量 c_t + 64 维 RoPE key = 576 维/token/层，暴降 93.3%。来源：[DeepSeek-V2, arXiv:2405.04434](https://arxiv.org/abs/2405.04434)*

MLA 让模型**自己学压缩**：不存完整 K/V，而存一个紧凑的潜在向量 c_t，推理时通过学习到的投影矩阵重建。
![](/img/attention/Pasted-image-20260825193058.png)
> **MLA 核心**：c_t = W_DKV × h_t（压缩隐状态为 512 维潜向量）
> 
> 只缓存 c_t + 64 维 RoPE key = 576 维/token/层。相比 MHA 的 32768 维，**KV Cache 暴降 93.3%**，吞吐提升 5.76×。

**矩阵吸收戏法**：推理时不需要把 c_t 还原成 K——把 W_UK 离线吸收进 Q 的投影、W_UV 吸收进 W_O，直接在压缩空间做点积。等价于 MQA 的数据搬运量，却保留 MHA 的表达能力。
>
> DeepSeek-AI. "DeepSeek-V2." [arXiv:2405.04434](https://arxiv.org/abs/2405.04434)

![](/img/attention/Pasted-image-20260822163745.png)

***

##### 3.3.2　序列稀疏：SWA → DSA
通道压缩解决了"存多少份"，但注意力计算复杂度仍是 O(n²)。

> ![](/img/attention/Pasted-image-20260825193338.png)
> *图：Longformer 论文原文——从全注意力（左）到滑动窗口（中）到组合局部+全局注意力（右）。来源：[Longformer, arXiv:2004.05150](https://arxiv.org/abs/2004.05150)*

**SWA 滑动窗口**（Mistral 7B）

每层只关注最近 w 个 token（如 4,096），更早的滑出窗口。O(n²) → O(n×w)。KV cache 有固定上限——无论对话多长，每层只缓存最近 4K token。**局限**：长距离检索直接失明——"大海捞针"无法完成。
Mistral 用堆叠缓解：窗口 4K + 32 层，信息可跨约 131K token 传播。但对大部分实际查询，相关上下文就在近期。

> ![](/img/attention/arxiv-mistral-fig1.png)
>
> *图：Mistral 7B 论文——滑动窗口注意力。来源：[Mistral 7B, arXiv:2310.06825](https://arxiv.org/abs/2310.06825)*

> 来源：Jiang, A.Q. et al. "Mistral 7B." [arXiv:2310.06825](https://arxiv.org/abs/2310.06825) | Beltagy et al. "Longformer." [arXiv:2004.05150](https://arxiv.org/abs/2004.05150)

**交替局部-全局**（Gemma 2/3/4）
Google 不让每层都局部，而是交替：Gemma 3 每 5 个局部层配 1 个全局层（5:1）。只有 1/6 的层需要看完整上下文。

|模型|局部窗口|全局层|比例|KV Cache 收益|
|---|---|---|---|---|
|Gemma 2|4,096|每隔一层|1:1|~50%|
|Gemma 3|1,024|每 6 层一层|5:1|128K 大幅减少|
|Gemma 4 31B|1,024|每 6 层一层|5:1|128K/256K 上下文|

**DSA：主动检索而非被动截断**（DeepSeek-V3.2）

SWA 被动截断历史。DSA 换了一个思路：**主动检索**相关 token。三步走：

1. **闪电索引器**：用极低精度（FP4/FP8）低维向量，O(L) 时间内算当前 Q 与历史所有 token 的"粗糙关联分"——快但不精确，目的是筛掉大部分不相关的 token。
2. **Top-k 选择器**：挑最相关的 2048 个 K-V 槽位。
3. **精确计算**：只对这 2048 个做完整 MLA 点积。计算量从 O(n²) 降到 O(n × 2048)。

效果：128K Prefill 成本从陡峭上升变常数级，**API 推理价格直接减半**，同时保全长程检索能力。

> ![](/img/attention/Pasted-image-20260825193502.png)
> *图：DeepSeek-V3.2 论文——DSA 结构，绿色部分为与 MLA 的区别。来源：[DeepSeek-V3.2, arXiv:2512.02556](https://arxiv.org/abs/2512.02556)*

***

##### 3.3.3　时变递推：Linear → Mamba → Gated DeltaNet / KDA

* 线性注意力：改变乘法顺序，O(1) 固定状态消灭 KV Cache

> ![](/img/attention/15-mamba.png)
>
> *图：Mamba（S6）推理长度超出训练长度数千倍仍保持 100% 检索准确率。来源：[Mamba, arXiv:2312.00752](https://arxiv.org/abs/2312.00752)*

* Mamba：选择性机制打破 LTI，内容感知型记忆
>  Gu, A. & Dao, T. "Mamba." [arXiv:2312.00752](https://arxiv.org/abs/2312.00752)

> ![](/img/attention/17-gated-deltanet.png)
>
> *图：Gated DeltaNet 的 Delta Rule 状态更新。来源：[Gated Delta Networks, arXiv:2412.06464](https://arxiv.org/abs/2412.06464)*

* Gated DeltaNet / KDA：通道级细粒度忘却门 + Delta 规则精确编辑记忆
>  Yang, S. et al. "Gated Delta Networks." [arXiv:2412.06464](https://arxiv.org/abs/2412.06464) | Moonshot AI. "Kimi Linear." [arXiv:2510.26692](https://arxiv.org/abs/2510.26692)
- Lightning Attention-2
https://arxiv.org/abs/2401.04658 （Lightning Attention-2: A Free Lunch for Handling Unlimited Sequence Lengths in Large Language Models）
- KDA：Kimi Delta Attention
> https://arxiv.org/abs/2510.26692 （Kimi Linear: An Expressive, Efficient Attention Architecture）


* 代价：有损压缩，精确拷贝/长程检索有物理上限
***

##### 3.3.4　小孩才做选择，现代大模型全都要
大模型架构画廊：[LLM Architecture Gallery | Sebastian Raschka, PhD](https://sebastianraschka.com/llm-architecture-gallery/)

纯线性模型有物理上限：固定隐状态面对"精确拷贝"和"长程检索"信息必然溢出。纯注意力模型内存暴涨。>
工业答案是**混合架构**。

|                                      |                                      |
| ------------------------------------ | ------------------------------------ |
| ![](/img/attention/Pasted-image-20260822164314.png) | ![](/img/attention/Pasted-image-20260822164325.png) |
| ![](/img/attention/Pasted-image-20260822164357.png) | ![](/img/attention/Pasted-image-20260822164407.png) |
| ![](/img/attention/Pasted-image-20260822164428.png) | ![](/img/attention/Pasted-image-20260822164440.png) |
| ![](/img/attention/Pasted-image-20260822164539.png) | ![](/img/attention/Pasted-image-20260822164529.png) |
> 来源：大模型架构画廊： https://sebastianraschka.com/llm-architecture-gallerys
![](/img/attention/Pasted-image-20260827100154.png)
***

### 3.4　存储表示层：两种"压缩"

> 结构定了，再压存储：要么把**每个数字**压小（纯比特），要么把**存的 token** 变少（语义）。

#### 3.4.1　纯比特压缩：KIVI / KVQuant / TurboQuant / 1-bit

标准 KV Cache 用 FP16（2 bytes），量化把它压到 2~8 bit。像图像压缩——不删像素，只让每个像素更紧凑。
核心挑战：K 和 V 的离群值模式不同——**Key 的特定通道产生超大值**，**Value 的特定 token 产生尖峰**。量化轴必须匹配实际的离群轴。

|方法|位数 (K/V)|内存缩减|需校准|质量影响|
|---|---|---|---|---|
|FP16（基线）|16/16|1×|—|基线|
|INT8|8/8|2×|极少|可忽略|
|**KIVI**|2/2|~8×|否|近零损失|
|**KVQuant**|3/3|~5×|极少|PPL <0.1|
|**TurboQuant**|2.5–3.5|4–7×|否|近零损失|

- **KIVI**（ICML 2024）：Key 按通道量化、Value 按 token 量化——匹配各自离群轴。峰值内存 ↓2.6×、批大小 ×4、吞吐 +2.35~3.47×。无需训练。
- **KVQuant**（NeurIPS 2024）：RoPE 施加前量化 Key + 非均匀桶 + 稠密-稀疏分解。单卡 A100-80GB 跑 **100 万上下文**，8-GPU 跑 **1000 万**。
- **TurboQuant**（2025）：随机旋转 + 最优标量量化器 + 1-bit JL 变换。无需校准数据，3.5 bit 零损失。
    

>  **1 bit 权重 ≠ 1-bit KV Cache**：Bonsai 8B 权重全是 1-bit（模型仅 1.15 GB），但相乘产生的 K/V 向量仍是全精度浮点。65K 上下文下 KV Cache 是权重的 7 倍。必须配 KV 量化：Bonsai + Turbo1Bit(Q4_0) 把总内存从 10.6 GB 降到 **4.0 GB**。
> 
> Liu, Z. et al. "KIVI." [arXiv:2402.02750](https://arxiv.org/abs/2402.02750) | Hooper, C. et al. "KVQuant." [arXiv:2401.18079](https://arxiv.org/abs/2401.18079) | Google Research. "TurboQuant." [arXiv:2504.19874](https://arxiv.org/abs/2504.19874)

#### 3.4.2　语义压缩：只留"重要的 token"（H₂O / StreamingLLM / SnapKV）

观察：注意力分布极度倾斜。少数 token 吸收了大部分注意力权重，许多其他 token 几乎不产生贡献。为什么不以全量代价保留每一个 token？

|方法|核心思路|关键数字|
|---|---|---|
|**H₂O**（NeurIPS 2023）|动态追踪累计注意力最高的 token（heavy hitters），保留这些 + 最近窗口|留 20% → 吞吐 +29×|
|**Scissorhands**（NeurIPS 2023）|"重要性持续性"：被高度关注的会持续被关注 → 早期识别后固定保留|单独 5× 无损；+4-bit → 20×|
|**StreamingLLM**（ICLR 2024）|开头 token 是 attention sinks，移除会不稳定 → 保留 sinks + 滑窗|跑 400 万 token；22.2× 加速|
|**SnapKV**（NeurIPS 2024）|prefill 阶段就预选重要前缀，生成前就丢弃其余|速度 3.6×、内存 8.2×|
|**PyramidKV**|token 重要性在不同层不均匀 → 早期层多分配、后期层少分配|仅保留 12% 缓存即持平|

***

### 3.5　硬件执行层：FlashAttention，IO-Aware 分块

前两层优化"存什么"和"存多小"，这一层优化"怎么算"。

> ![](/img/attention/Pasted-image-20260825194551.png)
> *图：标准实现（左）——n×n 注意力矩阵物化到 HBM，来回搬运；FlashAttention（右）——SRAM 内分块算完，矩阵不落地。来源：[FlashAttention, arXiv:2205.14135](https://arxiv.org/abs/2205.14135)*

**问题**：标准注意力会计算完整的 n×n 分数矩阵并**物化到 HBM**（大但慢），再读回做 softmax——HBM↔SRAM 来回搬运。对于 32K 序列、128 个头，这个矩阵极大。

**解法**：把注意力矩阵切成 SRAM 能容纳的 tiles，每个分块在 SRAM 内**完整算完**（Q·K^⊤ → 增量 softmax → ×V），只把最终结果写回 HBM。矩阵不落地，数学完全等价。

|指标|FlashAttention-1|FlashAttention-2|
|---|---|---|
|加速|2–4× vs 基线|1.7–3× vs FA1；3–10× vs 标准|
|内存|O(n²) → **O(n)**|同|
|A100 利用率|~35%|**~72%**（225 TFLOPs/s）|

***

### 3.6　系统服务层：缓存管理总览
前面几节讲的都是"怎么让单个请求的 KV Cache 更小"。但生产环境要同时服务上千用户，这就引出一个关键问题：**KV Cache 能不能跨请求复用？**

#### 3.6.1 KV Cache：单次推理内的"计算复用"

先回顾 3.1 讲的 KV Cache。它解决的是**单次推理内**的重复计算问题：

- 用户发来一段 prompt，模型在 Prefill 阶段计算每个 token 的 K 和 V，存入缓存
- Decode 阶段每生成一个新 token，**从缓存读取**历史 K/V 做注意力，而不是重新计算
- 核心：历史 token 的 K/V **不变**，所以可以复用计算结果

> **KV Cache 的复用范围 = 单次请求内**。请求结束后，这个 KV Cache 通常就丢弃了——下一个用户的 prompt 不同，无法直接复用。


#### 3.6.2 Prefix Cache：跨请求的"存储复用"

现在考虑一个真实场景：你有 1000 个用户，每个人都在用同一个 System Prompt（比如 2000 token 的角色设定）。

- **没有前缀缓存**：每个用户请求到来时，模型都要把那 2000 token 的 prompt 从头算一遍 Prefill——生成 2000 个 token 的 K 和 V。1000 个用户 = 重复计算 1000 次。每秒 1000 个请求 = 每秒 20 亿次冗余的 KV 计算。
- **有前缀缓存**：第一个用户算完后，把这 2000 token 的 KV Cache **存下来**。后续用户的 prompt 如果前缀相同，直接复用已缓存的 KV，跳过这部分 Prefill。**命中即免费。**

>  **澄清一个概念**：服务端一般不保存历史上下文，上下文保存在client侧（用户主机上的agent应用或者厂商的chatBot服务器），每次请求将完整上下文发给服务端（推理引擎）

#### 3.6.3 联系与区别

|维度|KV Cache|Prefix Cache|
|---|---|---|
|**复用什么**|复用**计算结果**（K/V 不重算）|复用**存储的 KV Cache**（跳过整个 Prefill）|
|**复用范围**|单次请求内（请求结束即丢弃）|跨请求（多个用户/多轮对话之间）|
|**解决的问题**|Decode 阶段的重复计算|多请求的重复 Prefill|
|**省的是什么**|计算量（不重算 K/V 投影）|计算量（整个 Prefill 跳过） + 延迟（首 token 更快）|
|**需要什么前提**|历史 token 的 K/V 不变|不同请求共享相同前缀（如 System Prompt）|
|**对模型有改动吗**|无（推理层透明）|无（服务层透明，输出与重算完全一致）|

**一句话总结**：

> **KV Cache 是"在一次推理中，历史 token 的 K/V 不变，所以不重算"。Prefix Cache 是"多次推理之间，如果前缀相同，连 Prefill 都不用算，直接复用存储的 KV Cache"。**
> 
> Prefix Cache 是 KV Cache 的自然延伸——把"单次推理内的计算复用"扩展到"跨请求的存储复用"。

***
## 第四章　现代推理实践（系统落地）

> 从算法到线上：vLLM / SGLang 生态怎么把前面的优化变成真实吞吐。

### 4.1　vLLM 与 PagedAttention

- 问题：内存碎片化
在 vLLM 之前，服务系统为每个请求预分配一块连续内存，按最大可能序列长度计算。预分配 4,096 token 而用户只发送 200 个 → 浪费 3,896 个。乘以数千并发用户，生成一个 token 前就浪费了 **60–80%** GPU 内存。

**PagedAttention**：借鉴 OS 虚拟内存
![](/img/attention/Pasted-image-20260825195154.png)

> *图：PagedAttention 的虚拟块 → 物理非连续块映射，以及多请求共享前缀物理页。来源：参考 [PagedAttention, arXiv:2309.06180](https://arxiv.org/abs/2309.06180)*

Woosuk Kwon 和伯克利团队借鉴了操作系统：Linux 虚拟内存不需要物理连续 RAM，把内存分成**页**，通过页表映射，OS 将页放在任何有空间的地方。
PagedAttention 把这种模式应用于 GPU KV Cache：拆成小固定块（通常 16 或 32 token/块），按需分配，不预分配。页表映射逻辑位置到物理位置。请求 A 的块 3 可以紧挨着请求 B 的块 7。注意力内核不关心，它使用页表。

> 请求到达 → 按需分配 KV 块 → 块存储在 GPU 内存任意位置 → 页表映射逻辑 → 物理

- 结果

|指标|数值|
|---|---|
|吞吐量提升|2–4×（对比 FasterTransformer 和 Orca）|
|内存浪费|~0%（从 60–80% 降至）|
|KV Cache 共享|免费（Copy-on-Write 跨请求共享前缀块）|

vLLM 迅速成为最常用的 LLM 服务器之一。TensorRT-LLM 和 SGLang 也采用了类似分页方案。
> Kwon, W. et al. "PagedAttention." [arXiv:2309.06180](https://arxiv.org/abs/2309.06180)

---

### 4.2　SGLang 与 Radix Cache

**vLLM 的 APC**（Automatic Prefix Caching）：对 token 序列分块做哈希，在 KV 块池里查前缀匹配，命中即复用已缓存块、跳过 Prefill。对模型透明。

- RadixAttention
APC 处理精确前缀匹配。RadixAttention 更进一步：把 KV Cache 组织为**基数树**（token 序列的 trie）。两个请求共享前 500 token 后分叉 → 这 500 token 的 KV 仍可共享。多轮对话天然适合此结构。
LRU 逐出发生在叶子节点。多个并发请求可从同一节点读取而无需锁竞争。
![](/img/attention/Pasted-image-20260825195420.png)

|场景|前缀命中率|吞吐提升|
|---|---|---|
|固定系统提示（1K）|~100%|2–5×|
|RAG 共享文档|60–80%|1.5–3×|
|多轮对话|50–90%|1.3–2×|

>  Zheng, L. et al. "SGLang." [arXiv:2312.07104](https://arxiv.org/abs/2312.07104)
> 混合模型时代的接力：LMSYS 的 Unified Radix Cache 把"一棵树"推广到 FULL/SWA/MAMBA 组件（见 5.2.2）：[LMSYS Blog](https://www.lmsys.org/blog/2026-08-11-unified-radix-cache)

---
### 4.3　PD 分离：Prefill 与 Decode 分家

同一块 GPU 同时处理 prefill（计算密集）和 decode（带宽密集）会互相干扰。

|阶段|特性|GPU 利用率|
|---|---|---|
|**Prefill**|计算密集，并行处理全部 prompt，KV Cache 在此**一次大写入**|~90%|
|**Decode**|带宽密集，每步 1 token，**每步读完整 KV Cache**|20–40%|

新请求的 prefill 会抢占正在 decode 的 GPU——要么延迟现有用户，要么让新用户苦等首 token。这就是 **prefill-decode 干扰**。

一个 prefill 集群构建 KV 缓存，通过 NVLink/InfiniBand 传输，一个 decode 集群处理生成。

> 用户请求 → Prefill 集群：计算 KV → 传输 KV → Decode 集群：生成 token
![](/img/attention/Pasted-image-20260825200642.png)

|技术|解决的问题|使用方|
|---|---|---|
|Splitwise / DistServe|Prefill-decode 干扰|生产服务|
|**Mooncake**|KV Cache 作为**一级资源**（池化传输）|Moonshot（Kimi）|
|Ring Attention|KV 超单卡容量|序列并行长上下文|

>  **💡 服务层现在承担了部分智能**：KV 缓存优化不再只是模型架构问题，还涉及调度、布局、传输和内存所有权。
> 
> Zhong, Y. et al. "DistServe." [arXiv:2401.09670](https://arxiv.org/abs/2401.09670) | Qin, P. et al. "Mooncake." [arXiv:2407.00079](https://arxiv.org/abs/2407.00079) | Liu, H. et al. "Ring Attention." [arXiv:2310.01889](https://arxiv.org/abs/2310.01889)

### 4.4　AF 分离：Transformer 拆拆拆
- MoE：其MLP/FFN部分会有极大规模的权重，但在单次inference过程中，只会激活其中的一部分权重，以专家为单位，计算视角来看，专家本质上也就是包含几个离线训练好的FC层的sub-module。但是专家的激活是per-token的，这意味着在大batch情况下，根据大数定律，绝大部分的专家都会被激活。

这个传统的MoE部署中，Attention和Expert通常部署在同一个GPU上。Attention层需要大量的显存来存储KV Cache，而Expert层则需要大量的显存来存储海量的专家权重。

![](/img/attention/Pasted-image-20260825200836.png)
AF分离架构将Attention层和Expert层物理拆分，部署在不同的GPU集群上。Attention Cluster专注于维护KV Cache和计算Attention，Expert Cluster则专注于存储专家权重和计算FFN。
这种拆分带来了极高的灵活性：系统可以根据Attention和FFN不同的计算量比例，独立配置两类集群的资源。例如，对于长Context任务，可以增加Attention节点以容纳更多KV Cache；对于复杂推理任务（激活更多专家），可以增加Expert节点以提升FFN计算能力。


> 这带来的代价也是很明显的，AF分离引入了高频的跨节点通信，每一层的Attention输出都需要发送给Expert集群，Expert计算完后再发回。这种通信模式是M-to-N的，且数据包极小、频率极高。
> 目前非生产实践手段
> 相关论文：Preble（Stanford, 2024）首次系统化验证了 Attention 与 FFN 分节点调度的思路：[arXiv:2407.00023](https://arxiv.org/abs/2407.00023)
---
## 第五章　UCM 实践：从前缀缓存到混合模型

> UCM 是"把 KV Cache 当资源来管"的系统层答案：持久化、跨请求复用、混合模型语义。

### 5.1　KV 持久化复用：UCM 在做什么

前缀缓存不只是"服务端内存里的一个字典"。UCM（Unified Cache Manager，ModelEngine 社区开源）把这条思路推到极致：**把 KV Cache 持久化到外部存储，用多种检索机制替代冗余计算**。与 vLLM 集成后，多轮对话、长上下文推理等场景的延迟降低 **3–10×**。

> **核心原则**：KV 太大、太稀疏，与其全塞 GPU，不如**卸载 + 按需取回**。存储层次：GPU HBM → 主机 DRAM → SSD → 远端存储（NFS / Ds3fs / Mooncake——基于 RDMA 网络的高效 KVCache 共享集群），GPU 上只留部分或压缩后的 KV，序列长度和 batch size 都能变大。

UCM 的几种检索机制（本质都是"省重复计算"）：

- **前缀缓存（Prefix Cache）**：内容寻址的块存储，跨请求复用相同的 KV 块；
- **稀疏注意力（Sparse Attention）**：免训练检索（ESA / GSA / CacheBlend 等），超长序列只把相关的 KV 块 load 回来。论文指出"没有一种稀疏模式能适配所有场景和所有模型"，所以做成可插拔算法框架；
- **PD 分离**：存储-计算分离的异构部署（见 4.3）。

实现上不改 vLLM 内核：在 KV Connector 的接缝处挂钩子（scheduler 与 layer.py 的少数位置），做额外的 load / dump / 检索。

![](/img/attention/ucm-architecture.png)

> *图：UCM 整体架构。灰色为 vLLM 0.9.2 原有类，绿色为 UCM 新增组件：KV Connector 挂在调度链路上，KVStoreBase 把外部存储抽象成"块 ID + 偏移"的统一读写。来源：[UCM GitHub](https://github.com/ModelEngine-Group/unified-cache-management)*

**流水线设计（Pipeline Store）**：UCM Store 把"存 KV"这个过程拆成可热插拔的组件栈，每层只干一件事：

| 层 | 职责 | 关键数字 |
| --- | --- | --- |
| **Cache 层** | POSIX 共享内存缓冲（TransBuffer），命中直接读、不碰磁盘 | 命中率 80–95%，延迟毫秒级 → 微秒级 |
| **Compressor 层** | 夹在 Cache 与磁盘之间：热数据不压缩、冷数据落盘前自动压缩 | 压缩比 2–4× |
| **Posix / Ds3fs 层** | 本地磁盘 / 分布式文件系统后端 | — |
| **IO 引擎** | AIO（libaio，高并发吞吐 3–5×）与 Psync（低负载延迟低 20–30%）双引擎，按负载切换 | — |

- **异步任务系统**：Task 按 Shard 拆到多队列并行，吞吐 **10–15×**；TaskSet 做失败隔离（一块读取失败不拖垮整批）；超时保护（存储节点慢就快速失败、走本地降级）。
- **读写分离**：LoadQueue / DumpQueue 独立队列 + 批量聚合，P99 延迟 8ms → 3ms；LookupOnPrefix 把前缀查找从 O(n) 降到 O(log n)（1000 块 15ms → 3ms）。
- **BlockId** 用 16 字节定长强类型，哈希从 O(n) 变 O(1)（每块 50ns → 10ns）。

![](/img/attention/ucm-store-architecture.png)

> *图：UCM Store 流水线架构——Cache / Compressor / Posix 组件栈，每个组件是独立的 .so 动态库，可热插拔替换。来源：[Store Architecture — Unified Cache Manager](https://ucm--954.org.readthedocs.build/en/954/design-doc/store_architecture.html)*

> DeepWiki 代码导读： https://deepwiki.com/ModelEngine-Group/unified-cache-management
> RoadMap： https://github.com/ModelEngine-Group/unified-cache-management/issues/679

---

### 5.2　混合模型的架构冲击：UCM 每版本在适配什么

前缀缓存在纯注意力模型上很好用。但当 Kimi K3、Qwen3.6、DeepSeek-V4 这类混合模型上线，经典 Radix 树直接崩溃：同一段前缀混杂了三种互不兼容的复用语义。

| 组件 | 复用规则 | 前缀截断后 |
| --- | --- | --- |
| **FULL**（MLA 层） | KV 整条前缀全局有效 | 安全 |
| **SWA**（滑动窗口层） | 只有尾部窗口内有效 | 超出窗口必须遗忘，否则污染 |
| **MAMBA/KDA**（递推层） | 只存固定状态，仅在确切边界有效 | 自回归链断裂 → 乱码 |

#### 5.2.1　SGLang 的实践：Unified Radix Cache（LMSYS, 2026-08）

LMSYS 团队 2026 年 8 月发布 **Unified Radix Cache**，正面回应上面的问题。核心是把"共享前缀身份"和"组件特定的复用有效性"**分开**：

- **一棵树**：所有组件共享同一棵 token 键控的 radix 树（UnifiedTreeCore 管匹配 / 分裂 / 插入 / 锁 / 逐出），每个前缀有唯一坐标；
- **TreeComponent**：每种组件只定义自己"变"的部分——FULL（整条路径可复用）、SWA（只有尾部窗口可复用，窗口外留空墓碑）、MAMBA（只在确切边界有检查点，复用前 CoW 复制到私有槽）；
- **组件投票**：匹配时每个组件出一个 validator，**所有 validator 都接受**才推进复用边界（遍历可以走到 n4，但只承认 n2 是安全边界）——既不错放有效复用，也不允许无效复用；
- **模型 = 组件组合**：DeepSeek-V4 = FULL + SWA；Kimi-K3 = FULL + MAMBA（KDA 状态）；Inkling = 三者全上。新模型复用已有组合，不用再写一棵新树。

![](/img/attention/urc-component-tree.svg)

> *图：一棵 radix 拓扑提供统一前缀身份——FULL / SWA / MAMBA 组件各自执行路径 / 窗口 / 检查点复用语义，HiCache 决定负载住在 GPU L1、主机 L2 还是外部 L3。来源：LMSYS 博客 Figure 1*

**HiCache：同一身份跨三层内存**。组件身份不随物理位置改变：GPU L1 → 主机 L2 → 外部 L3（500 GiB Mooncake Store 分布式内存）。多轮对话 benchmark（DeepSeek-V4-Flash，4×H200、TP4、48 客户端、60 轮）：

| 配置 | 后期轮次命中率 | 有效输入吞吐 |
| --- | --- | --- |
| 仅 GPU L1 | 先掉 | 9.4K tokens/s |
| L1 + L2 | 撑更久 | 14.3K tokens/s |
| L1 + L2 + L3 | **≈98%** | **145.5K tokens/s** |

Inkling-Small（8×H200、TP8）：L3 命中率 96.8%、TTFT 1.23s、吞吐 67.1K（对比 L1 15.5K、L1+L2 21.1K）。

**会话感知逐出（Session-Aware Eviction）**：请求挂 session_id，缓存条目按活跃会话调整逐出顺序——**只改顺序、不 pin 内存**；/close_session 只释放引用信号、不立即删缓存。SWE-bench 上比普通 LRU HiRadixCache 的 TTFT 低 **2.9%–16.6%**（DeepSeek-V4-Pro 与 Qwen3.5-397B-A17B）。

![](/img/attention/urc-swebench-ttft.png)

> *图：SWE-bench 上的缓存命中率与 TTFT——上图为 device+host 缓存命中堆叠，下图为 TTFT（标签为相对 LRU 基线的下降幅度）。来源：LMSYS 博客 Figure 6*

**实验性 Rust 树核心**：树状态机搬到 Rust，Python 仍独享"请求 → token 映射"和物理 KV 分配。SWA 负载 200 轮 TTFT 平均降 **38%**（最后 25 轮 42%）；FULL 平均降 10%（最后 25 轮 18%）；混合 SSM 平均降 5%（最后 25 轮 7%）。

> 启用：SGLANG_ENABLE_UNIFIED_RADIX_TREE=1
> 博客原文：LMSYS Org. "Unified Radix Cache: One Tree for Hybrid Model Prefix Caching." https://www.lmsys.org/blog/2026-08-11-unified-radix-cache

#### 5.2.3　UCM 的 FAWA：针对 DeepSeek-V4 的实践

SGLang 有 Unified Radix Cache，vLLM 这边的答案叫 **FAWA**（FULL/Window Attention 双存储 Connector），目标是对接 vLLM 的 **HMA**（混合多头注意力）KV 布局——也就是 DeepSeek-V4 式"全注意力组 + 窗口注意力组"的分组缓存：

- **fa_store / wa_store 分离**：FULL 组与 WINDOW 组各自独立的存储与哈希域，canonical block 哈希 + 组布局映射，前缀复用精确到组；
- **TP/MLA 的 dump 均衡**：FA dump 行按 TP rank 切分、WA dump 按请求分配（PR #968 / #976）；
- **异步 dump 完成追踪**：scheduler 侧等 worker 的 dump 任务真正结束才释放 HMA 块（PR #986 修的正是"块被提前释放"的 bug）；
- **wa_dump_block_wise**：默认按 canonical 块边界存 WA tail（PR #992）——之前只存每 chunk 最后一个 WA tail，外部缓存复用要看 chunk 边界的脸色。

DeepSeek-V4 的 C4/C128 压缩 KV 池、indexer 缓冲、compressor 状态**不定义新的复用边界**——它们是 sidecar：跟随源池的索引、不投票、不占树的槽位（3 个跟随 FULL，2 个跟随 SWA）。这与 LMSYS 博客的 Anchor / Sidecar 契约是同一个思想。

![](/img/attention/urc-deepseek-v4-sidecars.svg)

> *图：DeepSeek-V4 的组件与 sidecar——FULL / SWA 是组件（独立索引空间，运行时把 FULL 尾槽 F4/F5 映射到 SWA 槽 S0/S1），C4/C128 压缩池等是跟随源池的 sidecar。来源：LMSYS 博客 Figure 3*

**vLLM 当前的短板**：整条栈只有**一个标量 hit_length**（Connector 接口、HybridKVCacheCoordinator、scheduler 全是单值），各组件命中后取**交集截断**——FA 命中 4 块但 SWA 没命中时交集 = 0，所有缓存作废、从头重算。"部分命中 + 间隙填充"是正在讨论的方向（issue #1223 评论附逐层代码证据）。

> FAWA 演进：#953（支持 HMA）→ #968（合并简化）→ #976（dump 处理 + TP 均衡）→ #986（异步 dump 块释放修复）→ #992（WA 按块 dump + vllm-ascend 0.20.2rc1）
> 设计文档： https://github.com/ModelEngine-Group/unified-cache-management/pull/953

