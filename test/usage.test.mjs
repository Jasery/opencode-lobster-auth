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

test("plan, user and balance come from the two endpoints", () => {
  const u = usageFrom(QUOTA, PROFILE)
  expect(u.plan).toBe("免费")
  expect(u.user).toBe("Ada")
  expect(u.balance).toBe("1399.98 点数")
})

test("the free allowance becomes a window with a share", () => {
  const u = usageFrom(QUOTA, PROFILE)
  const w = u.windows.find((x) => x.name === "免费额度")
  expect(w.used).toBeCloseTo(6.48, 1)
  expect(w.display).toContain("19.4")
  expect(w.display).toContain("300")
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

test("missing pieces degrade instead of throwing", () => {
  const u = usageFrom({}, {})
  expect(u.windows).toEqual([])
  expect(u.balance).toBe("")
})
