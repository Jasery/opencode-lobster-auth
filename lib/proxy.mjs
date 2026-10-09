// 请求管线。上游有两个必须处理的行为：
//   1. 永远以 SSE 作答，即使请求写了 stream:false；
//   2. 把错误塞进 SSE 的 event:error 且状态码仍是 200，原样透传会让 magpie
//      永不故障切换。
// 另外思考档位要翻译成私有字段（见 lib/thinking.mjs）。

import { sse, first, chain } from "./sse.mjs"
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

export function makeFetch({ getAuth, profileOf, call }) {
  return async function lobsterFetch(input, init) {
    const auth = await getAuth()
    if (auth?.type !== "api" && auth?.type !== "oauth") {
      return errorResponse(401, 40100, "LobsterAI: 尚未登录")
    }
    const token = auth.type === "oauth" ? auth.access : auth.key
    if (!token) return errorResponse(401, 40100, "LobsterAI: 登录信息不完整")

    let req
    try { req = JSON.parse(typeof init?.body === "string" ? init.body : "{}") } catch { req = {} }

    // 请求体改写
    const profile = profileOf(req.model)
    const k3 = isKimiK3(req.model)
    if (k3) applyKimiK3(req)
    applyThinking(req, profile)
    // 档位已经翻译进私有字段，OpenAI 形状的字段不再透传。
    // K3 例外：reasoning_effort 由服务端固定为 max，必须留着。
    if (!k3) {
      delete req.reasoning_effort
      delete req.reasoningEffort
    }

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
    const out = await respond(req, rest)
    // 成功也要带 kept：插件不自己续期，用的就是存下来的 token。
    // magpie 靠这个头把账号上的失效标记清掉。
    out.headers.set("X-Magpie-Sign-In", "kept")
    return out
  }
}
