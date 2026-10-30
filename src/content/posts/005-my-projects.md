---
title: 聊聊我的开源项目们：LLM 基础设施方向的技术探索
description: 六个开源项目的回顾：性能测试、镜像同步、KV Cache 计算与持久化，记录解决什么问题、卡在哪、下一步想做什么
publishedAt: "2026-06-01"
category: 项目笔记
tags:
  - 开源
  - 项目总结
  - LLM
draft: false
---

## 写在前面

这两年大家在聊模型本身，参数量、推理能力、多模态。我做基础设施，关心的还是那几个更笨的问题：模型怎么跑起来，跑起来怎么稳住，稳住了怎么少花钱。

模型再强，部署搞不定也没用；推理再快，资源管理一乱照样翻车。这两年我就在这个方向写了几个工具，下面一个一个说，包括当时想解决什么、卡在哪、现在什么状态。

## ClawPerf：LLM 服务性能基准测试

GitHub: [Potterluo/ClawPerf](https://github.com/Potterluo/ClawPerf)

### 问题背景

LLM 服务上线前都要做性能测试。现成的工具要么太简单，只发单请求；要么太重，得搭一整套压测平台。我想要的东西很朴素：能模拟几个真实用户一起打过来，统计 TTFT、TPS 和成功率，一个命令就能跑，不用装一堆依赖。

### 设计

核心就是并发控制，用多个并发请求去逼近真实负载：

```bash
# 基本用法：模拟 5 个并发用户，每个发 10 个请求
clawperf --url http://localhost:8000/v1/chat/completions \
         --model llama3 \
         --concurrency 5 \
         --requests 10 \
         --prompt "Hello, how are you?"
```

输出会统计平均 TTFT、平均 TPS、成功失败率，以及 P50/P90/P99 的延迟分布。

### 三个技术点

并发用 Python asyncio 加 aiohttp，异步 HTTP 客户端才能真正并发，开线程是假的。指标要边收边算，因为推理是流式输出，等整个响应回来再统计，TTFT 就没意义了。Token 计数在没有现成 tokenizer 时用字符数估算，不精确，但看趋势够用。

### 适用场景

模型上线前的性能验收、不同推理引擎之间横向对比（vLLM、TGI、TensorRT-LLM）、GPU 选型时测不同卡的表现。

### 后续计划

想加长文本测试、多轮对话测试和混合负载测试。

## MirrorX：容器镜像同步系统

GitHub: [Potterluo/MirrorX](https://github.com/Potterluo/MirrorX)

### 问题背景

镜像管理是个老问题，但 AI 场景把它放大了。LLM 相关镜像动辄几 GB 到十几 GB，还要从 Docker Hub 同步到内网、再同步到多云，基础镜像一更新就得跟着同步新版本。

### 架构

四个组件：skopeo 负责跨仓库复制，cron 定时触发，webhook 在完成或失败时通知，WebUI 做可视化的配置和监控。

```yaml
# 同步任务配置示例
sync_tasks:
  - name: "sync-llm-base-images"
    source: "docker.io"
    destination: "myregistry.internal"
    images:
      - "vllm/vllm-openai:latest"
      - "huggingface/text-generation-inference:latest"
    schedule: "0 2 * * *" # 每天 2 点执行
    notify_webhook: "https://my-webhook/sync-complete"
```

### 几个特性

增量同步只拉新增的 layer，省带宽也省时间；架构过滤只同步需要的 amd64 或 arm64；网络抖动时自动重试，不丢任务；每次同步的日志都留档，出问题能翻。

### 适用场景

企业内网仓库维护、多云环境分发、CI/CD 里提前预热常用镜像。

## KVCache-calculator-Skill：KV Cache 内存计算器

GitHub: [Potterluo/KVCache-calculator-Skill](https://github.com/Potterluo/KVCache-calculator-Skill)

### 问题背景

KV Cache 是推理时的内存大户，经常有人问我这台卡能跑多大模型、能撑多长上下文。这事不是拿参数量除一下就能回答的，得看序列长度、层数、注意力头数，还得看架构。

### 设计

做成 CLI，输入模型参数，输出内存估算：

```bash
# 计算 Standard Attention 的 KV Cache
kvcache-calc --architecture standard \
             --num-layers 32 \
             --num-heads 32 \
             --head-dim 128 \
             --seq-length 4096 \
             --dtype fp16

# 输出：Estimated KV Cache Memory: 2.0 GB
```

支持的架构：

| 架构     | 特点                        | 计算公式差异                              |
| -------- | --------------------------- | ----------------------------------------- |
| Standard | 传统注意力                  | `2 × layers × heads × head_dim × seq_len` |
| GQA      | Grouped Query Attention     | 头数按 KV group 计算，内存更省            |
| MLA      | Multi-Head Latent Attention | DeepSeek 的压缩方案，内存大幅降低         |
| Hybrid   | 混合架构                    | 按比例组合不同 Attention                  |

### 难点

每种架构的公式得自己推一遍，抄不得。dtype 会影响结果，fp16 是 2 字节、fp32 是 4 字节。超长序列和多批次下的内存峰值也要单独处理。

### 适用场景

部署前的资源评估、不同架构之间的内存对比、长文本场景到底可不可行。

## docker-pull-tar：Docker 镜像拉取工具

GitHub: [Potterluo/docker-pull-tar](https://github.com/Potterluo/docker-pull-tar)

这个项目之前单独写过（[我写了个 Docker 镜像拉取工具，不用装 Docker](/posts/docker-pull-tar/))，这里简单回顾：

不需要 Docker 也不需要 Python，有 curl 和 shell 就能从 Registry 拉镜像打包成 tar。

它解决的是内网和离线交付的麻烦事：目标机器没有 Docker 但要拉镜像；大镜像传到一半断了；在 ARM 机器上不小心拉了 x86 的镜像。

```bash
# 基本用法
./docker-pull-tar.sh nginx:latest

# 指定架构
./docker-pull-tar.sh --platform linux/arm64 nginx:latest

# 断点续传
# 下载中断了，重新运行同一个命令即可
./docker-pull-tar.sh nginx:latest
```

实现上是绕开 Docker，直接和 Registry 的 HTTP API 打交道：解析镜像名拿到 Registry 地址，取 Manifest 查 layer 列表，用 curl 一个个下 blob，按 Docker 的 tar 格式组装，最后校验 SHA256。

## unified-cache-management：LLM KV Cache 持久化复用

GitHub: [Potterluo/unified-cache-management](https://github.com/Potterluo/unified-cache-management)

### 问题背景

相同 prefix 的请求（比如同一段 system prompt）每次都要重算一遍 KV Cache，纯属浪费。如果能持久化下来给后续请求复用，TTFT、算力、吞吐三样都能受益。

### 设计思路

```text
请求流程：
1. 请求进来 → 解析 prefix（system prompt + 部分 user prompt）
2. 检查缓存池 → 是否有匹配的 KV Cache？
3. 如果有 → 复用缓存，只计算新增部分
4. 如果没有 → 完整计算，并缓存结果
```

三处难点：不同推理引擎的 KV Cache 格式不一样，要统一接口；prefix 匹配要快；内存有限，淘汰策略得想清楚。

### 当前进展

还在实验阶段。已验证的是 prefix 匹配能带来 30%-50% 的 TTFT 下降、不同引擎的缓存接口差多少、内存管理的基本策略。后面想做成通用缓存层，适配多种推理引擎。

## MultiUserClaw：多用户版 OpenClaw

GitHub: [Potterluo/MultiUserClaw](https://github.com/Potterluo/MultiUserClaw)

### 问题背景

OpenClaw 是个不错的 LLM 接口聚合项目，原版面向单用户。放到企业里就不够了，需要多用户隔离、每个人的用量统计、配额管理防止一个人把资源吃光。

### 扩展

```yaml
# 用户配置示例
users:
  - name: "alice"
    api_key: "sk-alice-xxx"
    quota:
      max_tokens_per_day: 100000
      max_requests_per_minute: 60
    allowed_models:
      - "gpt-4"
      - "claude-3"

  - name: "bob"
    api_key: "sk-bob-xxx"
    quota:
      max_tokens_per_day: 50000
    allowed_models:
      - "gpt-3.5"
```

按 API key 识别用户，路由到对应的模型配置；请求前查配额，超了直接拒；每次请求记 token 数和成本，能导出报表；不同用户可访问的模型分开。

### 适用场景

企业内部 LLM 服务、多团队共享推理资源、按用量计费。

## 回顾与展望

六个项目方向各不相同，但都在解决同一类问题：让 LLM 在生产环境里更稳、更省、更省事。

| 项目                     | 解决的问题        | 核心价值                   |
| ------------------------ | ----------------- | -------------------------- |
| ClawPerf                 | 性能测试难做      | CLI 基准测试，模拟真实负载 |
| MirrorX                  | 镜像同步繁琐      | 自动化同步，WebUI 管理     |
| KVCache-calculator-Skill | 内存评估靠猜      | 精确计算不同架构的内存占用 |
| docker-pull-tar          | 无 Docker 拉镜像  | 纯 shell 工具，断点续传    |
| unified-cache-management | KV Cache 重复计算 | 持久化复用，降低延迟       |
| MultiUserClaw            | 多用户管理缺失    | 配额、权限、用量统计       |

写这些项目的收获，主要是把几个方向吃深了一点：KV Cache、TTFT、TPS 这些指标背后到底是什么；Registry API 和镜像格式怎么工作；做工具和做 Demo 的区别在哪，后者能跑，前者要能给人用；以及开源是怎么运转的，提 PR、收 Issue、被别人的需求推着改。

接下来想往三个方向走：缓存管理不只做 prefix 匹配，语义相近的请求也能复用；多模型混跑时的资源分配；以及更准确的资源预估和成本控制。

项目都在 GitHub 上，有 Issue 和 PR 都欢迎。
