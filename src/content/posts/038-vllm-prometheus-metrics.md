---
title: "vLLM 推理指标怎么看：从 Grafana 面板到 Prometheus 手写 PromQL"
description: 用一套本地可运行的查询，解释缓存命中率、TTFT、TPOT、吞吐和并发，并核对进程累计值、最新短窗口值与所选区间值的差别。
publishedAt: "2026-11-28"
category: 项目笔记
tags:
  - vLLM
  - Prometheus
  - PromQL
  - Grafana
  - KV Cache
draft: false
featured: true
---

一张推理面板的两个位置同时出现 Total tok/s：服务概览是 72.7K，核心指标卡是 64.3K。输入 63.6K，加输出 678.9，明明约等于 64.3K，为什么另一处会多出 8.4K？

排查后发现，两处 PromQL 都在算输入加输出，也没有重复选择实例。服务概览取最近 1 分钟 `rate` 的末点，核心卡取整个所选区间的平均值。流量有波动时，两个数字自然不同。后来我把服务概览也改成区间平均，并让校验脚本直接比较同一求值时刻的结果。

这次排错提醒我，看推理指标不能只核对指标名。还要问三个问题：原始数据是 Counter、Gauge 还是 Histogram；计算用了哪个窗口；面板展示的是整段统计还是最后一个点。本文把这套检查方法落到缓存命中率、TTFT、TPOT、吞吐和并发上，所有 PromQL 都可以脱离 Grafana，直接放进 Prometheus 的 Query 页执行。

## 材料与验证口径

本文涉及三类材料：

- Dashboard：[通用 vLLM 总览面板 PR #1836](https://github.com/ModelEngine-Group/unified-cache-management/pull/1836)，以及[配套文档与查询速查](https://www.modelscope.cn/datasets/keriko/UCM_tools/tree/master/metrics/Grafana_DashBoards)。
- 指标定义：[vLLM Metrics 文档](https://docs.vllm.ai/en/stable/design/metrics/)和上游 [`buckets.py`](https://github.com/vllm-project/vllm/blob/main/vllm/v1/metrics/buckets.py)。TPOT 直方图使用 vLLM 0.11 及以上版本。
- 本地验证环境：`demo/docker-compose.yml` 启动两个合成 vLLM v1 风格 exporter、Prometheus 和 Grafana。数据由脚本生成，只用于验证公式与面板，不代表生产性能。

本地地址如下：

| 组件          | 地址                            |
| :------------ | :------------------------------ |
| Prometheus    | `http://127.0.0.1:9099`         |
| Grafana       | `http://127.0.0.1:3009`         |
| 一个 exporter | `http://127.0.0.1:8008/metrics` |

文中实测表固定在同一求值时刻，窗口为 30 分钟，短窗口为 1 分钟。先执行 23 个指标查询，再按 `instance × engine` 执行 10 个原始计数器查询，独立复算命中率、TTFT、TPOT 和总吞吐。截图在另一些时刻生成，流量持续变化，因此截图值和表格值不要求相等。

## 先看请求阶段，再看指标名称

一次请求可以拆成到达、排队与 Prefill、持续生成、完成四段。缓存命中影响 Prefill 要重算多少，TTFT 反映首 Token 前的等待，TPOT 和 ITL 描述后续生成，E2E 记录完整耗时。

![图 1 请求阶段与指标类型的对应关系，先定位阶段再选择 PromQL 计算方式](/img/038-vllm-prometheus-metrics/fig-01.svg)

常见指标可以按问题归成五组：

| 问题            | 代表指标                                                                     |
| :-------------- | :--------------------------------------------------------------------------- |
| 服务处理了多少  | `prompt_tokens_total`、`generation_tokens_total`                             |
| 缓存省了多少    | `prefix_cache_hits_total`、`prefix_cache_queries_total`                      |
| 首 Token 等多久 | `time_to_first_token_seconds`                                                |
| 持续生成快不快  | `request_time_per_output_token_seconds`、`inter_token_latency_seconds`       |
| 系统是否排队    | `num_requests_running`、`num_requests_waiting`、`request_queue_time_seconds` |

Prometheus 数据类型决定后续写法：

- Counter 只增不减，例如 Token 数、命中数、完成请求数。看区间增量用 `increase`，看速率用 `rate`。
- Gauge 可升可降，例如运行中请求数、等待数、KVCache 使用率。看当前值、区间平均或峰值，不对它直接做 `rate`。
- Histogram 同时提供 `_bucket`、`_sum`、`_count`。均值来自 `_sum/_count`，分位数来自 `_bucket`，两类查询不要混用原始指标名。

## 总值、最新点、区间值，差别在窗口

“总值”至少有两种含义，“最新点”也不只有一种。以输入 Token 为例，本地同一时刻能得到四个都正确但用途不同的数字。

![图 2 同一个输入 Token 指标在进程累计、区间总量、最新短窗口速率和区间平均速率下的实测差异](/img/038-vllm-prometheus-metrics/fig-02.svg)

### 进程累计值

```text
sum(vllm:prompt_tokens_total)
```

这是所有匹配进程当前 Counter 的总和。每个进程从各自启动时开始累计，进程重启会重新计数。 Grafana 切换最近 30 分钟或最近 6 小时，不会改变这个查询在当前求值时刻的含义。

### 区间总增量

```text
sum(increase(vllm:prompt_tokens_total[30m]))
```

这是最近 30 分钟新增的输入 Token 数。`increase` 会根据窗口内样本估算完整窗口增量，结果可能带小数，不要把它理解成逐条请求精确相加后的整数。

### 最新短窗口速率

```text
sum(rate(vllm:prompt_tokens_total[1m]))
```

这是最近 1 分钟平均每秒输入 Token 数，再取该曲线在当前求值时刻的值。流量刚上升时，它会明显高于长区间平均值；流量刚下降时则相反。

### 区间平均速率

```text
sum(increase(vllm:prompt_tokens_total[30m])) / 1800
```

这是 30 分钟总增量除以 1800 秒。它适合回答“这段时间平均处理能力是多少”，与最近 1 分钟速率不需要相等。

Grafana Stat 卡经常再对查询结果取 `lastNotNull`，所以还要区分两件事：表达式本身的统计窗口，以及面板在整条结果序列里取哪个点。`increase[30m]` 的末点是区间值，`rate[1m]` 的末点是短窗口最新值，两者都不只是“当前 Counter 是多少”。

## 面板上的数字分别回答什么

当前 Dashboard 保留九个分组，阅读时不需要逐块查配置，可以先抓住几个代表位置。

![图 3 Grafana 服务概览与核心指标卡，展示区间总吞吐、缓存命中率、并发、等待和四类延迟](/img/038-vllm-prometheus-metrics/fig-03.png)

- 服务概览：请求总量与 Token 总量是区间累计，请求速率是短窗口，区间总吞吐与核心卡共用同一个表达式。
- 核心指标总览：吞吐、命中率、TTFT、TPOT、ITL、E2E 都以所选区间统计为主。TPOT 旁的单请求速度由平均 TPOT 换算。
- 缓存命中分析：左侧饼图看整段 Token 去向，右侧曲线看短窗口命中率变化。HBM 绿、外部蓝、综合紫、未命中灰。
- 调度队列：当前 Running/Waiting 是 Gauge，区间平均与峰值来自子查询，完整趋势另有时序图。
- 性能趋势分析：TTFT、TPOT、E2E、ITL 分开显示，Avg/P50/P90 为主，P99 用于观察尾部。
- DP Engine 分布：按 `instance × engine` 展开，全局汇总掩盖的冷热差异在这里核对。

[完整面板截图](https://www.modelscope.cn/datasets/keriko/UCM_tools/resolve/master/metrics/Grafana_DashBoards/img/overview-refined.png)展示了这些区域的相对位置。下文只保留查询，不再依赖 Grafana 的变量和面板类型。

## 在 Prometheus Query 页直接执行

打开 `http://<prometheus>:9090/graph`，本地环境是 `http://127.0.0.1:9099/graph`。粘贴表达式后点 Execute：

- Table：在指定 evaluation time 做一次瞬时求值，适合核对一个数字。
- Graph：在选定时间范围内做范围求值，适合看曲线。切到 Graph 后，`increase[30m]` 会在每个评估点计算一次，形成滑动窗口序列。
- Explain：检查表达式各部分的解析与执行过程，适合继续排查空结果。

Grafana 变量不能原样放进 Prometheus UI，要先替换：

| Grafana 写法         | 本文 Prometheus 写法            |
| :------------------- | :------------------------------ |
| `$__range`           | `30m`                           |
| `$__range_s`         | `1800`                          |
| `$__rate_interval`   | `1m`                            |
| `$__interval`        | `20s`                           |
| `$model_name`        | 具体模型标签，或去掉该过滤条件  |
| `$job` / `$instance` | 具体 job / 实例，或去掉过滤条件 |

例如 Dashboard 的区间平均输入吞吐：

```text
sum(increase(vllm:prompt_tokens_total{model_name=~"$model_name"}[$__range])) / $__range_s
```

在本地 Prometheus UI 中写成：

```text
sum(increase(vllm:prompt_tokens_total[30m])) / 1800
```

如果只看一个模型或一个实例，再补标签：

```text
sum(increase(vllm:prompt_tokens_total{model_name="qwen2.5-72b-instruct", instance="vllm-a:8000"}[30m])) / 1800
```

也可以用 API 做同样的瞬时查询：

```bash
curl -s -G 'http://127.0.0.1:9099/api/v1/query' \
  --data-urlencode 'query=sum(increase(vllm:prompt_tokens_total[30m])) / 1800'
```

## 缓存命中率：先统一分母

记四个 Counter：

- $H$：`vllm:prefix_cache_hits_total`，本地 HBM 命中 Token 数。
- $Q$：`vllm:prefix_cache_queries_total`，全部被查询的 Token 数。
- $E$：`vllm:external_prefix_cache_hits_total`，外部缓存命中 Token 数。
- $X$：`vllm:external_prefix_cache_queries_total`，交给外部缓存查找的 Token 数。

在 vLLM 标准记账关系里，外部查询处理的是本地未命中的余量，$X=Q-H$。因此面板中的三种命中率共用 $Q$ 作分母：

$$
L=\frac{H}{Q},\qquad R=\frac{E}{Q},\qquad T=\frac{H+E}{Q}=L+R
$$

### 所选区间的本地、外部与综合命中率

```text
# 本地 HBM 命中率
sum(increase(vllm:prefix_cache_hits_total[30m]))
/ sum(increase(vllm:prefix_cache_queries_total[30m]))
```

```text
# 外部缓存贡献份额
sum(increase(vllm:external_prefix_cache_hits_total[30m]))
/ sum(increase(vllm:prefix_cache_queries_total[30m]))
```

```text
# 综合命中率
(sum(increase(vllm:prefix_cache_hits_total[30m]))
 + sum(increase(vllm:external_prefix_cache_hits_total[30m])))
/ sum(increase(vllm:prefix_cache_queries_total[30m]))
```

结果在 0 到 1 之间，乘 100 才是百分比。`sum` 要先于除法，这样多个 DP Engine 会按查询 Token 量加权，不能把各 Engine 百分比再做算术平均。

### 最新短窗口命中率

```text
(sum(rate(vllm:prefix_cache_hits_total[1m]))
 + sum(rate(vllm:external_prefix_cache_hits_total[1m])))
/ sum(rate(vllm:prefix_cache_queries_total[1m]))
```

它回答最近 1 分钟的命中情况，不要求等于 30 分钟综合命中率。

### 进程累计命中率

```text
(sum(vllm:prefix_cache_hits_total)
 + sum(vllm:external_prefix_cache_hits_total))
/ sum(vllm:prefix_cache_queries_total)
```

它主要受各进程启动以来的历史流量影响，不能当成当前 30 分钟命中率。

### 另一个合法但不同的外部口径

```text
sum(increase(vllm:external_prefix_cache_hits_total[30m]))
/ sum(increase(vllm:external_prefix_cache_queries_total[30m]))
```

这是 $E/X$，表示“已经交给外部查找的 Token 中有多少命中”，不能命名为“外部贡献份额”后与 $E/Q$ 直接比较。面板里的外部命中率使用 $E/Q$，所以本地和外部可以相加。

分母为 0 时没有定义，应该显示无数据，不要用 `clamp_min(分母, 1e-9)` 硬算出一个巨大比率。外部指标不存在时，也应明确显示缺失或使用 `or vector(0)` 处理可选 Counter，而不是把无数据解释成 0% 命中。

## TTFT：均值看 `_sum/_count`，分位看 `_bucket`

TTFT 从请求到达到首个 Token 返回，主要包含排队和 Prefill。单位为秒。

### 区间平均 TTFT

```text
sum(increase(vllm:time_to_first_token_seconds_sum[30m]))
/ sum(increase(vllm:time_to_first_token_seconds_count[30m]))
```

本地复算为 0.37649 秒，即约 376.49ms。

### 区间 P50 / P90

```text
# P50
histogram_quantile(0.5,
  sum by(le) (increase(vllm:time_to_first_token_seconds_bucket[30m])))
```

```text
# P90
histogram_quantile(0.9,
  sum by(le) (increase(vllm:time_to_first_token_seconds_bucket[30m])))
```

本地 P50 约 289.77ms，P90 约 817.79ms。这里先对区间 bucket 增量求和，再求分位，不能对每秒 P90 再做平均来替代。

### 最新短窗口 TTFT

```text
# 平均
sum(rate(vllm:time_to_first_token_seconds_sum[1m]))
/ sum(rate(vllm:time_to_first_token_seconds_count[1m]))
```

```text
# P90
histogram_quantile(0.9,
  sum by(le) (rate(vllm:time_to_first_token_seconds_bucket[1m])))
```

把 `[1m]` 改回 `[30m]`、`rate` 改回 `increase`，就得到上一节的区间口径。两个窗口回答的问题不同，不需要数值一致。

## TPOT：先确认直方图，再谈单请求速度

vLLM 0.11 起，`vllm:request_time_per_output_token_seconds` 记录单请求 TPOT：

$$
TPOT_i=\frac{E2E_i-TTFT_i}{n_{out,i}-1}
$$

减 1 是因为首个 Token 已计入 TTFT。平均与分位数应使用这一份 per-request 直方图。

### 区间平均 TPOT

```text
sum(increase(vllm:request_time_per_output_token_seconds_sum[30m]))
/ sum(increase(vllm:request_time_per_output_token_seconds_count[30m]))
```

本地结果约 38.44ms。

### 区间 P90 TPOT

```text
histogram_quantile(0.9,
  sum by(le) (increase(vllm:request_time_per_output_token_seconds_bucket[30m])))
```

本地结果约 92.10ms。

### 由平均 TPOT 换算单请求生成速度

```text
1 / (
  sum(increase(vllm:request_time_per_output_token_seconds_sum[30m]))
  / sum(increase(vllm:request_time_per_output_token_seconds_count[30m]))
)
```

本地结果为约 26.02 tok/s。等价写法是 $1000/TPOT(ms)$。这是基于区间平均 TPOT 的近似单请求生成速度，不能与整个服务的 `generation_tokens_total / 秒` 混为一谈。后者包含并发请求的吞吐。

![图 4 Prometheus Table 页实际执行区间 TTFT、TPOT 与单请求速度查询，三条表达式都返回独立结果](/img/038-vllm-prometheus-metrics/fig-04.png)

### 最新短窗口 TPOT

```text
sum(rate(vllm:request_time_per_output_token_seconds_sum[1m]))
/ sum(rate(vllm:request_time_per_output_token_seconds_count[1m]))
```

本地同一批验证中，区间平均约 38.44ms，最近 1 分钟平均约 36.04ms。短窗口流量变化足以解释差异。

### TPOT 和 ITL 不要混用

`vllm:inter_token_latency_seconds` 是 ITL，统计相邻输出事件的间隔；TPOT 按请求统计持续生成耗时。标准 Decode 中两者通常接近，投机解码一次接受多个 Token 时可能明显分离。旧指标 `time_per_output_token_seconds` 的名字容易误导，它实际采样的是 ITL，不能直接替代这里的 per-request TPOT 直方图。

还要避开这个跨请求近似：

```text
# 不推荐：分子分母可能对应不同请求集合
(sum(increase(vllm:e2e_request_latency_seconds_sum[30m]))
 - sum(increase(vllm:time_to_first_token_seconds_sum[30m])))
/ clamp_min(
    sum(increase(vllm:generation_tokens_total[30m]))
    - sum(increase(vllm:e2e_request_latency_seconds_count[30m])),
    1e-9)
```

TTFT 在请求进入时记录，E2E 在请求完成时记录。长请求跨窗口时，分子与分母可能不属于同一批请求，极端情况下会得到负 TPOT。使用 TPOT 直方图 `_sum/_count` 后，均值和分位数才对应同一批完成样本。vLLM 低于 0.11 时没有这份直方图，应显示无数据，不要伪造一个确定值。

## 总吞吐与并发：一个看 Counter，一个看 Gauge

### 区间平均总吞吐

```text
(sum(increase(vllm:prompt_tokens_total[30m])) / 1800)
+
(sum(increase(vllm:generation_tokens_total[30m])) / 1800)
```

服务概览与核心卡现在共用这条表达式。独立复算结果约 93.97K tok/s，等于区间输入吞吐加输出吞吐。

### 最新短窗口总吞吐

```text
sum(rate(vllm:prompt_tokens_total[1m]))
+
sum(rate(vllm:generation_tokens_total[1m]))
```

本地同一时刻约为 98.64K tok/s，与区间平均的 93.97K 不同，流量末点变化就是原因。若产品希望两处显示同一个概念，应该统一窗口，而不是让其中一个数字去凑另一个。

### 当前并发与区间峰值

```text
# 当前所有匹配实例 / Engine 的 Running
sum(vllm:num_requests_running)
```

```text
# 30 分钟内的全局最大并发，子查询步长 20 秒
max_over_time((sum(vllm:num_requests_running))[30m:20s])
```

```text
# 30 分钟内的最大等待数
max_over_time((sum(vllm:num_requests_waiting))[30m:20s])
```

子查询必须先写 `(sum(...))[30m:20s]`。全局峰值是 $\max_t\sum_r running_r(t)$，各 Engine 峰值之和是 $\sum_r\max_t running_r(t)$，两者不能互换。

这里的 20s 是采样步长，30m 才是统计范围。Grafana 中相关卡片统一 `maxDataPoints=1000`，避免相同时间范围因面板配置不同而选择一个 20s、另一个 1min。步长越粗，越容易漏掉短暂峰值。

## 本地 Double check：公式结果和原始计数器对账

### 设置

在 `ucm-tools` 工作区执行：

```powershell
docker compose -f demo/docker-compose.yml up -d
```

得到两个 exporter、四个 Engine、一个 Prometheus 和一个 Grafana。查询使用 30 分钟窗口、1 分钟短窗口和 20s 子查询步长。TPOT 检查要求指标 `request_time_per_output_token_seconds` 存在。

### 过程

先把上述 23 个表达式逐个发给 `/api/v1/query`，确认每条都有结果。然后按 `instance × engine` 读取十组原始增量，分别求和，独立计算：

$$
T=\frac{\sum_r H_r+\sum_r E_r}{\sum_r Q_r}
$$

$$
TPOT=\frac{\sum_r TPOT\_sum_r}{\sum_r TPOT\_count_r},\qquad speed=\frac{\sum_r TPOT\_count_r}{\sum_r TPOT\_sum_r}
$$

吞吐则使用 $(\sum_r prompt_r+\sum_r generation_r)/1800$。这样检查结果不依赖面板生成器，也不依赖同一条聚合 PromQL 再算一遍。

### 结果

本次固定时刻的部分结果如下，完整原始查询和独立复算值保存在[验证记录](/img/038-vllm-prometheus-metrics/verification.json)。

| 指标           |     查询结果 | 独立复算 |
| :------------- | -----------: | -------: |
| 区间输入 Token |      167.37M |     一致 |
| 区间总吞吐     | 93.97K tok/s |     一致 |
| 本地命中率     |       68.14% |     一致 |
| 外部贡献份额   |       23.33% |     一致 |
| 综合命中率     |       91.48% |     一致 |
| TTFT 平均      |     376.49ms |     一致 |
| TPOT 平均      |      38.44ms |     一致 |
| 单请求速度     |  26.02 tok/s |     一致 |

另外两个恒等式也成立：综合命中率等于本地加外部，单请求速度等于平均 TPOT 的倒数。33 次本地 HTTP 查询总耗时约 0.52 秒，没有模型推理调用，也没有云服务费用。 exporter 是合成数据，因此本轮只证明指标存在、PromQL 可执行、公式与原始计数器一致，不构成性能 benchmark。

最后用 `docker compose -f demo/docker-compose.yml down` 关闭环境即可。生产集群还需要核对真实 scrape 间隔、数据保留期、`engine` 标签、TPOT 直方图是否存在，以及命中率记账关系是否满足 $X=Q-H$。

## 常见错误的快速排查

1. Prometheus UI 报变量不存在：把 `$__range`、`$__range_s`、`$__rate_interval`、`$__interval` 换成实际时长、秒数或步长。
2. 同一指标两个结果：先写清各自窗口，再检查一个取区间统计、另一个是否取短窗口末点。
3. 命中率异常：检查是否误用 $E/X$ 代替 $E/Q$，是否先对单 Engine 百分比做了平均，分母是否接近 0。
4. 延迟均值异常：确认 `_sum` 与 `_count` 来自同一个直方图、同一个窗口、同一组标签。
5. P90 与平均差很多：这通常是在描述不同统计量，不要用一个去校验另一个；分别检查 bucket 和 `_sum/_count`。
6. 单请求速度与 Output tok/s 不一致：前者来自平均 TPOT 的倒数，后者受并发影响，定义上就不要求相等。
7. 并发峰值不一致：检查是否把全局峰值写成各 Engine 峰值之和，以及子查询步长是否一致。
8. 没有数据：先确认指标是否存在、版本是否支持、窗口内是否有样本。无数据与 0 是两种状态。

这套 Dashboard 的查询也整理在[QUERIES.md](https://www.modelscope.cn/datasets/keriko/UCM_tools/resolve/master/metrics/Grafana_DashBoards/QUERIES.md)。下次再看到一个可疑数字，我会先把指标类型、统计窗口、标签过滤和取点方式写在旁边，再决定是展示问题、查询问题，还是服务真的发生了变化。
