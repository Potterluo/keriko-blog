---
title: 登录状态放在哪一侧
description: Cookie 只负责投递，Session 和 JWT 才是两种存放位置。按「状态存在哪、谁负责失效」重排一遍，并给出容易踩错的属性与校验规则。
publishedAt: "2026-03-25"
updatedAt: "2026-11-22"
category: 技术分享
tags:
  - Web
  - 认证
  - Cookie
  - Session
  - JWT
draft: false
---

用户按下登录之后，服务端要记住「这个人刚验过密码」这件事。这个记忆有三个去处：浏览器里、服务端里、或者写进一张自带签名的凭据里。位置一换，三件事跟着变：谁保存、谁失效、跨域时能不能带过去。

Cookie、Session、JWT 经常被并排成三个方案，其实不在一个层级。Cookie 是投递方式，另外两个是存放位置。

## Cookie 只负责送达

一次登录的往返只交换两个头。

```http
POST /login HTTP/1.1
Host: example.com
Content-Type: application/json

{"user": "alice", "pass": "..."}
```

```http
HTTP/1.1 200 OK
Set-Cookie: sid=8f3a1c9d2e7b40a6b5c8d1e2f3a4b5c6; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=1800
```

之后每个同域请求自动带上 `Cookie: sid=8f3a1c9d...`，不需要写代码。这是 Cookie 唯一的魔法，也是它所有麻烦的来源。

属性逐个看，有几处容易被说反。

`HttpOnly` 让 `document.cookie` 读不到。它挡的是脚本把值读走，挡不住脚本在页面里发一个同源请求，那个请求照样自动带上 Cookie。

`Secure` 限制只在 HTTPS 下发送。缺了它，用户访问一次 http 站点，Cookie 就明文上网了。

`SameSite` 决定跨站请求带不带。Chrome 80 之后的默认值是 `Lax`：顶级导航的 GET 会带，POST 和子资源不带。设成 `None` 必须同时加 `Secure`，否则浏览器直接丢弃这条 Cookie，控制台只留一行 warning。

`Max-Age` 和 `Expires` 同时出现时以 `Max-Age` 为准。都不写就是会话 Cookie，关浏览器清掉。开了「恢复上次会话」的浏览器不一定清，所以别把安全边界建在这一层。

常见的坑是把用户标识直接放进 Cookie，比如 `Set-Cookie: userId=123`。值是明文、可改，改成 124 就换了身份。Cookie 的内容一律不可信，服务端能信的只有签名，或者自己存储里的那份副本。

## Session：钥匙在浏览器，账本在服务端

Session 把状态搬回服务端，Cookie 里只放一个不透明的 ID。

```text
# 登录成功后写一条会话，30 分钟过期
SET sess:8f3a1c9d2e7b40a6b5c8d1e2f3a4b5c6 '{"uid":"123","login_at":1780000000}' EX 1800
```

```text
# 后续请求到达
GET sess:8f3a1c9d2e7b40a6b5c8d1e2f3a4b5c6
-> {"uid":"123","login_at":1780000000}
```

这个 ID 有两条要求：随机（至少 128 位，别用递增或时间戳拼），不含信息（不编码 uid，不编码权限）。它只是主键，泄漏了也只够查一条记录。

Session 被低估的地方是能真的作废。退出登录就是删掉那个键，钥匙立刻失效，不管有没有被复制走。踢掉某台设备、强制全站下线、改密码后让旧会话全部失效，这些在服务端存储上是删除操作，在客户端凭据上做不到。

麻烦在服务端。多实例要共享存储（Redis、数据库），或者用粘性会话把同一个用户钉到同一台机器。粘性会话在滚动发布时会掉登录，那台机器一下线，上面的会话跟着走。

还有个不同步的细节。浏览器里的 SID 是会话 Cookie，服务端的记录有自己的 TTL，两套计时器各走各的。浏览器恢复上次会话、SID 还在，服务端那条已经超时，用户看到的是昨天还好、今天一进来就 401。

## JWT：凭据自带状态，签名不等于加密

```text
eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjMiLCJleHAiOjE3ODAwMDAwMDAsImp0aSI6ImExYjJjMyJ9.<签名>
```

三段用点分隔，每段是 Base64URL。第二段解开就是这段 JSON：

```json
{ "sub": "123", "exp": 1780000000, "jti": "a1b2c3" }
```

所以「把用户信息加密编码成一个字符串」这个说法是错的，这也是这一类文章里最常见的错。JWT 默认只签名不加密，payload 是明文，任何人拿到 token 都能读出 `sub` 和 `exp`。签名解决的是有没有被改过，不是别人能不能看见。真要加密是 JWE，另一个东西。

`exp` 的单位是 Unix 秒，不是毫秒。

服务端校验至少要管四件事：算法固定（不信任 header 里的 `alg`）、验签、检查 `exp` 和 `nbf`、检查 `iss` 和 `aud`。算法这条是硬要求，`alg: none` 和 HS256/RS256 混用造出过的绕过是真实存在的漏洞类别，别交给库的默认值。

代价全在作废上。服务端不存 token，就没有「删掉它」这个动作。能不能撤销只有三条路：过期时间压到几分钟配 refresh token；用 `jti` 维护黑名单，等于回到有状态；或者接受发出去的凭据在过期前一直有效。

## 混在一起才会出事

单看任何一种都干净。

两套机制并存是最常见的。老系统用 Session，新接口用 JWT，同一个站两个入口。退出登录只清了一边，另一边在有效期内照常放行。问题出在没人负责边界，谁算已登录，两个模块各有各的答案。

多端各持一份也类似。Web 用 HttpOnly Cookie，移动端用 Authorization 头。用户在 Web 改密码，移动端的 token 还在跑，因为改密码通常只动 Session 那一侧。

`SameSite` 和 OAuth 回调也会打架。从第三方跳回来是顶级导航，`Lax` 下 Cookie 会带；如果回调是表单 POST，就不带，授权成功了却拿不到会话。这类问题只在特定浏览器和特定流程里出现，本地开发环境往往复现不了。

排查顺序我一般反着走：先看请求里有没有那个头（Cookie 或 Authorization），再看服务端认不认这个值，最后才看它该不该过期。顺序反了容易在配置文件里绕很久。

## 怎么选

单体渲染应用、只有一个域：用 Session，别折腾。一次 Redis 查询不在关键路径上，换来的是随时能踢人。

前后端分离、要跨域、多端共存：我倾向用不透明随机串当 token，服务端查存储，而不是 JWT。理由是能撤销，也少一堆算法约定要守。JWT 划算的场景是验证方不能回查，比如网关、多个服务、跨组织，对方只想验签就走。

只存偏好（语言、主题）这类没有权限含义的数据：Cookie 直接存。哪怕只是 `role: admin` 这种「服务端还会再查一次」的字段也不要放，它迟早会被某处当真。
