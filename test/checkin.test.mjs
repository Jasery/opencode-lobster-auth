import { test, expect, beforeEach, afterEach } from "bun:test"
import { readState, claim, checkinWith, clientVersion, nextDayTurn, OUTCOMES } from "../lib/checkin.mjs"

// 打桩全局 fetch：按 URL 后缀派发，记录每次调用
const realFetch = globalThis.fetch
let calls = []
let routes = {}

function stub(input, init = {}) {
  const url = typeof input === "string" ? input : input.url
  const request = {
    url,
    method: init.method ?? input.method ?? "GET",
    headers: new Headers(init.headers ?? input.headers),
    body: init.body ?? null,
  }
  calls.push(request)
  for (const [key, fn] of Object.entries(routes)) {
    if (url.includes(key)) return Promise.resolve(fn(request, url))
  }
  return Promise.reject(new Error(`unstubbed: ${url}`))
}

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

beforeEach(() => { calls = []; routes = {}; globalThis.fetch = stub })
afterEach(() => { globalThis.fetch = realFetch })

const V = { version: "2026.10.30", known: true }
const SLOT_OK = {
  code: 0,
  data: { slotState: "available", activity: { activityCode: "daily-check-in-evergreen-prod-20260814", configRevision: 1 } },
}
const ctx = ({ claimedToday, claimedDays = 42, actions = ["check_in"] }) => ({
  code: 0,
  data: { configRevision: 1, state: { claimedToday, claimedDays, rewardCredits: 100 }, actions },
})

test("a day already claimed is done, and nothing is posted", async () => {
  routes["/client-activities/slot"] = () => json(SLOT_OK)
  routes["/context"] = () => json(ctx({ claimedToday: true, actions: [] }))
  const r = await checkinWith("tok", { version: V })
  expect(r.outcome).toBe("done")
  expect(calls.some((c) => c.method === "POST")).toBe(false)
})

// 已签到必须报出 credit 和 until：
//   credit —— 界面上能看到今天拿了多少
//   until  —— magpie 靠它知道供应商的「一天」何时翻篇。缺了它，magpie 无法
//             判断今天是否真的过去，会把结果标成 again，界面就从「今日已签到」
//             退化成「暂不可签到」。
test("an already-claimed day still reports the reward and when the day turns", async () => {
  routes["/client-activities/slot"] = () => json(SLOT_OK)
  routes["/context"] = () => json(ctx({ claimedToday: true, actions: [] }))
  const r = await checkinWith("tok", { version: V })
  expect(r.outcome).toBe("done")
  expect(r.credit).toBe(100)
  expect(typeof r.until).toBe("string")
  const t = Date.parse(r.until)
  expect(Number.isFinite(t)).toBe(true)
  expect(t).toBeGreaterThan(Date.now())
})

// until 是下一个北京零点：UTC 主机上也要给出正确的时刻
test("until is the next Beijing midnight", () => {
  // 北京 09:30 = 01:30Z，下一个北京零点 = 16:00Z
  expect(nextDayTurn(Date.parse("2026-11-03T01:30:00Z"))).toBe("2026-11-03T16:00:00.000Z")
  // 北京 23:59 仍在同一天
  expect(nextDayTurn(Date.parse("2026-11-03T15:59:00Z"))).toBe("2026-11-03T16:00:00.000Z")
  // 北京 00:00 整应当指向再下一天
  expect(nextDayTurn(Date.parse("2026-11-03T16:00:00Z"))).toBe("2026-11-04T16:00:00.000Z")
})

test("an activity with no check_in action is ineligible", async () => {
  routes["/client-activities/slot"] = () => json(SLOT_OK)
  routes["/context"] = () => json(ctx({ claimedToday: false, actions: [] }))
  expect((await checkinWith("tok", { version: V })).outcome).toBe("ineligible")
})

test("claiming reports the credits once the re-read confirms it", async () => {
  let reads = 0
  routes["/client-activities/slot"] = () => json(SLOT_OK)
  routes["/context"] = () => {
    reads += 1
    // 第一次未领，复核时已领且天数 +1
    return json(reads === 1 ? ctx({ claimedToday: false, claimedDays: 42 }) : ctx({ claimedToday: true, claimedDays: 43, actions: [] }))
  }
  routes["/actions/check_in"] = () => json({ code: 0, data: { creditsGranted: 100 } })
  const r = await checkinWith("tok", { version: V, idempotencyKey: "fixed-idem-key" })
  const post = calls.find((c) => c.method === "POST")
  expect(post).toBeDefined()
  const postBody = JSON.parse(post.body)
  expect(postBody).toEqual({ configRevision: 1, idempotencyKey: "fixed-idem-key", payload: {} })
  expect(post.headers.get("authorization")).toBe("Bearer tok")
  expect(r.outcome).toBe("claimed")
  expect(r.credit).toBe(100)
  // 不能报 streak：claimedDays 是累计天数，magpie 会显示成「连续 N 天」
  expect(r.streak).toBeUndefined()
})

// 接口 200 不等于到账：复核没变就不能说领到了
test("a claim the re-read does not confirm is failed", async () => {
  routes["/client-activities/slot"] = () => json(SLOT_OK)
  routes["/context"] = () => json(ctx({ claimedToday: false, claimedDays: 42 }))
  routes["/actions/check_in"] = () => json({ code: 0, data: {} })
  const r = await checkinWith("tok", { version: V })
  expect(r.outcome).toBe("failed")
  expect(r.message).toContain("复核")
})

// 关键：POST 自己说发了 100 点，但复核显示 claimedToday 仍是 false ——
// 这是「响应说成功、状态没落地」。不能因为响应里 creditsGranted>0 就报 claimed，
// 那等于拿请求的回显当证据。
test("a claim whose re-read still says unclaimed is failed even if the POST said it granted", async () => {
  routes["/client-activities/slot"] = () => json(SLOT_OK)
  routes["/context"] = () => json(ctx({ claimedToday: false, claimedDays: 42 }))
  routes["/actions/check_in"] = () => json({ code: 0, data: { creditsGranted: 100 } })
  const r = await checkinWith("tok", { version: V })
  expect(r.outcome).toBe("failed")
  expect(r.message).toContain("复核")
})

// claimedToday 从 false 变成 true 已足够确认；累计天数可以滞后更新。
test("a re-read that changes claimedToday confirms the claim without a day increment", async () => {
  let reads = 0
  routes["/client-activities/slot"] = () => json(SLOT_OK)
  routes["/context"] = () => {
    reads += 1
    // 两次 claimedDays 都是 42，但复核说 claimedToday=true —— 状态确实变了，
    // 这一条应当算确认（claimedToday 由假变真是最强证据）
    return json(reads === 1 ? ctx({ claimedToday: false, claimedDays: 42 }) : ctx({ claimedToday: true, claimedDays: 42 }))
  }
  routes["/actions/check_in"] = () => json({ code: 0, data: {} })
  expect((await checkinWith("tok", { version: V })).outcome).toBe("claimed")
})

// 网络异常必须变成 failed + message，不能抛（magpie 会记成 failed 但丢失原因）
test("a network failure anywhere is failed with a reason, never a throw", async () => {
  routes["/client-activities/slot"] = () => Promise.reject(new TypeError("fetch failed"))
  const r = await checkinWith("tok", { version: V })
  expect(r.outcome).toBe("failed")
  expect(typeof r.message).toBe("string")
  expect(r.message.length).toBeGreaterThan(0)
})

test("a network failure during the claim itself is failed, never a throw", async () => {
  routes["/client-activities/slot"] = () => json(SLOT_OK)
  routes["/context"] = () => json(ctx({ claimedToday: false }))
  routes["/actions/check_in"] = () => Promise.reject(new TypeError("socket hang up"))
  const r = await checkinWith("tok", { version: V })
  expect(r.outcome).toBe("failed")
  expect(r.message).toContain("socket")
})

// 51104 = 活动奖励已领取（并发/重复领取），算 done 不是失败
test("an already-claimed answer from check_in is done", async () => {
  routes["/client-activities/slot"] = () => json(SLOT_OK)
  routes["/context"] = () => json(ctx({ claimedToday: false }))
  routes["/actions/check_in"] = () => json({ code: 51104, message: "活动奖励已领取", data: null })
  expect((await checkinWith("tok", { version: V })).outcome).toBe("done")
})

test("no activity announced is inactive when the version is known", async () => {
  routes["/client-activities/slot"] = () => json({ code: 0, data: { slotState: "unavailable" } })
  expect((await checkinWith("tok", { version: V })).outcome).toBe("inactive")
})

// 版本拿不到时用兜底值，活动位可能只是因为版本过旧才不投放 —— 要失败以当天重试，
// 不能报成「没有活动」让 magpie 一整天不再问
test("an unavailable slot with an unknown version is failed, not inactive", async () => {
  routes["/client-activities/slot"] = () => json({ code: 0, data: { slotState: "unavailable" } })
  const r = await checkinWith("tok", { version: { version: "2026.10.30", known: false } })
  expect(r.outcome).toBe("failed")
  expect(r.message).toContain("版本")
})

test("a lapsed sign-in is failed with the vendor's words", async () => {
  routes["/client-activities/slot"] = () => json({ code: 40100, message: "登录已过期，请重新登录" })
  const r = await checkinWith("tok", { version: V })
  expect(r.outcome).toBe("failed")
  expect(r.message).toContain("登录")
})

test("no token is failed, never a throw", async () => {
  expect((await checkinWith("", { version: V })).outcome).toBe("failed")
})

test("every outcome the plugin returns is in magpie's vocabulary", async () => {
  const seen = new Set()
  routes["/client-activities/slot"] = () => json(SLOT_OK)
  routes["/context"] = () => json(ctx({ claimedToday: true, actions: [] }))
  seen.add((await checkinWith("tok", { version: V })).outcome)
  routes["/context"] = () => json(ctx({ claimedToday: false, actions: [] }))
  seen.add((await checkinWith("tok", { version: V })).outcome)
  routes["/client-activities/slot"] = () => json({ code: 0, data: { slotState: "unavailable" } })
  seen.add((await checkinWith("tok", { version: V })).outcome)
  for (const o of seen) expect(OUTCOMES).toContain(o)
})

test("clientVersion falls back to a known value and says it is not known", async () => {
  routes["api-overmind"] = () => json({ data: { value: { version: "2026.10.30" } } })
  expect(await clientVersion()).toEqual({ version: "2026.10.30", known: true })
  routes["api-overmind"] = () => Promise.reject(new Error("offline"))
  const r = await clientVersion()
  expect(r.known).toBe(false)
  expect(r.version).toMatch(/^\d{4}\./)
})

for (const stage of ["slot", "context", "post", "verify"]) {
  for (const [label, response] of [
    ["HTTP 503 without code", () => json({ message: "Service unavailable" }, 503)],
    ["missing business code", () => json({ message: "missing code" })],
    ["HTTP 503 with success-looking body", () => json({ code: 0, data: { state: { claimedToday: true }, actions: [] } }, 503)],
    ["malformed success data", () => json({ code: 0, data: null })],
  ]) {
    test(`${stage}: ${label} is retryable failed`, async () => {
      let reads = 0
      routes["/client-activities/slot"] = () => stage === "slot" ? response() : json(SLOT_OK)
      routes["/context"] = () => {
        reads += 1
        if (stage === "context" || (stage === "verify" && reads > 1)) return response()
        return json(ctx({ claimedToday: reads > 1 }))
      }
      routes["/actions/check_in"] = () => stage === "post" ? response() : json({ code: 0, data: {} })
      const r = await checkinWith("tok", { version: V })
      expect(r.outcome).toBe("failed")
      expect(r.message?.length).toBeGreaterThan(0)
      if (label.includes("503")) expect(r.message).toContain("503")
      if (stage === "slot" || stage === "context") expect(calls.some((c) => c.method === "POST")).toBe(false)
    })
  }
}

for (const data of [
  {},
  { slotState: "available" },
  { slotState: "available", activity: { activityCode: "x" } },
]) {
  test(`an invalid successful slot is failed: ${JSON.stringify(data)}`, async () => {
    routes["/client-activities/slot"] = () => json({ code: 0, data })
    const r = await checkinWith("tok", { version: V })
    expect(r.outcome).toBe("failed")
    expect(calls.some((c) => c.method === "POST")).toBe(false)
  })
}

for (const data of [
  { state: { claimedToday: "false" }, actions: ["check_in"] },
  { state: {}, actions: ["check_in"] },
  { state: { claimedToday: false } },
  { state: { claimedToday: false }, actions: [null] },
]) {
  test(`an invalid context is failed before any POST: ${JSON.stringify(data)}`, async () => {
    routes["/client-activities/slot"] = () => json(SLOT_OK)
    routes["/context"] = () => json({ code: 0, data })
    const r = await checkinWith("tok", { version: V })
    expect(r.outcome).toBe("failed")
    expect(calls.some((c) => c.method === "POST")).toBe(false)
  })
}

test("a string claimedToday in verification cannot claim success", async () => {
  let reads = 0
  routes["/client-activities/slot"] = () => json(SLOT_OK)
  routes["/context"] = () => json(ctx({ claimedToday: ++reads === 1 ? false : "false" }))
  routes["/actions/check_in"] = () => json({ code: 0, data: {} })
  expect((await checkinWith("tok", { version: V })).outcome).toBe("failed")
})

test("a failed version HTTP response cannot mark the fallback version as known", async () => {
  routes["api-overmind"] = () => json({ data: { value: { version: "2026.10.30" } } }, 503)
  expect((await clientVersion()).known).toBe(false)
})

test("readState carries the revision and the actions through", async () => {
  routes["/client-activities/slot"] = () => json(SLOT_OK)
  routes["/context"] = () => json(ctx({ claimedToday: false }))
  const s = await readState("tok", { version: V })
  expect(s.code).toBe("daily-check-in-evergreen-prod-20260814")
  expect(s.rev).toBe(1)
  expect(s.actions).toEqual(["check_in"])
})
