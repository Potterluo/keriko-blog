---
title: "用子 Agent 搭一个 Harness：实战里踩到的四个坑"
description: 按前两篇的分层和六组件，真写了一个能跑的最小 harness（16 个提交、101 个测试）。骨架先落地，两个子 agent 并行填血肉，然后用真模型在一个坏掉的仓库上修 bug。文档里读不到的四件事都在这里。
publishedAt: "2026-10-31"
category: 项目笔记
tags:
  - Agent
  - Harness
  - 子 Agent
  - 工程实践
draft: false
---

前两篇讲完分层和六个组件之后，我把它们真写了一遍：一个 800 行左右的仓库，16 个提交，101 个测试，最后用 `deepseek-v4.1-flash` 在一个故意弄坏的小仓库上修好了两个 bug。

代码在 [Potterluo/mini-agent-harness](https://github.com/Potterluo/mini-agent-harness)。这一篇记录实现顺序，和四个只有真跑才会撞上的问题。

## 材料与口径

- 仓库：`mini-agent-harness`，Python 3.11，唯一依赖是 `openai`，其余全用标准库。
- 模型：`deepseek-v4.1-flash`，走 OpenAI 兼容接口。
- 测试：`python -m unittest discover -s tests`，101 个用例，全部用临时目录和假客户端，不联网。
- 分工：我自己写领域层、接口、编排和装配根；两个子 agent 并行写工具闸门、上下文削减与存储。
- 提交：16 个，每个都能独立通过全部测试。

## 骨架先落地，才能并行

并行的前提是契约先提交。第一个下午的提交顺序是：

| 提交                    | 内容                                | 对应哪一层 |
| :---------------------- | :---------------------------------- | :--------- |
| `chore: 初始化项目骨架` | pyproject、目录                     | 无         |
| `feat(domain)`          | Session、三类消息、Tool、Context    | 领域层     |
| `feat(ports)`           | SessionStore、ModelClient、Approver | 应用层接口 |

有了这三条，两个子 agent 才能同时开工：一个只碰 `tools.py` 和它的测试，一个只碰 `context.py`、`session.py`。文件不重叠，接口已在仓库里，它们不用猜。

![图 1 分工与提交顺序：契约先落地，两个子 agent 在不相交的文件上并行，最后由装配根收口](/img/032-building-a-harness/fig-01.svg)

我自己的部分（`service.py`、`runtime.py`、`cli.py`）也在同一时间写。等两边交付，跑一次全量测试就开始集成，总共 16 个提交。

## 真跑一次长什么样

目标仓库是我造的一个小项目：`add` 用了减法，`mean` 多减了个 1，两个用例都红。

```
[assistant] tools: run_shell
[tool] run_shell: FF                    # 两个用例失败
[assistant] tools: read_file, read_file
[tool] read_file: def add(a, b): ...
[assistant] 两个 bug 都清楚：add 用了减法，mean 多减了 1
[assistant] tools: patch_file
[review] patch_file -> approved 修复了任务中识别的两个测试失败问题
[tool] patch_file: patched calc.py (1 replacement)
[assistant] tools: run_shell
[tool] run_shell: ..                    # 通过
[assistant] 测试全部通过。
```

流程跑通了。但前几次尝试并不顺，问题都出在「文档里不会写、跑起来才知道」的地方。

## 坑一：审核角色会扮演助手

最初的 `ReviewerRole` 把整段 `session.messages` 丢给审核模型，让它判断这次工具调用该不该执行。

结果它不回判断，而是继续调工具。日志里写得很清楚：

```
[review] run_shell -> rejected reviewer returned unparsable output:
finish_reason=tool_calls, usage={'prompt': 594, 'completion': 44}
```

`finish_reason` 是 `tool_calls`，说明模型顺着历史里助手的说话方式，接着往下调工具了。历史里全是我调工具的记录，它自然认为自己也该调。

改法是给审核角色一份独立组织的上下文，只放三样：当前任务、最近几条工具结果、待审的那一次调用。历史清空。改完之后审核稳定回 JSON。

这也印证了分层那篇的说法：审核需要「另外组织一次上下文」，不是把对话转发一遍。

## 坑二：然后它返回空字符串

独立上下文之后，仍有大量 `reviewer returned empty content`。原因更难查，是消息序列不合法。

审核发生在工具执行之前。此时 session 末尾是一条带 `tool_calls`、却还没有对应 `tool` 结果的助手消息：

```
assistant { tool_calls: [...] }        ← 悬空
（审核在这一步发生）
```

把这种序列发给模型，网关直接返回空内容，`finish_reason=stop`，`completion` 只有几十个 token。修法是审核前把这条悬空的助手消息摘掉，等审核通过、工具执行完再补回结果。

现在 `ReviewerRole.build()` 里有这段：

```python
history = list(session.messages)
if history and isinstance(history[-1], AssistantMessage) and history[-1].tool_calls:
    history.pop()
```

顺带加了一条兜底：万一审核模型把内容放进 `reasoning_content`、`content` 为空，解析时读一眼思维链，但绝不写回历史。拒绝原因里带上 `finish_reason` 和用量，下次出问题能直接定位。

## 坑三：Windows 上三处编码

这台机器默认 GBK，撞了三次：

1. 命令行打印中文和目录符号，`UnicodeEncodeError`。修法是把 `stdout`/`stderr` 重配成 UTF-8。
2. `run_shell` 抓子进程输出，`subprocess` 用 locale 解码，遇到中文日志时连读取线程都抛异常。
3. `WorkspaceContext` 跑 `git status`，仓库里有中文文件名时同样炸。

三处都改成显式 `encoding="utf-8", errors="replace"`。这类问题不影响架构，但会让「明明代码没错」的排查耗掉一晚上。

## 坑四：子 agent 并发改同一个文件

这条最有意思。两个子 agent 并行时，一个负责工具闸门，一个负责上下文。但契约里的 `ReviewerRole` 归属没写清楚，其中一个顺手把它重写了，另一个正在跑测试，于是短暂出现：

```
NameError: name 'ToolResult' is not defined
```

等它跑完就没错了，因为文件已经被改回去了。

教训是并行要连「谁不许碰哪个文件」一起约定。我给它们的提示里写了「只碰这两个文件」，但漏了 `roles.py` 的归属，结果两个都以为自己可以动它。

文件级的分工比接口级的分工更容易被忽略，因为接口是显式的，文件是隐式的。

## 分层在实战里省掉了什么

有三件事，写的时候没感觉，改的时候很省事。

换模型只改装配根。`build_service()` 里一行 `OpenAIChatClient(...)`，测试和实际运行都走它。想换成别家，改这一行。

测试不用花钱。`AgentService` 依赖的 `ModelClient` 是协议，测试里塞一个按脚本回放的假客户端，四步循环的四种分支（正常、审核拒绝、批准拒绝、步数上限）都能覆盖，跑一次 0.4 秒。

审核能单独演进。第一版把历史全给它，第二版只给三样东西，接口没变，`service.py` 没动。这就是把「审核」当成角色而不是一段 if 的价值。

## 收尾

这个仓库没有实现的东西也写在 README 里：并行工具调用、摘要式压缩、多模态输入都不在范围内。委派只做了一层，子 agent 只读。

如果重来一次，我会先花十分钟把「文件归属」写进任务描述，再让子 agent 并行。接口冲突编译期会报，文件冲突往往跑一半才炸。
