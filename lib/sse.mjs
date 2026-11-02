// LobsterAI 的推理端点永远以 SSE 作答，即使请求写了 stream:false。
// 这里把字节流切成 {event, data} 记录，两种情形都由上层决定怎么用。

const decoder = new TextDecoder()

export async function* sse(body) {
  let buf = ""
  let event = ""
  let data = []

  // 一条空行结束一个事件；没有 data 的事件（只有注释）不产出
  const flush = () => {
    if (data.length === 0) { event = ""; return null }
    const rec = { event, data: data.join("\n") }
    event = ""
    data = []
    return rec
  }

  const feed = (raw) => {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw
    if (line === "") return flush()
    if (line.startsWith(":")) return null // 注释 / keep-alive
    const i = line.indexOf(":")
    const field = i === -1 ? line : line.slice(0, i)
    let value = i === -1 ? "" : line.slice(i + 1)
    if (value.startsWith(" ")) value = value.slice(1)
    if (field === "event") event = value
    else if (field === "data") data.push(value)
    return null
  }

  for await (const chunk of body) {
    buf += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true })
    let nl
    while ((nl = buf.indexOf("\n")) !== -1) {
      const rec = feed(buf.slice(0, nl))
      buf = buf.slice(nl + 1)
      if (rec) yield rec
    }
  }
  buf += decoder.decode()
  if (buf !== "") {
    const rec = feed(buf)
    if (rec) yield rec
  }
  const last = flush()
  if (last) yield last
}

export async function* chain(held, it) {
  try {
    yield* held
    for (;;) {
      const n = await it.next()
      if (n.done) return
      yield n.value
    }
  } finally {
    // DONE、合并时抛错或下游取消，都必须继续关闭底层 SSE/HTTP 流。
    await it.return?.()
  }
}
