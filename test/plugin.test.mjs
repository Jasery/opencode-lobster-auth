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

// byLabel 按按钮上的名字找方法：顺序会变（远程那条插在中间），下标不可靠。
const byLabel = (hooks, word) => hooks.auth.methods.find((m) => m.label.includes(word))

test("every sign-in method is offered", async () => {
  const hooks = await plugin({})
  const kinds = hooks.auth.methods.map((m) => m.type)
  // 全是 oauth：api 类型会逼 magpie 从 stdin 读一个 key，
  // 而这些路都不需要用户输入任何东西。
  expect(kinds.every((k) => k === "oauth")).toBe(true)
  expect(hooks.auth.methods.map((m) => m.label)).toEqual([
    "浏览器登录（有道账号）", "远程浏览器登录", "从本机 LobsterAI 导入登录",
  ])
  expect(hooks.auth.provider).toBe(PROVIDER)
  expect(hooks.auth.refreshLead).toBeGreaterThan(0)
})

test("the remote method names its callback port where magpie looks", async () => {
  const hooks = await plugin({})
  const started = await byLabel(hooks, "远程").authorize()
  const u = new URL(started.url)
  // magpie 只从普通 query 找 loopback 端口（loopbackPorts），找到才给
  // 「回调 URL」输入框；只写在 hash 里它看不见。这条断言就是那次约定。
  const plain = u.searchParams.get("redirect_uri")
  expect(plain).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/)
  // portal 要的那份仍在 hash 里，且与普通 query 指向同一地址
  const hash = new URLSearchParams(u.hash.slice(u.hash.indexOf("?") + 1))
  expect(hash.get("redirect_uri")).toBe(plain)
  expect(hash.get("source")).toBe("electron")
  expect(started.method).toBe("auto")
  expect(typeof started.callback).toBe("function")
})

test("the desktop method opens no page and needs no typing", async () => {
  const hooks = await plugin({})
  const m = byLabel(hooks, "导入")
  const started = await m.authorize()
  // url 为空 = magpie 不弹浏览器；有 callback 才能拿到结果
  expect(started.url).toBe("")
  expect(typeof started.callback).toBe("function")
  expect(started.method).toBe("auto")
})

test("the desktop method reports a failure instead of throwing", async () => {
  const hooks = await plugin({})
  // 本机没有桌面端登录信息时，authorize 仍要正常返回，由 callback 报错
  const started = await byLabel(hooks, "导入").authorize()
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
