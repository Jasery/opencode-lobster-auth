// magpie 的 auth.usage 返回形状。数据来自两个端点：
//   GET /api/user/quota            免费额度与订阅状态
//   GET /api/user/profile-summary  昵称、剩余积分明细

const round = (n, d = 2) => {
  const p = 10 ** d
  return Math.round(Number(n) * p) / p
}

export function usageFrom(quota, profile, signIn) {
  const q = quota ?? {}
  const p = profile ?? {}
  const out = { windows: [] }

  if (q.planName) out.plan = String(q.planName)
  if (p.nickname) out.user = String(p.nickname)

  const left = Number(p.totalCreditsRemaining)
  out.balance = Number.isFinite(left) && left > 0 ? `${round(left)} 点数` : ""

  const total = Number(q.freeCreditsTotal)
  const used = Number(q.freeCreditsUsed)
  if (Number.isFinite(total) && total > 0) {
    const u = Number.isFinite(used) ? used : 0
    out.windows.push({
      name: "免费额度",
      used: round((u / total) * 100),
      display: `${round(u, 1)} / ${round(total, 1)} 免费积分`,
      aside: !!q.freeCreditsExpired,
    })
  }

  const dates = (Array.isArray(p.creditItems) ? p.creditItems : [])
    .map((c) => c?.expiresAt)
    .filter((d) => typeof d === "string" && d !== "")
    .sort()
  if (dates.length > 0) out.until = dates[0]

  if (signIn) out.signIn = signIn
  return out
}
