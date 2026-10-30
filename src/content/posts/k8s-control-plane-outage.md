---
title: 一次 K8s 控制平面全面瘫痪的复盘：从一条 Prometheus EOF 到 etcd Quorum 丢失
description: 一条 Prometheus 查询报 EOF，最后查出 etcd 集群丢失 Quorum、三台 master 全体失联、Harbor 502、大批 Pod ImagePullBackOff。这篇复盘完整记录根因链（物理失联 + 误用 --force-new-cluster 污染数据）、幽灵 Pod 的连锁反应、单节点 etcd 的恢复全过程，以及那些真正决定成败的操作细节
publishedAt: "2026-09-28"
updatedAt: "2026-09-28"
category: 技术分享
tags:
  - Kubernetes
  - etcd
  - HAProxy
  - Keepalived
  - 线上事故
  - 故障复盘
  - SRE
draft: false
---

今天下午集群出了一个大状况：整个 Kubernetes 控制平面全面瘫痪，三台 Master 中有两台失联，etcd 集群丢失 Quorum，Harbor 镜像仓库不可用，大量业务 Pod 陷入 ImagePullBackOff 与 CrashLoopBackOff。

经过约 6 小时的紧急恢复，集群最终以单节点 etcd 模式恢复服务，数据完整保留，业务逐步自愈。

之所以现在才写，是因为故障当时我们手头只有"层层向下"的现象，没有最上游的证据。根因是拿到 etcd 日志、DB SIZE 和磁盘数据之后才确定的。命令都保留原样，便于以后再遇到时直接照做。

## 事故概要

| 项目         | 内容                                                                                      |
| :----------- | :---------------------------------------------------------------------------------------- |
| 发现时间     | 2026-09-28 16:32 前后（CST），由监控面板查询 CPU 历史失败触发                             |
| 恢复时长     | 约 6 小时                                                                                 |
| 影响范围     | 控制平面全面不可用；Harbor 502；大量 Pod ImagePullBackOff / CrashLoopBackOff；Ingress 502 |
| 直接现象     | HAProxy 后端池为空、`kubectl` 挂起、所有经 VIP 的 API 请求返回 EOF                        |
| 根本原因     | etcd 集群丢失 Quorum（master-1 物理失联 + master-3 数据目录被误操作污染）                 |
| 数据结果     | 完整保留，以单节点 etcd 模式恢复服务                                                      |
| 最严重的教训 | 故障排查期间引入新变更（`--force-new-cluster`），把"可恢复"变成了"险些不可恢复"           |

## 现场：一条看起来毫无杀伤力的报错

一切始于这行日志：

```text
Failed to get resource usage history: error querying CPU usage:
Post "https://141.111.32.128:8443/api/v1/namespaces/monitoring/services/prometheus-kube-prometheus-prometheus:9090/proxy/api/v1/query_range": EOF
```

把这条 URL 拆开看，它说清楚了请求链路：

- `141.111.32.128:8443` 是集群控制平面的对外 VIP（Keepalived + HAProxy）；
- `/api/v1/namespaces/monitoring/services/.../proxy/...` 是 kube-apiserver 的 service proxy 转发，不是直连 Prometheus；
- 结尾的 `EOF` 表示连接在数据传输完成前被对端关闭。

注意第三点：EOF 不是 HTTP 状态码，也不是 Prometheus 返回的错误，它意味着请求根本没走到 Prometheus。这条报错的位置和真正的故障点之间，隔了整整三层。

## 排查：三次层级下探

### 第一层：业务组件

第一反应是教科书式的标准答案：Prometheus Service 没有就绪端点，kube-proxy 接受连接后立即挂断，客户端看到 EOF。于是照方抓药：

```bash
kubectl get endpoints prometheus-kube-prometheus-prometheus -n monitoring
kubectl get node -o wide
```

但第一条命令直接挂住，只能 `Ctrl+C`，而且控制台冒出了完全不相干的告警：

```text
[root@master-2 ~]# kubectl get endpoints prometheus-kube-prometheus-prometheus -n monitoring

Message from syslogd@master-2 at Sep 28 16:32:08 ...
haproxy[2759847]:backend k8s_backend has no server available!

^C
[root@master-2 ~]# kubectl get node -o wide
Unable to connect to the server: EOF
```

这两行 HAProxy 告警比之前所有推理都更有信息量。`kubectl` 是访问 apiserver 最基础的工具，它挂住说明我们连不上 apiserver，问题已经不在 Prometheus，也不在代理层。两个不相关的客户端同时坏在同一段链路上，故障点就在这段链路上。

### 第二层：控制平面入口

既然是入口，就直接看 HAProxy：

```bash
journalctl -u haproxy --since "10 min ago" | tail -50
# 发现大量: backend k8s_backend has no server available!

cat /etc/haproxy/haproxy.cfg | grep -A 20 "backend k8s_backend"
```

```text
backend k8s_backend
  balance roundrobin
  option tcp-check
  server master-1 141.111.33.55:6443 check fall 3 rise 2
  server master-2 141.111.33.31:6443 check fall 3 rise 2
  server master-3 141.111.34.31:6443 check fall 3 rise 2
```

配置本身没问题，但日志在持续输出：

```text
k8s_frontend k8s_backend/<NOSRV> -1/-1/0 0 SC 1/1/0/0/0 0/0
```

两个关键标记：`<NOSRV>` 表示请求没有落到任何后端；`SC` 表示 Server Connection failure。配置里用的是 `option tcp-check`，这是纯 TCP 层探活，它失败意味着三台 master 的 6443 连 TCP 都建立不起来，与 HTTP 健康检查返回非 200 无关。后端根本不存在，谈不上"不健康"。

顺带记一笔：HAProxy 已连续运行 3 个月 27 天，故障前它自己没有任何异常，只是一个反映下游状态的旁观者。

绕开 HAProxy，逐个直连 master 的 apiserver：

```bash
curl -k --max-time 3 https://141.111.33.31:6443/healthz   # master-2（本机）
curl -k --max-time 3 https://141.111.34.31:6443/healthz   # master-3
curl -k --max-time 3 https://141.111.33.55:6443/healthz   # master-1
```

结果三种语义，必须分开读：

| 目标                  | 结果                 | 含义                                            |
| :-------------------- | :------------------- | :---------------------------------------------- |
| 141.111.33.31（本机） | `Connection refused` | 本机没有进程监听 6443，apiserver 进程不在了     |
| 141.111.34.31         | `Connection refused` | master-3 的 apiserver 同样没有监听              |
| 141.111.33.55         | `No route to host`   | master-1 主机层面就不可达，疑似宕机或网络层断裂 |

`refused` 说明主机活着、只是服务没了；`no route to host` 说明主机或链路本身有问题。这两个词的区别，决定了后面要不要去查物理机。

### 第三层：组件运行时

静态 Pod 由 kubelet 管理，所以直接看容器运行时：

```bash
crictl ps -a | grep -E "etcd|kube-apiserver|kube-controller|kube-scheduler"
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

这张表是整场排查里信息密度最高的一段。重启次数的量级直接暴露了故障的持续时间：controller-manager 98→99、scheduler 36→37、calico 22 次。这已经是一个持续很久的崩溃重启循环，不只是某个组件偶发重启。etcd 和 kube-apiserver 的 8→9 说明它们正处在最前排崩溃。

与此同时 kubelet 在疯狂重试，注意两个细节：

```text
Trace[802531992]: "Reflector ListAndWatch" name:object-"jenkins-test"/"kube-root-ca.crt"
(28-Sep-2026 16:35:41.594) (total time: 36370ms):
---"Objects listed" error:Get "https://141.111.32.128:8443/api/v1/namespaces/...": EOF
```

kubelet 是通过 VIP `141.111.32.128:8443` 访问 apiserver 的（HA 部署下的正常配置），不走本机 `127.0.0.1:6443`，而且每次 list 要耗 36 秒才超时失败。每个节点上的每个控制器都在以 36 秒为单位堆积失败请求，整个集群的协调能力归零。

排查到此，层级已经从"业务组件"下探到"etcd"，剩下的问题是：etcd 为什么会崩。

## 根因：三个条件同时成立

![控制平面故障因果链](/img/k8s-outage/causal-chain.svg)
_从物理失联和误操作，到最初的 Prometheus 报错：每一层都是上一层的受害者_

### 1. master-1 物理失联

master-1（`141.111.33.55`）返回 `No route to host`，主机层面不可达。三节点 etcd 集群因此只剩两票可用，这已经踩在 Quorum 的边界上（3 节点需要 2 票）。此时集群还能工作，但已经没有任何容错余量。

### 2. master-3 的 etcd 数据被污染（最严重）

在排查过程中，有人在 master-3 上使用 `--force-new-cluster` 或 `--initial-cluster-state=new` 启动了一个新的 etcd 集群，污染了原有的数据目录。

这是整场事故里最严重的一步。破坏力来自两点：

- 原集群的成员信息和数据一致性被破坏，丧失了原地恢复的可能性；
- 如果此时 master-2 的 etcd 仍在运行，会形成双集群冲突风险：两个自认为独立的集群持有不同的数据版本，后续无论以哪边为准都存在分歧。

### 3. 结果：Quorum 丢失

master-1 失联 + master-3 数据被污染，三节点集群只剩 master-2 一个健康节点，无法形成多数派，etcd 拒绝提供服务并陷入重启循环。剩下的链条就是纯机械的连锁反应：

```text
etcd 反复退出（退出码 8 → 9）
  → kube-apiserver 依赖 etcd，启动即失败（退出码 9）
    → kube-controller-manager / kube-scheduler / calico 失去 apiserver，疯狂重启
      → 三台 master 的 6443 无进程监听
        → HAProxy 三个 tcp-check 全失败，后端池为空（<NOSRV> / SC）
          → 所有经 VIP 141.111.32.128:8443 的请求被立即断开，客户端看到 EOF
            → 我们看到的：面板查询 CPU 历史失败
```

最初那条 Prometheus 报错，是这条链最末端的涟漪。Prometheus 一直是好的，HAProxy 是无辜的，面板只是最先喊出来的那一个。

## 为什么影响面被放大

控制平面挂掉之后，还有三个因素把故障面从"控制平面不可用"放大成了"大面积业务中断"。

### VIP 漂移到了故障节点

Keepalived 的 VIP `141.111.32.128` 漂移到了 master-3，而 master-3 的 apiserver 已经挂了。同时 HAProxy 仍把 master-1/3 放在后端池里。结果是集群入口指向了一个没有服务的节点，流量被转发到无服务处，可用性进一步恶化。

根子在于 Keepalived 的 VIP 归属没有与 apiserver 健康检查联动：它只知道 master-3 这台机器活着，不知道 master-3 上的 apiserver 已经死了。

### 幽灵 Pod

大量 Pod 显示 `Running`，但 `kubectl exec` 报 `container not found`：Pod 状态说有容器，节点上其实没有，也就是"幽灵 Pod"。

原因是控制平面故障期间 kubelet 与 apiserver 断连，容器被终止了，但状态没有同步回来。

### Harbor 死循环

这一层是最难受的放大效应：

```text
Harbor 依赖 Redis 维持会话
  → Redis master Pod 也是幽灵（容器不存在）
    → Harbor core 启动报 failed to ping redis，对外 502
      → 所有需要拉镜像的 Pod 陷入 ImagePullBackOff
        → 而修复这些 Pod 又需要 Harbor 正常……
```

依赖链是 Harbor → Redis → etcd/apiserver 维持 Pod 状态。控制平面一挂，镜像仓库跟着挂；镜像仓库一挂，所有 Pod 都无法重建，包括那些本来能自愈的。

## 止损：先备份，再动手

这一节是整场恢复的分水岭：动手之前，先把退路准备好。

```bash
# 1. 停止 master-3 上所有 etcd 相关操作，避免继续污染数据
# 2. 停掉 master-3 的 kubelet 与静态 Pod，防止它继续干扰集群
ssh root@master-3
systemctl stop kubelet
systemctl disable kubelet

# 3. 停止 master-3 的 keepalived，把 VIP 切回 master-2
ssh root@master-3 "systemctl stop keepalived && systemctl disable keepalived"
# 在 master-2 上确认 VIP 已回归
ip addr show | grep 141.111.32.128

# 4. 备份 master-2 的 etcd 数据与静态 Pod 清单（可回滚是前提）
mkdir -p /root/etcd-backup
cp -r /var/lib/etcd /root/etcd-backup/etcd-data
cp -r /etc/kubernetes/manifests /root/etcd-backup/kubernetes-manifests

# 5. 确认 master-2 的 etcd 数据完整
ETCDCTL_API=3 etcdctl \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  endpoint status -w table
# DB SIZE 423MB —— 数据完整，未丢失
```

顺序很重要：先隔离故障节点（master-3），再抢回入口（VIP），最后才动 master-2 的数据。反过来做，就等于在一个还有干扰源的环境里做恢复。

> 注：etcd 3.4 之后 `ETCDCTL_API=3` 已是废弃环境变量（默认就是 v3），新集群里可以省略。这里保留它只是为了和现场命令一致。

拿到 `DB SIZE 423MB` 这个数字，是整场恢复里最关键的一次确认：数据在，只是集群起不来。恢复策略因此从"重建集群"变成"让现有数据重新成为单节点集群"，代价从"丢数据"降到"暂时失去 HA"。

## 恢复：单节点 etcd 重建

### 先回答一个问题：同一个 `--force-new-cluster`，为什么这次是对的？

这是整场事故里最值得记下来的一点。完全相同的参数，在 master-3 上是灾难，在 master-2 上是解药，差别在前置条件。

| 前置条件     | master-3（误操作，造成污染）       | master-2（恢复，正确）                     |
| :----------- | :--------------------------------- | :----------------------------------------- |
| 数据完整性   | 未确认，直接启动                   | 已确认 `DB SIZE 423MB`，数据完整           |
| 备份         | 无                                 | 已完整备份 `/var/lib/etcd` 和 manifests    |
| 其他节点状态 | 仍在运行，存在双集群冲突风险       | master-1 失联、master-3 已隔离，无并存集群 |
| 操作目的     | 排查试探                           | 明确的灾难恢复手段                         |
| 结果         | 数据目录被污染，丧失原地恢复可能性 | 单节点集群拉起，数据完整保留               |

结论：`--force-new-cluster` 是有严格前置条件的高危操作，不是"危险参数"四个字能概括的。前置条件没满足就执行，它的破坏力比故障本身更大。故障排查期间禁止引入新变更，这条是用一次数据污染换来的。

### 4.1 修改 etcd 静态 Pod 清单

```bash
vi /etc/kubernetes/manifests/etcd.yaml
```

在 `command` 中调整：

```yaml
- --force-new-cluster=true
- --initial-cluster-state=new
- --initial-cluster=master-2=https://141.111.33.31:2380
```

`--initial-cluster-state` 必须为 `new`，不能是 `existing`，否则 etcd 会尝试按旧配置去连接已经不存在的集群成员。

### 4.2 停止 kubelet，清掉残留容器

```bash
systemctl stop kubelet
crictl ps | grep etcd          # 获取容器 ID
crictl stop <容器ID>
crictl rm <容器ID>
crictl ps | grep etcd          # 确认无输出
```

### 4.3 启动 kubelet 并验证

```bash
systemctl start kubelet
sleep 30
crictl ps | grep etcd          # 应看到 etcd 容器 Running

ETCD_ID=$(crictl ps | grep etcd | awk '{print $1}')
crictl logs $ETCD_ID 2>&1 | grep -E "ready to serve|serving client"

ETCDCTL_API=3 etcdctl \
  --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  endpoint health
# 期望: is healthy: successfully committed proposal
```

看到 `ready to serve client requests` 且健康检查通过，说明"单节点集群"这一步成功了。

### 4.4 清掉旧成员信息

新集群里可能还残留在旧集群中记录的成员信息，需要移除：

```bash
ETCDCTL_API=3 etcdctl --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  member list -w table

# 移除 master-1 和 master-3（替换为实际 ID）
ETCDCTL_API=3 etcdctl ... member remove <master-1-ID>
ETCDCTL_API=3 etcdctl ... member remove <master-3-ID>
```

### 4.5 摘掉 `--force-new-cluster`

```bash
vi /etc/kubernetes/manifests/etcd.yaml
# 删除 --force-new-cluster=true 这一行，保存退出，kubelet 会自动重建 etcd
sleep 30
crictl ps | grep etcd
```

因为残留成员已经被移除，"当前节点"就是这个集群唯一的成员，所以去掉 `--force-new-cluster` 后 etcd 仍能正常启动。这一步也在验证新集群是否真的自洽：如果去掉参数后 etcd 起不来，说明成员关系还没清干净，此时不能继续往下走。

### 4.6 控制平面自动重建

etcd 恢复后，kube-apiserver 由 kubelet 自动重建，其余组件随之恢复：

```bash
crictl ps | grep kube-apiserver
curl -k https://127.0.0.1:6443/healthz   # 期望: ok
kubectl get nodes
```

`kubectl get nodes` 正常输出，且所有 K8s 对象都在，这确认了第 4 节的判断：数据完整，集群只是起不来，不是没了。

## 幽灵 Pod：重启 kubelet，而不是删 Pod

控制平面回来之后，最大的坑是幽灵 Pod。

```bash
kubectl get pods -n redis-system -o wide
kubectl exec -n redis-system redis-master-0 -- ps aux 2>&1 | head -3
# 报 container not found，确认是幽灵 Pod
```

处理方法是逐节点重启 kubelet，让它用本地镜像缓存重建容器，不需要从 Harbor 拉取。

```bash
# 一次只重启一台，避免同时中断过多业务
ssh root@cpu-1
systemctl restart kubelet
sleep 20
crictl ps | grep harbor        # 确认容器重建

ssh root@cpu-3
systemctl restart kubelet
sleep 30
crictl ps | grep -E "redis|harbor"

ssh root@cpu-2
systemctl restart kubelet
sleep 30
crictl ps | grep -E "harbor|redis"
```

在 Harbor 还没恢复的时候删 Pod，新 Pod 会因为拉不到镜像直接陷入 `ImagePullBackOff`，状态不一致就变成真的没有服务，故障从可自愈变成不可自愈。这个坑我们踩了一次，记住顺序：先修节点上的容器（重启 kubelet），再处理 Pod 对象。

## Harbor 与 Redis 恢复

Harbor core 的日志把依赖关系暴露得很清楚：

```text
failed to ping redis://...@redis-master.redis-system.svc.cluster.local:6379/0
dial tcp 10.100.54.65:6379: connect: connection refused
```

Redis master 也是幽灵 Pod。重启 cpu-3 的 kubelet 后，Redis master 与 Harbor 三件套重建。验证要一路打到最外层：

```bash
# 1. Harbor Pod 不再是幽灵
kubectl exec -n harbor-system harbor-core-544fdbfc55-l7vs7 -- ls /

# 2. 从 Ingress Controller 直连 Harbor Service
kubectl exec -n kube-system ingress-controller-ingress-nginx-controller-dk2n8 -- \
  curl -v --max-time 5 http://10.102.69.212/api/v2.0/ 2>&1 | tail -10
# 期望: 返回 404 或 401，不再是 Connection refused

# 3. 直接测 registry 域名
curl -k -u admin:Harbor12345 https://registry.dev.huawei.com/v2/_catalog
# 期望: 返回 JSON 格式的镜像列表
```

`_catalog` 返回完整镜像列表，说明 Harbor 完全恢复。三层验证的顺序（Pod 存在 → Service 可达 → 域名可用）不能省：只测最后一层会误判，只测第一层会过早乐观。

## 业务恢复与残留清理

Harbor 恢复后，删掉处于 `ImagePullBackOff` 的 Pod 让它们重新调度：

```bash
kubectl get pods -A | grep ImagePullBackOff
kubectl delete pod -n <namespace> <pod-name>
```

kite、coredns、webdis 等陆续恢复，部分 `CrashLoopBackOff` 的 Pod 随依赖恢复而自愈。

master-1/3 必须彻底清干净，否则它们会再次尝试启动控制平面：

```bash
ssh root@master-3
systemctl stop kubelet
systemctl disable kubelet
mkdir -p /root/manifests-backup-$(date +%F)
mv /etc/kubernetes/manifests/*.yaml /root/manifests-backup-$(date +%F)/
crictl ps | grep -E "etcd|kube-apiserver"   # 有则强制停止

# 在 master-2 上从集群删除节点
kubectl delete node master-1
kubectl delete node master-3
```

这一点我们吃过回头账：master-3 的 kubelet 被重新启动过，etcd/apiserver 又尝试跑起来。"停服务"和"移走静态 Pod 清单"必须同时做，只 `stop` 而不 `disable`，一次重启就会复发。

## 做对了什么，做错了什么

| 做对了                                            | 做错了                                                     |
| :------------------------------------------------ | :--------------------------------------------------------- |
| 先备份 `/var/lib/etcd` 与 manifests 再动手        | 故障期间在 master-3 上执行 `--force-new-cluster`           |
| 用 `DB SIZE 423MB` 确认数据完整，避免仓促重建集群 | master-1 失联后未及时从集群移除，etcd 持续无效重试         |
| 先隔离 master-3 再抢 VIP，最后才动 master-2       | Keepalived 未与 apiserver 健康检查联动，VIP 漂到故障节点   |
| 幽灵 Pod 用"重启 kubelet"而不是"删 Pod"           | 在 Harbor 未恢复时删 Pod，触发 ImagePullBackOff 并放大中断 |
| etcd 恢复后逐层验证（healthz → nodes → _catalog） | HAProxy 后端未动态摘除，仍转发到无服务节点                 |
| 逐节点重启 kubelet，控制影响面                    | etcd 长期以高风险状态运行，无自动快照                      |

## 尚未完成的事（风险仍在）

故障恢复了，但下面这几件事没有做完，风险仍然挂在那里：

1. master-1 尚未修复，集群目前跑在单节点 etcd 上，现在没有任何 HA 余量，再挂一台就彻底没了。
2. etcd 没有自动快照。刚才能保住数据，靠的是 master-2 的数据目录恰好完整，并没有备份可回滚。这是运气。
3. `/var/lib/etcd` 所在分区使用率 78%，需要清理容器日志、无用镜像，并配置 etcd 压缩与碎片整理。
4. master-3 残留仍需彻底降级或移除。
5. Harbor 的 Redis / PostgreSQL 仍是单点，依赖链的脆弱性没有消除。

## 加固清单

| #   | 动作                                                                           | 目的                            | 优先级 |
| :-- | :----------------------------------------------------------------------------- | :------------------------------ | :----- |
| 1   | 配置 etcd 每小时自动快照 + 异地备份                                            | 把"靠运气"换成"有退路"          | P0     |
| 2   | 修复 master-1 或新增节点，恢复三节点 etcd                                      | 消除当前的零 HA 余量            | P0     |
| 3   | Keepalived 联动 apiserver 健康检查；HAProxy 动态摘除不健康后端                 | 避免 VIP 漂到无服务节点         | P0     |
| 4   | 清理 master-3 残留，降级为 worker 或彻底移除                                   | 消除复发风险                    | P1     |
| 5   | etcd 专项监控：`endpoint health`、`DB SIZE`、Quorum、leader 变更               | 早发现，而不是等面板报 EOF      | P1     |
| 6   | 磁盘治理：容器日志轮转、镜像清理、分区水位告警                                 | 消除"静默杀手"                  | P1     |
| 7   | Harbor 的 Redis / PostgreSQL 高可用化                                          | 切断"仓库挂→镜像拉不到"的死循环 | P1     |
| 8   | 变更管理：etcd / 控制平面操作必须审批 + 强制先备份                             | 防止第二次"故障中引入新变更"    | P1     |
| 9   | 定期演练控制平面恢复流程（`force-new-cluster`、`member remove`、kubelet 重启） | 把手册变成肌肉记忆              | P2     |

自动快照可以先用一条 crontab 顶上：

```bash
mkdir -p /root/etcd-snapshots
crontab -e
# 每小时快照一次
0 * * * * ETCDCTL_API=3 etcdctl --endpoints=https://127.0.0.1:2379 \
  --cacert=/etc/kubernetes/pki/etcd/ca.crt \
  --cert=/etc/kubernetes/pki/etcd/server.crt \
  --key=/etc/kubernetes/pki/etcd/server.key \
  snapshot save /root/etcd-snapshots/etcd-$(date +\%F-\%H).db \
  >> /var/log/etcd-snapshot.log 2>&1
```

## 附：再遇到时的执行顺序

止损：先建退路

1. 停止故障节点上的 etcd 相关操作，隔离该节点
2. 停掉它的 kubelet 并 `disable`，移走静态 Pod 清单
3. 停掉它的 keepalived，确认 VIP 已回到健康节点
4. 备份健康节点的 `/var/lib/etcd` 和 `/etc/kubernetes/manifests`
5. `etcdctl endpoint status` 确认 DB SIZE 与数据完整

恢复：从底层往上

6. 单节点 etcd：`--force-new-cluster=true` + `--initial-cluster-state=new` + 单成员 `--initial-cluster`
7. 验证 `ready to serve client requests` 与 `endpoint health`
8. `member list` → `member remove` 清掉旧成员
9. 摘掉 `--force-new-cluster` 重启，确认仍健康
10. 等 apiserver 自动重建：`curl -k https://127.0.0.1:6443/healthz` → `kubectl get nodes`

善后：自愈优先，删对象最后

11. 幽灵 Pod：逐节点重启 kubelet，用本地镜像缓存重建
12. Harbor / Redis 恢复（Pod → Service → 域名 三层验证）
13. 清理 `ImagePullBackOff` 的 Pod 让其重新调度
14. 彻底清掉失联节点，`kubectl delete node`

三条铁律：

1. 不要三台 master 的 kubelet 一起重启。3 节点 etcd 需要 2 票，同时重启等于亲手把 Quorum 弄丢。
2. 不要贸然删除 `/var/lib/etcd`。先尝试恢复；`snapshot restore` 或重新 `kubeadm init` 是最后手段，代价是丢数据。
3. 故障期间严禁引入新变更。`--force-new-cluster` 在 master-3 上是灾难，在 master-2 上是解药，区别只在前置条件。没满足条件就别执行。

## 结语

这次故障的直接原因是 etcd Quorum 丢失，而把"可恢复的 Quorum 丢失"变成"险些不可恢复的数据污染"的，是排查过程中的一次误操作。

面板报的是 Prometheus 查询失败，真实情况是三台 master 的 apiserver 都没在监听。看到 `EOF`、`connection refused`、`no route to host` 这类链路层症状时，先做可达性分层探测，再去看业务组件的配置。

这次能保住数据，靠的是备份和 `DB SIZE 423MB` 这次确认。顺序如果反了，先执行了那个参数，就没有这份复盘了。

本次恢复结束在"单节点 etcd 模式"，能跑，但零 HA 余量。
