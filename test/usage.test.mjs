import { test, expect } from "bun:test"
import { usageFrom } from "../lib/usage.mjs"

// 实测自 /api/user/quota 与 /api/user/profile-summary
const QUOTA = {
  freeCreditsUsed: 19.427564, freeCreditsTotal: 300, freeCreditsRemaining: 0,
  freeCreditsExpired: true, freeCreditsExpiresAt: "2026-08-21",
  hasPaidCredits: true, dailyCreditsUsed: 0,
  subscriptionStatus: "free", planName: "免费",
  deploymentEntitled: false, shareEntitled: false,
}
const PROFILE = {
  id: 67097, nickname: "Ada", avatarUrl: null, totalCreditsRemaining: 1399.98,
  creditItems: [{ type: "campaign", label: "每日登录奖励", creditsRemaining: 100, expiresAt: "2026-11-01" }],
}

test("plan, user and the wallet come from the two endpoints", () => {
  const u = usageFrom(QUOTA, PROFILE)
  expect(u.plan).toBe("免费")
  expect(u.user).toBe("Ada")
  // 结构化钱包：magpie 会把它当「余额」显示，并让路由按余额排序。
  // 原来是一个字符串（"1399.98 点数"），路由读不到。
  const w = u.windows.find((x) => x.name === "余额")
  expect(w).toEqual({ name: "余额", balance: 1399.98, unit: "点数", runsOutAt: "2026-11-01", runsOut: 100 })
  expect(u.balance).toBeUndefined()
})

// 免费额度 2026-08 就过期了，还按「6% used」显示会让人以为那是一笔有效额度
test("an expired free allowance is not shown as a live window", () => {
  const u = usageFrom({ ...QUOTA, freeCreditsExpired: true }, PROFILE)
  expect(u.windows.some((x) => x.name === "免费额度")).toBe(false)
})

test("a live free allowance keeps its share", () => {
  const u = usageFrom({ ...QUOTA, freeCreditsExpired: false }, PROFILE)
  const w = u.windows.find((x) => x.name === "免费额度")
  expect(w.used).toBeCloseTo(6.48, 1)
  expect(w.display).toContain("19.4")
  expect(w.display).toContain("300")
})

// 每天领的 100 点各有一批、逐日到期，先到期先扣。不报出来就白作废。
test("the wallet carries the soonest batch to lapse", () => {
  const u = usageFrom(QUOTA, { ...PROFILE, creditItems: [
    { creditsRemaining: 100, expiresAt: "2026-11-20T09:00:00" },
    { creditsRemaining: 69.68, expiresAt: "2026-11-11T09:11:24" },
    { creditsRemaining: 100, expiresAt: "2026-11-15T09:00:00" },
  ] })
  const w = u.windows.find((x) => x.name === "余额")
  expect(w.runsOut).toBe(69.68)
  // 带上偏移量：magpie 用 new Date(...) 读，裸时间在 UTC 主机上会差 8 小时
  expect(w.runsOutAt).toBe("2026-11-11T09:11:24+08:00")
})

test("a batch with nothing left is not the one that runs out", () => {
  const u = usageFrom(QUOTA, { ...PROFILE, creditItems: [
    { creditsRemaining: 0, expiresAt: "2026-11-01T00:00:00" },
    { creditsRemaining: 120, expiresAt: "2026-11-30T00:00:00" },
  ] })
  expect(u.windows.find((x) => x.name === "余额").runsOut).toBe(120)
})

test("until is the earliest credit expiry", () => {
  const u = usageFrom(QUOTA, { ...PROFILE, creditItems: [
    { expiresAt: "2026-12-01" }, { expiresAt: "2026-10-15" },
  ] })
  expect(u.until).toBe("2026-10-15")
})

test("signIn rides along when given", () => {
  expect(usageFrom(QUOTA, PROFILE, "renewed").signIn).toBe("renewed")
})

// 时区归一：上游不带偏移量，magpie 用 new Date(...) 读，裸时间在 UTC 主机上差 8 小时。
// 各种可能出现的形态都要补上 +08:00，否则那个 bug 只是换了形状。
test("every time shape upstream plausibly sends carries the offset", () => {
  const at = (s) => usageFrom(QUOTA, { ...PROFILE, creditItems: [{ creditsRemaining: 10, expiresAt: s }] })
    .windows.find((x) => x.name === "余额").runsOutAt
  expect(at("2026-11-11T09:11:24")).toBe("2026-11-11T09:11:24+08:00")       // 带秒
  expect(at("2026-11-11T09:11")).toBe("2026-11-11T09:11:00+08:00")           // 不带秒
  expect(at("2026-11-11T09:11:24.123")).toBe("2026-11-11T09:11:24.123+08:00") // 带毫秒
  expect(at("2026-11-11 09:11:24")).toBe("2026-11-11T09:11:24+08:00")        // 空格分隔
  expect(at("2026-11-11")).toBe("2026-11-11")                                // 只有日期：整天语义
  expect(at("2026-11-11T09:11:24Z")).toBe("2026-11-11T09:11:24Z")            // 已有偏移不重复加
  expect(at("2026-11-11T09:11:24+08:00")).toBe("2026-11-11T09:11:24+08:00")
})

// 脏数据原样透传，不能编一个时间出来
test("an unparseable time is passed through rather than invented", () => {
  const u = usageFrom(QUOTA, { ...PROFILE, creditItems: [{ creditsRemaining: 10, expiresAt: "not-a-date" }] })
  expect(u.windows.find((x) => x.name === "余额").runsOutAt).toBe("not-a-date")
})

test("missing pieces degrade instead of throwing", () => {
  const u = usageFrom({}, {})
  expect(u.windows).toEqual([])
  expect(u.balance).toBeUndefined()
})
