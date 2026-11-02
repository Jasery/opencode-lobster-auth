// 请求管线。上游有两个必须处理的行为：
//   1. 永远以 SSE 作答，即使请求写了 stream:false；
//   2. 把错误塞进 200 的 SSE 里，原样透传会让 magpie 永不故障切换。
//      错误有两种帧形态，见下面 errorFrame —— 只认一种会把它吞成一个 200 空回复。
// 另外思考档位要翻译成私有字段（见 lib/thinking.mjs）。

import { sse, chain } from "./sse.mjs"
import { respond, StreamError } from "./assemble.mjs"
import { applyThinking, applyKimi, isKimiK3 } from "./thinking.mjs"
import { CLIENT_VERSION, CAPABILITIES } from "./constants.mjs"

const LIMIT_WORDS = /限流|频率|过快|过于频繁|rate ?limit|too many/i

export function errorOf(data) {
  let v
  try { v = JSON.parse(data) } catch { return { code: 0, message: "" } }
  const raw = v?.error ?? v
  // message 有三种落点：{error:{message}}、{error:"一句话"}、{message}/{msg}
  const message = typeof raw === "string"
    ? raw
    : String(raw?.message ?? v?.message ?? v?.msg ?? "")
  const code = Number((raw && typeof raw === "object" ? raw.code : undefined) ?? v?.code ?? 0) || 0
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

// 上游把错误塞进 200 的 SSE，但有两种帧形态（2026-11-02 实测）：
//   A. event:error + data:{...}            代理层错误（4000、40301 模型不可见）
//   B. data:{"error":{...}}，没有 event 行  上游透传错误（50204：temperature 等）
// B 是最容易碰到的：客户端带个非 1 的 temperature，Kimi 家族就拒收。
// 只认 A 会把 B 当正常流读完，产出「200 + 空 content + finish_reason: stop」，
// 调用方既没有可故障切换的状态码，也看不到原始报错。
// A 的 data 不保证是 JSON，所以 event 行的判断必须保留。
function errorFrame(rec) {
  if (!rec) return null
  if (rec.event === "error") return rec
  let v
  try { v = JSON.parse(rec.data) } catch { return null }
  // 正常 chunk 一定带 choices（可能是 null，但键在）；带 error 又没有 choices
  // 才是错误帧。用 `!== undefined` 而不是真值判断，choices:null 也算正常 chunk。
  if (!Object.prototype.hasOwnProperty.call(v, "choices")) return v?.error ? rec : null
  return null
}

// 从流里嗅出错误帧。错误不一定是第一条：上游可能先发一条 role 空帧再发错误。
// 只窥探到「第一条真正带 choices 的 chunk」为止 —— 之后流式已经开始往外发，
// 改不了状态码了。已窥探的记录按原序放回，不能丢。
async function sniffError(records) {
  const held = []
  for (;;) {
    const n = await records.next()
    if (n.done) return { bad: null, head: emptyStream(), error: null }
    const rec = n.value
    held.push(rec)
    const bad = errorFrame(rec)
    if (bad) return { bad, head: emptyStream(), error: null }
    // 带 choices 的记录 = 真正的回复开始了，停止窥探
    let v = null
    try { v = JSON.parse(rec.data) } catch {}
    if (v && Object.prototype.hasOwnProperty.call(v, "choices")) {
      return { bad: null, head: chain(held, records), error: null }
    }
    // [DONE] 或其它非 chunk 记录：继续看下一条
  }
}

function emptyStream() {
  return (async function* () {})()
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
    const k3 = isKimiK3(req.model)
    // Kimi 家族：采样参数必须删（服务端固定）；k3 家族另外强制 max。
    // 拆成两个契约是因为 k3.1-pro 认完整档位，压成 max 会改掉用户选的档位。
    applyKimi(req, req.model)
    const translated = applyThinking(req, profile)
    // 翻译成功才把 magpie 下发的档位名删掉：它下发的是它阶梯里的名字
    // （最低档叫 none），未必是上游的叫法。没翻译成功（模型没有档位表）
    // 时保留原字段 —— 上游自己就认 reasoning_effort，删掉等于白扔一个控制。
    // K3 例外：reasoning_effort 由服务端固定为 max，必须留着。
    if (!k3 && translated) {
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

    // 错误不一定在第一帧：先窥探到第一条真正带 choices 的 chunk 为止
    const { bad, head } = await sniffError(sse(res.body))
    if (bad) {
      const { code, message } = errorOf(bad.data)
      return errorResponse(statusFor(code, message), code, message || "LobsterAI 返回了一个错误")
    }
    let out
    try {
      out = await respond(req, head)
    } catch (e) {
      // 非流式请求整条流都在手里，中途出现的错误帧也能还原成真正的状态码
      if (e instanceof StreamError) {
        return errorResponse(statusFor(e.payload.code, e.payload.message), e.payload.code, e.payload.message)
      }
      throw e
    }
    // 成功也要带 kept：插件不自己续期，用的就是存下来的 token。
    // magpie 靠这个头把账号上的失效标记清掉。
    out.headers.set("X-Magpie-Sign-In", "kept")
    return out
  }
}
