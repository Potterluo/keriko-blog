---
title: "Argus v2：把 deploy 和 clean 赶出平台"
description: "TestPlane 改名 Argus 时，deploy 和 clean 从平台硬编码阶段变成可插拔的 runner 对。术语对调逼出的架构问题、provider 枚举的消灭、clean 配对由 deploy runner 自己声明，以及本地 kind 联调撞碎的六个假设。"
publishedAt: "2026-11-11"
category: 项目笔记
tags:
  - Argus
  - 架构设计
  - Kubernetes
  - LLM 评测
  - 平台工程
draft: false
featured: true
---

v1 的 TestPlane 做一件事：给一个模型服务的地址，跑一轮标准化的性能或精度测试，产出指标。

平台里有三处写死了 Genet。Deploy 阶段直连 Genet 拉起服务，`cleanup.policy` 字段决定服务留多久，`DEPLOY_FAILED` 有一个 Genet 专属分支。想加一种部署形态（换个部署系统、多一个部署变体），这三处都得跟着动；想加一种新的信息传递方式，orchestrator 里就多一个 if。

到 v2 这三处全没了。

## 一、管道没变，判断权变了

四步管道原样保留：部署、探活、测试、清理。

![图 1 v1 与 v2 的同一条四步管道：上排看玫红那两格是平台阶段，下排同样两个格变成 runner，中间两步两边长得一样](/img/034-argus-v2-design-evolution/fig-01.svg)

| 位置       | v1（TestPlane）               | v2（Argus）                  |
| ---------- | ----------------------------- | ---------------------------- |
| Deploy     | 平台阶段，内部调 Genet        | `genet-deploy` runner        |
| Cleanup    | 平台阶段，读 `cleanup.policy` | `genet-clean`，finally 执行  |
| 失败传播   | 平台特判                      | `on_failure: abort_task`     |
| 信息传递   | 平台投影 Endpoint             | 收割并注入 `exports.env`     |
| 新部署形态 | 改平台代码                    | 新 `runner.yaml`，平台零改动 |

## 二、口径

下面提到的位置和名字都能对回仓库：

- 规约是 `design/ARCHITECTURE.md` v2.0（D-66～D-74），runner 契约见附录 B；代码在 `f53b4bd`。
- 联调用本地 kind 集群加 fake-genet，服务由 `mock-deploy` 拉起，不碰真 Genet。
- 规约与代码在 deploy 块上已经不一致：规约和 `server/api/openapi.yaml` 里仍是 `provider` + `spec`（`required: [provider]`），代码里是 `runner` + `version` + `input`。下文按代码写。

## 三、术语对调逼出来的一个问题

v1 的概念栈是 Run → Task → Attempt：最外层叫 Run，里面每个测试叫 Task，重试用 Attempt 计数，写测试的实体叫 Tester。

v2 全对调成 Task → attempt → runner。Task 是一次完整评测，也是重试单位；attempt 是 Task 的第 N 次全量执行；runner 在每次 attempt 内按序执行一次，自己没有重试，执行记录由 `(task_id, attempt_no, seq)` 定位。Tester 改叫 Runner。

改名是机械操作，但它逼出一个问题：deploy 和 cleanup 属于哪一层？

v1 里它们是平台阶段，有自己的状态机、自己的 `cleanup.policy`。改名之后，"Task 内的执行步骤"统一叫 runner，那 deploy 和 clean 凭什么不算？

没有理由。这一步迈出去，deploy 就变成了一个 runner。

它受同一份契约约束：输入文件加 `AG_*` 环境变量，一个可写的输出目录，退出码语义，日志落到 `logs/`，成功时写 `exports.env`。产物三选一（`result.json` / `result.html` / `result.csv`）只对 test 和 pre_check 生效，deploy 交的是 `deploy-state.json` 加 exports。

平台对 deploy runner 知道的事只剩四件：它必须是 `role: deploy` 的 runner；注入在 `seq=1`；它写的 `deploy-state.json` 用来映射部署阶段（`DEPLOY_FAILED` 和 `DEPLOY_BLOCKED` 两个码都还在，只是改成由 runner 归类写下、平台照着映射）；它声明的 `clean_runner` 决定要不要补一行 clean。

有一件事没跟着进 runner：部署 Pod 的日志仍由平台 collector 采。collector 按 deploy 导出的 `label_selector` 找到服务 Pod，按 Pod 落盘。这条路留在平台里，因为它是只读的旁路，不改任何被编排的东西。

### clean 的配对由 deploy 自己声明

deploy 起来一个服务，服务要活到 Task 终态才拆，所以管道末尾还要一行 clean。

问题是这行从哪来。v1 的答案：平台硬编码，有 Deploy 就有 Cleanup。v2 的答案：deploy runner 在自己的 `runner.yaml` 里声明。

```yaml
# runners/genet-deploy/runner.yaml
name: genet-deploy
role: deploy
clean_runner: genet-clean # 我配对的 clean runner
```

平台看到这一行非空，就按 `seq=last+1` 追加一行 clean，finally 执行。没声明就到此为止，`existing-deploy` 属于这种，提交体里也不会出现 clean 这个字段。

![图 2 两种声明的对比：上排 genet-deploy 写了 clean_runner 才有管道末尾那行 clean，下排 existing-deploy 没写，管道就停在测试](/img/034-argus-v2-design-evolution/fig-02.svg)

配对角色的校验放在注册表启动时：`clean_runner` 指向的名字不在注册表，或者角色不是 `clean`，整批拒绝启动。与其跑到一半发现拆不掉，不如一开始就不让提交。

## 四、provider 枚举是怎么死的

deploy 变成 runner 之后，下一个问题：同一个 `genet-deploy` 怎么对接不同的部署后端？

第一版实现走了一个弯路。assemble 里加了个 `deploy.provider` 枚举，`genet | mock | existing`，switch 到不同名字的 runner。这个设计活了几个小时，self-review 时被否掉。

问题在于 provider 枚举本身就是一种平台感知。平台认识 `genet`、`mock`、`existing` 这三个字符串，就意味着第三种部署形态到来时要改那个 switch。那是带选项的硬编码；插件的要求是平台根本不认识它。

正确的形状是让 deploy 块成为一个 runner 引用：

```yaml
task:
  name: qwen3-32b-daily
  deploy:
    runner: genet-deploy # 任何 role=deploy 的已注册 runner
    version: "1.0.0"
    input: |
      model: Qwen3-32B
      ...
  runners: # 与 deploy 同级
    - name: accuracy-dataset-a
      runner: aisbench-acc
      version: "1.0.0"
      execution: { profile: k8s-npu }
      input: |
        {"dataset":"/data/dataset-a"}
```

`deploy` 和 `runners` 同级；deploy 只有 `runner`、`version`、`input` 三个键，没有 `name` 也没有 `execution`，所以它和 `runners[]` 的条目像，但不完全同构。少了 `version` 会在提交期被判 400。

平台对 deploy 块只有三步：解析 `deploy.runner@version`，命中 `role: deploy` 才注入 `seq=1`；读它的 `clean_runner` 声明；非空则解析并追加一行。

于是 mock 的衔接变成零代码。`mock-deploy` 是一个薄壳：`run.sh` 与 `genet-deploy` 是同一份（28457 字节，SHA256 前八位 `7992B8B0`），唯一差别是 `runner.yaml` 里 `AG_GENET_BASE_URL` 带了个 default，指向 fake-genet 的联调接入点 `http://host.docker.internal:18091`。选 `mock-deploy` 就对接联调环境，选 `genet-deploy` 就对接真 Genet。平台不认识这两个名字。

改到这里规约还没跟上来。`design/ARCHITECTURE.md` 的 §10.2 与 `openapi.yaml` 的 deploy 块仍是 `provider: genet` 加 `spec`，`required: [provider]`，enum 三个值；`clean_runner` 与 `deploy.runner` 只活在代码和 `runners/` 里，D 系列还没有对应的新编号。规约比代码慢，这次慢了一步以上。

## 五、信息传递从平台投影变成 exports.env

deploy 起来服务，要把地址告诉下游的测试 runner。v1 的做法是平台在 Deploy 阶段结束后，把 Genet 返回的 Endpoint 投影成公共参数。平台因此要理解 Endpoint 的结构、知道怎么投影、知道哪些字段敏感。

v2 把这件事拆成两半：runner 负责写，平台负责搬。

runner 往标准文件里写：

```text
# $AG_OUTPUT_DIR/exports.env
AG_SERVED_URL=http://arg-<sha12>-unified-cache-stack.argus-svc.svc.cluster.local:18080
AG_SERVED_MODEL_NAME=Qwen3-32B
AG_MODEL_PATH=/models/Qwen3-32B
AG_DEPLOY_REF=argus-svc/arg-<sha12>
```

平台做三件事，全部在词法一级：

1. 收割：runner 退出码为 0 才读这个文件，逐行切 `KEY=VALUE`。有一行切不出来就整体拒收，runner 判失败（`EXPORT_INVALID`）。
2. 落档：值随 attempt 存档，事后能还原这次到底注入了什么。
3. 注入：按管道序合并进后续 runner 的环境变量。

不部署那一路给的静态 `service` 块，被当成"序号 0 的导出"，走同一条注入路径。

![图 3 一条 exports 的旅行：左边 runner 写四行，中间平台只切 KEY=VALUE，右边下游 runner 在自己的环境变量里看到它们；下排是提交期就会拒的四种情况](/img/034-argus-v2-design-evolution/fig-03.svg)

边界窄到一句话能说完：平台不知道 `AG_SERVED_URL` 是什么，不知道 `AG_DEPLOY_REF` 指向什么，不校验值的格式，也不检查地址可达。它只保证上游写的键值对会出现在下游的环境变量里。

组合期校验同样在词法一级：每个 runner 用 `consumes` 声明自己读哪些 key，平台校验每个 key 都有来源（上游导出、静态值或 secret）；两个 runner 导出同名 key 直接拒；凭据不许进 exports，只能走 §12.4 的 secret 注入。

## 六、被推翻的几条旧裁决

上面是主线。重写过程中还翻掉几条早先的裁决，每一条都是撞出来的，没有一条是凭空设计的。

### 平台不校验参数，只对了一半

v1 的裁决是平台不渲染、不校验参数，参数清单只是文档语义。当时参数走 argv 字符串，平台确实没有抓手。

v2 输入改成 JSONL 文件，结构化数据让校验可以左移到提交期，收益立刻明显：跑完才发现参数错，变成提交就被拒。所以这条被部分推翻（新裁决 D-67）：平台对 jsonl 输入做类型和 required 的结构校验，报错带行号和字段名；范围、枚举、跨字段约束仍然归 runner。

校验边界没动，平台仍不解析业务语义。变的是校验的可行性。

### 重试不再按 runner 算

v1 每个 Task 可以有多次 Attempt，重试产生新 Attempt，不覆盖历史，还带 `retry.max_attempts` 和 `retry_on` 白名单。v2 把 runner 级重试整个砍掉，重试等于 attempt 加一，整条管道全量重跑，含重新部署（D-68、D-69）。

真正的理由是正确性：跑过的服务带着 warm cache、残留连接和 KV cache 状态，性能数字与全新部署不可比。对前缀缓存测试和性能测试，这是直接的正确性问题。多花一次部署时间，换来的是数字能用。

### 进程生命周期不等于资源生命周期

deploy runner 在服务 ready 之后就退出了，但它部署的服务要活到 clean 拆完。两条时间线完全不同，任何"runner Job 完成即回收"的逻辑都会把还没测的服务杀掉。

这条落在 §9.3 和 D-72，配的硬规则是：runner 不得对 Genet 管理的资源设指向 runner Job 的 K8s ownerReferences。

联调时撞上的 bug 就是它。`genet-deploy` 的 Job 建服务资源时顺手设了 ownerRef，Job 一完成就被回收，服务跟着级联删除，探活永远连不上。修法很朴素：删掉 ownerRef，服务的生命周期交给 clean 显式管理。

## 七、前端跟着变

概念模型变了，UI 跟着变，这部分是跟随性的。

### 报告变成详情页的主体

v1 的 Task 详情把报告放在独立路由，点"查看报告"跳过去。v2 把报告放进详情页的默认 Tab：打开一个已完成的 Task，第一眼就是 report.md 的渲染和指标表格。

### 产物改成整页看

v1 用弹窗看产物，碰到一个 32KB 的 SLA 数据 CSV 就转不开身。v2 改成整页路由 `/tasks/{id}/file?path=...`，有面包屑，有可分享的 URL，大文件能滚动。渲染器按扩展名分发：JSON 树、CSV 表格、HTML 沙箱 iframe、文本终端风；超过 2MB 或二进制只提供下载。平台不解析内容，只按 content-type 分发。

### 服务来源还是一个开关

架构上 deploy 成了 runner 引用，前端反而更简单：一个二态分段器（部署 / 外接）加一个 deploy runner 下拉。下拉里的候选是注册表里所有 `role: deploy` 的 runner，加一个新 runner 不用改前端。

| 选什么       | 填什么               | 提交体                          |
| ------------ | -------------------- | ------------------------------- |
| Genet 部署   | 部署描述 YAML        | `deploy` 指向 `genet-deploy`    |
| Mock 联调    | 同一份 YAML          | `deploy` 指向 `mock-deploy`     |
| 已有服务登记 | 服务三元组           | `deploy` 指向 `existing-deploy` |
| 外接         | url 必填，另两个可省 | `service: {url, ...}`           |

第四行那个三元组是 `url`、`model_name`、`model_path`，被打包成 `AG_SERVED_URL`、`AG_SERVED_MODEL_NAME`、`AG_MODEL_PATH` 注入全部 runner。提交之后，管道时间线自动显示对应的 runner 序列，前端不需要知道 genet 是什么。

### 两个不起眼但反馈很好的改进

输入框旁的就地校验：校验、格式化、压缩、填示例四个小按钮，规则与服务端共用同一份 parameters schema，错误按行号列出，点一下跳到对应行。

Agent 亲和入口：`/llms.txt`、`/openapi.yaml` 静态服务、文档页的 Agent 卡片。Agent 拿到平台地址就能自举。

## 八、联调撞碎的六个假设

架构改完，在本地 kind 集群上跑端到端。六个 bug 里没有一个是靠读代码能看出来的，它们全长在两个模块对同一份契约的理解差上。

1. Job 名大小写不一致。`store.JobName` 保留了 TaskID 的原始大小写，`render.go` 里小写，库里的名字和集群里的名字对不上。统一小写再加 `argus-` 前缀。
2. 同一个 PVC 挂两个卷目会悬挂。kubelet 对同一 hostPath 目录做第二次 bind mount，在 Docker Desktop 的 drvfs 上永久卡死。同 claim 复用一条 volume 声明。
3. `AG_PARAMS_FILE` 指向了控制面路径。编排层把 `<storage-root>/...` 这种控制面路径写进 runner 环境变量，容器里根本没有这个目录。改成容器内的 `/workspace/input/...`（附录 B 契约）。
4. 目录预创建排在 Submit 之后。kubelet 对不存在的 subPath 做创建，在 drvfs 上悬挂。mkdir 提到 Submit 之前。
5. attempt 2 没有输入文件。retry 只复制 runner 行，不复制 input 文件。改成 retry 后从上一个 attempt 复制 `input/<seq>/`。
6. 注册表拒绝启动。探针的 `run.sh` 内容改了但版本号没 bump，同版本不同内容命中 `RUNNER_VERSION_PINNED`（K-3）。升版本才能起来。

每一条的教训都一样：跨边界的 bug 躲在单测覆盖不到的缝里。端到端联调的价值不在验证"代码能不能跑"，而在暴露两个模块对同一个契约的理解分叉。

## 九、收尾

平台的"懂"是有成本的，而且这个成本随时间超线性增长。

v1 的平台懂部署（知道 Genet 的 API）、懂清理（知道什么时候该卸载）、懂参数（知道哪些该校验）。每多懂一件事，就多一条和 runner 契约的耦合线：改 runner 要连带改平台，改平台可能弄坏 runner。

v2 的解法是少懂一点：

- 平台不懂部署。deploy 是一个 runner，平台按 role 认出它、按序拉起。
- 平台不懂清理。clean 是一个 runner，配不配对写在 deploy 的 `runner.yaml` 里。
- 平台不懂信息传递。exports 是一个文件，平台只做 KV 搬运。
- 平台不懂参数语义。输入是一个文件，平台只做词法和结构校验。

每少懂一件事，就少一条耦合线，多一个"加新形态不用改平台"的兑现。

让平台变哑是有代价的：它不能再替你做兜底判断，出了问题得去 runner 里找。换来的是加新形态时的零改动。这笔交易值不值，取决于你更怕哪一种改动。

---

_本篇引用的规约是 `design/ARCHITECTURE.md` v2.0（D-66～D-74），代码在 `f53b4bd`。deploy 引用化与 `clean_runner` 声明这条改动目前只在代码与 `runners/` 里落地，规约和 `openapi.yaml` 的 deploy 块仍是 `provider` + `spec`，D 系列编号尚未补。_
