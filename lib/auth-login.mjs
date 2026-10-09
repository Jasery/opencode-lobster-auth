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
