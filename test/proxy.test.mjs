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

test("a real 401 passes straight through", async () => {
  const f = makeFetch({
    getAuth: async () => ({ type: "api", key: "tok" }),
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
