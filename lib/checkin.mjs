// 每日积分礼（签到）的领取逻辑。
//
// 上游接口（2026-11-02 实测）：
//   GET  /api/client-activities/slot?placement=desktop_sidebar&clientVersion=…&…
//        → { slotState: "available", activity: { activityCode, configRevision } }
//   GET  /api/client-activities/<code>/context?configRevision=<rev>
//        → { state: { claimedToday, claimedDays, rewardCredits, claimedCredits }, actions: [] }
//   POST /api/client-activities/<code>/actions/check_in
//        体 { configRevision, idempotencyKey, payload: {} }
//        → code 0 领取成功；code 51104「活动奖励已领取」（幂等，重复发不重复给）
//
// 判据取 context 的 actions：已领时是 []，未领时才有 check_in。
// 领完必须复核（再读一次 context），接口 200 不等于真的到账。
//
// 这里只搬活动那一半。原脚本（技术方案调研/lobsterai-checkin）里取 token、
// 调 /api/auth/refresh、把 token 缓存到磁盘的部分**不搬** —— 那会把桌面端
// 踢下线，是本插件明确不碰的（见 README「不做的事」）。

const BASE = "https://lobsterai-server.youdao.com"
const UPDATE_URL = "https://api-overmind.youdao.com/openapi/get/luna/hardware/lobsterai/prod/update"
const PLACEMENT = "desktop_sidebar"
// 实测 macOS 上也认 win32，别按本机平台改
const PLATFORM = "win32"
const ACTIVITY = "daily-check-in-evergreen-prod-20260814"

// magpie 只认这几个 outcome，其它值会被改写成 failed
export const OUTCOMES = ["claimed", "done", "ineligible", "inactive", "captcha", "failed"]

const timeout = (ms) => AbortSignal.timeout(ms)

async function call(method, path, token, body, version) {
  const headers = { authorization: `Bearer ${token}`, accept: "application/json" }
  if (version) headers["User-Agent"] = `LobsterAI/${version}`
  if (body !== undefined) headers["content-type"] = "application/json"
  const res = await fetch(BASE + path, {
    method, headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: timeout(20_000),
  })
  const text = await res.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  return { status: res.status, json, text }
}

// 当前客户端版本。活动位是否投放跟版本号有关，版本过旧会拿不到活动。
export async function clientVersion() {
  try {
    const res = await fetch(UPDATE_URL, { signal: timeout(8_000) })
    const j = await res.json()
    const v = j?.data?.value?.version
    if (typeof v === "string" && /^\d{4}\.\d/.test(v)) return { version: v, known: true }
  } catch {}
  // 兜底：拿不到版本时用一个已知能用的值。known=false 让上层能把「可能是版本问题」
  // 如实报出来，而不是假装活动没投放。
  return { version: "2026.10.30", known: false }
}

function envelope(r) {
  // 上游业务错误也是 HTTP 200，靠 code 判断
  if (r.status === 401 || r.status === 403) return { expired: true, message: r.json?.message }
  if (!r.json) return { bad: true, message: `响应无法解析（HTTP ${r.status}）` }
  if (r.json.code === 0) return { data: r.json.data ?? {} }
  const msg = String(r.json.message ?? "")
  if (/未登录|登录已失效|token/i.test(msg)) return { expired: true, message: msg }
  return { code: r.json.code, message: msg }
}

// 读活动位 + 上下文，返回领不领得动、以及要用的判据
export async function readState(token, { version } = {}) {
  const v = version ?? (await clientVersion())
  const slotPath = `/api/client-activities/slot?${new URLSearchParams({
    placement: PLACEMENT, clientVersion: v.version, containerApiVersion: "2", platform: PLATFORM,
  })}`
  const slot = envelope(await call("GET", slotPath, token, undefined, v.version))
  if (slot.expired) return { outcome: "failed", reason: "登录已失效", version: v }
  if (slot.bad) return { outcome: "failed", reason: slot.message, version: v }
  if (slot.code !== undefined) return { outcome: "failed", reason: slot.message || `code ${slot.code}`, version: v }

  const activity = slot.data?.activity
  const slotState = String(slot.data?.slotState ?? "")
  if (slotState !== "available" || !activity?.activityCode) {
    // 版本是现取的 → 上游就是没投放；版本是兜底值 → 可能是版本过旧，值得当天重试
    return {
      outcome: v.known ? "inactive" : "failed",
      reason: v.known ? "" : "拿不到当前客户端版本，无法确认活动是否投放",
      slotState, version: v,
    }
  }

  const code = String(activity.activityCode)
  const rev = Number(activity.configRevision) || 0
  const ctx = envelope(await call("GET", `/api/client-activities/${code}/context?configRevision=${rev}`, token, undefined, v.version))
  if (ctx.expired) return { outcome: "failed", reason: "登录已失效", version: v }
  if (ctx.bad || ctx.code !== undefined) return { outcome: "failed", reason: ctx.message ?? "读取签到状态失败", version: v }

  const st = ctx.data?.state ?? {}
  const actions = (Array.isArray(ctx.data?.actions) ? ctx.data.actions : []).map((a) => String(a).toLowerCase().trim())
  return {
    outcome: null, code, rev: Number(ctx.data?.configRevision) || rev, state: st, actions, version: v,
  }
}

// 领一次并复核。返回 magpie 的 outcome 形状。
export async function claim(token, state, { idempotencyKey } = {}) {
  const { code, rev, actions } = state
  const before = state.state?.claimedDays ?? null

  if (state.state?.claimedToday) return { outcome: "done" }
  if (!actions.includes("check_in")) return { outcome: "ineligible" }

  const body = {
    configRevision: rev,
    idempotencyKey: idempotencyKey ?? crypto.randomUUID(),
    payload: {},
  }
  const r = envelope(await call("POST", `/api/client-activities/${code}/actions/check_in`, token, body, state.version?.version))
  // 51104 = 活动奖励已领取。并发的另一路已经领过，算 done
  if (r.code === 51104) return { outcome: "done" }
  if (r.expired) return { outcome: "failed", reason: "登录已失效" }
  if (r.code !== undefined || r.bad) return { outcome: "failed", reason: r.message ?? "领取失败" }

  const granted = Number(r.data?.creditsGranted ?? r.data?.rewardCredits ?? r.data?.result?.rewardCredits) || 0

  // 复核：接口 200 不等于到账
  let after = null
  try {
    const c = envelope(await call("GET", `/api/client-activities/${code}/context?configRevision=${rev}`, token, undefined, state.version?.version))
    after = c.data?.state ?? null
  } catch {}

  if (!after) return { outcome: "failed", reason: "领取后复核请求失败" }
  const nowClaimed = !!after.claimedToday
  const moved = before === null || after.claimedDays !== before
  if (!nowClaimed || !(moved || granted > 0)) {
    return { outcome: "failed", reason: "领取后复核未通过" }
  }

  const out = { outcome: "claimed" }
  const credit = granted || Number(after.rewardCredits) || 0
  if (credit > 0) out.credit = credit
  // 不填 streak：claimedDays 是活动开始以来的累计天数，不是连签天数，
  // magpie 会把 streak 显示成「连续 N 天」。
  return out
}

// auth.checkin 的实现：读状态 → 该领就领。任何失败都返回 outcome，不抛
// （抛异常 magpie 记成 failed，等价但没有 message）。
export async function checkinWith(token, { version, idempotencyKey } = {}) {
  if (!token) return { outcome: "failed", reason: "尚未登录" }
  const state = await readState(token, { version })
  if (state.outcome) {
    const out = { outcome: state.outcome }
    if (state.reason) out.message = state.reason
    return out
  }
  try {
    return await claim(token, state, { idempotencyKey })
  } catch (e) {
    return { outcome: "failed", reason: e?.message ?? String(e) }
  }
}

export { ACTIVITY, PLACEMENT, PLATFORM, UPDATE_URL }
