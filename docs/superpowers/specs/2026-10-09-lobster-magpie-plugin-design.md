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

| | 方式 | 存成 | magpie 是否续期 |
| --- | --- | --- | --- |
| A | 浏览器登录 | `oauth`（带 `refresh`/`access`/`expires`） | 会，走 `auth.refresh` |
| B | 从本机 LobsterAI 导入 | `api`（无 `expires`） | 不会 |

B 不续期不是靠代码判断，而是结构性保证：magpie 只对「带 `expires` 的 OAuth 账号」做续期，`api` 类型没有 `expires`，因此探测来的 token 不会被续期，桌面端会话不会被搅动。

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
- 解析 JWT 取 `exp` 与 `yid`，作为 `accountId` 与过期提示。

作为 `auth.methods` 中的 `{type:"api"}` 方法（无 `prompts`），`authorize()` 返回 `{type:"success", key: accessToken, metadata}`。

### 4.3 续期策略

`auth.refresh` 只服务于路径 A 产生的账号。本阶段**不主动验证** `/api/auth/refresh` 的轮换行为：调用它会消耗/轮换用户真实的 refreshToken，有把用户从桌面端挤下线的风险。除非用户明确批准，否则不对该端点做探测性调用。

`refreshLead` 取一个保守值（默认 `6h`），让 magpie 在过期前续期。

## 5. 模型与用量

### 5.1 模型发现

`provider.models(provider, {auth})` 请求 `/api/models/available?firstKeyfrom=official&latestKeyfrom=official`，映射：

| LobsterAI | magpie |
| --- | --- |
| `modelId` / `modelName` | `id` / `name` |
| `contextWindow` | `limit.context`；`limit.output` 默认 32000（接口未提供） |
| `supportsThinking` | `reasoning` |
| —（实测支持工具调用） | `tool_call: true` |
| `supportsImage` | `modalities.input` 追加 `image` |
| `costMultiplier` | `rate`（如 `deepseek-flash` 0.1、`deepseek-v4-pro` 0.52） |
| `thinkingConfig.options` | `variants` |

`accessible === false` 的模型跳过。拉取失败时返回 `provider.models`（magpie 会保留上一份列表）；401 抛出 `{signIn:"expired"}` 标记账号需要重新登录。

`config` 钩子同时声明一份静态兜底模型表（`lib/constants.mjs`），供未登录状态显示。

### 5.2 用量

`auth.usage` 合并两个端点：

- `plan` ← `quota.planName`（实测「免费」）
- `user` ← `profile.nickname`
- `balance` ← `profile.totalCreditsRemaining`（实测 1399.98）
- 免费额度窗口 ← `quota.freeCreditsUsed` / `quota.freeCreditsTotal`
- `until` ← `profile.creditItems` 中最早的 `expiresAt`

`costMultiplier` 是分时计价，静态值会过期，因此以线上拉取为准。

## 6. 请求管线

`loader` 返回 `{baseURL: "https://lobsterai-server.youdao.com/api/proxy/v1", apiKey, headers, fetch}`，所有请求经 `lib/proxy.mjs`。模型 `npm` 用 `@ai-sdk/openai-compatible`。

三个必须处理的坑，全部实测确认：

### 坑 1：上游永远返回 SSE

即使请求体写 `stream:false`，回包仍是 `Content-Type: text/event-stream`。

处理：

- 调用方要流式 → 透传。
- 调用方不要流式 → 把 SSE 聚合成单个 `chat.completion` JSON：`content` 拼接、`reasoning_content` 拼接、分片 `tool_calls` 按 `index` 合并，补 `usage` 与 `finish_reason`。
- 重组后删除 `content-length`。

### 坑 2：错误伪装成 HTTP 200

上游把错误放进 SSE：`event:error` + `data:{"type":"error","error":{...,"code":40300}}`。原样透传会导致 magpie 永远不会故障切换。

处理：先窥探流首段，若为 `event:error` 则转成真正的非 2xx JSON 响应：

- `40100` → 401，并带 `X-Magpie-Sign-In: expired`
- 其余 → 403 / 429 / 400，按 `code` 归类

若为正常数据，把已读取的前缀拼回，继续流式转发。只有真实 401（`{"code":40100,"message":"登录已过期，请重新登录"}`）本来就是 HTTP 401。

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

设计中对以下三点采取防御式实现，实测后收敛，不靠猜测：

1. magpie 把思考档位传进请求体的确切字段名 —— 先兼容多种来源，实测后收窄。
2. `/api/auth/exchange` 是否接受最小 body —— 先用假 code 探测参数校验，不消耗真实凭证。
3. 上游对非流式请求是否真的从不返回 JSON —— 若某模型返回 JSON 则直通，不做重组。

## 9. 风险

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| `/api/auth/refresh` 行为未知（轮换 vs 不轮换） | 续期可能失败或挤掉桌面端 | 本阶段不主动调用；路径 B 结构性不续期 |
| 桌面端运行中占用 sqlite | 导入失败 | 只读打开 + 清晰降级提示 |
| 企业账号走不同 portal 路径（`EnterpriseIdentitySelect`） | 登录失败 | 本阶段只支持个人账号，README 说明 |
| `costMultiplier` 分时变动 | 静态费率过期 | 以线上拉取为准 |
| 上游限流策略未知 | 并发过高被限 | `magpie.maxConcurrency: 8` |

## 10. 交付物

可 `magpie plugin add D:\git\magpie-lobster` 直接加载的本地文件夹插件，含 README、设计文档与测试。代码按 npm 包约定布局，后续发布到 npm 或社区注册表无需重构。
