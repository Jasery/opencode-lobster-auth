// LobsterAI 的 accessToken 是标准 JWT（未加密，仅签名）。
// 插件只读它的载荷，不校验签名——校验由上游负责。

function decode(part) {
  try {
    const s = Buffer.from(String(part).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")
    const v = JSON.parse(s)
    return v && typeof v === "object" ? v : null
  } catch {
    return null
  }
}

export function jwtPayload(token) {
  const parts = String(token ?? "").split(".")
  if (parts.length < 2) return null
  return decode(parts[1])
}

// exp 以秒计；返回毫秒，读不到就是 0（magpie 把 0 当作「不续期」）
export function jwtExp(token) {
  const p = jwtPayload(token)
  const exp = Number(p?.exp)
  return Number.isFinite(exp) && exp > 0 ? exp * 1000 : 0
}

export function accountOf(token) {
  const p = jwtPayload(token)
  if (!p) return {}
  const out = {}
  if (p.yid) out.yid = p.yid
  if (p.sub !== undefined) out.id = p.sub
  return out
}
