---
title: "同一份会话，三种搬法：AgentX 与 ClawPerf 的回放族"
description: "AgentX 用锁死的 scenario 加官方语料换可横比，ClawPerf 的 trace 用块哈希换缓存预算的答案，replay 用 live 历史换前缀保真。拆开四步构建与时间语义，再看这几种实现各自把成本付在哪。"
publishedAt: "2026-11-02"
category: 技术分享
tags:
  - Agent
  - Benchmark
  - Trace 回放
  - KV Cache
  - TCO
draft: false
featured: true
---

## 一、起因：分母该用什么

我要回答的问题很具体：一张卡在 agent 场景下，每百万 token 该算多少钱。

SemiAnalysis 的 AI Cloud & TCO 模型把这件事拆成三步：先测硅片的训练与推理吞吐，再把服务器 capex、网络、电、机位和资金成本摊成每 GPU 小时多少钱，最后把这根成本曲线放进三张财务报表。把前两步接起来，中间那步的算术是：

$$\mathrm{USD/MTok} = \mathrm{USD}/(\mathrm{GPU{\cdot}h}) \times 10^{6} / (3600 \times \mathrm{tok/s})$$

分子是钱，摊得出来。分母是 token 速率，它的可信度完全取决于压测时喂的是什么流量。同一张卡，用 4k 输入的合成短请求压出来的 tok/s，和用 142k 输入、九成命中缓存的 agent 会话压出来的，不是一个数。

分母有几种拿法：自己造、录一段真的、拿别人的 trace、或者干脆让模型真跑一遍。AgentX 挑的是第三条，而且把参数锁死到接近没有回旋余地。ClawPerf 把这几条路各做了一个模式。两边摊开看，能看清每条路要付的代价。

## 二、材料与口径

读的东西：

- `agentx-harness==1.0.7` 的 wheel，解包后看 scenario 定义、validator、WEKA trace 的 schema、会话重建、cache-bust 标记与 warmup 逻辑
- AgentX 官方两页：Overview 与 Methodology，链接在文末
- SemiAnalysis 的 AI Cloud & TCO 模型页面里 method 那一节
- ClawPerf 0.5.0：七个模式的文档（`docs/modes/`）、`agent.py`、`player.py`、`recorder.py`、`trace_simulator.py`，以及仓库里落盘的 `results_*.md`
- 我在 GPT-Zero 里用真 harness 加真语料跑过的离线记录

没做的，先说清楚：

- 没跑 393 条全量语料，只用了前 8 条（理由在第十一节）
- 没做官方 submission，时长和硬件都不合规
- ClawPerf 的模式我没在本机重跑，读的是源码与文档，数字取自它仓库里的报告
- TCO 模型本体是付费产品，我只读了公开页面对方法的描述，上面那个公式是按定义自己推的

## 三、AgentX 的四步

![图 1 AgentX 把生产会话变成负载的四步：左边采集，右边回放，中间两步做脱敏与重建，每一步丢掉什么、留下什么都写在框里](/img/033-agentx-vs-clawperf/fig-01.svg)

采集。参与者在自己的环境里挂一个 opt-in 的 HTTP 代理，它记的是请求与响应的时刻、输入输出 token 数、会话 ID 和子代理 ID。官方明确说，公开语料里没有 prompt、没有源码、没有工具参数，也没有工具结果。

变换。每个输入被写成「会话内链式的 64-token 块哈希」。同一会话里重复出现的块 ID，表示这段前缀又被带上了。

重建。AIPerf 往这些块里填确定性的合成 coding 与 tool-use token，长度对得上，内容换成假的，然后按时间轴把会话拼回一张有向无环图。

回放。固定种子在会话的 25% 到 75% 之间取一个起点，先跑 primer 和每条 lane 十条预热，之后测满一小时。

v1.0 语料的形状：393 条会话，135,282 个请求，每个请求中位 142,016 个输入 token、444 个输出 token，44% 的会话带子代理，175 条会话里共 1,697 个子代理组，组时长中位 2.27 分钟、p95 18.5 分钟。另有一个 256k 变体，砍掉超过 256k 输入的请求后剩 68,266 个，中位输入降到 88,768。

要理解这套设计，得先问一句：为什么不直接自己造 142k 的长 prompt。

因为长度好造，前缀复用不好造。官方那组示例会话里，20 个请求的缓存命中是 92.6%；方法论也写明测量窗口内 HBM 缓存命中占主导。这个比例来自同一份 system prompt、工具定义和不断增长的历史被反复携带。合成 token 保留了「哪些块被重复带上」这个结构，服务端算最长公共前缀时就会自然命中，命中率因此是被负载形状决定的，不是被脚本调出来的。

官方给的保真度证据是：重建后的 token 数与原始 token 数的中位比值 1.004。

## 四、它把测量强度锁成了硬约束

`agentx` 这个命令本身只是一层包装。wheel 里的 `agentx_cli.py` 全文 1900 字节，实质动作只有一处：

```python
def main(argv=None):
    tokens = list(sys.argv[1:] if argv is None else argv)
    if tokens and tokens[0] == "profile":
        options = tokens[1 : tokens.index("--") if "--" in tokens else len(tokens)]
        has_scenario_or_config = any(
            token in {"--scenario", "--config", "-f"}
            or token.startswith(("--scenario=", "--config=", "-f"))
            for token in options
        )
        if not has_scenario_or_config:
            tokens[1:1] = ["--scenario", "agentx"]
    app(tokens)
```

所以 `agentx profile` 等价于 `aiperf profile --scenario agentx`，真正的差别全在那份 scenario 定义里。它锁的是一批很容易被使用者拧松的旋钮：

| 参数                                    | 值                  | 不锁会怎样                              |
| :-------------------------------------- | :------------------ | :-------------------------------------- |
| `timing_mode`                           | `agentic_replay`    | 退化成固定并发压测，时序不由 trace 决定 |
| `ignore_eos`                            | 必须 true           | 输出长度由 EOS 决定，TPOT 分母变了      |
| `streaming`                             | 必须 true           | 没有首帧，TTFT 无从测起                 |
| `ignore_trace_delays`                   | 禁止                | 空闲间隔被抹平，lane 一起堆过去         |
| `input_truncation`                      | 禁止                | 142k 的 prompt 被截成 4k                |
| `benchmark_duration`                    | 不低于 900 秒       | 采样窗口太短，会话没跑到稳态            |
| `cache_bust`                            | `first_turn_prefix` | 第二次跑白拿一次全命中                  |
| `system_idle_gap_cap`                   | 10 秒               | 一次咖啡时间的静默污染并发曲线          |
| `failed_request_threshold`              | 0.10                | 失败率高也照样出数                      |
| `minimum_profile_metric_coverage_ratio` | 0.95                | 指标残缺的样本混进分位数                |

这些不是建议值。Validator 会改写或拒绝，日志里逐条写着 `Scenario 'agentx': auto-set ...` 和 `injecting extra_inputs.ignore_eos=true`。带 `--unsafe-override` 时违约项被记录并接受，provenance 里留痕，这就是本地缩着跑能起来的原因。

这份清单值得逐条读，因为每一条都对应一次「数字看起来没问题、其实不可比」的事故。

## 五、回放里的时间、并发与预热

时间戳 `t` 的单位是秒。wheel 里 schema 的注释是 `Request timestamp in seconds`，loader 内部再乘 1000 转成毫秒。看文档时很容易被「毫秒」带偏。

三层时间缩放叠在一起：系统级空闲上限 10 秒，单条 trace 内放宽到 300 秒（跨子代理的长思考），请求之间取 end-to-start 的间隔，也就是下一次的时间戳减去上一次结束时刻，再夹到非负。

并发语义是 `--concurrency N` 指 N 个并发客户端，每个客户端跑一条会话。客户端内部串行，上一个请求返回了才可能发下一个；但一个客户端扇出子代理后，服务端在飞请求数可以超过 N。

![图 2 一条会话在回放里的样子：上排是预热与测量窗口，下面三条泳道是主链与两条子链，红色竖线是父链等子链的汇合门控](/img/033-agentx-vs-clawperf/fig-02.svg)

子代理块里记了 spawn 时刻和墙钟时长，父链的下一条请求是汇合点，必须等最晚结束的那条子链。这个门控我们合成 trace 时踩过一次：`duration_ms` 四舍五入会把汇合时刻算到内层请求结束之前，父链提前醒来。改成向上取整才对。

预热是两段叠加。一段是强制的 primer，由起点位置决定，把每个流在起点之前最后一个 turn 重放一次，让前缀缓存热到「跟线上一样」；另一段是每条 lane 再加十条。预热数据不进统计，覆盖率要求 0.95 也只对测量阶段生效。

还有一个容易被忽略的机制：每次回收重放，首轮 prompt 前面会插一个 `[rid:12hex]` 标记。digest 由 benchmark_id、recycle_pass、trajectory_index、trace_id 四个值哈希出来，同一条 trace 树的所有成员共用同一个标记，换一条 lane 复用就换 digest。它存在的理由很实际：393 条会话的 system prompt 和工具定义高度模板化，不打标记的话，第二次跑的厂商会白拿一次「全命中」。

## 六、合成负载的代价

换成合成 token 之后，有几处真实的失真必须补。

投机解码的接受率首当其冲。合成 token 与真实模型输出的分布不同，draft token 被接受的比例也就对不上。AgentX 的做法是拿 SPEED-Bench 里 coding 分类实测的 acceptance length，按模型、投机方法、draft 长度和是否思考四个维度固定下来，服务端开强制接受，值记录在版本化的 golden 文件里。这样引擎之间的差异只剩服务系统本身，不掺合成载荷带来的接受率抖动。

DRAM 卸载是第二处。KV 卸载直接改变长会话能用的容量，不设上限的话，内存大的机器会白占便宜。规则是：没有标准化 DRAM 配置的服务器限到 3TB，GB200 NVL72、GB300 NVL72 和 TPUv7 按装机容量算，并且每个配置只能用与 GPU 配额成比例的那一份。

第三处是质量。官方原话是合成载荷不支持模型质量评估，这一项直接放弃。

代价写在明处：能复现的是长度、时序、分支结构和 KV 前缀复用，不能复现的是厂商侧 chat template、私有 tokenizer、加密的推理内容，以及图片和文档的 token 展开方式。

## 七、ClawPerf 的七个模式落在哪一格

![图 3 七个模式按负载来源分成四格，再按要不要真打端点分成两条出口；官方语料那一格只有 AgentX，它比同族多三道核验](/img/033-agentx-vs-clawperf/fig-03.svg)

七个模式分成四种负载来源，通向两条出口。

录自己的这一对最直白。`record` 是一个 FastAPI 代理，同时接受 OpenAI 和 Anthropic 两种客户端，后者实时翻译成前者，每个往返的请求体、流式分片、耗时和 usage 都写进 JSONL，写文件时跨重启追加。`replay` 再把这份 JSONL 打到任意端点。它有 `--history-mode` 两档：`live` 只抽客户端新增的消息，assistant 轮用服务端真实返回，这样即使换了模型，前缀也和当时一致；`verbatim` 原样重发录制的字节，适合两台服务端做严格 A/B。

拿别人的这一对是 `trace` 和 `trace-convert`。`trace` 吃的是 kvcache.ai 格式的 JSONL，字段是 `hash_ids`、`input_length`、可选 `block_size`，先把块哈希喂进本地模拟缓存算可达复用率，这一步不需要端点；给了端点再把请求真打过去。仓库里那次跑出 34 个请求、命中 90.42%、理想 prefill 加速 10.44 倍。`trace-convert` 负责把 Claude Code 会话、ShareGPT、OpenAI messages 转成可回放的 trace，所以「别人的」这个词可以很宽。

自己造那一格里是 `scenario`、`hitrate`、`slo`。`scenario` 让 N 个用户各自维护一条独立增长的对话，系统前缀、用户前缀、历史、当前输入四段拼起来，撞到窗口上限做追加式压缩；`hitrate` 构造 `[共享前缀][边界][唯一后缀]` 去标定命中率；`slo` 用几何爬坡加二分找满足约束的最大并发。

`agent` 不在这一族里，它的负载由模型当场生成。

有个细节值得单独说：块哈希这个表示已经成了共识。AgentX 的 WEKA trace 用 `hash_ids` 加 `block_size`，ClawPerf 的 trace 用 `hash_ids` 加 `input_length` 加 `block_size`，两边都把「同一段前缀」表达成「同一串块 ID」。这是唯一能同时保住前缀结构和内容保密的写法。

## 八、同一份负载，三种搬法

|            | AgentX        | trace      | replay         |
| :--------- | :------------ | :--------- | :------------- |
| 负载来源   | 官方语料      | trace 文件 | 自己的录制     |
| 语料身份   | 要核验        | 不校验     | 不校验         |
| 前缀怎么保 | 块哈希重建    | 块哈希模拟 | 真实返回当历史 |
| 时间轴     | 按 t 严格回放 | 会话级并发 | 录制顺序       |
| 独有能力   | 出 submission | 扫缓存预算 | 字节级 A/B     |

语料身份只在 AgentX 这边是硬约束。本地目录一律被判「无法核验身份」，要 valid 就必须用 pinned 的公开别名。这一条换来的是可复核的 submission，代价是它永远测不了你自己的流量，你的会话不在那 393 条里。

前缀怎么保，三家的做法完全不同。AgentX 用合成 token 按块重建，前缀由 hash 块决定；`trace` 把块哈希喂进模拟缓存，压根不构造 prompt，所以它第一步根本不打请求；`replay` 的 `live` 模式只保留客户端新增的部分，assistant 轮换成服务端的真实输出。最后这个在解决一个很具体的问题：录制文件里有旧模型自己的回答，原样发过去，换了个模型前缀就断了，KV 复用从第一轮起就不对。

缓存怎么测也有分歧。AgentX 直接读服务端的 Prometheus counters；`trace` 先离线算出上界，再拿真回放的结果和这个上界对照，两者的差就是服务端没做到的；`replay` 和 `hitrate` 一样读 counters。

时间轴是分水岭。AgentX 是唯一一个严格按 `t` 重放、还把子代理的 SPAWN/JOIN 建出来的，因为它要复现的是并发形状；`trace` 只做会话级并发，`--trace-users` 有几个用户就是几条会话；`replay` 按录制顺序加 `--concurrency`。

锁的形态最后决定了两者的定位。AgentX 把参数写成 validator 会改写的硬约束，整体是一个「不合规就不出数」的判定器；ClawPerf 把同类的东西留成开关：`--request-rate` 打开开环泊松到达，`--cache-budget-tokens/--cache-budget-gb` 扫缓存容量，`--eviction-policy` 选 LRU 还是 FIFO，`--history-mode` 选 live 还是 verbatim。前者的产物是一份能被别人复核的 submission，后者的产物是你自己机器上的一组诊断。

## 九、另外两条路

### 合成：不录也能跑

`scenario` 模式不需要任何外部数据，改参数就能造出想要的形状。AgentX 明令禁止这条路，理由是语料身份不可核验。

这个理由成立。合成语料可以调得刚好对某台机器友好，比如把前缀共享度拉高，命中率就好看。但它也意味着 AgentX 回答不了「我这份流量在这台机器上要多少钱」，因为你的流量不在它的语料里。

### 真跑：让模型自己决定负载

![图 4 ClawPerf agent 模式的工具循环：从上面领任务进去，只有「这一轮没有 tool_calls」能走到右边出口](/img/033-agentx-vs-clawperf/fig-04.svg)

ClawPerf 的 `agent` 模式不预置请求序列，它把四个文件工具交给模型，让模型自己决定读哪个文件、改哪一行、跑哪条命令。一轮的流程是：领任务（一句 prompt 加一份预置工作区，每个任务实例物化到独立目录）→ 组装 messages 并带上工具声明 → 流式请求，记 TTFT 和 usage → 有 `tool_calls` 就执行，结果截到 4000 字符以 `role=tool` 回填 → 没有 `tool_calls` 就判定完成，步数到上限则截断。

工具就四个：`list_files`、`read_file`、`write_file`、`run_shell`。路径做了逃逸检查，shell 超时默认 30 秒。每一轮都单独记 TTFT、E2E、输入输出 token、工具耗时；模型吐 `reasoning_content` 时，思考 token 按字符数除以 4 单独记一笔。

仓库里落盘过两次实跑：

| 报告                   | 任务 | 每任务步数 | 输入 token    | 输出 token  |
| :--------------------- | :--- | :--------- | :------------ | :---------- |
| `results_agent.md`     | 2    | 1 / 1      | 465 / 471     | 256 / 256   |
| `results_e2e/agent.md` | 2    | 8 / 2      | 9,663 / 1,130 | 1,497 / 479 |

两次的报告都写着完成率 100%，读起来却是两回事。第二组第一个任务跑了 8 步、9,663 个输入 token，是真的在循环里读文件、改代码、跑命令。第一组两个任务各一步就结束，输出恰好 256，正好等于 max_tokens：模型第一轮没有调工具，被截断，而判定完成的规则是「这一轮没有 tool_call」：

```python
if not tr.tool_calls:
    finished = True
    break
```

这行代码便宜、可解释，代价是完成率这个指标会被模型的偷懒直接污染。判断一次 agent 跑得有没有意义，得同时看步数、输入 token 的增长率、以及出现过哪些工具调用。只报一个完成率，等于把「模型压根没动手」和「任务被干完了」写成了同一个数。

这条路的负载是内生的：换一个模型，工具调用的次数、顺序、上下文增长速度全变。所以它不能横比，但能回答另一类问题，这套栈干完一件活要多少 token、多少秒。

## 十、放回 TCO 的链条

回到开头那个公式。分母必须从真实负载形状里来，否则每百万 token 的钱会被低估：用 4k 输入的合成短请求压测，142k 的 prefill 和九成命中都不在，tok/s 被高估，代进公式后成本被压低。第七节那四条路都在补这个分母，区别只在补得准不准、能不能被别人复核。

举个算例，假设每 GPU 小时 2 美元，实测输出 2500 tok/s：

$$2 \times 10^{6} / (3600 \times 2500) \approx 0.222$$

也就是每百万输出 token 约 0.22 美元。这个数跟任何厂商报价无关，只是把公式跑一遍看量级。

`agent` 模式补的是另一半。一个任务要花多少步、多少输入 token、多少工具等待，这些决定一次 agent 会话的成本。分母告诉你机器的速度，分子告诉你工作的量。

## 十一、我实际跑通的那一段

链路能不能在离线环境里跑起来，是另一件事。我拿 GPT-Zero 的 mock 服务和官方的真 harness 试了一遍。

设置：

```powershell
# mock：无模型权重，按 ttft/tpot 参数产生时延，带 trie 前缀缓存与 /metrics
.venv\Scripts\python.exe server.py --port 8092 --tokenizer deepseek_v3_tokenizer `
  --ttft-ms 120 --tpot-ms 8 --max-concurrency 64 --cache-blocks 8192

# 真 harness：8 条真实 trace，4 个并发会话，180 秒
$env:HF_HOME="D:\Vibe_Workspace\GPT-Zero\data\hf"; $env:HF_HUB_OFFLINE="1"
.venv-agentx\Scripts\agentx.exe profile `
  --url http://127.0.0.1:8092 --endpoint-type chat --streaming `
  --public-dataset semianalysis_cc_traces_weka_062126 `
  --tokenizer deepseek-ai/DeepSeek-V3 --model gpt-3.5-turbo `
  --concurrency 4 --benchmark-duration 180 --num-dataset-entries 8 `
  --stats-interval 30 --unsafe-override `
  --output-artifact-dir experiments\agentx_real\run_c4_180
```

几处设置是有理由的。只用 8 条，是因为 393 条全量重建时 AIPerf 会并行重建所有会话，16 个 worker 能把 31GB 内存的机器打到 free 归零。本地把时长从官方的 900 秒压到 180 秒，图的是缩短冒烟时间，这一条受到了 `--unsafe-override` 的降级。mock 侧还补了两个兼容点：AIPerf 发的是 `max_completion_tokens`，老 mock 只认 `max_tokens`；另外 AgentX 要看 `usage.prompt_tokens_details.cached_tokens`，不给就会警告「no prompt-cache read tokens were seen」。

结果：

| 指标                  | 值                 |
| :-------------------- | :----------------- |
| 请求数 / 成功率       | 58 / 100%          |
| RPS                   | 0.28               |
| TTFT p50 / p90 / p99  | 160 / 239 / 370 ms |
| ISL p50               | 54,258 tokens      |
| OSL p50               | 124 tokens         |
| 缓存命中（理论/实测） | 95.5% / 93.4%      |

58 个请求、180 秒、8 条 trace、4 个并发，这是这一段的全部成本。

有一个坑得记下来：Windows 上 AIPerf 的结果总线偶发收不到记录，日志停在 `currently 0 of N records processed`，`profile_export.jsonl` 是 0 字节，而 mock 侧一切正常。c=4 这次完整跑通，c=1、2、8 的几次尝试里有卡在这里的，换成 Linux 没有这个问题。所以这条链路只交付了一个并发点，并发曲线是用自研的回放器补的，两边的数据没有混在一张表里。

这一段跑通的意义在于确认一件事：官方那层锁在离线环境里是可以复现的，锁本身不影响链路能不能起，只影响出来的数算不算数。

## 十二、判断

要出可横比的数，只有 AgentX 那种锁法，前提是你的负载落在它的语料名单里。超过这个前提，它剩下的作用是提供一个参照点：同一台机器在 AgentX 那份负载上是多少，用来校准你自己那套合成负载偏乐观还是偏保守。

要回答「缓存该给多大」，用 `trace` 模式。它不需要端点，扫一遍预算就能出命中率曲线，几十秒的事，比真压测便宜两个数量级。

要回答「同一份输入换到另一台机器差多少」，用 `replay` 的 `verbatim`，字节级对齐，结论最干净。

要回答「这套栈能不能干活」，只能让模型真跑。完成率之外，步数和 token 增长曲线要一起报。

几条路可以接起来，接口上是通的：拿 `record` 录一段自己的会话，或者用 `trace-convert` 把别人的数据集转成 trace，再交给 `trace` 模式回放。这一步我只看了代码和文档，没实际走完，所以不把它当成结论。

唯一不能做的是把不同路的数字放进同一张表。它们的分母连定义都不一样。

参考：

- [AgentX Overview](https://inferencex.semianalysis.com/agentx)
- [AgentX Methodology](https://inferencex.semianalysis.com/agentx/methodology)
- [SemiAnalysis AI Cloud & TCO Model](https://semianalysis.com/ai-cloud-tco-model/)
- [ClawPerf](https://github.com/ucm-system/ClawPerf)
