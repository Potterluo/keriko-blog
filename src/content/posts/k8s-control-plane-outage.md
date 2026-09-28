---
title: 一次 K8s 控制平面雪崩复盘：从 Prometheus 查询 EOF 到三台 master 全体失联
description: 一条 Prometheus 查询报 EOF，最后查出三台 master 的 kube-apiserver 与 etcd 全部陷入崩溃重启循环。这篇复盘记录排查过程的四次假设修正、关键证据的解读方式，以及那些让我们走弯路的认知陷阱
publishedAt: "2026-09-28"
category: 技术分享
tags:
  - Kubernetes
  - etcd
  - HAProxy
  - 线上事故
  - 故障排查
  - SRE
draft: false
---

今天下午集群出了一个不小的状况。值得写下来的原因不是"etcd 崩了"这件事本身，而是**我们最初看到的报错和真正的故障点之间隔了整整两层**——一条 Prometheus 查询失败的提示，背后是整个控制平面的雪崩。

需要先声明：截至本文写下时，etcd 为什么反复退出还没拿到最终证据，**根因尚未确认**。所以这篇复盘的重点放在"排查是怎么一步步收敛的"以及"我们为什么走了弯路"，而不是给一个事后诸葛亮的完美答案。

## 事故概要

| 项目     | 内容                                                                     |
| :------- | :----------------------------------------------------------------------- |
| 发现时间 | 2026-09-28 16:32 前后（CST）                                             |
| 发现方式 | 运维面板查询 CPU 使用率历史失败，报 EOF                                  |
| 影响范围 | 三台 master 的 kube-apiserver 全部不可达，集群控制平面不可用             |
| 直接现象 | HAProxy 后端池为空、`kubectl` 挂起、所有经 VIP 的 API 请求返回 EOF       |
| 根因状态 | **未确认**，证据指向 etcd 崩溃重启循环（磁盘/配额/证书/quorum 等待验证） |

## 现场：一条看起来毫无杀伤力的报错

一切始于这行日志：

```text
Failed to get resource usage history: error querying CPU usage:
Post "https://141.111.32.128:8443/api/v1/namespaces/monitoring/services/prometheus-kube-prometheus-prometheus:9090/proxy/api/v1/query_range": EOF
```

把这条 URL 拆开看，它其实说清楚了请求链路：

- `141.111.32.128:8443` —— 集群控制平面的对外 VIP，前面是 HAProxy；
- `/api/v1/namespaces/monitoring/services/.../proxy/...` —— 这是 **kube-apiserver 的 service proxy 转发**，不是直连 Prometheus；
- 结尾的 `EOF` —— 连接在数据传输完成前被对端关闭。

注意第三点：EOF 不是 HTTP 状态码，也不是 Prometheus 返回的错误，它意味着**根本没走到 Prometheus**。所以问题要么在 apiserver 的代理层，要么在 apiserver 之前。

而这一点，恰恰是最初被我们低估的地方。

## 第一次假设：Prometheus Service 没有就绪端点

第一轮判断是教科书式的标准答案：当 Kubernetes Service 已接受连接、却没有可用的就绪端点（Ready Endpoints）时，kube-proxy 会接受连接然后立即挂断，客户端看到的就是 EOF。

于是照方抓药：

```bash
kubectl get endpoints prometheus-kube-prometheus-prometheus -n monitoring
kubectl get pods -n monitoring -l app.kubernetes.io/name=prometheus
kubectl describe pod -n monitoring <prometheus-pod-name>
```

这个假设在**通用场景下是对的**，但在这次事故里是错的。而更糟的是——我们执行第一条命令时，它就挂住了，只能按 `Ctrl+C`：

```text
[root@master-2 ~]# kubectl get endpoints prometheus-kube-prometheus-prometheus -n monitoring

Message from syslogd@master-2 at Sep 28 16:32:08 ...
haproxy[2759847]:backend k8s_backend has no server available!

Message from syslogd@master-2 at Sep 28 16:32:08 ...
haproxy[2759847]:backend k8s_backend has no server available!
^C
```

现在回头看，**这两行被刷到控制台上的 HAProxy 告警，比之前所有推理都更有信息量**。`kubectl` 是访问 apiserver 最基础的工具，它挂住意味着：故障点不在 Prometheus，甚至不在 apiserver 的代理逻辑，而在于"我们连不上 apiserver 这件事本身"。

紧接着这条命令把这个判断钉死了：

```text
[root@master-2 ~]# kubectl get node -o wide
Unable to connect to the server: EOF
```

`kubectl` 和 Prometheus 面板用的是同一条控制平面入口。**当两个不相关的客户端同时坏在同一段链路上，故障点就在这段链路上**——这是本次排查唯一一次"一步到位"的推理。

## 第二次假设：HAProxy 后端池是空的

既然是控制平面入口，就直接看 HAProxy：

```text
[root@master-2 ~]# cat /etc/haproxy/haproxy.cfg | grep -A 20 "backend k8s_backend"
default_backend k8s_backend

backend k8s_backend
  balance roundrobin
  option tcp-check
  server master-1 141.111.33.55:6443 check fall 3 rise 2
  server master-2 141.111.33.31:6443 check fall 3 rise 2
  server master-3 141.111.34.31:6443 check fall 3 rise 2
```

配置本身没问题，三台 master 都在。但 HAProxy 的日志在持续输出这个：

```text
k8s_frontend k8s_backend/<NOSRV> -1/-1/0 0 SC 1/1/0/0/0 0/0
```

两个关键标记：

- `<NOSRV>` —— 请求没有落到任何后端服务器上；
- `SC` —— Server Connection failure，HAProxy 连不上后端。

这里有个容易被忽略但很有价值的细节：配置里用的是 `option tcp-check`，**这是纯 TCP 层探活**。它失败的含义是"三台 master 的 6443 端口连 TCP 都建立不起来"，而不是"HTTP 健康检查返回了非 200"。换句话说，后端不是"不健康"，是"不存在"。

顺带记一笔环境信息：HAProxy 已经连续运行 3 个月 27 天（`since Mon 2026-06-01 19:34:52 CST`）。**故障发生前 HAProxy 自己没有任何异常**，它只是一个忠实反映下游状态的旁观者。

## 定位：三台 master 的 6443 全部不可达

绕开 HAProxy，逐个直连 master 的 apiserver 端口：

```bash
curl -k https://141.111.33.31:6443/healthz   # master-2（本机）
curl -k https://141.111.34.31:6443/healthz   # master-3
curl -k https://141.111.33.55:6443/healthz   # master-1
```

结果：

```text
curl: (7) Failed to connect to 141.111.33.31 port 6443 after 0 ms: Connection refused
curl: (7) Failed to connect to 141.111.34.31 port 6443 after 0 ms: Connection refused
curl: (7) Failed to connect to 141.111.33.55 port 6443 after 2823 ms: No route to host
```

三种结果的语义完全不同，必须分开读：

| 目标                  | 结果                 | 含义                                            |
| :-------------------- | :------------------- | :---------------------------------------------- |
| 141.111.33.31（本机） | `Connection refused` | 本机没有任何进程监听 6443，apiserver 进程不在了 |
| 141.111.34.31         | `Connection refused` | master-3 的 apiserver 同样没有监听              |
| 141.111.33.55         | `No route to host`   | master-1 主机层面就不可达，疑似宕机或网络层断裂 |

`refused` 说明主机活着、只是服务没了；`no route to host` 说明主机或链路本身有问题。**这两个词的区别直接决定了后面要不要去查物理机。**

到这里，"Prometheus 有问题"已经被彻底排除，问题层级是：三台 master 的 kube-apiserver 全部不在监听状态。

## 真正的根因层：etcd 与 apiserver 的崩溃重启循环

静态 Pod 由 kubelet 管理，所以直接看容器运行时：

```bash
crictl ps -a | grep -E "kube-apiserver|etcd|kube-controller|kube-scheduler"
```

```text
141d616fa8c20  ...  20 seconds ago  Running  etcd                     9
34b7055cda3d4  ...  4 minutes ago   Exited   etcd                     8
c66d0425d1995  ...  4 minutes ago   Exited   kube-apiserver           9
a87fc5d638b97  ...  19 minutes ago  Running  kube-controller-manager  99
042a0bd6e003b  ...  30 minutes ago  Exited   kube-controller-manager  98
e6295cb9e4a18  ...  19 minutes ago  Running  kube-scheduler           37
27ed374bd687c  ...  30 minutes ago  Exited   kube-scheduler           36
2a28b1c1a7df3  ...  3 minutes ago   Exited   calico-kube-controllers  22
```

这张表是整个排查里信息密度最高的一段。**重启次数的量级直接暴露了故障的严重程度**：controller-manager 98→99、scheduler 36→37、calico 22 次——这不是"某个组件偶发重启"，这是一个已经持续了很久的**崩溃重启循环**。而 `etcd` 和 `kube-apiserver` 的 8→9 说明它们正在最前排崩溃。

与此同时，kubelet 的日志在疯狂重试：

```text
Trace[802531992]: "Reflector ListAndWatch" name:object-"jenkins-test"/"kube-root-ca.crt"
(28-Sep-2026 16:35:41.594) (total time: 36370ms):
---"Objects listed" error:Get "https://141.111.32.128:8443/api/v1/namespaces/...": EOF
```

注意这里两个细节：kubelet 是通过 **VIP `141.111.32.128:8443`** 而不是本机 `127.0.0.1:6443` 去访问 apiserver 的（HA 部署下的正常配置），而且每次 list 都要耗掉 **36 秒**才超时失败。这意味着**每个节点上的每个控制器都在以 36 秒为单位堆积失败请求**，整个集群的协调能力归零。

现在可以把因果链完整地串起来了：

![K8s 控制平面雪崩因果链](/img/k8s-outage/causal-chain.svg)
_从 etcd 崩溃到最初那条 Prometheus 报错：每一层都是上一层的受害者_

```text
etcd 反复退出（退出码 8 → 9）
  → kube-apiserver 依赖 etcd，启动即失败（退出码 9）
    → kube-controller-manager / kube-scheduler / calico 失去 apiserver，疯狂重启
      → 三台 master 的 6443 无进程监听
        → HAProxy 三个 tcp-check 全失败，后端池为空（<NOSRV> / SC）
          → 所有经 VIP 141.111.32.128:8443 的请求被立即断开，客户端看到 EOF
            → kubelet 无法上报状态，节点 NotReady
              → 我们看到的：面板查询 CPU 历史失败
```

**最初那条 Prometheus 报错，是这条链最末端的涟漪。** Prometheus 本身大概率一直是好的，HAProxy 是无辜的，面板只是最先喊出来的那个人。

## 尚未确认的触发源

因果链的下游很清楚，但**最上游那一环——etcd 为什么退出——还没有证据**。当时提出的候选假设和各自需要什么证据来证伪：

| 候选原因                 | 判断依据                                                           | 状态   |
| :----------------------- | :----------------------------------------------------------------- | :----- |
| etcd 数据库超过 2GB 配额 | 日志出现 `mvcc: database space exceeded`，`snap/db` 超过 2GB       | 待验证 |
| 磁盘写满                 | `df -h` / `df -i`，重点看 `/var/lib/etcd`、容器日志分区            | 待验证 |
| 证书过期                 | `openssl x509 -noout -dates` 查 `etcd/server.crt`、`apiserver.crt` | 待验证 |
| etcd quorum 丢失         | master-1 已 `No route to host`，3 节点若再挂一台就只剩 1 票        | 待验证 |
| 内存 OOM / 磁盘 I/O 错误 | 内核日志、容器退出原因、`crictl logs` 里的 `request timed out`     | 待验证 |

这几条其实能用一把很短的命令区分开：

```bash
# 1. 最关键：etcd 到底为什么退出
crictl logs <exited-etcd-container-id> 2>&1 | tail -100

# 2. 磁盘与 inode
df -h; df -i; du -sh /var/lib/etcd/member/snap/db

# 3. apiserver 的退出原因（它会告诉你是不是 etcd 拖累的）
crictl logs <exited-apiserver-container-id> 2>&1 | tail -100

# 4. 证书有效期
openssl x509 -in /etc/kubernetes/pki/etcd/server.crt -noout -dates
```

写这篇复盘时这四条还没跑完，所以本文的根因一栏只能写"未确认"。**这不是留白，而是复盘纪律**：在证据到手之前，把"最可能"写成"已确认"，下一次故障就会拿这份错误的复盘当参考。

> 补一句小提醒：etcd 3.4 之后 `ETCDCTL_API=3` 已经是废弃环境变量（默认就是 v3），新集群里可以省略，避免以后有人以为切了 API 版本。

## 认知复盘：为什么排查走了弯路

技术细节之外，这次更值得记下来的是**三个让我们绕路的认知陷阱**。

### 1. 症状的位置，不是故障的位置

我们第一反应是"Prometheus 的服务没有就绪端点"，因为那是 EOF + apiserver proxy 这个组合最常见的解释。但这个推理链有一个隐含前提——**apiserver 本身是好的**。恰恰是这个前提失效了。

一个更好用的起手式是：**先确认"谁还活着"，再问"谁挂了"**。像 `kubectl version --request-timeout=3s` 这种三秒钟就能跑的探测，应该排在查任何业务组件之前。工具本身连不上时，所有关于业务组件的结论都没有意义。

### 2. 通用答案的诱惑

值得诚实记录的一点：这次排查是有 AI 辅助的。前两轮对话给出的是相当标准的答案——检查 Endpoints、检查 NetworkPolicy、检查服务网格、检查 `routePrefix`、检查资源限制——**条条都对，但全部指错了方向**。

原因不难理解：通用知识库描述的是"概率最高的场景"，而事故现场是"已经发生的特定事实"。AI（以及翻文档的我们）只能在**症状层面**做匹配；要收敛到真因，必须往链路里灌入只有现场才有的证据——一次 `curl` 的结果、一个重启计数器、一行 HAProxy 的 `<NOSRV>`。

真正的转折点出现在把 `kubectl` 挂起和 HAProxy 告警贴出去之后：诊断层级立刻从"业务组件"跳到"控制平面"，之后每一步都在收敛。**AI 排障的瓶颈从来不是推理能力，而是证据带宽。**

### 3. 排查工具链依赖了故障组件

我们是在 master-2 上执行 `kubectl` 的，而 kubeconfig 指向的是 VIP——**排查工具和故障组件共享同一个单点**。当 HAProxy 后端池为空，我们连"看一眼集群状态"这个动作都做不到，只能靠 `crictl`、`systemctl`、`journalctl` 这些不依赖 apiserver 的本地命令。

这次还算幸运，这些命令都在。但可以想象更糟的情况：如果 `crictl` 也没配好、如果 etcd 日志没有本地留档，我们就只能在 HAProxy 日志里干瞪眼。

### 4. 告警的失效

最后一个可能比技术细节更重要的发现：HAProxy 在**持续**输出 `backend k8s_backend has no server available!`，但它只是刷在 master-2 的 syslog 里。用户不是被告警叫醒的，而是在**面板上查一个不相干的指标**时撞上了 EOF。

（3 个月 27 天的正常运行时间也说明，这是一次长期潜伏的风险的集中释放，而不是新变更引入的问题——这个信息本身就否掉了一大类猜测。）

## 改进项

按"先补证据、再补防线"的顺序整理：

| #   | 动作                                                                                         | 目的                                           | 优先级 |
| :-- | :------------------------------------------------------------------------------------------- | :--------------------------------------------- | :----- |
| 1   | 取回 etcd / apiserver 退出日志、`df -h`、`df -i`、证书有效期                                 | 把本文的"未确认根因"补成结论                   | P0     |
| 2   | 建控制平面告警：HAProxy 可用后端数、三台 6443 存活探测、etcd `endpoint health`               | 故障第一分钟就能被人知道，而不是靠面板偶然发现 | P0     |
| 3   | 为排查准备"不依赖控制平面"的工具与 kubeconfig                                                | `kubectl` 挂掉时仍有观测手段                   | P0     |
| 4   | etcd 专项治理：`--quota-backend-bytes` 容量评估 + 定期 `compact` / `defrag` / `alarm disarm` | 消除最常见的 etcd 自杀路径                     | P1     |
| 5   | 磁盘与日志容量治理：容器日志轮转、`/var/lib/etcd` 所在分区容量水位告警                       | 消除"静默杀手"                                 | P1     |
| 6   | etcd 快照定时备份 **并演练恢复**                                                             | 保证最坏情况下有退路                           | P1     |
| 7   | 补一份控制平面恢复 Runbook                                                                   | 故障时不需要现查命令                           | P1     |
| 8   | 检查三台 master 的共因（共享存储、时间同步、证书轮换策略）                                   | 三台同时挂，必然存在共同依赖                   | P2     |

## 恢复手册（写给自己）

如果控制平面再次全线不可用，按这个顺序走，**不要跳步，也不要抢跑**：

```bash
# 1. 先确认是 etcd 还是 apiserver：apiserver 起不来通常是被 etcd 拖累的
crictl ps -a | grep -E "etcd|kube-apiserver"

# 2. 看已退出容器的日志（这是唯一能确定根因的证据）
crictl logs <exited-container-id> 2>&1 | tail -100

# 3. 排除系统级共因：磁盘 / inode / 内存 / 时间
df -h; df -i; free -h; timedatectl

# 4. etcd 健康（注意不同版本 etcdctl 的用法）
etcdctl --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  endpoint health
```

三条铁律：

1. **不要三台 master 的 kubelet 一起重启**。3 节点 etcd 集群需要 2 票才能形成 quorum，同时重启等于亲手把 quorum 弄丢。
2. **不要贸然删除 `/var/lib/etcd` 数据目录**。先尝试恢复；`snapshot restore` 或重新 `kubeadm init` 是最后手段，代价是丢数据。
3. **修好 etcd，再修 apiserver**。所有依赖 apiserver 的组件（controller-manager、scheduler、calico、Prometheus Operator）会在 apiserver 恢复后自行恢复，不需要逐个去动。

## 结语

这次事故最值得记住的不是 etcd 的哪个参数，而是**报错的位置和故障的位置可以相隔很远**：面板告诉我 Prometheus 查询失败，真实情况是三台 master 的 apiserver 都没在监听。

由此得到两个可以复用的习惯：

- 看到 `EOF`、`connection refused`、`no route to host` 这类**链路层症状**时，先做可达性分层探测（本机 → 端口 → VIP → 后端），不要直接跳进业务组件的配置里找答案。
- 当**两个不相关的客户端同时失败**时，立刻停止排查单个客户端，转去找它们的共同依赖。

以及一条给自己的提醒：这份复盘里有一栏写着"未确认"。它比一个漂亮的结论更有用——**因为它是真的**。
