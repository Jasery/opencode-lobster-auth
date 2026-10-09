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

import { signIn } from "../lib/auth-login.mjs"

test("signIn completes the loopback callback and returns an oauth account", async () => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url")
  const token = `h.${b64({ sub: 67097, yid: "u@x.com", exp: 1793152423 })}.s`

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const u = new URL(req.url)
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
