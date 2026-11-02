import { test, expect } from "bun:test"
import { errorOf, statusFor, makeFetch } from "../lib/proxy.mjs"

test("errorOf reads the proxy's nested error envelope", () => {
  expect(errorOf('{"type":"error","error":{"type":"proxy_error","message":"不支持的模型: x","code":40300}}'))
    .toEqual({ code: 40300, message: "不支持的模型: x" })
})

test("errorOf tolerates junk", () => {
  expect(errorOf("nope")).toEqual({ code: 0, message: "" })
})

// 形态 B 把 message 直接写成字符串（实测 {error:{...}} 是对象，但上游两种都发得出）
test("errorOf reads an error that is just a string", () => {
  expect(errorOf('{"error":"上游炸了"}')).toEqual({ code: 0, message: "上游炸了" })
})

// 上游的错误有两种帧形态（2026-11-02 实测）：
//   A. event:error + data:{...}          代理层错误（4000 / 40301）
//   B. data:{"error":{...}}，没有 event 行  上游透传错误（50204：temperature 等）
// 只认 A 会把 B 当成正常流读完，吐出一个 200 空回复。
const UPSTREAM_ERR = 'data: {"error":{"message":"invalid temperature: only 1 is allowed for this model","type":"upstream_error","code":50204}}\n\n'

test("a form-B error frame becomes a real 400 for a non-streaming caller", async () => {
  const f = makeFetch({
    getAuth: async () => ({ type: "api", key: "tok" }),
    tokenOf: async (a) => a.key,
    profileOf: () => undefined,
    call: async () => sseResponse([UPSTREAM_ERR, "data: [DONE]\n\n"]),
  })
  const res = await f("https://up/v1/chat/completions", {
    method: "POST", body: JSON.stringify({ model: "kimi-k2.8-preview", stream: false, messages: [], temperature: 0.7 }),
  })
  expect(res.status).toBe(400)
  // 原始报错必须留在 message 里，不能被吞成「空回复」
  expect((await res.json()).error.message).toContain("invalid temperature")
})

test("a form-B error frame becomes a real 400 for a streaming caller", async () => {
  const f = makeFetch({
    getAuth: async () => ({ type: "api", key: "tok" }),
    tokenOf: async (a) => a.key,
    profileOf: () => undefined,
    call: async () => sseResponse([UPSTREAM_ERR, "data: [DONE]\n\n"]),
  })
  const res = await f("https://up/v1/chat/completions", {
    method: "POST", body: JSON.stringify({ model: "kimi-k2.8-preview", stream: true, messages: [], temperature: 0.7 }),
  })
  expect(res.status).toBe(400)
  expect((await res.json()).error.message).toContain("invalid temperature")
})

// 反向保护：正常 chunk 一定带 choices，不能被误判成错误帧
test("a chunk that carries both choices and an error field is not an error frame", async () => {
  const f = makeFetch({
    getAuth: async () => ({ type: "api", key: "tok" }),
    tokenOf: async (a) => a.key,
    profileOf: () => undefined,
    call: async () => sseResponse([
      'data: {"choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}],"error":null}\n\n',
      "data: [DONE]\n\n",
    ]),
  })
  const res = await f("https://up/v1/chat/completions", {
    method: "POST", body: JSON.stringify({ model: "m", stream: false, messages: [] }),
  })
  expect(res.status).toBe(200)
  expect((await res.json()).choices[0].message.content).toBe("hi")
})

// 错误不一定打头：上游可能先发一条 role 空帧（正常 chunk），再发错误。
// 只看首帧的话这种情况仍然会被吞成一个 200 空回复。
test("a form-B error in the second record is still caught", async () => {
  const f = makeFetch({
    getAuth: async () => ({ type: "api", key: "tok" }),
    tokenOf: async (a) => a.key,
    profileOf: () => undefined,
    call: async () => sseResponse([
      'data: {"id":"c","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}\n\n',
      UPSTREAM_ERR,
      "data: [DONE]\n\n",
    ]),
  })
  const res = await f("https://up/v1/chat/completions", {
    method: "POST", body: JSON.stringify({ model: "m", stream: false, messages: [] }),
  })
  // 非流式整条流都在手里，中段的错误帧也要能还原成真正的状态码
  expect(res.status).toBe(400)
  expect((await res.json()).error.message).toContain("invalid temperature")
})

// 决定性用例：首帧是 role 空帧、错误在第二帧，且调用方**不流式** ——
// 此时整条流都在我们手里，必须能报错。
test("a non-streaming caller never gets an empty reply when an error follows a role chunk", async () => {
  const f = makeFetch({
    getAuth: async () => ({ type: "api", key: "tok" }),
    tokenOf: async (a) => a.key,
    profileOf: () => undefined,
    call: async () => sseResponse([
      'data: {"id":"c","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"role":"assistant"},"finish_reason":null}]}\n\n',
      UPSTREAM_ERR,
      "data: [DONE]\n\n",
    ]),
  })
  const res = await f("https://up/v1/chat/completions", {
    method: "POST", body: JSON.stringify({ model: "m", stream: false, messages: [] }),
  })
  const body = await res.json()
  // 现状：200 + content:"" + finish_reason:stop（静默失败）
  // 期望：把中段错误帧也识别出来，变成错误响应
  expect(body.error?.message ?? "").toContain("invalid temperature")
})

// 形态 A 的 data 不保证是 JSON，event 行的判断必须保留
test("an event:error whose data is not JSON is still an error", async () => {
  const f = makeFetch({
    getAuth: async () => ({ type: "api", key: "tok" }),
    tokenOf: async (a) => a.key,
    profileOf: () => undefined,
    call: async () => sseResponse(['event: error\ndata: gateway blew up\n\n']),
  })
  const res = await f("https://up/v1/chat/completions", {
    method: "POST", body: JSON.stringify({ model: "m", stream: true, messages: [] }),
  })
  expect(res.status).toBe(400)
  expect((await res.json()).error.message).toContain("LobsterAI")
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

// 回归：没有档位表的模型（29 个里的 21 个）不能收到 lobsterai_options，
// 否则上游报 code 4000 直接拒答。
test("a model without a thinking profile gets no lobsterai_options", async () => {
  let seen = null
  const f = makeFetch({
    getAuth: async () => ({ type: "api", key: "tok" }),
    tokenOf: async (a) => a.key,
    profileOf: () => undefined,
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
    body: JSON.stringify({ model: "qwen3.8-flash", stream: false, messages: [] }),
  })
  expect(res.status).toBe(200)
  expect("lobsterai_options" in seen).toBe(false)
})

// deepseek-flash 的 thinkingConfig（实测）。注意 max 的 openclawLevel 是 xhigh。
const DS_PROFILE = {
  options: [
    { level: "off", openclawLevel: "off" },
    { level: "high", openclawLevel: "high" },
    { level: "max", openclawLevel: "xhigh" },
  ],
  defaultLevel: "high",
}

const okStream = () => sseResponse([
  'data: {"id":"c","object":"chat.completion.chunk","model":"m","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n',
  "data: [DONE]\n\n",
])

async function bodySeenFor(body, profile) {
  let seen = null
  const f = makeFetch({
    getAuth: async () => ({ type: "api", key: "tok" }),
    tokenOf: async (a) => a.key,
    profileOf: () => profile,
    call: async (url, init) => { seen = JSON.parse(init.body); return okStream() },
  })
  await f("https://up/v1/chat/completions", { method: "POST", body: JSON.stringify(body) })
  return seen
}

// 端到端锁：magpie 下发的是它自己阶梯里的 "none"，插件必须换成上游的 "off"。
// 这条曾经是坏的 —— 变体名用了 "off"，magpie 够不着，最低档永远传不过来。
test("magpie's none reaches the wire as off", async () => {
  const seen = await bodySeenFor(
    { model: "deepseek-flash", stream: false, messages: [], reasoning_effort: "none" },
    DS_PROFILE,
  )
  expect(seen.lobsterai_options).toEqual({ version: 1, thinking: { level: "off" } })
  // 上游不认识 "none"，翻译完就不要再把 magpie 的叫法透传下去
  expect(seen.reasoning_effort).toBeUndefined()
})

test("magpie's xhigh still maps to the model's max", async () => {
  const seen = await bodySeenFor(
    { model: "deepseek-flash", stream: false, messages: [], reasoning_effort: "xhigh" },
    DS_PROFILE,
  )
  expect(seen.lobsterai_options).toEqual({ version: 1, thinking: { level: "max" } })
})

// 没翻译成功时不能把 magpie 下发的档位名删掉：上游自己就认 reasoning_effort，
// 删掉等于白扔一个本来能用的控制。
test("a model with no thinking profile keeps reasoning_effort", async () => {
  const seen = await bodySeenFor(
    { model: "qwen3.8-flash", stream: false, messages: [], reasoning_effort: "high" },
    undefined,
  )
  expect("lobsterai_options" in seen).toBe(false)
  expect(seen.reasoning_effort).toBe("high")
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
