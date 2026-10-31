---
title: "从需求到落地：手写一个 Agent Harness"
description: 一个只会文本进文本出的模型，要怎样才真的能改仓库。从产品需求推六项能力，拆功能、定接口、填实现，最后用真模型在一个坏掉的仓库上修 bug，中间踩到的四个坑一并写清。
publishedAt: "2026-10-31"
category: 项目笔记
tags:
  - Agent
  - Harness
  - 架构设计
  - 工程实践
draft: false
---

在网页聊天框里说「把这段代码的 bug 修了」，模型会给你一段看着很对的代码。它没见过你的仓库，不知道你用的哪个依赖版本，也没法把改动写进文件、跑一遍测试确认。

Claude Code、Cursor 这类工具背后的模型往往一样，区别在模型外面那一层：工具、权限、上下文、状态。这层东西叫 harness。

我按「先想清楚要什么，再设计，最后实现」的顺序真写了一个，代码在 [Potterluo/mini-agent-harness](https://github.com/Potterluo/mini-agent-harness)：11 个文件、约 1700 行，16 个提交，101 个测试。

## 一、需求：harness 要补什么

把模型看成一个只会「文本进、文本出」的函数，一个能改代码的 agent 至少得补四件事：

它能看见现场。仓库在哪、当前什么分支、有没有未提交的改动、项目自己写的构建和测试约定。

它能动手。读文件、写文件、跑命令、看报错，这些都是模型自己做不到的动作。

它记得住。一次任务几十轮，关掉还能续上。

它被约束。模型不能随手 `rm -rf`，也不能跑出仓库去读别人的文件。

从这四件事往下推，能落到六项具体要求：

| 要求       | 为什么是必须的                                            |
| :--------- | :-------------------------------------------------------- |
| 上下文忠实 | 现场信息不全，模型只能猜，「修好测试」这种指令就没法执行  |
| 成本可控   | 每轮都重发全量上下文，账单和延迟都会失控，前缀缓存得命中  |
| 动作可控   | 自由 shell 太危险，工具要固定、参数要校验、危险动作要批准 |
| 窗口不炸   | 工具输出会把上下文撑满，撑满之后模型表现为「变笨」        |
| 会话可续   | 长任务会被打断，状态不落盘就白干                          |
| 支线隔离   | 查支线会把主上下文搅浑，得有办法派出去只收回结论          |

还有三条非功能要求，决定了它能不能被改：换模型不改核心逻辑；测试不烧真金白银；在 Windows 上能跑。

## 二、功能分析：把要求拆成行为

需求写成形容词没用，得拆成可验收的行为。下面这张表是我动手前先列的，右边一列是「怎么知道它做对了」。

| 要求       | 具体行为                                           | 失败模式                         | 验收方式                               |
| :--------- | :------------------------------------------------- | :------------------------------- | :------------------------------------- |
| 上下文忠实 | 启动时收集仓库根、分支、status、最近提交、项目文档 | 不是 git 仓库直接崩              | 非 git 目录下不报错，返回降级结果      |
| 成本可控   | 不变的放提示词最前，多变的放尾部                   | 工具列表随机排序导致缓存永不命中 | 多轮调用里缓存命中数上升               |
| 动作可控   | 固定工具集、参数校验、路径闸、批准闸               | 模型给 `../../etc/passwd`        | 越界返回错误串且不落盘                 |
| 窗口不炸   | 单块输出封顶、老结果压缩、近期保真                 | 一次 read_file 灌进十万字        | 单块不超 4000 字，最近六条工具结果原样 |
| 会话可续   | 每步落盘、支持按 id 续跑                           | 中途挂掉丢全部状态               | 关掉进程再 `--resume` 能接上           |
| 支线隔离   | 子 agent 只读、步数更少、不能再派                  | 无限递归烧钱                     | 子 agent 的工具箱里没有 delegate       |

这张表还有个副作用：每条「失败模式」都能直接变成测试用例。101 个测试基本就是这么长出来的。

![图 1 六项要求与代码落点：每一条都对应一个模块和一个可验收的行为](/img/032-building-a-harness/fig-01.svg)

## 三、架构：先抽象，再有实现

写代码之前只做了一件事：把「系统里有哪些概念」定下来。概念定错，后面每一层都要跟着改。

### 领域层：四个对象

`Session` 是对话，装一个消息列表和一个 append 方法。消息分三种：

```python
UserMessage(text)
AssistantMessage(text, tool_calls)
ToolResult(tool_call_id, content)
```

工具调用单独定义成 `ToolCall(id, name, arguments)`，id 用来把结果对回去。工具本身是 `Tool`，五个成员：

```python
class Tool(Protocol):
    name: str            # 模型靠它点名
    description: str     # 模型靠它判断用途
    parameters: dict     # 模型靠它知道传什么
    risky: bool          # 执行层靠它决定要不要过人工闸
    def invoke(self, arguments: dict) -> str: ...
```

`risky` 是设计阶段特意加进去的。前四个成员给模型看，最后一个是给执行层看。漏了它，等到接真实闸门时会发现字段不够，而改领域模型意味着全链路重编译。

`Context` 是发给模型的那一包东西，用泛型标出期望的输出类型：

```python
@dataclass
class Context(Generic[OpType]):
    instruction: str
    tools: list[Tool]
    history: list[Message]
    output_type: type[OpType]
```

这个泛型是整个设计里最省事的一处。回复用户时 `output_type=AssistantMessage`，审核工具调用时 `output_type=Decision`，同一套组装逻辑服务两个角色。

### 应用层：三个接口

`SessionStore`、`ModelClient`、`Approver` 全是协议，只说明「应用层需要什么」：

```python
class SessionStore(Protocol):
    def list_ids(self) -> list[str]: ...
    def get(self, session_id: str) -> Session | None: ...
    def put(self, session: Session) -> None: ...

class ModelClient(Protocol):
    def generate(self, context: Context, setting: ModelSetting) -> Any: ...
```

实现放在适配层。好处在测试时立刻兑现：`ModelClient` 换成按脚本回放的假客户端，四步循环的四种分支都能覆盖，一次跑 0.4 秒，不花一分钱。

### 分层与装配根

领域层不认识任何外部协议，应用层只依赖接口，适配层把仓库、文件、模型翻译成领域对象。最上面是装配根，整个系统里唯一知道所有具体类的地方。

![图 2 一次工具调用要过的三道闸：代码校验、人工批准、模型审核，顺序按成本从低到高](/img/032-building-a-harness/fig-02.svg)

装配根只做一件事：把具体类创建出来、接上去。换模型、换存储、换前端入口都只改它。

## 四、实现：16 个提交把功能填进去

提交顺序就是依赖顺序，每个提交都能独立通过全部测试：

| 提交                    | 内容                                       |
| :---------------------- | :----------------------------------------- |
| `chore: 初始化项目骨架` | pyproject、目录                            |
| `feat(domain)`          | Session、三类消息、Tool、Context、Decision |
| `feat(ports)`           | 三个协议                                   |
| `feat(context)`         | clip 与 compact                            |
| `feat(session)`         | JSON 持久化、工作记忆                      |
| `feat(tools)`           | 六个工具与五道闸                           |
| `feat(workspace)`       | 仓库现场与项目文档                         |
| `feat(client)`          | OpenAI 兼容客户端                          |
| `feat(service)`         | 两个角色与主循环                           |
| `feat(runtime)`         | 装配根与命令行                             |
| `test: 主循环集成测试`  | 假客户端回放                               |
| `feat(delegate)`        | 有界委派                                   |
| 三个 `fix`              | 实跑暴露的问题，见下一节                   |

六项要求各自落在哪里：

| 要求       | 落点                       | 关键实现                                                                  |
| :--------- | :------------------------- | :------------------------------------------------------------------------ |
| 上下文忠实 | `workspace.py`             | git 命令包一层降级，按优先级读 `AGENTS.md`、`README.md`、`pyproject.toml` |
| 成本可控   | `runtime.py` + `client.py` | 系统提示只在会话开始构造一次，后面只追加消息                              |
| 动作可控   | `tools.py`                 | 五道闸，失败全部返回 `error:` 字符串                                      |
| 窗口不炸   | `context.py`               | `clip` 封顶 4000 字，`compact` 只压老的工具结果                           |
| 会话可续   | `session.py`               | 每步 `put`，临时文件加 `os.replace` 落盘                                  |
| 支线隔离   | `runtime.py`               | `depth < max_depth` 才注册 delegate                                       |

工具闸门的重点不在于「拦住了」，而在于「拦住之后模型知道为什么」：

```python
def run(self, name, arguments):
    tool = self._by_name.get(name)
    if tool is None:
        return f"error: unknown tool '{name}'"
    try:
        self._validate(tool, arguments)
    except ValueError as exc:
        return f"error: invalid arguments for {name}: {exc}"
    ...
```

模型看到 `old_text must occur exactly once, found 3`，下一步就会换一个更精确的匹配。错误信息本身是反馈，不是日志。

## 五、踩坑实录

文档里读不到、跑起来才知道的四件事。

### 坑一：审核角色会扮演助手

第一版审核把整段对话历史丢给模型，让它判断这次调用该不该执行。它不回判断，继续调工具：

```
[review] run_shell -> rejected reviewer returned unparsable output:
finish_reason=tool_calls, usage={'prompt': 594, 'completion': 44}
```

`finish_reason` 是 `tool_calls`，它顺着历史里助手的说话方式，接着往下干活了。历史里全是我调工具的记录，它自然认为自己也该调。

改法是给审核一份独立组织的上下文，只放三样：当前任务、最近几条工具结果、待审的那次调用。历史清空。

### 坑二：然后它返回空字符串

独立上下文之后仍有大量空回复。根因是消息序列不合法。

审核发生在工具执行之前。此时 session 末尾是一条带 `tool_calls`、却还没有对应 `tool` 结果的助手消息：

```
assistant { tool_calls: [...] }     ← 悬空
（审核在这一步发生）
```

网关拒绝这种序列，直接返回空内容，`finish_reason=stop`。修法是审核前把这条悬空的助手消息摘掉：

```python
history = list(session.messages)
if history and isinstance(history[-1], AssistantMessage) and history[-1].tool_calls:
    history.pop()
```

顺带加了一条兜底：审核模型有时把内容放进 `reasoning_content`、`content` 为空，解析时读一眼思维链，但绝不写回历史。拒绝原因里带上 `finish_reason`，下次出问题能直接定位。

### 坑三：Windows 上三处编码

这台机器默认 GBK，撞了三次：命令行打印中文直接抛 `UnicodeEncodeError`；`run_shell` 抓子进程输出，读取线程解码失败；`git status` 遇到中文文件名同样炸。三处都改成显式 `encoding="utf-8", errors="replace"`。

不影响架构，但会让「明明代码没错」的排查耗掉一晚上。

### 坑四：并行改同一个文件

写的时候开了两个子 agent 并行，一个写工具闸门，一个写上下文和存储。提示里写了「只碰这两个文件」，但漏了 `roles.py` 的归属，两边都以为自己可以动它。一个在重写，另一个正在跑测试，于是短暂出现：

```
NameError: name 'ToolResult' is not defined
```

等它跑完就好了，因为文件已经被改回去。

文件归属比接口归属更容易被忽略：接口是显式的，编译期会报；文件是隐式的，跑到一半才炸。

## 六、效果

用一个故意弄坏的小仓库验收：`add` 用了减法，`mean` 多减了个 1。

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

代价是 8 次模型调用和几百毫秒的工具耗时，全程审计记录在会话文件里。

没做的也写清楚：并行工具调用、摘要式压缩、多模态输入都不在范围内；委派只做了一层，子 agent 只读、步数默认 3。

## 收尾

回头看，决定成败的是三个跟具体功能无关的选择，六项功能只是把它们落到地上。

先定概念再写代码。`Tool` 加不加 `risky`，决定了闸门能不能插进来。

接口放应用层、实现放适配层。测试不花钱、换模型不改核心，都是这一条带来的。

错误对模型可见。所有失败路径返回可读字符串，模型能自己纠偏，这比任何提示词技巧都管用。

代码在 [GitHub](https://github.com/Potterluo/mini-agent-harness)，README 里带了同样的脉络和实跑日志，clone 下来配上自己的 key 就能跑。
