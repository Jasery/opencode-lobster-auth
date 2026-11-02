# opencode-lobster-auth 优化方案（对照 magpie 0.1.2668 / LobsterAI 2026.10.30）

- 日期：2026-11-02（含评审修订）
- 目标仓库：`D:\git\magpie-lobster`（当前 `0.1.2`，最后提交 `6ed3faf`，79 个测试全过）
- 上游实测账号：`urs-phoneyd.6fb7d380e0094d1b8@163.com`（免费计划）
- 实测方式：直连上游 + 经 magpie 网关（`127.0.0.1:3425`）端到端，两处都留了原始响应
- 评审依据：当前代码、`%TEMP%` 下的目录与积分快照、magpie.exe 内嵌的 plugin-host 源码

本文只写**实测证实**的问题与改法。凡是没测出来的，一律标成「待验证」而不是
「应该改」。

> **修订记录（评审后）**
>
> - Bug 2「能力头导致阶梯失效」改判为**不是 bug**：能力头与 `lobsterai_options` 通道
>   保留不动。「没档位可选」的真正原因是 `lib/models.mjs` 没给无档位表的模型声明
>   `variants`，不动能力头也能修（§3.1）。
> - 模型计数更正为有档位表 8 个、无档位表 11 个（初稿写 7 / 12）。
> - Bug 1 的修法必须保留 `event:error` 判断；初稿说的「清掉失效标记」不成立。
> - Bug 3 分两步：先放宽「删采样参数」，「强制 max」等补档位时再收窄。
> - 输出上限改为「补测剩余 11 个模型后再改」。
> - 签到提前到第三批、与钱包窗口同批；不移植脚本里的取 token / 续期逻辑；多账号照常各签一次。
> - `auth.single` 不做：magpie 支持一个插件挂多个账号，用户本来就可能有多个号。
> - 新增 Bug 4：多账号下桌面导入的账号会串号。

---

## 0. 一句话结论

插件本身写得相当干净（79 个测试全过、零运行时依赖、注释把坑都记下来了），
但它是在 **9 月底的 LobsterAI + magpie 早期版本**上定型的。一个月后上游变了几处
契约，magpie 又多出几个插件可用的钩子。评审后的结论：**3 个真 bug**（其中一个是
评审新发现的）、**2 处能力浪费**、**2 项值得接的官方能力**；初稿里的「能力头 bug」
不成立，不改。

| 编号 | 问题 | 性质 | 用户感受 | 安排 |
|---|---|---|---|---|
| Bug 1 | 错误帧有两种形态，插件只认一种 | **真 bug** | 失败被吞成空回复，原始报错丢失 | 第一批 |
| Bug 3 | Kimi 家族采样参数契约只覆盖 `kimi-k3*` | **真 bug** | `kimi-k2.8-preview` 带 temperature 直接 400 | 第一批 |
| Bug 4 | 多账号时桌面导入的账号会串号 | **真 bug** | 桌面端切账号后，原账号悄悄用上别人的 token | 第一批 |
| §3.1 | 19 个模型里 11 个没有思考档位可选 | 能力浪费 | 上游支持，界面上选不了 | 补测后第二批 |
| §3.2 | 输出上限写死 32000 | 能力浪费 | 131072 只在 8 / 19 个模型上验证过 | 补测后第二批 |
| §4.1 / §4.3 | 没有自动签到、积分没用钱包窗口 | 缺功能 | 每日积分要手动领；积分静默过期 | 第三批 |
| Bug 2 | 能力头让 `reasoning_effort` 被忽略 | **不是 bug** | 有档位表的模型本来就走 options，不受影响 | 不改 |

---

## 1. 上游这一个月变了什么

### 1.1 模型目录：29 → 20，且字段语义变了

旧文档记的是「29 个模型，21 个 `thinkingConfig` 为 null」。今天实测
`/api/models/available` 返回 **20 条**，其中 1 条 `accessible: false`
（`kimi-k3.1-pro-highspeed`，`restrictionHint: 该模型仅限有效订阅用户使用`），
所以可用 **19 个**。19 个全部 `supportsThinking: true`；其中 **8 个**带
`thinkingConfig`（deepseek-flash / deepseek-v4-pro / deepseek-v4-flash /
deepseek-v4-flash-vision-exp / glm-5.3 / glm-5.3-flash / glm-5.3-flashx / glm-5.2，
档位都是 off/high/max），**11 个**为 null。

新增/变化的字段（旧文档完全没有）：

| 字段 | 含义 | 插件是否用 |
|---|---|---|
| `limitedFree` / `limitedFreeActive` / `limitedFreeStartAt` / `limitedFreeEndAt` | 限时免费窗口 | ❌ 未用 |
| `busy` | 上游自报的忙闲 | ❌ 未用 |
| `subscriptionPriority` | 仅订阅可用 | ❌ 未用（靠 `accessible` 兜住） |
| `restrictionHint` | 不可用的原因文案 | ❌ 未用（直接丢弃该模型） |
| `supportsToolCalling` / `agenticReady` | 工具能力 | ❌ 未用（一律写 `tool_call: true`；今天只有 `kimi-k3` 为 true，其余 null） |
| `explicitContextCache` | 显式上下文缓存 | ❌ 未用 |
| `moreModel` | 折叠项 | ❌ 未用 |
| `maxTokens` | **仍然全为 null** | — |

关键点：`maxTokens` 依然是 null，所以「输出上限接口不提供」这条旧结论**仍然
成立**；但插件填的 32000 是**偏保守到浪费**——见 §3.2。

### 1.2 能力头从「可选」变成了「有副作用」

这是本次最要紧的发现。旧设计文档 §2 写「客户端标识头可选，实测不带也正常返回
29 个模型」。**今天这句话只对一半**：不带确实能返回，但带上之后**上游会切换思考
档位的解析路径**。

实测矩阵（`deepseek-flash`，同一 prompt，reasoning 字节数）：

| 请求头 | `reasoning_effort=none` | `lobsterai_options.thinking.level=off` | 裸请求 |
|---|---|---|---|
| 无版本头、无能力头 | **0B / 0 tokens** ✅ | 400 `thinking-level-control-v1 capability is required` | 85B |
| 仅版本头 `2026.10.30` | **0B / 0 tokens** ✅ | 400 同上 | 65B |
| 版本 + 能力头 | **90B / 26 tokens** ❌ | **0B / 0 tokens** ✅ | 75B |

也就是说：

- **带能力头时**，有 `thinkingConfig` 的模型只认 `lobsterai_options`，
  `reasoning_effort` 被**忽略**（连 `none` 都关不掉思考）。没有 `thinkingConfig`
  的模型不受影响，`reasoning_effort` 照常生效（实测 `qwen3.8-max` none→0B、
  max→156B；`kimi-k3.1-pro` none/low/max → 0B/20B/156B）。
- **不带能力头时**，上游只认 `reasoning_effort`，**完整的 magpie 阶梯**
  （`none/minimal/low/medium/high/xhigh/max`）都被接受：

```
effort=none     0B/0t      ← 真关掉
effort=minimal  167B/37t
effort=low      154B/34t
effort=medium   95B/26t
effort=high     110B/28t
effort=xhigh    67B/20t
effort=max      90B/26t
裸              55B/14t
```

注意这组数是**同一 prompt 每档各跑一次**，字节数不单调（minimal 反而最多），
只能证明「上游接受这些值、`none` 真能关掉」，**证明不了 7 档效果各不相同**。
上游自己给有档位表的 8 个模型声明的也只有 off/high/max 三档。

而 `off`/`disabled`/`adaptive`/`enabled`/空串**不在阶梯里**，上游直接
`400 50204: 'reasoning_effort' must be one of: 'none', 'minimal', ...`。

**推论（评审修订）**：能力头只影响有档位表的 8 个模型，而插件对它们本来就走
`lobsterai_options`（3 档全部生效），从不依赖 `reasoning_effort`——所以能力头
**没有造成功能缺陷**。初稿把「没档位可选」归因于能力头是错的，真正的原因见 §3.1。

### 1.3 错误有两种帧形态（真 bug 的源头）

上游把错误塞进 200 的 SSE 里，这一点旧文档写对了。但**帧形态有两种**，而
`lib/proxy.mjs` 的 `first(sse(...))` 只判断 `head.event === "error"`：

**形态 A（插件能识别）** —— 代理层错误，带 `event:` 行：

```
event:error
data:{"type":"error","error":{"type":"proxy_error","message":"...","code":4000}}
```

触发者：`lobsterai_options` 相关、模型不可见（40301）。

**形态 B（插件漏掉）** —— 上游透传错误，**没有 `event:` 行**：

```
data:{"error":{"message":"invalid temperature: only 1 is allowed for this model","type":"upstream_error","code":50204}}
data:[DONE]
```

触发者：`temperature` / `top_p` / `reasoning_effort` 非法值等**所有
`upstream_error`**。

形态 B 是**最容易碰到的**——客户端只要带了非 1 的 `temperature`，Kimi 家族就拒收。

---

## 2. 三个真 bug 与一处误判

### Bug 1：形态 B 的错误被静默吞掉（最严重）

**证据**（隔离插件自己的 `fetch`，`stream: false`）：

```
[无event行的error] stream=false -> 200  signIn=kept
  {"id":"chatcmpl-...","object":"chat.completion",...,"choices":[
     {"index":0,"message":{"role":"assistant","content":""},"finish_reason":"stop"}],
   "usage":null}
```

上游说的是 `invalid temperature`，插件吐给调用方的是**一个 200、空内容、
`finish_reason: stop` 的「正常」回复**。经 magpie 网关同样复现：

```
[kimi-k2.8-preview temperature=0.7] stream=false -> HTTP 400  ← 插件自己的 fetch 拦不住，
                                                                是 magpie 后来从空回复里
                                                                反推出来的
```

等一下——这里要精确。上面 400 是 magpie 网关**自己**产生的（magpie 拿到空
completion 后判为失败）。**绕过 magpie、直接用插件 fetch**，得到的是干净的
200 空回复。也就是说：

- 经 magpie 的非流式请求，magpie 靠「空回复」启发式兜住了一半，但错误信息丢了
  （网关报的是它自己的话，不是 `invalid temperature`）。
- **任何宿主**的非流式请求，插件本身返回的都是 200 空回复。

`stream: true` 时，插件**把上游的错误帧原样转发**给调用方：

```
data: {"error":{"message":"invalid temperature: only 1 is allowed for this model",...}}
data: [DONE]
```

调用方拿到的是一个 200 的 `text/event-stream`，里面混着一条非标准的 error 帧。
能不能识别看客户端；无论识别与否，HTTP 层的故障切换与退避都不会触发。
流式经 magpie 的表现**没测过**（见 §6）。如果上游厂商把限流也按形态 B 透传，
现在同样拿不到 429。

**关于 `X-Magpie-Sign-In: kept`（评审更正）**：初稿说形态 B 被当成成功会「清掉
失效标记」。这一条**不成立**——能收到 `upstream_error`，说明 token 已经通过了
LobsterAI 的鉴权，报 `kept` 本身是对的。真正的损害只有「错误被吞」。

**改法**：保留 `event` 判断，再加上对 `data` 本身的判断：

```js
const { head, rest } = await first(sse(res.body))
if (head) {
  let v = null
  try { v = JSON.parse(head.data) } catch {}
  // 形态 A：event:error（data 不一定是 JSON）；形态 B：无 event 行，{error:{...}} 或 {error:"..."}
  if (head.event === "error" || (v?.error && !v?.choices)) {
    const { code, message } = errorOf(head.data)
    return errorResponse(statusFor(code, message), code, message || "LobsterAI 返回了一个错误")
  }
}
```

要点：

- **`head.event === "error"` 必须保留。** 初稿示例把它删了，`event:error` 后面跟的若
  不是 JSON，就会回归成漏判。
- 数据判定是「带 `error` 且没有 `choices`」，正常 chunk 不会被误伤。
- `errorOf` 补上 `{error:"字符串"}` 的情形（现在会取不到 message）。
- 可选：非流式本来就会把整条流读完，可在 `mergeChunks` 里把**流中途**出现的 error
  帧也转成错误响应。流式请求一旦开始转发就改不了状态码，不处理。

**验证**：隔离 fetch 复现形态 B（流式、非流式各一次）→ 均变为 400 且带原始
`message`；形态 A 行为不变。

### Bug 2（评审改判：不是 bug，不改）：能力头与 `reasoning_effort`

初稿的提议是：删掉 `X-LobsterAI-Client-Capabilities`，删掉 `lobsterai_options` 通道，
所有模型统一透传 `reasoning_effort`，号称「19 个模型都有 7 档」。评审结论是**不做**：

1. **修的不是 bug。** 现在插件两条路并行：有档位表的 8 个模型翻译成
   `lobsterai_options`（off/high/max 全部生效），没有档位表的 11 个原样透传
   `reasoning_effort`（带能力头时照样生效，见 §1.2）。能力头只让前 8 个忽略
   `reasoning_effort`，而插件对它们从不依赖这个字段。
2. **「7 档」大多是摆设。** 上游给这 8 个模型声明的就是三档；§1.2 的 7 档数据每档
   只跑一次、字节数不单调，只能证明「接受」，证明不了「有区别」。
3. **风险不小。** 等于放弃官方桌面端的协议、改押上游的兼容路径；能力头里还带着
   `kimi-k3-agentic-v1`，作用不明。初稿 §6 建议「保留版本头、只删能力头」来降低赌注，
   其实并没有降低——`kimi-k3-agentic-v1` 就在能力头里。
4. **初稿的分档会出事故。** 初稿把「删能力头」排在第一档（低风险、可单独发布）。
   若真单独发，`applyThinking` 对有档位表的模型**每个请求**都会写 `lobsterai_options`
   （没选档也用 `defaultLevel`），而没有能力头时带这个字段上游直接 400——
   deepseek、glm 共 8 个模型全部不可用，不只是「none 会 400」。

用户能感知的问题（11 个模型没档位可选）另有原因，**不动能力头也能修**，见 §3.1。

它唯一站得住的好处，是不再依赖 `index.mjs` 里那张内存档位表（进程刚启动、模型
列表还没拉成功时，有档位表的模型收到的档位会被忽略）——边缘情况，不值得为此换协议。

**重新考虑的条件**：上游废弃 `lobsterai_options` 或能力头。届时也只删
`thinking-level-control-v1`、保留 `kimi-k3-agentic-v1`，并先跑完 19 个模型 × 7 档。

### Bug 3：Kimi 家族采样参数契约覆盖不全

`lib/thinking.mjs` 的 `isKimiK3()` 是 `/^kimi-k3(?:$|[-.])/i`，只匹配
`kimi-k3` 与 `kimi-k3.1-pro`。但实测**整个 Kimi 家族**都拒收采样参数：

```
kimi-k3              temperature=0.7 → 400 invalid temperature: only 1 is allowed
kimi-k3.1-pro        temperature=0.7 → 400 同上
kimi-k2.8-preview    temperature=0.7 → 400 同上   ← 正则不匹配它！
kimi-k3.1-pro        top_p=0.5       → 400 invalid top_p: only 0.95 is allowed
kimi-k3.1-pro        presence_penalty=0.5 → 400 only 0 is allowed
```

`kimi-k2.8-preview` 是 19 个可用模型之一：客户端只要带了非 1 的 temperature
（或 top_p / penalty），一选它就 400。目录里可用的 Kimi 一共 3 个，全部实测拒收。

`applyKimiK3()` 现在把三件事绑在一起：删采样参数、强制 `reasoning_effort: "max"`、
给 assistant tool_call 补 `reasoning_content: ""`。改法分两步：

| 步骤 | 改什么 | 适用模型 | 批次 |
|---|---|---|---|
| ① | 「删采样参数」（`temperature`/`top_p`/`n`/两个 penalty）单独拆出 | 所有 `/^kimi-/i` | 第一批 |
| ② | 「强制 `max`」收窄到精确 `kimi-k3` | 仅 `kimi-k3` | 第二批，与 §3.1 同批 |

为什么 ② 不放第一批：`kimi-k3.1-pro` 现在在 magpie 里显示 `thinks, no levels`，
本来就选不了档位，强制 `max` 没有造成看得见的损失；等 §3.1 给它补上档位时再收窄，
否则收窄了也用不上。实测 `kimi-k3.1-pro` 的 `effort=none/low/max` 全部生效
（0B/20B/156B），所以届时**不应该**再被压成 `max`。

补 `reasoning_content` 保持现状（对 `kimi-k3*` 生效）；`kimi-k3.1-pro` 是否需要
**待验证**（见 §6）。删参数的最坏后果只是用服务端默认值，风险极低。

### Bug 4（评审新增）：多账号时桌面导入的账号会串号

magpie 0.1.2668 支持一个插件 provider 挂多个账号（plugin-host 源码里有
`accounts` / `maxAccounts`，账号身份取 `accountId`），用户本来就可能有多个有道账号。

`desktopToken()` 每次读的是桌面端**当前**登录的 token，`tokenOf()` 也不比对
`accountId`。单账号时这是优点（桌面端续期后插件自动跟上）；多账号时，桌面端一换
账号，原来那个账号就悄悄用上了另一个账号的 token。

例：A 从桌面端导入，B 用浏览器登录，之后桌面端切到 B：

- A 的卡片显示 B 的余额，走 A 的请求扣 B 的积分；
- 路由把同一份额度算成两份；
- 签到（§4.1）时 A 实际签的是 B，A 自己一直签不上。

有多个号的人手动领积分时常在桌面端来回切账号，这个场景不罕见。

**改法**：

- 桌面账号取 token 时，把桌面端当前的 `yid ?? String(id)` 与该账号存的 `accountId`
  比对；不一致就抛 `signIn: "expired"`，提示「LobsterAI 桌面端已切换到其它账号」，
  让 magpie 把这个账号标成需要重新登录。没存 `accountId` 的老账号跳过比对。
- 顺带：`desktopSignIn()` 存的 `uid` 是数字，而 magpie 只认字符串 uid（源码
  `uidOf`），现在等于没存，改成 `String(c.id)`。

改动约 5 行，第一批。

---

## 3. 两处能力浪费

### 3.1 11 个模型没有思考档位（补测后第二批）

当前 magpie 里 `lobster/*` 的档位（`magpie model spec` 实测）：

```
lobster/deepseek-flash       reasoning none,high,max
lobster/kimi-k3              reasoning low,high,max     ← 来自 models.dev；插件强制 max，选了也没用
lobster/qwen3.8-max          reasoning thinks, no levels
lobster/kimi-k3.1-pro        reasoning thinks, no levels
lobster/kimi-k2.8-preview    reasoning thinks, no levels
lobster/MiniMax-M3           reasoning thinks, no levels
```

`qwen3.8-max` 的上游实测（带能力头）：`effort=none` → 0B，`effort=max` → 156B。
**它明明支持，界面上却一档都选不了。**

**根因（评审更正）**：不是能力头，而是 `lib/models.mjs` 的
`hasThinking = supportsThinking && thinkingConfig.options 非空`——没有 `thinkingConfig`
的模型 `variants` 为空、`capabilities.reasoning` 为 false。

**改法**（只动 `lib/models.mjs`，能力头与 options 通道不动）：

- `capabilities.reasoning` 改用 `!!entry.supportsThinking`（不要写死 `true`）。
- 有 `thinkingConfig` 的 8 个：维持现状（`none/high/max` → `lobsterai_options`）。
- 没有 `thinkingConfig` 但 `supportsThinking` 的：按补测结果声明 magpie 阶梯里的档位，
  请求时 `reasoning_effort` 原样透传（`proxy.mjs` 现有逻辑已经这样做）。
- `kimi-k3` 不加 `none`（初稿说它「少 none」，与 Bug 3 的强制 `max` 矛盾）；同批把
  强制 `max` 收窄到精确 `kimi-k3`（Bug 3 ②）。

**前提：先补测**（§5「补测」）——11 个模型 × 7 档，看哪档会 400、`none` 是否真为 0，
再决定每个模型声明哪几档。本机可先用 `magpie model spec lobster/<模型> --reasoning …`
零代码试。改完需 `magpie plugin rm` + `add` 才刷新档位缓存。

### 3.2 输出上限 32000 → 131072（补测后第二批）

旧文档的理由是「接口不提供，实测 262144 通过、524288 报 500」。今天复核：

```
deepseek-flash max_tokens=32768   ok
deepseek-flash max_tokens=131072  ok
deepseek-flash max_tokens=262144  ok
deepseek-flash max_tokens=524288  500 服务器内部错误
glm-5.3       max_tokens=262144   400 max_tokens参数非法：限制数值范围[1,131072]
glm-5.3       max_tokens=131072   ok
kimi-k3 / qwen3.8-max / MiniMax-M3 / glm-5.2 / qwen3.7-max / kimi-k3.1-pro @131072  全 ok
```

`glm-5.3` 自己吐出了**确切上限**：`[1, 131072]`，而且超限是**直接 400**——上游不会
替你钳到上限以内。

**评审结论**：131072 只在 19 个里的 **8 个**上验证过（上面列出的 deepseek-flash、
glm-5.3、kimi-k3、qwen3.8-max、MiniMax-M3、glm-5.2、qwen3.7-max、kimi-k3.1-pro）。

- 收益：只在 agent 真按 `max_output_tokens` 发 `max_tokens`、且单次回复超过 32k 时
  体现，多数回合碰不到。
- 风险：未测的模型里只要有一个真实上限低于 131072，它就会**每次请求都 400**，
  比偶尔截断严重得多。

**改法**：先把剩余 11 个模型（deepseek-v4-pro / deepseek-v4-flash /
deepseek-v4-flash-vision-exp / glm-5.3-flash / glm-5.3-flashx / qwen3.8-flash /
qwen3.8-omni-flash / qwen3.7-plus / MiniMax-M3.1-Flash / doubao-seed-2-1-pro-260915 /
kimi-k2.8-preview）用极短 prompt + `max_tokens=131072` 各打一次。全过就把
`DEFAULT_OUTPUT` 从 `32000` 改成 `131072`；有不过的按模型给值。本机可先
`magpie model output 'lobster/*' 128k` 试用。

`kimi-k3` 在 magpie 里显示 131072 是 `models.dev` 覆盖了插件的值，只说明两处数据
来源不同，不能当作 bug 的证据。

---

## 4. 官方能力：两项要接、两项不接

以下对照 magpie `0.1.2668` 的官方文档（`docs/subsystems/provider-plugins.md`），
并在本机 magpie.exe 内嵌的 plugin-host / 界面源码里核对过实现。

### 4.1 `auth.checkin`：每日积分自动签到（第三批）

**上游实测**（今天）：

```
GET /api/client-activities/slot?placement=desktop_sidebar&clientVersion=2026.10.30&... 
→ slotState: available, activityCode: daily-check-in-evergreen-prod-20260814

GET /api/client-activities/<code>/context?configRevision=1
→ state: {totalDays:36500, claimedDays:42, claimedToday:true, rewardCredits:100, claimedCredits:4200}

POST /api/client-activities/<code>/actions/check_in
→ 200 {"code":51104,"message":"活动奖励已领取"}     ← 已领，幂等
```

关键事实：

- 签到是**每天 100 积分**，每批 30 天后到期（`creditItems` 里 22 批「每日登录奖励」
  的到期日逐日排开，最晚一批 2026-12-02）。`claimedDays: 42` 是活动开始以来的累计天数。
- POST **幂等**：今天已领时返回 `51104`，重复发同一个 `idempotencyKey`
  也是 `51104`，不会重复发奖。
- `context.actions` 在已领时是 `[]`，**未领时才有 `check_in`**——这就是
  「今天能不能领」的权威判据。
- 客户端版本号从 `https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/prod/update`
  取，今天返回 `2026.10.30`。旧技能文档记的 `platform=win32` 在 macOS 上也
  有效，这条仍然成立。

**为什么值得做**：签到入口在桌面端侧栏（`placement=desktop_sidebar`），只用 magpie、
不开桌面端的用户基本领不到每天的 100 点，自动签到是他们唯一的领法；开关、每日调度、
结果展示 magpie 都已做好，插件只实现一个函数。

**magpie 契约**（plugin-host 源码实证，`auth.checkin(` 处的注释与校验代码）：

- 调用：`auth.checkin(getAuth, provider)`
- 返回：`{ outcome, credit?, streak?, message?, until? }`
- `outcome` 只能是 `claimed` / `done` / `ineligible` / `inactive` / `captcha` / `failed`，
  其它值会被改写成 `failed` 并带上 `the plugin answered …`
- 用户打开开关后，magpie **按北京时间每天、每个账号**调用一次；失败后当天稍后
  （或到 `until`）再试；hook 抛异常按 `failed` 算
- 初稿说的「抛异常走 1 分钟、返回 failed 走 30 分钟」在源码里没找到，不作依据；
  做法不变：统一返回 outcome + message，不抛

**现有资产与移植边界**：`C:\Users\admin\WorkBuddy\技术方案调研\lobsterai-checkin\scripts\lobsterai-claim.mjs`
可以复用活动那一半（`resolveVersion` / `getActivity` / `getContext` / check_in 请求体 /
领后复核，约 100 行），但**不能整份移植**：

- 不搬取 token 逻辑（`loadClientCreds` / `loadStore` / `saveStore` / `refreshTokens` /
  `resolveToken`）：脚本在 access token 过期时会拿桌面端的 refreshToken 调
  `/api/auth/refresh`，还会把 token 缓存到 `data/tokens.json`——这正是插件明确不碰的
  （§7）。token 一律走插件现有的 `tokenOf(auth)`。
- 不搬日志文件：结果由 magpie 展示。

**outcome 映射**：

| 情况 | outcome |
|---|---|
| 今天已领（`state.claimedToday` 为真，或 check_in 返回 `51104`） | `done` |
| 有 `check_in` 动作 → POST → 复核 `claimedToday` 变真 | `claimed`（`credit` 取返回值，缺省用 `rewardCredits`） |
| POST 成功但复核状态没变 | `failed`（「领取后复核未通过」） |
| 活动在，但没有 `check_in` 动作且今天没领 | `ineligible` |
| slot 不是 `available`，版本号是现取的 | `inactive` |
| slot 不是 `available`，版本号没取到、用了兜底值 | `failed`（提示可能是版本问题，让 magpie 当天重试） |
| 登录失效 / 网络错误 / 其它 code | `failed`，带原始 message |

其余要点：

- **不填 `streak`**：`claimedDays` 是累计天数，不是连签，magpie 会把 `streak` 显示成
  「连续 N 天」；接口里拿不到连签天数。
- 领取后**必须复核**（再读一次 context），接口 200 不等于到账。这条脚本已经踩过。
- 请求头沿用脚本实测可用的 `Accept: application/json`、`User-Agent: LobsterAI/<版本>`；
  `platform=win32` 保持（实测 macOS 也认）。
- 不返回 `until`：magpie 本来就按北京时间切日。
- **多账号照常签**：magpie 给每个已登录账号各签一次，这正是多账号用户要的；README 如实
  写明「开关打开后，每个已登录的 LobsterAI 账号每天各签一次」。
- 这是**写操作**。开关默认关（magpie 的插件签到开关独立、默认不开），由用户在
  Settings 里打开。
- 依赖 Bug 4：不修串号，桌面导入的账号可能签到别的账号上。

### 4.2 `auth.options`：让用户能开「只用免费模型」（暂缓）

官方支持插件声明自己的开关：

```js
auth.options = [{ key: "free_only", label: "只用限时免费模型", default: false, filtersModels: true }]
```

上游目录里**已经有** `limitedFree` / `limitedFreeActive` / `limitedFreeStartAt`
/ `limitedFreeEndAt` 四个字段，今天全部是 `false`（这个账号没有限免活动），
但字段存在说明**随时可能投放**。

**改法**（分两步，先易后难）：

1. **先加 `free_only` 开关但暂不接数据**——只声明 option，`filtersModels: true`，
   让 UI 上先有这个东西。⚠️ 但这样开关是**假的**，不推荐。
2. **接 `limitedFreeActive`**：开关打开时，模型列表只保留
   `limitedFreeActive === true` 的；请求非免费模型时**插件自己返回 404
   `model_not_found`**（绝不发给上游，避免烧点数），这样 magpie 只 rest 那个
   模型、不 rest 账号。

**建议**：等真的出现 `limitedFreeActive: true` 的模型再做，否则是空开关。
**列为「待验证」**，不算进本次必做。

### 4.3 `balance` 窗口：把「点数」显示成钱包（第三批）

现在 `lib/usage.mjs` 把 `totalCreditsRemaining` 塞进 `out.balance`（一个
**字符串** `"2806.2 点数"`），magpie 只能当文本显示，路由读不到。

**magpie 支持情况（plugin-host / 界面源码实证）**：

- 用量窗口字段里有 `balance`、`unit`、`runsOutAt`、`runsOut`、`aside`。
- 钱包窗口显示为「N 点数 left · M 点数 expire …」（`runsOutText`）。
- `runsOutText` 的注释：「Smart routing spends such an account first」——有积分快到期
  的账号，Smart 路由会优先用。

**为什么值得做**：积分是每天 100 点、各自 30 天到期的批次，先到期先扣（两次快照
之间，最早那批的 69.64 点被扣光，`until` 从 11-11 变成 11-12）。截至今天上午的快照，
最近 22 天领的批次几乎原封未动——照这个用量，后面每一批到期都会白白作废。接上之后
卡片能看到哪天过期多少；lobster 在 Smart 路由组里时会被优先使用。

**改法**：

```js
out.windows.push({
  name: "点数", balance: round(left), unit: "点数",
  runsOutAt: earliest.expiresAt,             // creditItems 里最早到期、仍有剩余的那批
  runsOut: round(earliest.creditsRemaining),
})
```

- 替换掉现在的 `balance` 字符串，避免重复显示。
- 免费额度已过期（`freeCreditsExpired`）时不再推「免费额度」窗口——它 8 月就过期了
  （设计期实测 `freeCreditsExpiresAt: 2026-08-21`），现在仍显示「6% used」，看起来像一笔有效额度。
- `expiresAt` 原始值不带时区（如 `2026-11-11T09:11:24`），交给 magpie 前要先确定时区，
  见 §6。
- 纯展示层改动，风险低。

### 4.4 `keyless` + `single`：不做

官方文档 `Fixed-credential sign-in`：

> An `auth.methods` API method may declare magpie-only `keyless: true` when its
> `authorize` function supplies the credential.
> `auth.single: true` declares one provider identity: signing in again reuses
> its account slot and the account action says Sign in again.

- `keyless` 只对 `type: "api"` 有效，当前没有 api 方法，**不适用**。
- `auth.single` **不做**（评审修订）：初稿以为 LobsterAI / magpie 都是单账号，但
  magpie 0.1.2668 支持一个插件 provider 挂多个账号（plugin-host 源码里有
  `accounts` / `maxAccounts`），`single: true` 会把它收成一个身份。用户本来就可能有
  多个有道账号；它的收益只是按钮文案变成「Sign in again」，不值得为此关掉多账号。
- 顺带：README 的「Several accounts at once — magpie keeps one sign-in per provider」
  （中文版「同时使用多个账号。magpie 每个 provider 只保留一份登录」）已过时，改成
  支持多账号，并说明 Bug 4 修复后的行为（桌面端换账号时原账号会被标成需重新登录）。

---

## 5. 改动清单（评审后，按批次）

每一批都能单独发布、单独回滚。版本号等确认后再升。默认不新增测试用例（需要时再补），
只同步改断言旧行为的已有测试。

### 第一批：修 bug（改动小，风险低）

| # | 文件 | 改什么 | 验证 |
|---|---|---|---|
| 1.1 | `lib/proxy.mjs` | 错误首帧判定：保留 `event:error`，再加「带 `error` 且无 `choices`」；`errorOf` 支持字符串 `error`（Bug 1） | 隔离 fetch 复现形态 B（流式 / 非流式）→ 400 + 原始 message；形态 A 不变 |
| 1.2 | `lib/thinking.mjs`、`lib/proxy.mjs` | 「删采样参数」拆出，对 `/^kimi-/i` 生效；强制 `max` 暂不动（Bug 3 ①） | `kimi-k2.8-preview` 带 temperature 不再 400 |
| 1.3 | `index.mjs`、`lib/auth-import.mjs` | 桌面账号取 token 时比对 `accountId`，不一致抛 `signIn: "expired"`；`uid` 存成字符串（Bug 4） | 桌面端切到另一账号后，原账号被标为需重新登录 |

### 补测（第二批的前提）

一个探测脚本，带现有请求头（版本头 + 能力头）跑完：

- 11 个无档位表模型 × 7 档（`none` … `max`）：记录是否 400、`none` 是否 0 字节
- 11 个未测模型 × `max_tokens=131072`：记录是否 400

每次都是极短 prompt，成本可忽略。结果写回本文 §3。

### 第二批：档位 + 输出上限（按补测结果定）

| # | 文件 | 改什么 |
|---|---|---|
| 2.1 | `lib/models.mjs` | `capabilities.reasoning` 改用 `!!entry.supportsThinking` |
| 2.2 | `lib/models.mjs` | 无档位表但支持思考的模型声明补测通过的档位；有档位表的 8 个不动 |
| 2.3 | `lib/thinking.mjs` | 强制 `max` 收窄到精确 `kimi-k3`（Bug 3 ②） |
| 2.4 | `lib/constants.mjs` / `lib/models.mjs` | 输出上限：全过则 `DEFAULT_OUTPUT = 131072`，否则按模型给值 |

⚠️ 档位有缓存，改完需 `magpie plugin rm` + `add` 才刷新（旧记忆里记过这个坑，实测仍然成立）。

### 第三批：积分（钱包窗口 + 自动签到）

| # | 文件 | 改什么 |
|---|---|---|
| 3.1 | `lib/usage.mjs` | `balance` 字符串 → `{name, balance, unit, runsOutAt, runsOut}` 窗口；免费额度过期时不推该窗口 |
| 3.2 | 新 `lib/checkin.mjs` | 移植脚本的活动部分（版本、slot、context、check_in、复核），不含取 token / 续期 / 日志 |
| 3.3 | `index.mjs` | `auth.checkin(getAuth, provider)`，按 §4.1 的映射返回 outcome |
| 3.4 | README（中英文） | 说明签到开关（默认关，每个已登录账号每天各签一次）；更新多账号说明 |

验证：打开开关后，在 Settings 看到签到结果，`magpie quota lobster` 同时看到进账与到期。

### 不做 / 暂缓

| 项 | 结论 | 理由 |
|---|---|---|
| 删能力头 + 删 `lobsterai_options` 通道（初稿 1.2、2.1–2.4） | 不做 | 不是 bug，见 Bug 2 |
| `auth.single` | 不做 | 会关掉多账号，见 §4.4 |
| `limitedFree` 接 `free_only` 开关 | 暂缓 | 今天没有限免模型，开关是空的 |
| `busy` 接 `input.magpie.load()` | 暂缓 | 需要插件自己起定时器，收益不确定 |
| `supportsToolCalling` / `agenticReady` 接 `tool_call` | 暂缓 | 今天只有 `kimi-k3` 为 true，其余 null，无从接起 |

---

## 6. 待验证（不要照做）

这些我**没能实测收敛**，写下来是防止下次凭印象改：

1. **`kimi-k3.1-pro` 是否需要补 `reasoning_content: ""`**。旧文档说这是
   `kimiK3StreamWrapper` 的契约。今天没构造出「assistant tool_call 缺
   reasoning_content」的多轮场景。**改动时先保持现状**（补上不报错），别急着删。
2. **11 个无档位表模型各认哪几档、`max_tokens=131072` 是否都过**。第二批的前提，
   见 §5「补测」。
3. **`kimi-k3-agentic-v1` 到底管什么**。实测带与不带工具调用都是 8 个
   call，看不出差别。能力头不动，这条暂时不用验证；只有将来重新考虑 Bug 2 时
   才要先搞清楚。
4. **`limitedFreeActive` 何时为真**。今天全 `false`，没法测开关逻辑。
5. **`costMultiplier` 分时计价**。旧文档说 `deepseek-flash` 高峰 0.1 / 空闲
   0.05。今天取到 0.1（北京时间 10:38，属于高峰 09:00-12:00），**吻合**。
   但空闲时段没验证过，`rate` 静态快照过期这条老风险仍在。
6. **`creditItems[].expiresAt` 的时区**。原始值不带时区（如 `2026-11-11T09:11:24`），
   本机按本地时间（北京）解释正好对上；magpie 若跑在 UTC 的容器 / NAS 里会差 8 小时，
   现有的 `until` 也受影响。大概率是北京时间，实现 §4.3 时用签到 context 的
   `state.timezone` 核对一次，再决定是否补 `+08:00`。
7. **形态 B 的流式请求经 magpie 时怎么表现**。只测了非流式经网关、流式隔离 fetch。
8. **签到触发验证码 / 风控时上游返回什么**。没见过，先按 `failed` + 原始 message 处理；
   出现可识别的信号再映射成 `captcha`。

---

## 7. 不打算改的

| 项 | 理由 |
|---|---|
| 浏览器登录路径 | 今天没测（用户已重新登录桌面端），但代码没问题，无证据要改 |
| 不调用 `/api/auth/refresh` | 旧结论仍然成立：可能消耗真实 refresh token，把桌面端踢下线。**保持不碰**（移植签到时同样不搬脚本里的续期逻辑） |
| 桌面端「不存 token」策略 | 设计上是对的（`expires: 0` 结构性不续期），实测有效；只补 Bug 4 的身份比对 |
| 能力头 + `lobsterai_options` 通道 | 有档位表的模型 3 档全部生效；删掉是押上游的兼容路径，见 Bug 2 |
| `auth.single` | 会关掉多账号，见 §4.4 |
| `magpie.maxConcurrency: 8` | 没测到限流，无从判断高低 |
| `lib/sse.mjs` 解析器 | 79 个测试覆盖，跨块边界都对，不动 |
| `lib/assemble.mjs` 重组逻辑 | 非流式重组的产物经网关验证正确，不动 |

---

## 8. 附：本次实测的原始数据出处

全部可复现，脚本已删（在 `tmp/` 下，`.gitignore` 已排除），但方法记在这里：

- 目录：`GET /api/models/available?firstKeyfrom=official&latestKeyfrom=official`
  → 20 条，存 `%TEMP%\lob-models.json`
- 用量：`GET /api/user/quota` + `GET /api/user/profile-summary`
- 签到：`GET /api/client-activities/slot` → `.../context` → `POST .../actions/check_in`
- 版本：`GET https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/prod/update`
- 档位矩阵：直连 `/api/proxy/v1/chat/completions`，按「3 种请求头 × 3 种发法」
  跑，统计 `delta.reasoning_content` 字节数与 `usage.completion_tokens_details.reasoning_tokens`
- 端到端：`http://127.0.0.1:3425/v1/chat/completions`，`Authorization: Bearer magpie-probe`
- 隔离插件：直接 `import { makeFetch } from "lib/proxy.mjs"`，注入假 `getAuth`，
  绕过 magpie 观察插件自身行为
- 积分批次：`%TEMP%\lob-profile.json`（`creditItems` 23 条）
- 评审复核：`magpie model spec lobster/<模型>`（档位现状）、`magpie quota lobster --json`（用量现状）
- magpie 契约：magpie.exe 内嵌的 plugin-host 与界面源码，按字符串 `auth.checkin(`、
  `runsOutText`、`function whoOf`、`function uidOf` 定位
