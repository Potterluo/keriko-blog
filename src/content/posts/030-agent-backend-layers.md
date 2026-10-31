---
title: "一个 Agent 后端该怎么分层"
description: 从一个 while 循环到装配根：领域层定语言，应用层定流程，适配层做翻译。附 Session、Tool、Context 的字段定义，以及三家模型对「思考深度」的不同叫法。
publishedAt: "2026-10-31"
category: 技术分享
tags:
  - Agent
  - 架构设计
  - 依赖倒置
  - Harness
draft: false
---

「Agent 就是个循环」，这句话大概是对的，也确实简单到可以写在一个函数里。

Hucci 写代码这期 11 分钟的视频干的事情是：把这个循环真的实现一遍，然后一条条列出会疼的地方。换模型要改多个文件，测流程要真调模型，加一个前端要动核心逻辑。他的答案是分三层，最后收在一个装配根上。

## 材料与口径

- 视频：[10分钟学会设计 Agent 架构](https://www.bilibili.com/video/BV1winH6DEgt/)，UP 主 Hucci 写代码，11 分 13 秒，单 P。
- 转写：B 站未登录拿不到 CC，本地 SenseVoice 转写，4834 字，专有名词按上下文还原。
- 画面：按 10 秒抽帧，30 帧。这一期是 PPT 加代码截图，全部属于「结构可重述」，图我都重画了，没有直接引用截图。判断依据见文末。
- 我没有跑他的代码，下文的字段名和接口名取自画面与转写。

## 一、一个循环，四处会疼

先看流程。开始一个新对话或继续旧对话，收到用户消息，把指令、可用工具、历史消息组织成上下文，发给模型。模型回复里如果有工具调用，再单独调一次模型审核这次调用是否合理。审核通过就执行工具，把结果连同上下文再发一次模型，循环到没有工具调用、或者到达次数上限为止。每条消息产生时都落库。

不设计的话，这整段就是一个函数，一个步骤一段代码。麻烦在于：

- 模型从 OpenAI 换成 Anthropic，改的地方不止一处。
- 想测流程，得真调模型，慢且不可重复。
- 想加命令行前端，得动核心逻辑。
- 想换存储，同上。

这几个问题的共同点是边界没划出来，和代码本身写得好不好关系不大。

## 二、三层：定语言、定流程、做翻译

| 层     | 职责                         | 一句话                                 |
| :----- | :--------------------------- | :------------------------------------- |
| 领域层 | 定义系统自己的语言           | 什么是对话、工具、上下文               |
| 应用层 | 把概念编排成应用             | 先做什么，什么时候继续循环，什么时候停 |
| 适配层 | 把外部的东西翻译成自己的语言 | 存储、模型、前端                       |

他给适配层举的例子很到位：系统里的对话是一个 Session 对象，存到文件里是一行行 JSON，存进数据库是一张表。要让它在这三者之间流动，就得有人做翻译。

关键的一句在后面：适配层和应用层都是为领域层而生的，因为怎么定义领域，决定这个系统长什么样。

![图 1 三层与装配根的依赖方向：领域层谁都不依赖，应用层只依赖接口，适配层向上实现接口，装配根是唯一知道具体类的地方](/img/030-agent-backend-layers/fig-01.svg)

## 三、领域层：三个对象撑起一个 Agent

### Session

对话是整个系统的表现形态，所以它是第一个要定义的东西。

```python
@dataclass
class Session:
    id: str
    messages: list[UserMessage | AssistantMessage | ToolResult]

    def append(self, message) -> None:
        self.messages.append(message)
```

消息分三种：`UserMessage` 只有文本；`AssistantMessage` 有文本和工具调用；`ToolResult` 有 `tool_call_id` 和 `content`。工具调用本身单独定义成 `ToolCall`，带 `id`、工具名和参数。

这里有个容易漏的点：既然对话里记录了工具调用，结果也必须进对话，否则下一次请求模型时，上下文里会缺一块。

### Tool

工具要让模型知道怎么用，也要能真的被执行。

```python
class Tool(Protocol):
    name: str
    description: str
    parameters: dict

    def invoke(self, args: dict) -> str: ...
```

前三个字段是写给模型看的，`invoke` 是写给人执行的。视频里实现了一个 `BashTool`，让模型能跑 shell 命令。

### Context

调用模型时发的东西到底是什么，也需要定义。

```python
@dataclass
class Context(Generic[OpType]):
    instruction: str
    tools: list[Tool]
    history: list[Message]
    output_type: type[OpType]
```

他用了一个泛型来表示输出类型，因为同一套上下文机制要用在不同任务上：回复用户时输出 `AssistantMessage`，审核工具调用时输出一个 `Decision`。

上下文还能加字段，比如记忆、`AGENT.md`，他只是为了示范留了四个最基本的。

![图 2 领域层的三个对象和它们之间的引用关系：Session 装着三种消息，Tool 被 Context 引用，Context 带着泛型的输出类型](/img/030-agent-backend-layers/fig-02.svg)

## 四、应用层：接口放这里，实现放那边

这是整套设计里最值得记的一处。

`SessionStore` 定义「列出对话、存对话、取对话」这些方法，按职责看像是在描述存储，它却被放在应用层。理由是他自己点出来的：`SessionStore` 只是一个接口，说明应用层需要什么；真正的实现放在适配层。

```python
class SessionStore(Protocol):
    def list(self) -> list[Session]: ...
    def put(self, session: Session) -> None: ...
    def get(self, session_id: str) -> Session | None: ...
```

适配层里的 `JsonlSessionStore` 实现它，多一个文件路径字段。测试时可以换一个内存实现，换技术栈时换一个类，应用层的编排代码一行不用改。这就是依赖倒置落到具体位置的样子。

`ModelClient` 同理：

```python
class ModelClient(Protocol):
    def generate(self, context: Context, setting: ModelSetting) -> OpType: ...
```

`ModelSetting` 把「用哪个模型」和「想多深」绑在一起，因为两者总成对出现。视频里 `effort` 留了 6 档。

## 五、适配层：同一个概念，三家三个名字

这段是我觉得最有实操价值的地方。系统内部叫 `effort`，落到各家协议上：

| 系统内   | OpenAI             | Anthropic         | Google           |
| :------- | :----------------- | :---------------- | :--------------- |
| `effort` | `reasoning_effort` | `thinking budget` | `thinking level` |

三个名字，三种语义粒度，都得翻译。这也解释了为什么不能让应用层直接调 SDK：一旦协议细节漏上去，新增一家就要改核心。

新协议来的时候，适配层加一个类，实现 `ModelClient`，应用层不动。

## 六、两个角色，两份模型设置

回复用户和审核工具调用，需要的上下文并不一样，所以拆成两个角色。

`Assistant` 有自己的 instruction 和可用工具，`context(session)` 产出一个 `Context[AssistantMessage]`。

`ToolCallReviewer` 只有 instruction，没有工具，`context(session, tool_call)` 产出 `Context[Decision]`。`Decision` 里两个字段：这次调用能不能执行，以及拒绝的原因。拒绝的原因会作为 `ToolResult.content` 交还给模型，模型能看到自己为什么被拦。

这个设计的好处是审核也能用不同的模型设置。他的建议是 reviewer 用更便宜更快的模型，因为判断「这条命令危险吗」比写代码简单得多。

对应到前面流程里的「另外调一次模型来审核」，到这里才落成具体对象。

## 七、装配根：唯一知道具体类的地方

三层写完，还差把接口接到实现上。这个位置叫组装根，也是启动服务的地方。

`AgentService` 只认 `ModelClient` 和 `SessionStore` 接口，不知道背后是 Anthropic 还是 JSONL。装配根负责把具体类创建出来、连接起来。

于是换模型、换存储、换前端入口，都只改这一个文件。他把这个说成整个设计的目的：让变化集中到一个点。

对前端也一样。所有对外能力在 `AgentService` 上定义：新建对话、列出对话、发送消息。前端是命令行还是网页，应用层不关心，那是适配层的事。网页就加一个 HTTP 适配器，以后要 CLI 再加一个。

## 八、收尾：留给读者的两个练习

视频末尾留了两个功能让人自己设计，这两个恰好考的是前面那套分层。

分叉对话：用户从某条消息分出一支新对话，新对话带着这条消息之前的全部历史，之后各走各的。要想清楚的是 id 怎么分配、历史是深拷贝还是共享、存储层要不要按「消息序号」而不是「整段对话」来寻址。

对话压缩：对话变长后，上下文变大，费用和延迟都上去。做法是把较早的消息总结成一段摘要，之后只发摘要加最近几条。要设计的是压缩在哪一层触发、摘要本身算不算领域对象、被压缩掉的原文要不要保留。

两个问题的答案都会牵动领域层的定义，这也印证了他的说法：先梳理流程，建立一套自己的语言，再谈实现。

## 关于配图的裁定

这一期的画面全是可重述的结构：三层框图、`session.json` 的结构、三类消息的字段、目录树、代码片段。按站里的裁定，能不看原图讲清的就不引用，所以全部重绘。

反过来，如果画面里出现论文插图、真实产品界面，或者像「397B-A17B」这种具体到数字的参数规模，重绘有改错的风险，那种情况我会直接引用截图并标注时间戳。
