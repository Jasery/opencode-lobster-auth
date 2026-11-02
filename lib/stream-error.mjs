// SSE 的两种错误形态共用同一判据，避免首帧与非流式重组的处理分叉。
// event:error 的 data 可以是纯文本；无 event 的错误必须是没有 choices 的 error 信封。

export function errorOf(data) {
  let v
  try { v = JSON.parse(data) } catch { return { code: 0, message: String(data ?? "") } }
  const raw = v?.error ?? v
  const message = typeof raw === "string"
    ? raw
    : String(raw?.message ?? raw?.msg ?? v?.message ?? v?.msg ?? "")
  const code = Number((raw && typeof raw === "object" ? raw.code : undefined) ?? v?.code ?? 0) || 0
  return { code, message }
}

export function errorFrame(rec) {
  if (!rec) return null
  // 显式事件优先于 JSON 解析和 choices；标量/null/畸形的普通记录则不算错误。
  if (rec.event !== "error") {
    let v
    try { v = JSON.parse(rec.data) } catch { return null }
    if (!v || typeof v !== "object" || Array.isArray(v)) return null
    if (Object.prototype.hasOwnProperty.call(v, "choices") || !v.error) return null
  }
  const payload = errorOf(rec.data)
  return { ...payload, message: payload.message || "LobsterAI 返回了一个错误" }
}

export class StreamError extends Error {
  constructor(payload) {
    super(payload.message)
    this.name = "StreamError"
    this.payload = payload
  }
}
