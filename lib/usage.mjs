// magpie 的 auth.usage 返回形状。数据来自两个端点：
//   GET /api/user/quota            免费额度与订阅状态
//   GET /api/user/profile-summary  昵称、剩余积分明细

const round = (n, d = 2) => {
  const p = 10 ** d
  return Math.round(Number(n) * p) / p
}

// 上游的时间不带时区（如 2026-11-11T09:11:24）。magpie 用 new Date(...) 读它，
// 裸时间会被当成本机本地时间 —— magpie 跑在 UTC 的容器 / NAS 上就差 8 小时。
// 上游是北京时间（签到 context 的 state.timezone 是 Asia/Shanghai），补上 +08:00。
// 只有日期的（2026-11-01）保持原样：那是整天语义，没有时刻可言。
const rfc3339 = (s) => {
  const v = String(s ?? "")
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(v)) return `${v}:00+08:00`
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(v)) return `${v}+08:00`
  return v
}

export function usageFrom(quota, profile, signIn) {
  const q = quota ?? {}
  const p = profile ?? {}
  const out = { windows: [] }

  if (q.planName) out.plan = String(q.planName)
  if (p.nickname) out.user = String(p.nickname)

  // 钱包窗口。积分是一批批的余额，不是「用了几成」的额度：magpie 的匹配规则里
  // 窗口带 balance 才被当钱包（不当 Text/Aside），路由才会按余额排序、先花快
  // 到期的。原来把它塞进顶层 balance 字符串，magpie 只能当文字显示，路由读不到。
  const left = Number(p.totalCreditsRemaining)
  if (Number.isFinite(left)) {
    // 名字只当标签用。magpie 把它渲染成「<窗口名> <余额> <单位> left」，
    // 叫「点数」会读成「点数 2,487.54 点数 left」，所以用「余额」。
    const w = { name: "余额", balance: round(left), unit: "点数" }
    // 每天领的 100 点各是一批、逐日到期，先到期先扣；不报出来就白作废。
    // 只剩 0 的批次不算「将要到期」，否则永远指向一批已经用完的。
    const soonest = (Array.isArray(p.creditItems) ? p.creditItems : [])
      .filter((c) => Number(c?.creditsRemaining) > 0 && typeof c?.expiresAt === "string" && c.expiresAt !== "")
      .sort((a, b) => String(a.expiresAt).localeCompare(String(b.expiresAt)))[0]
    if (soonest) {
      w.runsOutAt = rfc3339(soonest.expiresAt)
      w.runsOut = round(soonest.creditsRemaining)
    }
    out.windows.push(w)
  }

  // 免费额度只在还没过期时才算一笔有效额度。免费期 2026-08 就结束了，
  // 过了还按「6% used」显示，看起来像还有一笔可用额度。
  const total = Number(q.freeCreditsTotal)
  const used = Number(q.freeCreditsUsed)
  if (Number.isFinite(total) && total > 0 && !q.freeCreditsExpired) {
    const u = Number.isFinite(used) ? used : 0
    out.windows.push({
      name: "免费额度",
      used: round((u / total) * 100),
      display: `${round(u, 1)} / ${round(total, 1)} 免费积分`,
    })
  }

  const dates = (Array.isArray(p.creditItems) ? p.creditItems : [])
    .map((c) => c?.expiresAt)
    .filter((d) => typeof d === "string" && d !== "")
    .sort()
  if (dates.length > 0) out.until = rfc3339(dates[0])

  if (signIn) out.signIn = signIn
  return out
}
