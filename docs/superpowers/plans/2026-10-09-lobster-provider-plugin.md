# LobsterAI provider 插件实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付一个可 `magpie plugin add` 加载的本地文件夹插件，把有道 LobsterAI 账号下的约 30 个模型暴露为 magpie provider `lobster`。

**Architecture:** 单包 `opencode-lobster-auth`，入口 `index.mjs` 只装配钩子；所有逻辑放在 `lib/` 下的纯函数模块里，通过 `_internal` 导出供 `bun test` 测试。鉴权两条路径（浏览器登录存真 token 的 `oauth`、从本机 sqlite 导入的 `oauth` 不存 token 而是每次现读）；`loader.fetch` 承担请求改写（思考档位、Kimi-K3 契约）与响应改写（SSE 重组、错误状态码还原）。

**Tech Stack:** Bun（宿主，内置 `bun:sqlite`、`node:http`、`node:crypto`）、`@ai-sdk/openai-compatible`（线协议）、`bun test`（单元测试）。零运行时依赖。

> **修订（2026-10-09，晚于本计划）：** Task 5 里的 `variantsOf` 直接拿 `o.level` 当变体键（`[o.level, { [MARKER]: o.level }]`，见下文 5 处），**这会让最低档 `off` 永远选不中** —— magpie 不用 variants 的值对象，而是把入参 `reasoning_effort` 映射到「模型声明过的档位名」再下发，而它的档位阶梯（`none/minimal/low/medium/high/xhigh/max`）里没有 `off`。正确做法是：对外用 `none` 当键，写给上游时换回 `off`。以 `lib/thinking.mjs` 和设计文档 §5.1 为准；照本计划原样重做会把该缺陷带回来。

## Global Constraints

- 包名 `opencode-lobster-auth`，`type: "module"`，`main: "./index.mjs"`。
- provider id 固定为 `lobster`；`config` 钩子里必须用 `??=`，不得覆盖用户配置。
- **入口模块导出的每个函数都会被 magpie 当作插件调用**，因此辅助函数只能通过 `_internal` 导出，不得裸导出。
- **入口模块只能有一个函数导出**（`LobsterAuthPlugin`），且**不要写 `export default`**。已安装的六个社区插件都没有 `export default`；若同一个函数既具名又默认导出，magpie 会把它加载两次，provider id 冲突后被改名为 `lobster-plugin`。
- `package.json` 的 `exports` 写成字符串 `"./index.mjs"`（与六个社区插件一致），不要写成对象。
- 零运行时依赖：只用 Bun/Node 内置模块。
- 上游 base `https://lobsterai-server.youdao.com`；推理基地址 `https://lobsterai-server.youdao.com/api/proxy/v1`。
- 客户端头：`X-LobsterAI-Client-Version: 2026.9.23`、`X-LobsterAI-Client-Capabilities: kimi-k3-agentic-v1,thinking-level-control-v1`。
- 模型 `npm` 用 `@ai-sdk/openai-compatible`（对应 `/chat/completions`）。
- **绝不主动调用 `POST /api/auth/refresh`**（会轮换用户真实 refreshToken，有把用户挤下线的风险）。`auth.refresh` 只对路径 A 的账号生效。
- 路径 B 的账号必须存成 `{type:"oauth", access:"", refresh:"", expires:0, source:"desktop"}`：`expires` 为 0 才能保证 magpie 永不续期，不存 token 才能保证不与桌面端共用 refreshToken。**不能存成 `{type:"api"}`** —— api 类型会让 magpie 强制从 stdin 读一个 key，而这条路不需要任何输入。
- 所有对 `%APPDATA%\LobsterAI\lobsterai.sqlite` 的访问必须只读，绝不写入。
- 提交信息用中文，遵循 `type: 描述` 格式。

---

## File Structure

| 文件 | 职责 |
| --- | --- |
| `package.json` | 包元数据、`magpie.icon`、`magpie.maxConcurrency` |
| `index.mjs` | 钩子装配（`config`、`auth`、`provider`）+ `_internal` 导出 |
| `lib/constants.mjs` | provider id、base URL、客户端头、兜底模型表 |
| `lib/jwt.mjs` | 解析 JWT，取 `exp`、`yid` |
| `lib/sse.mjs` | SSE 字节流 → `{event, data}` 记录 |
| `lib/assemble.mjs` | 记录 → OpenAI 响应（流式 / 非流式重组） |
| `lib/thinking.mjs` | 思考档位映射 + Kimi-K3 契约 |
| `lib/proxy.mjs` | 请求管线：改写请求体、还原错误状态码 |
| `lib/models.mjs` | `/api/models/available` → magpie 模型表 |
| `lib/usage.mjs` | `/api/user/quota` + `profile-summary` → usage |
| `lib/auth-import.mjs` | 只读读取本机 sqlite 的登录信息 |
| `lib/auth-login.mjs` | 浏览器登录（loopback 回调 + exchange） |
| `test/*.test.mjs` | `bun test` 单元测试 |
| `README.md` | 登录方式、存储位置、模型说明 |

---

### Task 1: 包骨架、常量与 config 钩子

**Files:**
- Create: `package.json`
- Create: `lib/constants.mjs`
- Create: `index.mjs`
- Test: `test/constants.test.mjs`

**Interfaces:**
- Consumes: 无（首个任务）
- Produces:
  - `constants.mjs` 具名导出：`PROVIDER`（`"lobster"`）、`NAME`（`"LobsterAI"`）、`BASE`、`API`（`BASE + "/api"`）、`CHAT_BASE`（`BASE + "/api/proxy/v1"`）、`NPM`、`LOGIN_URL`、`CLIENT_VERSION`、`CAPABILITIES`、`ICON`、`FALLBACK_MODELS`（对象，键为模型 id）
  - `index.mjs` 默认导出 `async (input) => hooks`，具名导出 `LobsterAuthPlugin` 与 `_internal`
  - `configModel()`（`lib/constants.mjs`）→ `{name, limit:{context,output}, reasoning, tool_call, modalities}`

- [ ] **Step 1: 写失败的测试**

创建 `test/constants.test.mjs`：

```js
import { test, expect } from "bun:test"
import { PROVIDER, NAME, BASE, CHAT_BASE, NPM, FALLBACK_MODELS, configModel } from "../lib/constants.mjs"

test("provider identity is stable", () => {
  expect(PROVIDER).toBe("lobster")
  expect(NAME).toBe("LobsterAI")
  expect(BASE).toBe("https://lobsterai-server.youdao.com")
  expect(CHAT_BASE).toBe("https://lobsterai-server.youdao.com/api/proxy/v1")
  expect(NPM).toBe("@ai-sdk/openai-compatible")
})

test("fallback catalog is non-empty and shaped for magpie", () => {
  const ids = Object.keys(FALLBACK_MODELS)
  expect(ids.length).toBeGreaterThan(0)
  for (const id of ids) {
    const m = FALLBACK_MODELS[id]
    expect(m.name).toBeTruthy()
    expect(m.limit.context).toBeGreaterThan(0)
    expect(m.limit.output).toBeGreaterThan(0)
  }
})

test("configModel emits the flat shape the config hook needs", () => {
  const m = configModel({ name: "X", context: 1000, output: 100, reasoning: true, image: false })
  expect(m).toEqual({
    name: "X",
    limit: { context: 1000, output: 100 },
    reasoning: true,
    tool_call: true,
    modalities: { input: ["text"], output: ["text"] },
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test test/constants.test.mjs`
Expected: FAIL — `Cannot find module '../lib/constants.mjs'`

- [ ] **Step 3: 写 `package.json`**

```json
{
  "name": "opencode-lobster-auth",
  "version": "0.1.0",
  "description": "OpenCode provider plugin: NetEase Youdao LobsterAI (有道龙虾)",
  "type": "module",
  "main": "./index.mjs",
  "exports": "./index.mjs",
  "files": ["index.mjs", "lib", "README.md"],
  "keywords": ["opencode", "opencode-plugin", "magpie", "lobster", "lobsterai", "youdao"],
  "license": "MIT",
  "scripts": { "test": "bun test" },
  "magpie": {
    "maxConcurrency": 8,
    "icon": "https://lobsterai.youdao.com/portal/lobsterai-logo.png"
  }
}
```

- [ ] **Step 4: 写 `lib/constants.mjs`**

```js
// LobsterAI（有道龙虾）的固定事实：地址、客户端标识、未登录时的兜底模型表。
// 兜底表只在没登录时显示；登录后由 /api/models/available 的实时结果替换。

export const PROVIDER = "lobster"
export const NAME = "LobsterAI"
export const BASE = "https://lobsterai-server.youdao.com"
export const API = BASE + "/api"
export const CHAT_BASE = BASE + "/api/proxy/v1"
export const NPM = "@ai-sdk/openai-compatible"

export const LOGIN_URL = "https://lobsterai.youdao.com/portal#/login"
export const ICON = "https://lobsterai.youdao.com/portal/lobsterai-logo.png"

// 桌面端 2026.9.23 发的标识头；上游不强制，但可能影响特性开关
export const CLIENT_VERSION = "2026.9.23"
export const CAPABILITIES = "kimi-k3-agentic-v1,thinking-level-control-v1"

// 接口不提供输出上限，取一个保守值（见设计文档 §8）
export const DEFAULT_OUTPUT = 32000
export const DEFAULT_CONTEXT = 1000000

export function configModel({ name, context, output, reasoning, image }) {
  const input = ["text"]
  if (image) input.push("image")
  return {
    name,
    limit: { context: context || DEFAULT_CONTEXT, output: output || DEFAULT_OUTPUT },
    reasoning: !!reasoning,
    tool_call: true,
    modalities: { input, output: ["text"] },
  }
}

// 兜底：未登录时让用户看到 provider 存在。字段来自实测的模型目录。
export const FALLBACK_MODELS = {
  "deepseek-v4-pro": configModel({ name: "DeepSeek V4 Pro", reasoning: true }),
  "deepseek-flash": configModel({ name: "DeepSeek Flash", reasoning: true }),
  "glm-5.3": configModel({ name: "GLM-5.3", reasoning: true }),
  "kimi-k3": configModel({ name: "Kimi K3", reasoning: true, image: true }),
  "qwen3.8-max": configModel({ name: "Qwen3.8 Max", reasoning: true }),
}
```

- [ ] **Step 5: 写 `index.mjs`（本步只装配 config）**

```js
import { PROVIDER, NAME, API, NPM, ICON, FALLBACK_MODELS } from "./lib/constants.mjs"

export const LobsterAuthPlugin = async () => ({
  config: async (cfg) => {
    cfg.provider ??= {}
    cfg.provider[PROVIDER] ??= {
      name: NAME,
      npm: NPM,
      api: API,
      models: FALLBACK_MODELS,
    }
  },
})

// 唯一允许的函数导出：magpie 会把每个导出的函数都当成一个插件加载
export const _internal = { FALLBACK_MODELS }
```

- [ ] **Step 6: 运行测试确认通过**

Run: `bun test test/constants.test.mjs`
Expected: PASS — 3 pass

- [ ] **Step 7: 提交**

```bash
git add package.json lib/constants.mjs index.mjs test/constants.test.mjs
git commit -m "feat: 包骨架、常量与 config 钩子"
```

---

### Task 2: JWT 解析

**Files:**
- Create: `lib/jwt.mjs`
- Test: `test/jwt.test.mjs`

**Interfaces:**
- Consumes: 无
- Produces: `jwtPayload(token)` → `object | null`；`jwtExp(token)` → `number`（毫秒，失败为 `0`）；`accountOf(token)` → `{yid, id}`（失败为 `{}`）

- [ ] **Step 1: 写失败的测试**

创建 `test/jwt.test.mjs`：

```js
import { test, expect } from "bun:test"
import { jwtPayload, jwtExp, accountOf } from "../lib/jwt.mjs"

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url")
const token = (payload) => `x.${b64(payload)}.y`

test("reads the payload", () => {
  expect(jwtPayload(token({ sub: 67097 }))).toEqual({ sub: 67097 })
})

test("jwtExp returns milliseconds", () => {
  expect(jwtExp(token({ exp: 1793152423 }))).toBe(1793152423000)
})

test("accountOf reads yid and sub", () => {
  expect(accountOf(token({ sub: 67097, yid: "urs-phoneyd.abc@163.com" })))
    .toEqual({ yid: "urs-phoneyd.abc@163.com", id: 67097 })
})

test("malformed input is not fatal", () => {
  expect(jwtPayload("nope")).toBeNull()
  expect(jwtPayload("")).toBeNull()
  expect(jwtExp("nope")).toBe(0)
  expect(accountOf("nope")).toEqual({})
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test test/jwt.test.mjs`
Expected: FAIL — `Cannot find module '../lib/jwt.mjs'`

- [ ] **Step 3: 写 `lib/jwt.mjs`**

```js
// LobsterAI 的 accessToken 是标准 JWT（未加密，仅签名）。
// 插件只读它的载荷，不校验签名——校验由上游负责。

function decode(part) {
  try {
    const s = Buffer.from(String(part).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
    const v = JSON.parse(s)
    return v && typeof v === "object" ? v : null
  } catch {
    return null
  }
}

export function jwtPayload(token) {
  const parts = String(token ?? "").split(".")
  if (parts.length < 2) return null
  return decode(parts[1])
}

// exp 以秒计；返回毫秒，读不到就是 0（magpie 把 0 当作「不续期」）
export function jwtExp(token) {
  const p = jwtPayload(token)
  const exp = Number(p?.exp)
  return Number.isFinite(exp) && exp > 0 ? exp * 1000 : 0
}

export function accountOf(token) {
  const p = jwtPayload(token)
  if (!p) return {}
  const out = {}
  if (p.yid) out.yid = p.yid
  if (p.sub !== undefined) out.id = p.sub
  return out
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test test/jwt.test.mjs`
Expected: PASS — 4 pass

- [ ] **Step 5: 提交**

```bash
git add lib/jwt.mjs test/jwt.test.mjs
git commit -m "feat: JWT 解析"
```

---

### Task 3: SSE 解析器

**Files:**
- Create: `lib/sse.mjs`
- Test: `test/sse.test.mjs`

**Interfaces:**
- Consumes: 无
- Produces: `sse(body)` → `AsyncGenerator<{event: string, data: string}>`；`first(it)` → `{head, rest}`；`chain(held, it)` → `AsyncGenerator`

- [ ] **Step 1: 写失败的测试**

创建 `test/sse.test.mjs`：

```js
import { test, expect } from "bun:test"
import { sse, first, chain } from "../lib/sse.mjs"

async function* from(list) { for (const s of list) yield new TextEncoder().encode(s) }
const collect = async (it) => { const out = []; for await (const r of it) out.push(r); return out }

test("parses events split across chunk boundaries", async () => {
  const got = await collect(sse(from(["data: {\"a\"", ":1}\n\n", "data: [DONE]\n\n"])))
  expect(got).toEqual([{ event: "", data: '{"a":1}' }, { event: "", data: "[DONE]" }])
})

test("carries event names and joins multi-line data", async () => {
  const got = await collect(sse(from(["event: error\ndata: {\"x\":\ndata: 1}\n\n"])))
  expect(got).toEqual([{ event: "error", data: '{"x":\n1}' }])
})

test("ignores comments and tolerates CRLF", async () => {
  const got = await collect(sse(from([": keep-alive\r\n\r\ndata: hi\r\n\r\n"])))
  expect(got).toEqual([{ event: "", data: "hi" }])
})

test("flushes a trailing event with no blank line", async () => {
  const got = await collect(sse(from(["data: tail"])))
  expect(got).toEqual([{ event: "", data: "tail" }])
})

test("first() peeks without losing the record", async () => {
  const { head, rest } = await first(sse(from(["data: one\n\ndata: two\n\n"])))
  expect(head).toEqual({ event: "", data: "one" })
  expect(await collect(rest)).toEqual([{ event: "", data: "one" }, { event: "", data: "two" }])
})

test("first() on an empty stream yields null", async () => {
  const { head } = await first(sse(from([])))
  expect(head).toBeNull()
})

test("chain replays held records then the rest", async () => {
  const got = await collect(chain([{ event: "", data: "held" }], sse(from(["data: live\n\n"]))))
  expect(got).toEqual([{ event: "", data: "held" }, { event: "", data: "live" }])
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test test/sse.test.mjs`
Expected: FAIL — `Cannot find module '../lib/sse.mjs'`

- [ ] **Step 3: 写 `lib/sse.mjs`**

```js
// LobsterAI 的推理端点永远以 SSE 作答，即使请求写了 stream:false。
// 这里把字节流切成 {event, data} 记录，两种情形都由上层决定怎么用。

const decoder = new TextDecoder()

export async function* sse(body) {
  let buf = ""
  let event = ""
  let data = []

  // 一条空行结束一个事件；没有 data 的事件（只有注释）不产出
  const flush = () => {
    if (data.length === 0) { event = ""; return null }
    const rec = { event, data: data.join("\n") }
    event = ""
    data = []
    return rec
  }

  const feed = (raw) => {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw
    if (line === "") return flush()
    if (line.startsWith(":")) return null // 注释 / keep-alive
    const i = line.indexOf(":")
    const field = i === -1 ? line : line.slice(0, i)
    let value = i === -1 ? "" : line.slice(i + 1)
    if (value.startsWith(" ")) value = value.slice(1)
    if (field === "event") event = value
    else if (field === "data") data.push(value)
    return null
  }

  for await (const chunk of body) {
    buf += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true })
    let nl
    while ((nl = buf.indexOf("\n")) !== -1) {
      const rec = feed(buf.slice(0, nl))
      buf = buf.slice(nl + 1)
      if (rec) yield rec
    }
  }
  buf += decoder.decode()
  if (buf !== "") {
    const rec = feed(buf)
    if (rec) yield rec
  }
  const last = flush()
  if (last) yield last
}

async function* empty() {}

// first 读一条但把它放回去：上游把错误藏在流里，必须先看一眼首条
export async function first(it) {
  const n = await it.next()
  if (n.done) return { head: null, rest: empty() }
  return { head: n.value, rest: chain([n.value], it) }
}

export async function* chain(held, it) {
  yield* held
  for (;;) {
    const n = await it.next()
    if (n.done) return
    yield n.value
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test test/sse.test.mjs`
Expected: PASS — 7 pass

- [ ] **Step 5: 提交**

```bash
git add lib/sse.mjs test/sse.test.mjs
git commit -m "feat: SSE 解析器"
```

---

### Task 4: 响应装配（流式与非流式重组）

**Files:**
- Create: `lib/assemble.mjs`
- Test: `test/assemble.test.mjs`

**Interfaces:**
- Consumes: Task 3 的 `{event, data}` 记录
- Produces: `respond(req, records)` → `Response`；`mergeChunks(records)` → `object`（供测试直接断言）

- [ ] **Step 1: 写失败的测试**

创建 `test/assemble.test.mjs`：

```js
import { test, expect } from "bun:test"
import { respond, mergeChunks } from "../lib/assemble.mjs"

async function* from(list) { for (const d of list) yield { event: "", data: d } }
const chunk = (delta, extra = {}) => JSON.stringify({
  id: "c1", object: "chat.completion.chunk", model: "deepseek-flash",
  choices: [{ index: 0, delta, finish_reason: extra.finish_reason ?? null }],
  ...(extra.usage ? { usage: extra.usage } : {}),
})

test("merges content, reasoning and streamed tool calls", async () => {
  const out = await mergeChunks(from([
    chunk({ content: "He", reasoning_content: "thi" }),
    chunk({ content: "llo", reasoning_content: "nk" }),
    chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "get_", arguments: "" } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: '{"a"' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: ":1}" } }] }),
    chunk({}, { finish_reason: "tool_calls", usage: { prompt_tokens: 5, completion_tokens: 7 } }),
    "[DONE]",
  ]), "deepseek-flash")

  expect(out.object).toBe("chat.completion")
  expect(out.model).toBe("deepseek-flash")
  const msg = out.choices[0].message
  expect(msg.content).toBe("Hello")
  expect(msg.reasoning_content).toBe("think")
  expect(msg.tool_calls).toEqual([{
    id: "call_1", type: "function", function: { name: "get_", arguments: '{"a":1}' },
  }])
  expect(out.choices[0].finish_reason).toBe("tool_calls")
  expect(out.usage).toEqual({ prompt_tokens: 5, completion_tokens: 7 })
})

test("tool-only answers get a null content, not an empty string", async () => {
  const out = await mergeChunks(from([
    chunk({ tool_calls: [{ index: 0, id: "c", type: "function", function: { name: "f", arguments: "{}" } }] }),
    "[DONE]",
  ]), "m")
  expect(out.choices[0].message.content).toBeNull()
})

test("skips malformed records instead of throwing", async () => {
  const out = await mergeChunks(from(["not json", chunk({ content: "ok" }), "[DONE]"]), "m")
  expect(out.choices[0].message.content).toBe("ok")
})

test("non-streaming requests get one JSON body", async () => {
  const res = await respond({ stream: false, model: "m" }, from([chunk({ content: "hi" }), "[DONE]"]))
  expect(res.headers.get("content-type")).toBe("application/json")
  const body = await res.json()
  expect(body.choices[0].message.content).toBe("hi")
})

test("streaming requests get an SSE body ending in [DONE]", async () => {
  const res = await respond({ stream: true, model: "m" }, from([chunk({ content: "hi" })]))
  expect(res.headers.get("content-type")).toBe("text/event-stream")
  const text = await res.text()
  expect(text).toContain('data: {"id":"c1"')
  expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test test/assemble.test.mjs`
Expected: FAIL — `Cannot find module '../lib/assemble.mjs'`

- [ ] **Step 3: 写 `lib/assemble.mjs`**

```js
// 上游给的是 OpenAI 形状的 chat.completion.chunk，只是永远走 SSE。
// 流式请求原样转发；非流式请求要把分片拼成一个完整的 chat.completion。

import { randomBytes } from "node:crypto"

const enc = new TextEncoder()

function newId() {
  return "chatcmpl-" + randomBytes(12).toString("hex")
}

export async function mergeChunks(records, model) {
  const out = {
    id: newId(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" }],
    usage: null,
  }
  const calls = new Map()
  let content = ""
  let reasoning = ""

  for await (const rec of records) {
    if (rec.data === "[DONE]") break
    let v
    try { v = JSON.parse(rec.data) } catch { continue }
    if (v?.usage) out.usage = v.usage
    const ch = v?.choices?.[0]
    if (!ch) continue
    const d = ch.delta ?? {}
    if (typeof d.content === "string") content += d.content
    if (typeof d.reasoning_content === "string") reasoning += d.reasoning_content
    for (const tc of d.tool_calls ?? []) {
      const i = tc.index ?? 0
      let c = calls.get(i)
      if (!c) { c = { id: "", type: "function", function: { name: "", arguments: "" } }; calls.set(i, c) }
      if (tc.id) c.id = tc.id
      if (tc.type) c.type = tc.type
      if (tc.function?.name) c.function.name = tc.function.name
      if (typeof tc.function?.arguments === "string") c.function.arguments += tc.function.arguments
    }
    if (ch.finish_reason) out.choices[0].finish_reason = ch.finish_reason
  }

  const msg = out.choices[0].message
  msg.content = content
  if (reasoning) msg.reasoning_content = reasoning
  if (calls.size > 0) {
    msg.tool_calls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c)
    // OpenAI 的约定：只有工具调用时 content 为 null
    if (!content) msg.content = null
  }
  return out
}

function streamOut(records) {
  const body = new ReadableStream({
    async start(controller) {
      try {
        for await (const rec of records) {
          if (rec.data === "[DONE]") break
          controller.enqueue(enc.encode(`data: ${rec.data}\n\n`))
        }
        controller.enqueue(enc.encode("data: [DONE]\n\n"))
        controller.close()
      } catch (e) {
        controller.error(e)
      }
    },
    cancel() { records.return?.() },
  })
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  })
}

export async function respond(req, records) {
  if (req.stream) return streamOut(records)
  const body = await mergeChunks(records, req.model)
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test test/assemble.test.mjs`
Expected: PASS — 5 pass

- [ ] **Step 5: 提交**

```bash
git add lib/assemble.mjs test/assemble.test.mjs
git commit -m "feat: 响应装配与 SSE 重组"
```

---

### Task 5: 思考档位与 Kimi-K3 契约

**Files:**
- Create: `lib/thinking.mjs`
- Test: `test/thinking.test.mjs`

**Interfaces:**
- Consumes: 无
- Produces:
  - `levelOf(req, profile)` → `string`（`off|minimal|low|medium|high|xhigh|max`）
  - `variantsOf(profile)` → `object`（`{[level]: {lobsterai_thinking: level}}`）
  - `applyThinking(req, profile)` → `void`（就地写 `req.lobsterai_options`）
  - `isKimiK3(modelId)` → `boolean`
  - `applyKimiK3(req)` → `void`

- [ ] **Step 1: 写失败的测试**

创建 `test/thinking.test.mjs`：

```js
import { test, expect } from "bun:test"
import { levelOf, variantsOf, applyThinking, isKimiK3, applyKimiK3 } from "../lib/thinking.mjs"

// 实测自 deepseek-flash 的 thinkingConfig
const PROFILE = {
  options: [{ level: "off", openclawLevel: "off" }, { level: "high", openclawLevel: "high" }, { level: "max", openclawLevel: "xhigh" }],
  defaultLevel: "max",
}

test("variants are keyed by level and carry a plugin marker", () => {
  expect(variantsOf(PROFILE)).toEqual({
    off: { lobsterai_thinking: "off" },
    high: { lobsterai_thinking: "high" },
    max: { lobsterai_thinking: "max" },
  })
})

test("levelOf prefers the plugin marker", () => {
  expect(levelOf({ lobsterai_thinking: "high" }, PROFILE)).toBe("high")
})

test("levelOf accepts reasoning_effort and maps through openclawLevel", () => {
  expect(levelOf({ reasoning_effort: "xhigh" }, PROFILE)).toBe("max")
})

test("levelOf accepts reasoningEffort", () => {
  expect(levelOf({ reasoningEffort: "off" }, PROFILE)).toBe("off")
})

test("levelOf falls back to the profile default", () => {
  expect(levelOf({}, PROFILE)).toBe("max")
})

test("levelOf with no profile yields off", () => {
  expect(levelOf({}, undefined)).toBe("off")
})

test("applyThinking writes the protocol field and drops the marker", () => {
  const req = { model: "m", lobsterai_thinking: "high", messages: [] }
  applyThinking(req, PROFILE)
  expect(req.lobsterai_options).toEqual({ version: 1, thinking: { level: "high" } })
  expect("lobsterai_thinking" in req).toBe(false)
})

// 实测 29 个模型里有 21 个 thinkingConfig 是 null。对它们下发
// lobsterai_options 会让上游直接报 4000，整轮对话失败。
test("applyThinking writes nothing for a model without a thinking profile", () => {
  const req = { model: "m", lobsterai_thinking: "high", messages: [] }
  applyThinking(req, undefined)
  expect("lobsterai_options" in req).toBe(false)
})

test("applyThinking writes nothing when the profile has no options", () => {
  const req = { model: "m", lobsterai_thinking: "high", messages: [] }
  applyThinking(req, { options: [], defaultLevel: "high" })
  expect("lobsterai_options" in req).toBe(false)
})

test("applyThinking still drops the marker when it writes nothing", () => {
  const req = { model: "m", lobsterai_thinking: "high", messages: [] }
  applyThinking(req, undefined)
  // 标记必须清掉，否则会原样漏给上游
  expect("lobsterai_thinking" in req).toBe(false)
})

test("isKimiK3 matches the family but not unrelated ids", () => {
  expect(isKimiK3("kimi-k3")).toBe(true)
  expect(isKimiK3("kimi-k3-auto-max")).toBe(true)
  expect(isKimiK3("kimi-k2.6")).toBe(false)
})

test("applyKimiK3 fixes sampling and repairs tool-call reasoning", () => {
  const req = {
    model: "kimi-k3", temperature: 0.7, top_p: 0.9, n: 1,
    presence_penalty: 0, frequency_penalty: 0, thinking: { type: "enabled" },
    reasoningEffort: "high",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", tool_calls: [{ id: "c", type: "function", function: { name: "f", arguments: "{}" } }] },
    ],
  }
  applyKimiK3(req)
  expect(req.temperature).toBeUndefined()
  expect(req.top_p).toBeUndefined()
  expect(req.n).toBeUndefined()
  expect(req.presence_penalty).toBeUndefined()
  expect(req.frequency_penalty).toBeUndefined()
  expect(req.thinking).toBeUndefined()
  expect(req.reasoningEffort).toBeUndefined()
  expect(req.reasoning_effort).toBe("max")
  expect(req.messages[1].reasoning_content).toBe("")
  expect("reasoning_content" in req.messages[0]).toBe(false)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test test/thinking.test.mjs`
Expected: FAIL — `Cannot find module '../lib/thinking.mjs'`

- [ ] **Step 3: 写 `lib/thinking.mjs`**

```js
// 上游的思考档位走私有字段，不是 reasoning_effort：
//   {"lobsterai_options":{"version":1,"thinking":{"level":"off"|"high"|"max"}}}
// 协议来自 LobsterAI 自带的 lobsterai-model-compat 插件
// （resources/cfmind/third-party-extensions/lobsterai-model-compat）。
//
// 实测（deepseek-flash，同一问题）：level=off 时 reasoning_content 约 0 字节，
// level=max 约 16.8KB，不带该字段约 19.3KB —— 即 off 会真正关掉思考。

export const OPTIONS_FIELD = "lobsterai_options"
export const OPTIONS_VERSION = 1
export const MARKER = "lobsterai_thinking"

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
const isLevel = (s) => LEVELS.includes(s)

// variants 的值对象会被 magpie 合并进请求体（社区插件据此传 reasoningEffort）。
// 这里放一个插件自读的标记，fetch 再把它翻译成 lobsterai_options。
export function variantsOf(profile) {
  const opts = profile?.options ?? []
  return Object.fromEntries(opts.map((o) => [o.level, { [MARKER]: o.level }]))
}

// 档位可能以多种形式到达：插件的标记、reasoning_effort、reasoningEffort、
// thinking.level。按 level 或 openclawLevel 查表，未命中用 defaultLevel。
export function levelOf(req, profile) {
  const opts = profile?.options ?? []
  const wanted = [
    req?.[MARKER],
    req?.reasoning_effort,
    req?.reasoningEffort,
    req?.thinking?.level,
  ].find((v) => typeof v === "string" && v !== "")

  if (wanted) {
    if (isLevel(wanted) && opts.some((o) => o.level === wanted)) return wanted
    const byOpenclaw = opts.find((o) => o.openclawLevel === wanted)
    if (byOpenclaw) return byOpenclaw.level
    if (isLevel(wanted)) return wanted
  }
  if (profile?.defaultLevel && isLevel(profile.defaultLevel)) return profile.defaultLevel
  return "off"
}

export function applyThinking(req, profile) {
  const level = levelOf(req, profile)
  delete req[MARKER]
  // 关键：只有当模型真的有档位表时才下发这个字段。
  // 实测 29 个模型里有 21 个 thinkingConfig 是 null，对它们下发
  // lobsterai_options 会直接报 4000（"model does not have a valid
  // thinkingConfig"），整轮对话失败 —— 而这个字段只是用来控制思考档位的，
  // 不下发时模型照样正常思考（reasoning_content 照常返回）。
  const opts = profile?.options
  if (!Array.isArray(opts) || opts.length === 0) return
  req[OPTIONS_FIELD] = { version: OPTIONS_VERSION, thinking: { level } }
}

// Kimi K3 的额外契约（LobsterAI 的 kimiK3StreamWrapper.ts）：
// 采样参数由服务端固定，必须删掉；reasoning_effort 固定为 max；
// 历史里缺 reasoning_content 的 assistant tool_call 消息会被拒答。
const K3_FIXED = ["temperature", "top_p", "n", "presence_penalty", "frequency_penalty"]

export function isKimiK3(modelId) {
  return /^kimi-k3(?:$|[-.])/i.test(String(modelId ?? ""))
}

export function applyKimiK3(req) {
  delete req.thinking
  delete req.reasoningEffort
  for (const f of K3_FIXED) delete req[f]
  req.reasoning_effort = "max"
  if (!Array.isArray(req.messages)) return
  for (const m of req.messages) {
    if (m?.role !== "assistant") continue
    if (!Array.isArray(m.tool_calls) || m.tool_calls.length === 0) continue
    if (!("reasoning_content" in m)) m.reasoning_content = ""
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test test/thinking.test.mjs`
Expected: PASS — 9 pass

- [ ] **Step 5: 提交**

```bash
git add lib/thinking.mjs test/thinking.test.mjs
git commit -m "feat: 思考档位映射与 Kimi-K3 契约"
```

---

### Task 6: 请求管线与错误状态码还原

**Files:**
- Create: `lib/proxy.mjs`
- Test: `test/proxy.test.mjs`

**Interfaces:**
- Consumes: Task 3 `sse`/`first`（`chain` 由 `first` 内部使用，Task 6 不再直接用）、Task 4 `respond`、Task 5 `applyThinking`/`applyKimiK3`/`isKimiK3`
- Produces:
  - `errorOf(data)` → `{code, message}`（解析 SSE `event:error` 的载荷）
  - `statusFor(code, message)` → `number`
  - `makeFetch({getAuth, profileOf})` → `(input, init) => Promise<Response>`

- [ ] **Step 1: 写失败的测试**

创建 `test/proxy.test.mjs`：

```js
import { test, expect } from "bun:test"
import { errorOf, statusFor, makeFetch } from "../lib/proxy.mjs"

test("errorOf reads the proxy's nested error envelope", () => {
  expect(errorOf('{"type":"error","error":{"type":"proxy_error","message":"不支持的模型: x","code":40300}}'))
    .toEqual({ code: 40300, message: "不支持的模型: x" })
})

test("errorOf tolerates junk", () => {
  expect(errorOf("nope")).toEqual({ code: 0, message: "" })
})

test("statusFor maps the observed codes", () => {
  expect(statusFor(40100, "登录已过期，请重新登录")).toBe(401)
  expect(statusFor(40300, "不支持的模型: x")).toBe(403)
  expect(statusFor(42900, "请求过于频繁")).toBe(429)
  expect(statusFor(42900, "rate limited")).toBe(429)
  expect(statusFor(12345, "whatever")).toBe(400)
})

const sseResponse = (lines) => new Response(
  new ReadableStream({
    start(c) {
      for (const l of lines) c.enqueue(new TextEncoder().encode(l))
      c.close()
    },
  }),
  { status: 200, headers: { "content-type": "text/event-stream" } },
)

test("an event:error in a 200 becomes a real non-2xx", async () => {
  const f = makeFetch({
    getAuth: async () => ({ type: "api", key: "tok" }),
    tokenOf: async (a) => a.key,
    profileOf: () => undefined,
    call: async () => sseResponse([
      'event: error\ndata: {"type":"error","error":{"message":"不支持的模型: x","code":40300}}\n\n',
    ]),
  })
  const res = await f("https://up/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "x", stream: true, messages: [] }),
  })
  expect(res.status).toBe(403)
  expect((await res.json()).error.message).toContain("不支持的模型")
})

test("a lapsed sign-in is reported as 401 with X-Magpie-Sign-In", async () => {
  const f = makeFetch({
    getAuth: async () => ({ type: "api", key: "tok" }),
    tokenOf: async (a) => a.key,
    profileOf: () => undefined,
    call: async () => sseResponse([
      'event: error\ndata: {"type":"error","error":{"message":"登录已过期，请重新登录","code":40100}}\n\n',
    ]),
  })
  const res = await f("https://up/v1/chat/completions", {
    method: "POST", body: JSON.stringify({ model: "m", stream: true, messages: [] }),
  })
  expect(res.status).toBe(401)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("expired")
})

test("a good answer is reassembled for a non-streaming caller", async () => {
  let seen = null
  const f = makeFetch({
    getAuth: async () => ({ type: "api", key: "tok" }),
    tokenOf: async (a) => a.key,
    profileOf: () => ({ options: [{ level: "off", openclawLevel: "off" }], defaultLevel: "off" }),
    call: async (url, init) => {
      seen = JSON.parse(init.body)
      return sseResponse([
        'data: {"id":"c","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n',
        "data: [DONE]\n\n",
      ])
    },
  })
  const res = await f("https://up/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "m", stream: false, messages: [], reasoning_effort: "high" }),
  })
  expect(res.headers.get("content-type")).toBe("application/json")
  expect((await res.json()).choices[0].message.content).toBe("hi")
  // 成功要带 kept，magpie 才会清掉账号上的失效标记
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("kept")
  // 请求体被改写：私有字段写入，档位标记清除
  expect(seen.lobsterai_options).toEqual({ version: 1, thinking: { level: "high" } })
  expect(seen.reasoning_effort).toBeUndefined()
})

// 桌面端导入的账号不存 token，每次现读；读不到就是账号失效。
// 这里不能让请求带着空 token 发出去 —— 那会被上游当成匿名请求。
test("a resolver that cannot read the token reports a lapsed account", async () => {
  let called = false
  const f = makeFetch({
    getAuth: async () => ({ type: "oauth", source: "desktop" }),
    tokenOf: async () => { throw Object.assign(new Error("桌面端未登录"), { signIn: "expired" }) },
    profileOf: () => undefined,
    call: async () => { called = true; return new Response("{}", { status: 200 }) },
  })
  const res = await f("https://up/v1/chat/completions", {
    method: "POST", body: JSON.stringify({ model: "m", stream: true, messages: [] }),
  })
  expect(res.status).toBe(401)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("expired")
  expect((await res.json()).error.message).toContain("桌面端未登录")
  expect(called).toBe(false)
})

test("a real 401 passes straight through", async () => {
  const f = makeFetch({
    getAuth: async () => ({ type: "api", key: "tok" }),
    tokenOf: async (a) => a.key,
    profileOf: () => undefined,
    call: async () => new Response('{"code":40100,"message":"登录已过期，请重新登录"}', { status: 401 }),
  })
  const res = await f("https://up/v1/chat/completions", {
    method: "POST", body: JSON.stringify({ model: "m", stream: true, messages: [] }),
  })
  expect(res.status).toBe(401)
  expect(res.headers.get("X-Magpie-Sign-In")).toBe("expired")
  expect((await res.json()).message).toContain("登录已过期")
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test test/proxy.test.mjs`
Expected: FAIL — `Cannot find module '../lib/proxy.mjs'`

- [ ] **Step 3: 写 `lib/proxy.mjs`**

```js
// 请求管线。上游有两个必须处理的行为：
//   1. 永远以 SSE 作答，即使请求写了 stream:false；
//   2. 把错误塞进 SSE 的 event:error 且状态码仍是 200，原样透传会让 magpie
//      永不故障切换。
// 另外思考档位要翻译成私有字段（见 lib/thinking.mjs）。

import { sse, first } from "./sse.mjs"
import { respond } from "./assemble.mjs"
import { applyThinking, applyKimiK3, isKimiK3 } from "./thinking.mjs"
import { CLIENT_VERSION, CAPABILITIES } from "./constants.mjs"

const LIMIT_WORDS = /限流|频率|过快|过于频繁|rate ?limit|too many/i

export function errorOf(data) {
  let v
  try { v = JSON.parse(data) } catch { return { code: 0, message: "" } }
  const e = v?.error && typeof v.error === "object" ? v.error : v
  const code = Number(e?.code ?? v?.code ?? 0) || 0
  const message = String(e?.message ?? v?.message ?? v?.msg ?? "")
  return { code, message }
}

export function statusFor(code, message) {
  if (code === 40100) return 401
  if (code === 40300) return 403
  if (code === 42900) return 429
  if (LIMIT_WORDS.test(String(message ?? ""))) return 429
  return 400
}

// 401 带 expired 让 magpie 给账号打上失效标记；其余状态不带这个头
function errorResponse(status, code, message) {
  const headers = { "content-type": "application/json" }
  if (status === 401) headers["X-Magpie-Sign-In"] = "expired"
  return new Response(
    JSON.stringify({ error: { message, type: status === 429 ? "rate_limit_error" : "api_error", code: code || null } }),
    { status, headers },
  )
}

// tokenOf 由调用方注入：桌面端导入的账号自己不存 token，得每次现读，
// 因此这里不能写死「oauth 读 access、api 读 key」。
export function makeFetch({ getAuth, tokenOf, profileOf, call }) {
  return async function lobsterFetch(input, init) {
    const auth = await getAuth()
    if (auth?.type !== "api" && auth?.type !== "oauth") {
      return errorResponse(401, 40100, "LobsterAI: 尚未登录")
    }
    let token = ""
    try {
      token = await tokenOf(auth)
    } catch (e) {
      // 桌面端退出登录 / 库读不到：带上失效标记，让 magpie 提示重新登录
      return errorResponse(401, 40100, e?.message ?? "LobsterAI: 登录信息不可用")
    }
    if (!token) return errorResponse(401, 40100, "LobsterAI: 登录信息不完整")

    let req
    try { req = JSON.parse(typeof init?.body === "string" ? init.body : "{}") } catch { req = {} }

    // 请求体改写
    const profile = profileOf(req.model)
    if (isKimiK3(req.model)) applyKimiK3(req)
    applyThinking(req, profile)

    const headers = new Headers(init?.headers)
    headers.set("authorization", `Bearer ${token}`)
    headers.set("content-type", "application/json")
    headers.set("X-LobsterAI-Client-Version", CLIENT_VERSION)
    headers.set("X-LobsterAI-Client-Capabilities", CAPABILITIES)
    headers.delete("content-length")

    const res = await call(input, { ...init, method: init?.method ?? "POST", headers, body: JSON.stringify(req) })

    // 上游的鉴权失败是真 401，原样透传但要补上失效标记
    if (res.status === 401) {
      const headers = new Headers(res.headers)
      headers.set("X-Magpie-Sign-In", "expired")
      return new Response(res.body, { status: 401, statusText: res.statusText, headers })
    }
    if (!res.ok) return res
    const ctype = res.headers.get("content-type") ?? ""
    // 上游理论上永远给 SSE；真给了 JSON 就直通，不做重组
    if (!ctype.includes("event-stream")) return res

    const { head, rest } = await first(sse(res.body))
    if (head && head.event === "error") {
      const { code, message } = errorOf(head.data)
      return errorResponse(statusFor(code, message), code, message || "LobsterAI 返回了一个错误")
    }
    // 注意：Task 3 的 first() 已经把 head 放回 rest 里了，这里不能再拼一次，
    // 否则第一个 chunk 会重复。直接用 rest。
    const out = await respond(req, rest)
    // 成功也要带 kept：插件不自己续期，用的就是存下来的 token。
    // magpie 靠这个头把账号上的失效标记清掉。
    out.headers.set("X-Magpie-Sign-In", "kept")
    return out
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test test/proxy.test.mjs`
Expected: PASS — 7 pass

- [ ] **Step 5: 提交**

```bash
git add lib/proxy.mjs test/proxy.test.mjs
git commit -m "feat: 请求管线与错误状态码还原"
```

```

---

### Task 7: 模型发现

**Files:**
- Create: `lib/models.mjs`
- Test: `test/models.test.mjs`

**Interfaces:**
- Consumes: `lib/constants.mjs` 的 `configModel`、`DEFAULT_OUTPUT`、`DEFAULT_CONTEXT`
- Produces:
  - `modelsFromCatalog(list, provider)` → `object`（键为模型 id，值为 magpie 运行时模型）
  - `profileOfFrom(list)` → `object`（`{modelId: thinkingConfig}`）
  - `runtimeModel(entry, base)` → `object`

- [ ] **Step 1: 写失败的测试**

创建 `test/models.test.mjs`：

```js
import { test, expect } from "bun:test"
import { modelsFromCatalog, profileOfFrom, runtimeModel } from "../lib/models.mjs"

// 实测自 /api/models/available 的条目形状
const ENTRY = {
  modelId: "deepseek-flash", modelName: "DeepSeek Flash", provider: "LobsterAI",
  apiFormat: "openai", supportsImage: false, supportsThinking: true,
  thinkingConfig: {
    options: [{ level: "off", openclawLevel: "off" }, { level: "high", openclawLevel: "high" }, { level: "max", openclawLevel: "xhigh" }],
    defaultLevel: "max",
  },
  requestCapabilities: ["lobsterai-options-v1"],
  contextWindow: 1000000, costMultiplier: 0.1, accessible: true,
}

test("maps a catalog entry to a magpie model", () => {
  const m = runtimeModel(ENTRY, {})
  expect(m.id).toBe("deepseek-flash")
  expect(m.name).toBe("DeepSeek Flash")
  expect(m.limit).toEqual({ context: 1000000, output: 32000 })
  expect(m.capabilities.reasoning).toBe(true)
  expect(m.capabilities.toolcall).toBe(true)
  expect(m.capabilities.input.image).toBe(false)
  expect(m.rate).toBe(0.1)
})

test("thinking options become variants keyed by level", () => {
  expect(runtimeModel(ENTRY, {}).variants).toEqual({
    off: { lobsterai_thinking: "off" },
    high: { lobsterai_thinking: "high" },
    max: { lobsterai_thinking: "max" },
  })
})

test("image support reaches modalities and capabilities", () => {
  const m = runtimeModel({ ...ENTRY, supportsImage: true }, {})
  expect(m.capabilities.input.image).toBe(true)
})

test("inaccessible models are dropped", () => {
  const out = modelsFromCatalog([
    ENTRY,
    { ...ENTRY, modelId: "hidden", accessible: false },
  ], { models: {} })
  expect(Object.keys(out)).toEqual(["deepseek-flash"])
})

test("an empty catalog yields an empty map, not a crash", () => {
  expect(modelsFromCatalog([], { models: {} })).toEqual({})
})

test("profileOfFrom indexes thinking profiles by model id", () => {
  const p = profileOfFrom([ENTRY])
  expect(p["deepseek-flash"].defaultLevel).toBe("max")
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test test/models.test.mjs`
Expected: FAIL — `Cannot find module '../lib/models.mjs'`

- [ ] **Step 3: 写 `lib/models.mjs`**

```js
// /api/models/available 的条目 → magpie 的运行时模型。
// 运行时模型用嵌套的 capabilities；config 钩子用扁平字段（见 constants.configModel）。

import { NPM, DEFAULT_OUTPUT, DEFAULT_CONTEXT, configModel } from "./constants.mjs"
import { variantsOf } from "./thinking.mjs"

export function runtimeModel(entry, base = {}) {
  const id = String(entry.modelId ?? "")
  const image = !!entry.supportsImage
  const profile = entry.thinkingConfig
  const hasThinking = !!entry.supportsThinking && Array.isArray(profile?.options) && profile.options.length > 0

  return {
    ...base,
    id,
    providerID: base.providerID,
    name: String(entry.modelName ?? id),
    api: { id, url: "", npm: NPM },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: Number(entry.contextWindow) || DEFAULT_CONTEXT, output: DEFAULT_OUTPUT },
    capabilities: {
      temperature: true,
      reasoning: hasThinking,
      attachment: image,
      toolcall: true,
      input: { text: true, image, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
    variants: hasThinking ? variantsOf(profile) : {},
    // magpie 自己的字段：一次请求消耗的点数倍率
    rate: Number(entry.costMultiplier) || 0,
  }
}

export function modelsFromCatalog(list, provider) {
  const out = {}
  for (const entry of Array.isArray(list) ? list : []) {
    if (!entry || entry.accessible === false) continue
    const id = String(entry.modelId ?? "")
    if (!id) continue
    const was = provider?.models?.[id] ?? {}
    out[id] = runtimeModel(entry, { ...was, providerID: provider?.id })
  }
  return out
}

export function profileOfFrom(list) {
  const out = {}
  for (const entry of Array.isArray(list) ? list : []) {
    const id = String(entry?.modelId ?? "")
    if (id && entry.thinkingConfig) out[id] = entry.thinkingConfig
  }
  return out
}

// 未登录时 config 钩子用的扁平形状
export function configModels(list) {
  const out = {}
  for (const entry of Array.isArray(list) ? list : []) {
    if (!entry || entry.accessible === false) continue
    const id = String(entry.modelId ?? "")
    if (!id) continue
    out[id] = configModel({
      name: String(entry.modelName ?? id),
      context: Number(entry.contextWindow) || DEFAULT_CONTEXT,
      output: DEFAULT_OUTPUT,
      reasoning: !!entry.supportsThinking,
      image: !!entry.supportsImage,
    })
  }
  return out
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test test/models.test.mjs`
Expected: PASS — 6 pass

- [ ] **Step 5: 提交**

```bash
git add lib/models.mjs test/models.test.mjs
git commit -m "feat: 模型发现与映射"
```

---

### Task 8: 用量映射

**Files:**
- Create: `lib/usage.mjs`
- Test: `test/usage.test.mjs`

**Interfaces:**
- Consumes: 无
- Produces: `usageFrom(quota, profile, signIn)` → usage 对象（magpie 的 `auth.usage` 返回形状）

- [ ] **Step 1: 写失败的测试**

创建 `test/usage.test.mjs`：

```js
import { test, expect } from "bun:test"
import { usageFrom } from "../lib/usage.mjs"

// 实测自 /api/user/quota 与 /api/user/profile-summary
const QUOTA = {
  freeCreditsUsed: 19.427564, freeCreditsTotal: 300, freeCreditsRemaining: 0,
  freeCreditsExpired: true, freeCreditsExpiresAt: "2026-08-21",
  hasPaidCredits: true, dailyCreditsUsed: 0,
  subscriptionStatus: "free", planName: "免费",
  deploymentEntitled: false, shareEntitled: false,
}
const PROFILE = {
  id: 67097, nickname: "Ada", avatarUrl: null, totalCreditsRemaining: 1399.98,
  creditItems: [{ type: "campaign", label: "每日登录奖励", creditsRemaining: 100, expiresAt: "2026-11-01" }],
}

test("plan, user and balance come from the two endpoints", () => {
  const u = usageFrom(QUOTA, PROFILE)
  expect(u.plan).toBe("免费")
  expect(u.user).toBe("Ada")
  expect(u.balance).toBe("1399.98 点数")
})

test("the free allowance becomes a window with a share", () => {
  const u = usageFrom(QUOTA, PROFILE)
  const w = u.windows.find((x) => x.name === "免费额度")
  expect(w.used).toBeCloseTo(6.48, 1)
  expect(w.display).toContain("19.4")
  expect(w.display).toContain("300")
})

test("until is the earliest credit expiry", () => {
  const u = usageFrom(QUOTA, { ...PROFILE, creditItems: [
    { expiresAt: "2026-12-01" }, { expiresAt: "2026-10-15" },
  ] })
  expect(u.until).toBe("2026-10-15")
})

test("signIn rides along when given", () => {
  expect(usageFrom(QUOTA, PROFILE, "renewed").signIn).toBe("renewed")
})

test("missing pieces degrade instead of throwing", () => {
  const u = usageFrom({}, {})
  expect(u.windows).toEqual([])
  expect(u.balance).toBe("")
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test test/usage.test.mjs`
Expected: FAIL — `Cannot find module '../lib/usage.mjs'`

- [ ] **Step 3: 写 `lib/usage.mjs`**

```js
// magpie 的 auth.usage 返回形状。数据来自两个端点：
//   GET /api/user/quota            免费额度与订阅状态
//   GET /api/user/profile-summary  昵称、剩余积分明细

const round = (n, d = 2) => {
  const p = 10 ** d
  return Math.round(Number(n) * p) / p
}

export function usageFrom(quota, profile, signIn) {
  const q = quota ?? {}
  const p = profile ?? {}
  const out = { windows: [] }

  if (q.planName) out.plan = String(q.planName)
  if (p.nickname) out.user = String(p.nickname)

  const left = Number(p.totalCreditsRemaining)
  out.balance = Number.isFinite(left) && left > 0 ? `${round(left)} 点数` : ""

  const total = Number(q.freeCreditsTotal)
  const used = Number(q.freeCreditsUsed)
  if (Number.isFinite(total) && total > 0) {
    const u = Number.isFinite(used) ? used : 0
    out.windows.push({
      name: "免费额度",
      used: round((u / total) * 100),
      display: `${round(u, 1)} / ${round(total, 1)} 免费积分`,
      aside: !!q.freeCreditsExpired,
    })
  }

  const dates = (Array.isArray(p.creditItems) ? p.creditItems : [])
    .map((c) => c?.expiresAt)
    .filter((d) => typeof d === "string" && d !== "")
    .sort()
  if (dates.length > 0) out.until = dates[0]

  if (signIn) out.signIn = signIn
  return out
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test test/usage.test.mjs`
Expected: PASS — 5 pass

- [ ] **Step 5: 提交**

```bash
git add lib/usage.mjs test/usage.test.mjs
git commit -m "feat: 用量映射"
```

---

### Task 9: 从本机 LobsterAI 导入登录

**Files:**
- Create: `lib/auth-import.mjs`
- Test: `test/auth-import.test.mjs`

**Interfaces:**
- Consumes: Task 2 的 `jwtExp`、`accountOf`
- Produces:
  - `dbPath(env)` → `string`
  - `readCredentials(path)` → `{accessToken, refreshToken, yid, id, nickname}`，读不到返回 `null`
  - `desktopSignIn(env)` → magpie 的 oauth 账号 `{type:"success", refresh:"", access:"", expires:0, source:"desktop", accountId, uid}`，失败抛错
  - `desktopToken(env)` → 现读桌面端当前 token `string`；读不到抛 `{signIn:"expired"}`

- [ ] **Step 1: 写失败的测试**

创建 `test/auth-import.test.mjs`：

```js
import { test, expect } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { dbPath, readCredentials, desktopSignIn, desktopToken } from "../lib/auth-import.mjs"

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url")
const TOKEN = `h.${b64({ sub: 67097, yid: "urs-phoneyd.abc@163.com", exp: 1793152423 })}.s`

function makeDb({ tokens = TOKEN, user = '{"yid":"urs-phoneyd.abc@163.com","id":67097,"nickname":"Ada"}' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "lobster-test-"))
  const file = join(dir, "lobsterai.sqlite")
  const db = new Database(file, { create: true })
  db.run("CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)")
  if (tokens !== null) {
    db.run("INSERT INTO kv VALUES (?,?,?)", ["auth_tokens", JSON.stringify({ accessToken: tokens, refreshToken: "r" }), 0])
  }
  if (user !== null) db.run("INSERT INTO kv VALUES (?,?,?)", ["auth_user", user, 0])
  db.close()
  return { dir, file }
}

test("dbPath is the desktop app's data directory", () => {
  const p = dbPath({ APPDATA: "C:\\Users\\x\\AppData\\Roaming" })
  expect(p).toContain("LobsterAI")
  expect(p.endsWith("lobsterai.sqlite")).toBe(true)
})

test("reads the token and the account", () => {
  const { dir, file } = makeDb()
  try {
    const c = readCredentials(file)
    expect(c.accessToken).toBe(TOKEN)
    expect(c.refreshToken).toBe("r")
    expect(c.nickname).toBe("Ada")
    expect(c.yid).toBe("urs-phoneyd.abc@163.com")
    expect(c.id).toBe(67097)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("a database without the keys reads as null", () => {
  const { dir, file } = makeDb({ tokens: null, user: null })
  try { expect(readCredentials(file)).toBeNull() }
  finally { rmSync(dir, { recursive: true, force: true }) }
})

test("a missing file reads as null, not a throw", () => {
  expect(readCredentials(join(tmpdir(), "definitely-absent-lobster.sqlite"))).toBeNull()
})

// 造一份「桌面端已经登录」的环境：目录按各平台的 dbPath 规则摆好
function makeDesktop({ tokens = TOKEN } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "lobster-desktop-"))
  const env = { APPDATA: dir, HOME: dir, USERPROFILE: dir, XDG_CONFIG_HOME: dir }
  const file = dbPath(env)
  mkdirSync(dirname(file), { recursive: true })
  const db = new Database(file, { create: true })
  db.run("CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)")
  if (tokens !== null) {
    db.run("INSERT INTO kv VALUES (?,?,?)", ["auth_tokens", JSON.stringify({ accessToken: tokens, refreshToken: "r" }), 0])
    db.run("INSERT INTO kv VALUES (?,?,?)", ["auth_user", '{"yid":"urs-phoneyd.abc@163.com","id":67097,"nickname":"Ada"}', 0])
  }
  db.close()
  return { dir, env }
}

test("the desktop sign-in stores no token of its own", () => {
  const { dir, env } = makeDesktop()
  try {
    const r = desktopSignIn(env)
    expect(r.type).toBe("success")
    // 关键：一个字节的凭据都不留。抄一份 refreshToken 会让桌面端和插件
    // 共用同一个 token，谁先续期谁就把对方踢下线。
    expect(r.access).toBe("")
    expect(r.refresh).toBe("")
    expect(r.expires).toBe(0)
    expect(r.source).toBe("desktop")
    expect(r.accountId).toBe("urs-phoneyd.abc@163.com")
    expect(r.uid).toBe(67097)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("a desktop sign-in with nothing to read fails loudly", () => {
  const { dir, env } = makeDesktop({ tokens: null })
  try {
    expect(() => desktopSignIn(env)).toThrow(/LobsterAI/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("the desktop token is read fresh each time", () => {
  const { dir, env } = makeDesktop()
  try {
    expect(desktopToken(env)).toBe(TOKEN)
    // 桌面端续期后，插件下一次调用立刻用上新的 token
    const other = `h.${b64({ sub: 67097, yid: "urs-phoneyd.abc@163.com", exp: 1793152423 })}.s2`
    const db = new Database(dbPath(env))
    db.run("UPDATE kv SET value=? WHERE key='auth_tokens'", [JSON.stringify({ accessToken: other, refreshToken: "r" })])
    db.close()
    expect(desktopToken(env)).toBe(other)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("an unreadable desktop token is reported as a lapsed sign-in", () => {
  const { dir, env } = makeDesktop({ tokens: null })
  try {
    let caught = null
    try { desktopToken(env) } catch (e) { caught = e }
    expect(caught?.signIn).toBe("expired")
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("junk in the row reads as null", () => {
  const { dir, file } = makeDb({ tokens: null, user: null })
  try {
    const db = new Database(file)
    db.run("INSERT INTO kv VALUES (?,?,?)", ["auth_tokens", "not json", 0])
    db.close()
    expect(readCredentials(file)).toBeNull()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test test/auth-import.test.mjs`
Expected: FAIL — `Cannot find module '../lib/auth-import.mjs'`

- [ ] **Step 3: 写 `lib/auth-import.mjs`**

```js
// 从本机 LobsterAI 桌面端的 sqlite 里读出登录信息。
// 表：CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)
//   auth_tokens -> {"accessToken":"…","refreshToken":"…"}
//   auth_user   -> {"yid","id","nickname"}
//
// 必须只读：桌面端可能正在运行，插件绝不写入它的库。

import { Database } from "bun:sqlite"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { jwtExp, accountOf } from "./jwt.mjs"

export function dbPath(env = process.env) {
  const home = env.HOME || env.USERPROFILE || ""
  if (process.platform === "win32") {
    const appdata = env.APPDATA || (home ? join(home, "AppData", "Roaming") : "")
    return join(appdata, "LobsterAI", "lobsterai.sqlite")
  }
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "LobsterAI", "lobsterai.sqlite")
  }
  const cfg = env.XDG_CONFIG_HOME || join(home, ".config")
  return join(cfg, "LobsterAI", "lobsterai.sqlite")
}

const parse = (s) => {
  try {
    const v = JSON.parse(String(s ?? ""))
    return v && typeof v === "object" ? v : null
  } catch { return null }
}

export function readCredentials(path) {
  if (!path || !existsSync(path)) return null
  let db
  try {
    // 只读打开：绝不改动桌面端的库
    db = new Database(path, { readonly: true })
    const rows = db.query("SELECT key, value FROM kv WHERE key IN ('auth_tokens','auth_user')").all()
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]))
    const tokens = parse(byKey.auth_tokens)
    const accessToken = String(tokens?.accessToken ?? "")
    if (!accessToken) return null
    const user = parse(byKey.auth_user) ?? {}
    const claims = accountOf(accessToken)
    return {
      accessToken,
      refreshToken: String(tokens?.refreshToken ?? ""),
      yid: user.yid ?? claims.yid,
      id: user.id ?? claims.id,
      nickname: user.nickname,
      expires: jwtExp(accessToken),
    }
  } catch {
    return null
  } finally {
    try { db?.close() } catch {}
  }
}

// 桌面端这条路只借一个身份，**不存 token**：
//   access/refresh 都留空，expires 为 0，靠 source:"desktop" 标记来源。
// token 每次用的时候现读（desktopToken），所以桌面端续期后插件自动跟着用新的。
//
// 为什么不把 token 抄一份：抄下来的 refreshToken 会是桌面端和插件共用的，
// 谁先续期谁就把对方踢下线。留空则 magpie 永不续期（expires 为 0），
// 桌面端的会话不受任何影响。
export function desktopSignIn(env = process.env) {
  const path = dbPath(env)
  const c = readCredentials(path)
  if (!c) {
    throw new Error(
      `没有在本机找到 LobsterAI 的登录信息（${path}）。` +
      "请先在 LobsterAI 桌面端登录，或改用「浏览器登录」。",
    )
  }
  return {
    type: "success",
    refresh: "",
    access: "",
    expires: 0,
    source: "desktop",
    accountId: c.yid ?? (c.id !== undefined ? String(c.id) : undefined),
    uid: c.id,
  }
}

// 桌面端账号的 token：每次现读，桌面端换了 token 插件立刻跟上。
// 读不到就是账号不可用（桌面端退出登录、库被删、文件被加密），
// 报 signIn:"expired" 让 magpie 给账号打上失效标记，提示用户重新登录。
export function desktopToken(env = process.env) {
  const c = readCredentials(dbPath(env))
  if (!c) {
    throw Object.assign(
      new Error("LobsterAI 桌面端未登录，或它的登录信息已不可读"),
      { signIn: "expired" },
    )
  }
  return c.accessToken
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test test/auth-import.test.mjs`
Expected: PASS — 9 pass

- [ ] **Step 5: 提交**

```bash
git add lib/auth-import.mjs test/auth-import.test.mjs
git commit -m "feat: 从本机 LobsterAI 导入登录"
```

---

### Task 10: 浏览器登录

**Files:**
- Create: `lib/auth-login.mjs`
- Test: `test/auth-login.test.mjs`

**Interfaces:**
- Consumes: Task 2 的 `jwtExp`、`accountOf`
- Produces:
  - `authorizeUrl(loginUrl, callbackUrl, state)` → `string`
  - `beginSignIn({timeoutMs})` → `{url, finish(), close()}`（`finish()` 解析为 oauth 登录结果 `{type:"success", refresh, access, expires, accountId}`）
  - `signIn({open, timeoutMs})` → 同上，额外用 `open(url)` 打开浏览器

- [ ] **Step 1: 写失败的测试**

创建 `test/auth-login.test.mjs`：

```js
import { test, expect } from "bun:test"
import { authorizeUrl } from "../lib/auth-login.mjs"

test("login params ride the hash query, as the portal expects", () => {
  const u = new URL(authorizeUrl(
    "https://lobsterai.youdao.com/portal#/login",
    "http://127.0.0.1:5555/auth/callback",
    "st4te",
  ))
  expect(u.origin + u.pathname).toBe("https://lobsterai.youdao.com/portal")
  expect(u.hash.startsWith("#/login?")).toBe(true)
  const q = new URLSearchParams(u.hash.slice(u.hash.indexOf("?") + 1))
  expect(q.get("source")).toBe("electron")
  expect(q.get("state")).toBe("st4te")
  expect(q.get("redirect_uri")).toBe("http://127.0.0.1:5555/auth/callback")
})

test("return_to points back at the login page's success state", () => {
  const u = new URL(authorizeUrl(
    "https://lobsterai.youdao.com/portal#/login", "http://127.0.0.1:5555/auth/callback", "s",
  ))
  const q = new URLSearchParams(u.hash.slice(u.hash.indexOf("?") + 1))
  const back = q.get("redirect_uri")
  expect(back).toBe("http://127.0.0.1:5555/auth/callback")
  expect(q.get("source")).toBe("electron")
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test test/auth-login.test.mjs`
Expected: FAIL — `Cannot find module '../lib/auth-login.mjs'`

- [ ] **Step 3: 写 `lib/auth-login.mjs`**

```js
// 浏览器登录，走 LobsterAI 桌面端自己的通道。
//
// portal 的 auth 模块允许把授权码回调到任意
// http://127.0.0.1:<port>/auth/callback（条件是 http + 127.0.0.1 +
// /auth/callback + 有端口），因此插件可以自带登录，不依赖桌面端。
// 参数必须追加到登录页的 hash query，不是 URL query；且必须带
// source=electron，否则 portal 不会带上 redirect_uri。

import { createServer } from "node:http"
import { randomBytes } from "node:crypto"
import { API, LOGIN_URL } from "./constants.mjs"
import { jwtExp, accountOf } from "./jwt.mjs"

const TIMEOUT_MS = 5 * 60 * 1000

export function authorizeUrl(loginUrl, callbackUrl, state) {
  const base = loginUrl || LOGIN_URL
  const hashAt = base.indexOf("#")
  const head = hashAt === -1 ? base : base.slice(0, hashAt)
  const hash = hashAt === -1 ? "" : base.slice(hashAt + 1)
  const [route, query = ""] = hash.split("?")
  const q = new URLSearchParams(query)
  q.set("source", "electron")
  q.set("redirect_uri", callbackUrl)
  q.set("state", state)
  return `${head}#${route}?${q.toString()}`
}

// 起一个只监听 127.0.0.1 的临时服务；端口由系统分配（listen 0）。
// 返回 { port, result(ms), close() }，把「等回调」和「关服务」分开，
// 这样调用方可以先拿到端口拼 URL，再去等结果。
function listenOnce() {
  return new Promise((resolve, reject) => {
    let deliver = () => {}
    const got = new Promise((r) => { deliver = r })
    let timer = null
    const server = createServer((req, res) => {
      const u = new URL(req.url, "http://127.0.0.1")
      if (u.pathname !== "/auth/callback") { res.writeHead(404).end(); return }
      const code = u.searchParams.get("code")
      const state = u.searchParams.get("state")
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      res.end(code
        ? "<h2>登录成功，可以关闭此页面。</h2>"
        : "<h2>登录失败：没有拿到授权码。</h2>")
      deliver({ code, state })
    })
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address()
      resolve({
        port,
        close() {
          if (timer) clearTimeout(timer)
          try { server.close() } catch {}
        },
        result(ms) {
          const late = new Promise((r) => {
            timer = setTimeout(() => r({ error: new Error("登录超时（5 分钟）") }), ms)
          })
          return Promise.race([got, late]).then((v) => {
            if (v?.error) throw v.error
            return v
          })
        },
      })
    })
  })
}

async function exchangeCode(code) {
  const res = await fetch(`${API}/auth/exchange`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ authCode: code, firstKeyfrom: "official", latestKeyfrom: "official" }),
    signal: AbortSignal.timeout(30_000),
  })
  const text = await res.text()
  let v
  try { v = JSON.parse(text) } catch { throw new Error(`LobsterAI 的登录响应无法解析：${text.slice(0, 200)}`) }
  // /api/* 用 {code, message, data} 信封，业务错误也是 HTTP 200
  if (v?.code !== 0 || !v?.data) {
    throw new Error(`LobsterAI 拒绝了登录：${v?.message || `code ${v?.code}`}`)
  }
  return v.data
}

// beginSignIn 起回调服务并拼出授权地址，然后把「等回调并换 token」交给
// finish()。分成两半是因为由 magpie 负责打开 authorize 返回的 url ——
// 插件自己再开一次就会开两个标签页。
export async function beginSignIn({ timeoutMs = TIMEOUT_MS } = {}) {
  const state = randomBytes(24).toString("base64url")
  const listening = await listenOnce()
  const callbackUrl = `http://127.0.0.1:${listening.port}/auth/callback`
  const url = authorizeUrl(LOGIN_URL, callbackUrl, state)

  const finish = async () => {
    try {
      const got = await listening.result(timeoutMs)
      if (got.state !== state) throw new Error("登录回调的 state 不匹配，已忽略")
      const data = await exchangeCode(got.code)
      const access = String(data.accessToken ?? "")
      if (!access) throw new Error("LobsterAI 没有返回 accessToken")
      const who = accountOf(access)
      return {
        type: "success",
        refresh: String(data.refreshToken ?? ""),
        access,
        expires: jwtExp(access) || Date.now() + 30 * 24 * 3600 * 1000,
        accountId: who.yid ?? (who.id !== undefined ? String(who.id) : undefined),
      }
    } finally {
      listening.close()
    }
  }

  return { url, finish, close: () => listening.close() }
}

// signIn 是 beginSignIn 的「自己开浏览器」封装：给命令行与测试用。
// open 可注入，因此测试里不必真的弹浏览器。
export async function signIn({ open, timeoutMs = TIMEOUT_MS } = {}) {
  const pending = await beginSignIn({ timeoutMs })
  try {
    await open(pending.url)
    return await pending.finish()
  } catch (e) {
    pending.close()
    throw e
  }
}
```

- [ ] **Step 4: 补充集成测试（用假 portal）**

在 `test/auth-login.test.mjs` 末尾追加：

```js
import { signIn } from "../lib/auth-login.mjs"

test("signIn completes the loopback callback and returns an oauth account", async () => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url")
  const token = `h.${b64({ sub: 67097, yid: "u@x.com", exp: 1793152423 })}.s`

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url)
      // 注意：这里只替换 origin，pathname 仍然是 /api/auth/exchange
      if (u.pathname === "/api/auth/exchange") {
        return Response.json({ code: 0, message: "OK", data: { accessToken: token, refreshToken: "rt" } })
      }
      return new Response("nope", { status: 404 })
    },
  })

  // 把 exchange 指向假服务端
  const orig = globalThis.fetch
  globalThis.fetch = (input, init) => {
    const s = String(input)
    return s.includes("/api/auth/exchange")
      ? orig(s.replace(/^https?:\/\/[^/]+/, `http://127.0.0.1:${server.port}`), init)
      : orig(input, init)
  }

  try {
    const out = await signIn({
      open: async (url) => {
        // 假装用户在浏览器里登录：直接把 code 回调到 redirect_uri
        const q = new URLSearchParams(new URL(url).hash.split("?")[1])
        const cb = new URL(q.get("redirect_uri"))
        cb.searchParams.set("code", "fake-code")
        cb.searchParams.set("state", q.get("state"))
        await fetch(cb.toString())
      },
      timeoutMs: 5000,
    })
    expect(out.type).toBe("success")
    expect(out.access).toBe(token)
    expect(out.refresh).toBe("rt")
    expect(out.accountId).toBe("u@x.com")
  } finally {
    globalThis.fetch = orig
    server.stop(true)
  }
})
```

- [ ] **Step 5: 运行测试确认通过**

Run: `bun test test/auth-login.test.mjs`
Expected: PASS — 3 pass

- [ ] **Step 6: 提交**

```bash
git add lib/auth-login.mjs test/auth-login.test.mjs
git commit -m "feat: 浏览器登录"
```

---

### Task 11: 装配钩子、README 与沙箱冒烟

**Files:**
- Modify: `index.mjs`
- Create: `README.md`
- Test: `test/plugin.test.mjs`

**Interfaces:**
- Consumes: 前面所有任务的模块
- Produces: 完整的 `index.mjs` 钩子集合

- [ ] **Step 1: 写失败的测试**

创建 `test/plugin.test.mjs`：

```js
import { test, expect } from "bun:test"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { LobsterAuthPlugin as plugin, _internal } from "../index.mjs"
import { PROVIDER } from "../lib/constants.mjs"

test("the module exports exactly one plugin function", async () => {
  expect(typeof plugin).toBe("function")
  expect(typeof _internal).toBe("object")
  // magpie 会把每个导出的函数都当成插件；多一个就会撞 provider id
  const mod = await import("../index.mjs")
  const fns = Object.values(mod).filter((v) => typeof v === "function")
  expect(fns.length).toBe(1)
})

test("config declares the provider without clobbering the user's", async () => {
  const hooks = await plugin({})
  const cfg = { provider: { [PROVIDER]: { name: "mine" } } }
  await hooks.config(cfg)
  expect(cfg.provider[PROVIDER].name).toBe("mine")
})

test("config declares the provider when absent", async () => {
  const hooks = await plugin({})
  const cfg = {}
  await hooks.config(cfg)
  expect(cfg.provider[PROVIDER].name).toBe("LobsterAI")
  expect(cfg.provider[PROVIDER].npm).toBe("@ai-sdk/openai-compatible")
  expect(Object.keys(cfg.provider[PROVIDER].models).length).toBeGreaterThan(0)
})

test("both sign-in methods are offered", async () => {
  const hooks = await plugin({})
  const kinds = hooks.auth.methods.map((m) => m.type)
  // 两条都必须是 oauth：api 类型会逼 magpie 从 stdin 读一个 key，
  // 而「导入本机登录」这条路不需要用户输入任何东西。
  expect(kinds).toEqual(["oauth", "oauth"])
  expect(hooks.auth.provider).toBe(PROVIDER)
  expect(hooks.auth.refreshLead).toBeGreaterThan(0)
})

test("the desktop method opens no page and needs no typing", async () => {
  const hooks = await plugin({})
  const m = hooks.auth.methods[1]
  expect(m.label).toContain("导入")
  const started = await m.authorize()
  // url 为空 = magpie 不弹浏览器；有 callback 才能拿到结果
  expect(started.url).toBe("")
  expect(typeof started.callback).toBe("function")
  expect(started.method).toBe("auto")
})

test("the desktop method reports a failure instead of throwing", async () => {
  const hooks = await plugin({})
  // 本机没有桌面端登录信息时，authorize 仍要正常返回，由 callback 报错
  const started = await hooks.auth.methods[1].authorize()
  const done = await started.callback()
  expect(typeof done).toBe("object")
  expect(["success", "failed"]).toContain(done.type)
})

test("refresh never touches a desktop sign-in", async () => {
  const hooks = await plugin({})
  const desktop = { type: "oauth", source: "desktop", access: "", refresh: "", expires: 0 }
  expect(await hooks.auth.refresh(desktop)).toEqual({})
})

test("models() falls back to the declared list when not signed in", async () => {
  const hooks = await plugin({})
  const provider = { id: PROVIDER, models: { a: { id: "a" } } }
  expect(await hooks.provider.models(provider, { auth: undefined })).toEqual(provider.models)
})

test("a desktop sign-in whose store vanished reports a lapsed account", async () => {
  const hooks = await plugin({})
  const provider = { id: PROVIDER, models: { a: { id: "a" } } }
  // source:desktop 的账号不存 token，读不到库就是账号失效。
  // 本机可能真的装了 LobsterAI，所以把 APPDATA 指到不存在的目录，
  // 让这条断言不依赖跑测试的机器。
  const was = process.env.APPDATA
  process.env.APPDATA = join(tmpdir(), "lobster-absent-store")
  try {
    let caught = null
    try {
      await hooks.provider.models(provider, { auth: { type: "oauth", source: "desktop" } })
    } catch (e) { caught = e }
    expect(caught?.signIn).toBe("expired")
  } finally {
    if (was === undefined) delete process.env.APPDATA
    else process.env.APPDATA = was
  }
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test test/plugin.test.mjs`
Expected: FAIL — `auth` / `provider` 尚不存在

- [ ] **Step 3: 写完整的 `index.mjs`**

```js
import { PROVIDER, NAME, API, CHAT_BASE, NPM, FALLBACK_MODELS } from "./lib/constants.mjs"
import { makeFetch } from "./lib/proxy.mjs"
import { modelsFromCatalog, profileOfFrom } from "./lib/models.mjs"
import { usageFrom } from "./lib/usage.mjs"
import { desktopSignIn, desktopToken } from "./lib/auth-import.mjs"
import { beginSignIn } from "./lib/auth-login.mjs"
import { jwtExp } from "./lib/jwt.mjs"

const REFRESH_LEAD = 6 * 3600 * 1000

// 每个账号的模型 → 思考档位，供请求管线查表
const profiles = new Map()

async function apiGet(path, token, timeout = 20_000) {
  const res = await fetch(API + path, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(timeout),
  })
  const text = await res.text()
  let v
  try { v = JSON.parse(text) } catch { throw new Error(`LobsterAI ${path}: 响应无法解析`) }
  if (res.status === 401) {
    throw Object.assign(new Error("LobsterAI 的登录已过期，请重新登录"), { signIn: "expired" })
  }
  if (v?.code !== 0) throw new Error(`LobsterAI ${path}: ${v?.message || `code ${v?.code}`}`)
  return v.data
}

// 取这次请求要用的 token。
// 桌面端导入的账号自己不存 token（见 Task 9），每次现读 ——
// 桌面端续期后插件自动跟上。读不到就抛 signIn:"expired"。
async function tokenOf(auth) {
  if (!auth) return ""
  if (auth.source === "desktop") return desktopToken()
  return auth.type === "oauth" ? (auth.access ?? "") : (auth.key ?? "")
}

export const LobsterAuthPlugin = async () => ({
  config: async (cfg) => {
    cfg.provider ??= {}
    cfg.provider[PROVIDER] ??= {
      name: NAME,
      npm: NPM,
      api: API,
      models: FALLBACK_MODELS,
    }
  },

  auth: {
    provider: PROVIDER,
    refreshLead: REFRESH_LEAD,

    methods: [
      {
        type: "oauth",
        label: "浏览器登录（有道账号）",
        async authorize() {
          // 由 magpie 打开这个 url；插件不再自己开一次，否则会开两个标签页
          const pending = await beginSignIn()
          return {
            url: pending.url,
            instructions: "在浏览器里用有道账号登录，完成后回到这里。",
            method: "auto",
            callback: () => pending.finish(),
          }
        },
      },
      {
        // 必须是 oauth：api 类型会让 magpie 强制从 stdin 读一个 key，
        // 而这条路根本不需要用户输入任何东西（见设计文档 §4.3）。
        type: "oauth",
        label: "从本机 LobsterAI 导入登录",
        async authorize() {
          // url 留空：magpie 不打开任何页面，直接走 callback
          return {
            url: "",
            instructions: "直接使用本机 LobsterAI 桌面端已登录的账号。",
            method: "auto",
            async callback() {
              try {
                return desktopSignIn()
              } catch (e) {
                return { type: "failed", error: e.message }
              }
            },
          }
        },
      },
    ],

    // 只对路径 A（浏览器登录，有 refresh 和 expires）生效。
    // 路径 B（桌面端导入）的 refresh 是空串、expires 为 0，
    // magpie 不会调用这里，桌面端的会话因此不会被搅动。
    async refresh(auth) {
      if (auth?.type !== "oauth" || auth.source === "desktop" || !auth.refresh) return {}
      const res = await fetch(`${API}/auth/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken: auth.refresh }),
        signal: AbortSignal.timeout(30_000),
      })
      const text = await res.text()
      let v
      try { v = JSON.parse(text) } catch { throw new Error("LobsterAI 续期：响应无法解析") }
      if (v?.code !== 0 || !v?.data?.accessToken) {
        throw Object.assign(new Error(`LobsterAI 续期失败：${v?.message || `code ${v?.code}`}`), { signIn: "expired" })
      }
      const d = v.data
      return {
        access: String(d.accessToken),
        refresh: String(d.refreshToken ?? auth.refresh),
        // 上游可能不给新 token 的 exp；读不到就沿用旧的到期时间
        expires: jwtExp(d.accessToken) || auth.expires || 0,
      }
    },

    async loader(getAuth) {
      const auth = await getAuth()
      // 这里只是给 magpie 一个「看起来已登录」的信号；真正的 token
      // 由下面的 fetch 每次请求现取（桌面端账号尤其需要）。
      let token = ""
      try { token = await tokenOf(auth) } catch { return {} }
      if (!token) return {}
      return {
        baseURL: CHAT_BASE,
        apiKey: token,
        headers: {},
        fetch: makeFetch({
          getAuth,
          tokenOf,
          profileOf: (id) => profiles.get(String(id)),
          call: (input, init) => fetch(input, init),
        }),
      }
    },

    async usage(getAuth) {
      const auth = await getAuth()
      let token = ""
      try { token = await tokenOf(auth) } catch (e) {
        return { error: e.message, windows: [], signIn: e.signIn === "expired" ? "expired" : "kept" }
      }
      if (!token) return { error: "尚未登录", windows: [] }
      try {
        const [quota, profile] = await Promise.all([
          apiGet("/user/quota", token),
          apiGet("/user/profile-summary", token),
        ])
        // 插件自己不续期（交给 magpie 的 auth.refresh），所以这次请求用的
        // 就是存下来的 token —— 如实报 kept。社区插件报 renewed 是因为它们
        // 自己维护续期表，这里没有那张表，不该照抄。
        return usageFrom(quota, profile, "kept")
      } catch (e) {
        return {
          error: e.message,
          windows: [],
          signIn: e.signIn === "expired" ? "expired" : "kept",
        }
      }
    },
  },

  provider: {
    id: PROVIDER,
    async models(provider, { auth } = {}) {
      let token = ""
      try { token = await tokenOf(auth) } catch (e) {
        if (e.signIn === "expired") throw e
        return provider.models
      }
      if (!token) return provider.models
      try {
        const list = await apiGet(
          "/models/available?firstKeyfrom=official&latestKeyfrom=official",
          token,
        )
        if (!Array.isArray(list) || list.length === 0) return provider.models
        for (const [id, p] of Object.entries(profileOfFrom(list))) profiles.set(id, p)
        const out = modelsFromCatalog(list, { ...provider, id: PROVIDER })
        return Object.keys(out).length > 0 ? out : provider.models
      } catch (e) {
        // 登录失效要标记账号；其余情况保留原列表
        if (e.signIn === "expired") throw e
        return provider.models
      }
    },
  },
})

export const _internal = { PROVIDER, FALLBACK_MODELS, usageFrom, modelsFromCatalog }
```

> **注意：** 模块里**只能有一个函数导出**——magpie 会把每个导出的函数都当成一个插件加载。`_internal` 是对象，安全；不要再加第二个函数导出（例如 `export default` 之外再 `export const X = () => {}`），否则 provider 会因 id 冲突被改名成 `lobster-plugin`。

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test`
Expected: PASS — 全部测试通过

- [ ] **Step 5: 写 `README.md`**

```markdown
# opencode-lobster-auth

为 [magpie](https://usemagpie.ai) 提供 provider `lobster`：使用有道
LobsterAI（有道龙虾）账号里的模型。

## 登录

两种方式，任选其一：

1. **浏览器登录** —— 插件在本机 `127.0.0.1` 起一个回调服务，打开有道登录页。
   登录成功后浏览器跳回本地，插件用授权码换取 token。存成 OAuth 账号，
   magpie 会在过期前自动续期。
2. **从本机 LobsterAI 导入** —— 只读读取 LobsterAI 桌面端的登录信息
   （Windows `%APPDATA%\LobsterAI\lobsterai.sqlite`）。**不弹浏览器、不需要
   输入任何东西**，直接使用桌面端当前登录的账号。
   这种方式需要先在本机安装并登录 LobsterAI 桌面端。

两种方式用同一个账号标识（有道账号的 `yid`），因此用第二种登录后，
再用第一种登录同一账号会原地替换它。

### 为什么导入这条路不保存 token

导入方式**一个字节的凭据都不存**（`access`、`refresh` 都是空串，`expires` 为 0），
只在每次请求时现读桌面端的库：

- 抄一份 `refreshToken` 会让桌面端和插件共用同一个 token，**谁先续期谁就把
  对方踢下线**。留空则双方互不干扰。
- `expires` 为 0，magpie 因此永不续期（它只在 `expires` 非零时才调用
  `auth.refresh`），桌面端的会话不会被搅动。
- 现读的好处是桌面端续期后，插件下一次请求自动用上新 token，不必重新登录。

代价是：如果桌面端退出登录、卸载或库文件不可读，这个账号会立刻失效并提示
重新登录 —— 这比用一个已经悄悄失效的旧 token 更诚实。

## 模型

登录后从 `/api/models/available` 拉取账号可用的模型（约 30 个，
含 DeepSeek、GLM、Kimi、Qwen、MiniMax、豆包等），并带上各自的思考档位。
未登录时显示一份静态兜底列表。

## 说明

- 思考档位通过 LobsterAI 的私有字段 `lobsterai_options` 传给上游；**只对
  有档位表的模型下发**，其余模型不下发（下发会被上游拒绝），它们照常思考。
- 上游始终以 SSE 作答（即使请求写了 `stream:false`），插件会为非流式
  请求重组；上游把错误放在 SSE 里且状态码仍为 200，插件会还原成真正的
  非 2xx，以便 magpie 故障切换。
- 本插件不会主动调用 LobsterAI 的续期接口去验证或刷新「导入」来的 token；
  续期只发生在浏览器登录的账号上，由 magpie 在过期前触发。
```

- [ ] **Step 6: 沙箱冒烟测试**

在独立 `HOME` 下运行，避免污染真实配置：

```powershell
$sb = Join-Path $env:TEMP "magpie-lobster-sbx"
Remove-Item $sb -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $sb | Out-Null
$env:HOME = $sb
$env:USERPROFILE = $sb
$env:XDG_CONFIG_HOME = Join-Path $sb ".config"
$env:XDG_CACHE_HOME = Join-Path $sb ".cache"
$env:MAGPIE_ADDR = "127.0.0.1:3499"
$magpie = "$env:LOCALAPPDATA\Programs\magpie\magpie.exe"
& $magpie plugin add D:\git\magpie-lobster
& $magpie plugin --json
```

> **注意：** 不要写 `& $magpie plugin add ... < $null`。`<` 在 PowerShell 里是
> 保留运算符（"“<”运算符保留供将来使用"），这样写会直接解析失败。实测
> `plugin add` 不会交互提问，不需要重定向 stdin。

Expected: `plugins[].providers` 里出现 `lobster`，有两个登录方式，且**没有**加载错误。

> 提示：Task 1 的 `index.mjs` 只有 `config` 钩子，此时 `providers` 会是空数组——
> provider 由 `auth` 钩子声明，要等 Task 11 装配完才出现。冒烟测试必须在 Task 11 之后跑。

- [ ] **Step 7: 真实调用验证**

在同一沙箱里登录并打一次真实请求：

```powershell
& $magpie plugin login lobster
& $magpie provider test lobster
& $magpie quota
```

Expected: `provider test` 显示 `✓ chat`；`quota` 显示套餐与剩余点数。

- [ ] **Step 8: 提交**

```bash
git add index.mjs README.md test/plugin.test.mjs
git commit -m "feat: 装配钩子、README 与沙箱验证"
```

---

## Self-Review

**1. Spec coverage**

| 设计文档章节 | 覆盖任务 |
| --- | --- |
| §2 上游接口面 | Task 1（常量）、Task 6（proxy）、Task 7/8（端点） |
| §3 文件布局 | 全部任务 |
| §4.1 浏览器登录 | Task 10 |
| §4.2 从本机导入 | Task 9 |
| §4.3 续期策略 | Task 11（`refresh` 只处理浏览器登录的 oauth 账号；桌面端导入的账号 `expires` 为 0 故不会被续期） |
| §5.1 模型发现 | Task 7 |
| §5.1 variants 通道 | Task 5（`variantsOf`）、Task 6（`applyThinking`） |
| §5.2 用量 | Task 8 |
| §6 坑 1（永远 SSE） | Task 4 |
| §6 坑 2（错误伪装 200） | Task 6 |
| §6 坑 3（思考档位 + K3） | Task 5、Task 6 |
| §7 测试与验证 | 每个任务的测试 + Task 11 沙箱 |
| §9 风险 | Task 9（只读）、Task 11（`maxConcurrency`） |

无缺口。

**2. Placeholder scan**

- 无 TBD / TODO / 「稍后实现」/「执行时替换」。
- 所有代码步骤都带完整代码块，直接可写。
- Task 10 的 `authorizeUrl` 被两个测试覆盖；`signIn` 由 Step 4 的假 portal 集成测试端到端覆盖。

**3. Type consistency**

- `profile`（思考档位表）在 Task 5 定义为 `{options:[{level,openclawLevel}], defaultLevel}`，Task 7 的 `profileOfFrom` 原样透传 `entry.thinkingConfig`，Task 11 存入 `profiles` Map，Task 6 通过 `profileOf(model)` 读取 —— 命名一致。
- `variantsOf`（Task 5）返回 `{[level]: {lobsterai_thinking: level}}`，Task 7 的 `runtimeModel` 调用它，Task 6 的 `applyThinking` 读同一个 `MARKER` 常量 —— 一致。
- `makeFetch({getAuth, tokenOf, profileOf, call})`（Task 6）与 Task 11 的调用点参数名一致；`tokenOf` 由调用方注入，因为桌面端导入的账号不存 token（见 Task 9）。
- `errorOf`/`statusFor` 只在 Task 6 使用，命名一致。
- `_internal` 在 Task 1 与 Task 11 都导出，Task 11 的版本是最终版。

`signIn`（Task 10）与 `desktopSignIn`（Task 9）都返回顶层 `accountId`（有道 `yid`），因此同一账号下后一次登录会原地替换前一次。

两条登录路径**都是 `oauth` 账号**，靠 `source` 与 `expires` 区分续期行为：

| | 浏览器登录 | 从本机 LobsterAI 导入 |
|---|---|---|
| `access` / `refresh` | 真 token | 都是 `""`（不存凭据） |
| `expires` | 真到期时间 | `0` |
| `source` | 无 | `"desktop"` |
| magpie 是否续期 | 是（`expires` 非零 + `refresh` 非空） | **否**（`expires` 为 0，magpie 只在非零时才调 `auth.refresh`） |
| token 来源 | 账号里的 `access` | 每次请求现读桌面端 sqlite |

导入这条路刻意**不保存 token**：抄一份 `refreshToken` 会让桌面端和插件共用同一个凭据，谁先续期谁就把对方踢下线。留空 + 现读则双方互不干扰，且桌面端续期后插件自动跟上。代价是桌面端退出登录后该账号立刻失效并提示重新登录 —— 这比继续用一个已悄悄失效的旧 token 更诚实。

`makeFetch` 因此接收注入的 `tokenOf(auth)`（Task 6），而不是自己写死「oauth 读 `access`、api 读 `key`」—— 桌面端账号的 `access` 是空的，写死就会解析出空 token。`desktopToken()` 抛 `{signIn:"expired"}`，`makeFetch` 把它转成带失效标记的 401。
