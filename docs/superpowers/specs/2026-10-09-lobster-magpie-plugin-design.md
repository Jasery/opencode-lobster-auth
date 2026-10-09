# LobsterAI provider 插件设计

- 日期：2026-10-09
- 状态：已确认，待实现
- 目标仓库：`D:\git\magpie-lobster`
- 包名：`opencode-lobster-auth`
- provider id：`lobster`

## 1. 背景与目标

magpie 的插件机制等价于 OpenCode v1 的 provider 插件：一个 npm 包 / git 仓库 / 本地文件夹导出一个 async 函数，返回 `{ config, auth, provider }` 钩子，由 magpie 加载进同一个 Bun 进程。

本插件为 magpie 增加 provider `lobster`，使 agent 可以直接使用有道 LobsterAI（NetEase Youdao LobsterAI，Electron 桌面 agent，v2026.9.23，基于 OpenClaw）账号下的模型，约 30 个：`deepseek-v4-pro`、`deepseek-flash`、`glm-5.3`、`kimi-k3`、`qwen3.8-max`、`MiniMax-M3`、`doubao-seed-2-1-pro-260915` 等。

### 范围

做：

- 两条登录路径（浏览器登录、本机 LobsterAI 导入）
- 模型发现（`/api/models/available`）
- 推理代理（chat completions，含工具调用、思考内容、流式）
- 用量显示（积分、套餐）

不做：

- 中间件（magpie 中间件不能新增 provider，无法达成目标）
- 复用 LobsterAI 本机的 `127.0.0.1:63667/v1` 代理（该代理的 `apiKey` 来自 `${LOBSTER_PROXY_TOKEN}` 环境变量，每次启动随机，外部进程拿不到；且要求桌面端常驻）
- npm / 社区注册表发布（本阶段只交付可 `magpie plugin add` 的本地文件夹插件，但代码布局遵循 npm 包约定，后续发布无需重构）

## 2. 上游接口面（已实测确认）

生产 base：`https://lobsterai-server.youdao.com`
登录页：`https://lobsterai.youdao.com/portal#/login`
鉴权：`Authorization: Bearer <accessToken>`（JWT，有效期约 30 天）
可选头：`X-LobsterAI-Client-Version: <appVersion>`、`X-LobsterAI-Client-Capabilities: kimi-k3-agentic-v1,thinking-level-control-v1`

| 端点 | 用途 |
| --- | --- |
| `POST /api/auth/exchange` | `{authCode}` → `{accessToken, refreshToken, user, quota}` |
| `POST /api/auth/refresh` | 续期（**本阶段不主动调用**，见 §4） |
| `POST /api/auth/logout` | 服务端登出 |
| `GET /api/models/available` | 模型目录（含能力、思考档位、计价倍率） |
| `GET /api/user/quota` | 免费额度与订阅状态 |
| `GET /api/user/profile-summary` | 昵称、头像、剩余积分明细 |
| `POST /api/proxy/v1/chat/completions` | 推理 |
| `GET /api/proxy/v1/models` | 不存在（404） |

模型条目字段：`modelId`、`modelName`、`provider:"LobsterAI"`、`apiFormat:"openai"`、`supportsImage`、`supportsThinking`、`thinkingConfig{options[{level,openclawLevel}],defaultLevel}`、`requestCapabilities:["lobsterai-options-v1"]`、`contextWindow`（多为 `1000000`）、`costMultiplier`、`description`、`accessible`、`restrictionHint`。

### 两种错误形态

`/api/*` 系列端点（`exchange`、`models/available`、`quota`、`profile-summary`）统一用 `{code, message, data}` 信封，且**业务错误也返回 HTTP 200**。实测：

```
POST /api/auth/exchange  {"authCode":"无效码"}
→ HTTP 200  {"code":40102,"message":"无效或已过期的授权码","data":null}
```

只有 `/api/proxy/v1/chat/completions` 例外：它把错误塞进 SSE 的 `event:error`（见 §6 坑 2），而登录过期是真 HTTP 401。

因此插件要处理**两种**错误形态：

- JSON 信封 —— 判断 `code !== 0`（用于 exchange、模型列表、用量）。
- SSE 事件 —— 用于推理端点。

### 客户端标识头可选

实测 `GET /api/models/available` 不带 `X-LobsterAI-Client-Version` / `X-LobsterAI-Client-Capabilities` 也正常返回 29 个模型。插件仍会带上这两个头，因为它们可能影响上游的特性开关（如 `kimi-k3-agentic-v1`）。

## 3. 架构与文件布局

```
D:\git\magpie-lobster\
  package.json            name=opencode-lobster-auth, type=module, main=index.mjs
                          magpie:{ icon, maxConcurrency: 8 }
  index.mjs               只做钩子装配；导出 _internal 供测试
  lib/
    constants.mjs         provider id / base URL / 客户端头 / 静态兜底模型表
    jwt.mjs               解析 JWT，取 exp、yid
    sse.mjs               SSE 解析与重组
    proxy.mjs             请求管线（§6 三个坑）
    models.mjs            /api/models/available → magpie 模型表
    usage.mjs             /api/user/quota + profile-summary → usage
    auth-login.mjs        浏览器登录（loopback 回调）
    auth-import.mjs       读本机 LobsterAI sqlite
  test/*.test.mjs         bun test
  README.md
```

零运行时依赖。宿主是 Bun，`bun:sqlite`、`node:http`、`node:crypto`、`node:os`、`node:path` 均内置。

`package.json` 关键字段：

```json
{
  "name": "opencode-lobster-auth",
  "type": "module",
  "main": "./index.mjs",
  "files": ["index.mjs", "lib", "README.md"],
  "keywords": ["opencode", "opencode-plugin", "lobster", "lobsterai", "magpie"],
  "magpie": { "maxConcurrency": 8, "icon": "https://lobsterai.youdao.com/portal/lobsterai-logo.png" }
}
```

图标地址已确认可访问（HTTP 200，`image/png`，252275 字节）。

## 4. 鉴权

两条路径，用同一个 `accountId`（`user.yid`），因此先用 B 再用 A 登录同一账号时，A 会原地替换 B。

| | 方式 | `access`/`refresh` | `expires` | `source` | magpie 是否续期 |
| --- | --- | --- | --- | --- | --- |
| A | 浏览器登录 | 真 token | 真到期时间 | — | 会，走 `auth.refresh` |
| B | 从本机 LobsterAI 导入 | 都是 `""` | `0` | `"desktop"` | 不会 |

两条路径**都是 `oauth` 账号**，靠 `expires` 与 `source` 区分续期行为。

**为什么 B 不能存成 `{type:"api"}`**（早期设计的错误）：`api` 类型会让 magpie 强制从 stdin 读一个 key（实测 `magpie: no key on stdin: EOF`），而这条路不需要用户输入任何东西。加 `prompts` 也不能绕过——它要求真实 TTY。

**为什么 B 不保存 token**：抄一份 `refreshToken` 会让桌面端和插件共用同一个凭据，谁先续期谁就把对方踢下线。B 因此一个字节的凭据都不存，只在每次请求时现读桌面端的库。

B 不续期是结构性保证：magpie 只对 `expires` 非零的 OAuth 账号做续期（实测 `expires: 0` 的 `oauth` 账号同样不会被续期），因此桌面端会话不会被搅动。现读则保证桌面端续期后插件自动跟上。

### 4.1 路径 A：浏览器登录

沿用 LobsterAI 桌面端自己的通道。其 portal 代码（`auth-BfLW0v77.js`）中的回调构造逻辑允许把授权码回调到任意 `http://127.0.0.1:<port>/auth/callback`：

```js
function K(t, e = {}) {
  if (G(e.redirectUri)) {                 // G: http + 127.0.0.1 + /auth/callback + 有端口
    const n = new URL(e.redirectUri);
    if (P(e.returnTo)) n.searchParams.set("return_to", e.returnTo);
    n.searchParams.set("code", t);
    if (e.state) n.searchParams.set("state", e.state);
    return n.toString();
  }
  return `lobsterai://auth/callback?code=${encodeURIComponent(t)}`;
}
```

流程：

1. `state = base64url(randomBytes(24))`。
2. 起本地 HTTP 服务：`127.0.0.1:0`，路径 `/auth/callback`。
3. 打开浏览器到登录页，参数追加到 **hash query**（不是 URL query）：
   - `source=electron`
   - `redirect_uri = http://127.0.0.1:<port>/auth/callback?return_to=<encodeURIComponent(returnTo)>`
   - `state`
   - 其中 `returnTo = https://lobsterai.youdao.com/portal#/login?source=electron&electronLogin=success`
   - 即 `https://lobsterai.youdao.com/portal#/login?source=electron&redirect_uri=...&state=...`
4. portal 登录成功后重定向到本地回调，携带 `code` 与 `state`；校验 `state`，5 分钟超时。
5. `POST /api/auth/exchange`，body：`{authCode, firstKeyfrom:"official", latestKeyfrom:"official", uuid, userId, version}`。
6. 返回 `{type:"success", refresh, access, expires, accountId}`；`expires` 由 JWT `exp` 推导。

作为 `auth.methods` 中的 `{type:"oauth"}` 方法，`authorize()` 返回 `{url, instructions, method:"auto", callback}`，由 magpie 负责打开 `url`，`callback()` 内部等待本地回调完成交换。

`source=electron` 是必要的：portal 的 `Re()` 只在 `source === "electron"` 时才会带上 `redirect_uri`。

### 4.2 路径 B：从本机 LobsterAI 导入

只读打开 `%APPDATA%\LobsterAI\lobsterai.sqlite`，读 `kv` 表：

| key | 值 |
| --- | --- |
| `auth_tokens` | `{"accessToken":"...","refreshToken":"..."}`（明文 JWT） |
| `auth_user` | `{"yid","id","nickname"}` |

表结构已确认：`CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)`。

实现要点：

- `bun:sqlite` 以只读模式打开，绝不写入。
- 数据库可能被运行中的桌面端占用；打开失败或读取失败时降级为清晰的错误提示，引导用户改用浏览器登录。
- 按平台解析路径：Windows `%APPDATA%\LobsterAI`、macOS `~/Library/Application Support/LobsterAI`、Linux `~/.config/LobsterAI`。
- 解析 JWT 取 `yid` 与 `sub`，作为 `accountId`（`user.yid ?? String(user.id)`）与 `uid`。

作为 `auth.methods` 中的 `{type:"oauth"}` 方法，`authorize()` 返回 `{url:"", instructions, method:"auto", callback}` —— `url` 为空则 magpie 不打开任何页面、不需要任何输入，`callback()` 返回：

```js
const account = { type:"success", refresh:"", access:"", expires:0, source:"desktop", accountId, uid }
```

`desktopToken(env)` 每次调用现读 sqlite 并返回当前 `accessToken`；读不到时抛 `{signIn:"expired"}`，让 magpie 给账号打上失效标记并提示重新登录。这与社区插件 `@magpie-community/opencode-workbuddy-auth` 的 `desktopSignIn`/`current` 模式一致。

### 4.3 续期策略

`auth.refresh` 只服务于路径 A 产生的账号。本阶段**不主动验证** `/api/auth/refresh` 的轮换行为：调用它会消耗/轮换用户真实的 refreshToken，有把用户从桌面端挤下线的风险。除非用户明确批准，否则不对该端点做探测性调用。

`refreshLead` 取一个保守值（默认 `6h`），让 magpie 在过期前续期。

magpie 的官方文档确认了本策略所依赖的机制：

> OAuth 账号的 `expires` 距现在不到 `refreshLead` 时，在这个账号的 loader、`provider.models`、`auth.usage` 或请求之前运行。**`expires` 为 0 或没有的账号不会续期。**

这正是路径 B「结构性不续期」的依据：把它存成 `{type:"oauth", access:"", refresh:"", expires:0, source:"desktop"}`，`expires` 为 0，magpie 不会对它调用 `auth.refresh`，桌面端的会话因此不会被搅动。而 `auth.refresh` 的实现只需处理路径 A 的账号（并额外用 `auth.source !== "desktop"` 做一道防御）。

## 5. 模型与用量

### 5.1 模型发现

`provider.models(provider, {auth})` 请求 `/api/models/available?firstKeyfrom=official&latestKeyfrom=official`，映射：

| LobsterAI | magpie |
| --- | --- |
| `modelId` / `modelName` | `id` / `name` |
| `contextWindow` | `limit.context`；`limit.output` 用保守默认 32000（接口未提供该字段，见 §8） |
| `supportsThinking` | `reasoning` |
| —（实测支持工具调用） | `tool_call: true` |
| `supportsImage` | `modalities.input` 追加 `image` |
| `costMultiplier` | `rate`（如 `deepseek-flash` 0.1、`deepseek-v4-pro` 0.52） |
| `thinkingConfig.options` | `variants`（见下） |

`accessible === false` 的模型跳过。拉取失败时返回 `provider.models`（magpie 会保留上一份列表）；401 抛出 `{signIn:"expired"}` 标记账号需要重新登录。

`config` 钩子同时声明一份静态兜底模型表（`lib/constants.mjs`），供未登录状态显示。

#### variants：只有键名有用，而且必须是 magpie 阶梯里的名字

原先从社区插件推断的「值对象会被合并进请求体」是**错的**。用一次性探针插件把 `loader.fetch` 收到的 `init.body` 落盘后，实际语义是：

- **值对象永远不会到达插件。** magpie 的 plugin-host 汇总模型时写的是 `Object.keys(m.variants ?? {})`，落盘（`plugin-providers.json`）也是 `"variants":["none","high","max"]` 这样的名字数组。Go 侧从一开始就没有过值对象，所以**不存在「把值合并进请求体」这回事** —— qoder 等社区插件的值对象同样到不了。
- **键名才是通道。** magpie 维护一条自己的档位阶梯（`none/minimal/low/medium/high/xhigh/max`），把入参 `reasoning_effort` 映射到「模型声明过的那个档位名」，再以 `reasoning_effort: <该名字>` 放进交给插件的 body。阶梯外的入参（`off` / `disabled` / `enabled` / `adaptive` / 空串）被直接丢弃。自定义字段一律不进 body；`model`/`messages`/`stream`/`temperature`/`max_tokens` 等标准字段保留。

实测映射（探针模型声明 `none/high/max`）：`none`→`none`，`minimal`/`low`/`medium`/`high`→`high`，`xhigh`/`max`→`max`。

**推论：档位名必须落在 magpie 的阶梯里。** LobsterAI 管最低档叫 `off`，这个名字不在阶梯里，于是那一档永远选不中 —— 声明 `off/high/max` 时发 `none` 会被钳到 `high`（这正是修复前的行为）。因此对外用 `none`，写给上游时再换回来：

```js
variants: Object.fromEntries(
  profile.options.map((o) => [o.level === "off" ? "none" : o.level, { lobsterai_thinking: o.level }])
)
```

`lib/proxy.mjs` 读取 `reasoning_effort`（以及 `reasoningEffort` / `thinking.level` / 插件自己的标记），把 `none` 换回 `off`，再按 §6 坑 3 写入 `lobsterai_options`。**只有翻译成功时才删掉 `reasoning_effort`** —— 上游自己就认这个字段，没翻译成功时删掉等于白扔一个本来能用的控制。

### 5.2 用量

`auth.usage` 合并两个端点：

- `plan` ← `quota.planName`（实测「免费」）
- `user` ← `profile.nickname`
- `balance` ← `profile.totalCreditsRemaining`（实测 1399.98）
- 免费额度窗口 ← `quota.freeCreditsUsed` / `quota.freeCreditsTotal`
- `until` ← `profile.creditItems` 中最早的 `expiresAt`

`costMultiplier` 是分时计价，静态值会过期，因此以线上拉取为准。

## 6. 请求管线

`loader` 返回 `{baseURL: "https://lobsterai-server.youdao.com/api/proxy/v1", apiKey, headers, fetch}`。模型 `npm` 用 `@ai-sdk/openai-compatible`。

`apiKey` 只用于让 magpie 认为账号「已登录」；真正的 token 由注入的 `tokenOf(auth)` 在**每次请求时**现取（路径 B 尤其需要，因为它的 `access` 是空的），`makeFetch` 因此不自己写死「oauth 读 `access`、api 读 `key`」。

职责划分：

- `headers`：注入客户端标识头（`X-LobsterAI-Client-Version`、`X-LobsterAI-Client-Capabilities`），对每个请求生效。
- `fetch`：`lib/proxy.mjs` 的请求管线，负责鉴权头、请求体改写（§6 坑 3）与响应改写（坑 1、坑 2）。

三个必须处理的坑，全部实测确认：

### 坑 1：上游永远返回 SSE

即使请求体写 `stream:false`，回包仍是 `Content-Type: text/event-stream`。

处理：

- 调用方要流式 → 透传。
- 调用方不要流式 → 把 SSE 聚合成单个 `chat.completion` JSON：`content` 拼接、`reasoning_content` 拼接、分片 `tool_calls` 按 `index` 合并，补 `usage` 与 `finish_reason`。
- 重组后删除 `content-length`。

### 坑 2：错误伪装成 HTTP 200

上游把错误放进 SSE：`event:error` + `data:{"type":"error","error":{...,"code":40300}}`。原样透传会导致 magpie 永远不会故障切换。

处理：先窥探流首段，若为 `event:error` 则转成真正的非 2xx JSON 响应，响应体保留上游的 `{code, message}`，状态码按 `code` 映射：

| 上游 `code` | HTTP 状态 | 理由 |
| --- | --- | --- |
| `40100` | 401 | 登录过期，并带 `X-Magpie-Sign-In: expired` 标记账号 |
| `40300`（如「不支持的模型」） | 403 | 触发换模型或换账号 |
| `message` 命中限流关键词（限流 / 频率 / 过快 / rate） | 429 | 触发退避 |
| 其余 | 400 | 保守归类，仍会触发故障切换 |

`40100` 与 `40300` 是实测观察到的；限流分支按 `message` 关键词判断，因为尚未观察到真实的限流响应，具体 `code` 待实测收敛（见 §8）。

若为正常数据，把已读取的前缀拼回，继续流式转发。只有真实 401 本来就是 HTTP 401（响应体为 `{"code":40100,"message":"登录已过期，请重新登录"}`），直通即可。

### 坑 3：思考档位是私有字段

上游认的是 `lobsterai_options`，不是 `reasoning_effort`：

```json
{ "lobsterai_options": { "version": 1, "thinking": { "level": "off" | "high" | "max" } } }
```

该协议来自 LobsterAI 自带的 `resources/cfmind/third-party-extensions/lobsterai-model-compat`（以可读源码形式分发）：

- `requestOptionsProtocol.ts`：`LOBSTERAI_REQUEST_OPTIONS_FIELD = 'lobsterai_options'`，`LOBSTERAI_REQUEST_OPTIONS_VERSION = 1`
- `requestOptions.ts`：写入 `payload.lobsterai_options = {version, thinking:{level}}`
- `thinkingProfileMapping.ts`：`resolveLobsterAIRequestThinkingLevel(profile, requestedLevel)` 按 `openclawLevel` 查表，未命中用 `defaultLevel`；level 取值 `off|minimal|low|medium|high|xhigh|max`，openclawLevel 取值 `off|minimal|low|medium|high|xhigh`

处理：从请求体防御式读取档位（`reasoning_effort`、`reasoningEffort`、`thinking.level` 都识别），按该模型的 `thinkingConfig` 映射（`openclawLevel` → `level`，例如 `xhigh` → `max`），写入 `lobsterai_options`；未指定时用 `defaultLevel`。

另外复刻 Kimi-K3 契约（`kimiK3StreamWrapper.ts`）：

- 删除 `thinking`、`reasoningEffort`、`temperature`、`top_p`、`n`、`presence_penalty`、`frequency_penalty`
- 固定 `reasoning_effort = "max"`
- 给历史中缺 `reasoning_content` 的 assistant tool_call 消息补 `reasoning_content: ""`，否则 K3 直接拒答

## 7. 测试与验证

单元测试（`bun test`，针对 `_internal` 导出的纯函数）：

- SSE 解析，含跨块边界的行拆分
- 非流式重组（content / reasoning_content / 分片 tool_calls / usage）
- 错误映射（`event:error` → 非 2xx，`40100` → 401）
- 思考档位映射与 Kimi-K3 契约
- 模型映射与用量映射
- JWT 解析
- sqlite 只读探测（用临时库构造样本）

沙箱冒烟（独立 `HOME`，避免污染真实配置）：

1. `magpie plugin add <仓库路径>`
2. `magpie plugin --json` 确认无加载错误
3. `magpie provider test lobster` / `magpie quota` 打一次真实调用

## 8. 待实测收敛项

### 已实测确认（不再是假设）

- **`lobsterai_options.thinking.level` 确实生效。** 同一问题问 `deepseek-flash`：

  | `thinking.level` | `reasoning_content` 体积 |
  | --- | --- |
  | `off` | 约 0 字节 |
  | `max` | 约 16.8 KB |
  | 不带该字段 | 约 19.3 KB |

  即 `off` 会真正关掉思考，`max` 与默认档位都产出思考。上游侧的字段名与语义已坐实。
- **`POST /api/auth/exchange` 接受最小 body。** 只发 `{"authCode": …}` 也能进入业务逻辑（返回 `40102 无效或已过期的授权码`，而非参数校验错误）。`firstKeyfrom`/`latestKeyfrom`/`uuid`/`userId`/`version` 均非必需，但保留它们更贴近真实客户端。
- **客户端标识头可选。** `GET /api/models/available` 不带它们也返回完整列表。

### 仍待收敛（防御式实现，实测后收窄）

1. ~~`variants` 的标记字段能否原样到达 `fetch`~~ —— **已收敛**：值对象根本到不了插件，magpie 下发的是它阶梯里的档位名，见 §5.1。修复后真机实测（`lobster/deepseek-flash`，各两遍）：`none` 令 `reasoning_content` 精确为 0 字节且正文非空，`high` / `max` / 不指定均大于 0。
2. 上游对非流式请求是否真的从不返回 JSON —— 若某模型返回 JSON 则直通，不做重组。**已收敛**：实测 10 次调用（含错误）全部是 HTTP 200 + `text/event-stream`；由插件重组成 JSON 交给调用方。
3. 真实的限流响应长什么样（`code` 与文案）—— 未观察到，暂按关键词判断，见 §6 坑 2。**未收敛**。
4. `limit.output` 的真实上限 —— 接口未提供（模型目录 18 个字段里没有任何输出上限），先用 32000 的保守值。**部分收敛**：实测 `max_tokens` 在 262144 时通过、524288 时 HTTP 500「服务器内部错误」，故真实上限介于两者之间；32000 是安全的保守值。注意 magpie 的 `/v1/models` 只是把这个数字回显成 `max_output_tokens`，无法自证。
5. ~~`variants` 的键名能否驱动 magpie 传出对应档位~~ —— **已收敛**（与第 1 点同源）：键名必须落在 magpie 的档位阶梯内，否则该档选不中，见 §5.1。

## 9. 风险

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| `/api/auth/refresh` 行为未知（轮换 vs 不轮换） | 续期可能失败或挤掉桌面端 | 本阶段不主动调用；路径 B 因 `expires` 为 0 结构性不续期 |
| 桌面端退出登录 / 卸载后路径 B 立刻失效 | 用户需重新登录 | `desktopToken()` 抛 `{signIn:"expired"}`，magpie 标记账号失效并提示；比继续用已失效的旧 token 更诚实 |
| `lobsterai_options` 只被有档位表的模型接受（实测 29 个中 21 个 `thinkingConfig` 为 `null`） | 下发即报 `4000`，整轮对话失败 | `applyThinking` 只在 `profile.options` 非空时才写入；无档位表的模型不下发该字段，实测照常返回 `reasoning_content` |
| 桌面端运行中占用 sqlite | 导入失败 | 只读打开 + 清晰降级提示 |
| 企业账号走不同 portal 路径（`EnterpriseIdentitySelect`） | 登录失败 | 本阶段只支持个人账号，README 说明 |
| `costMultiplier` 分时变动 | 静态费率过期 | 以线上拉取为准 |
| 上游限流策略未知 | 并发过高被限 | `magpie.maxConcurrency: 8` |

## 10. 交付物

可 `magpie plugin add D:\git\magpie-lobster` 直接加载的本地文件夹插件，含 README、设计文档与测试。代码按 npm 包约定布局，后续发布到 npm 或社区注册表无需重构。
