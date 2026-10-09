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
