// 上游给的是 OpenAI 形状的 chat.completion.chunk，只是永远走 SSE。
// 流式请求原样转发；非流式请求要把分片拼成一个完整的 chat.completion。

import { randomBytes } from "node:crypto"

const enc = new TextEncoder()

function newId() {
  return "chatcmpl-" + randomBytes(12).toString("hex")
}

export async function mergeChunks(records, model) {
  const out = {
    id: newId(),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, message: { role: "assistant", content: "" }, finish_reason: "stop" }],
    usage: null,
  }
  const calls = new Map()
  let content = ""
  let reasoning = ""

  for await (const rec of records) {
    if (rec.data === "[DONE]") break
    let v
    try { v = JSON.parse(rec.data) } catch { continue }
    if (v?.usage) out.usage = v.usage
    const ch = v?.choices?.[0]
    if (!ch) continue
    const d = ch.delta ?? {}
    if (typeof d.content === "string") content += d.content
    if (typeof d.reasoning_content === "string") reasoning += d.reasoning_content
    for (const tc of d.tool_calls ?? []) {
      const i = tc.index ?? 0
      let c = calls.get(i)
      if (!c) { c = { id: "", type: "function", function: { name: "", arguments: "" } }; calls.set(i, c) }
      if (tc.id) c.id = tc.id
      if (tc.type) c.type = tc.type
      if (tc.function?.name) c.function.name = tc.function.name
      if (typeof tc.function?.arguments === "string") c.function.arguments += tc.function.arguments
    }
    if (ch.finish_reason) out.choices[0].finish_reason = ch.finish_reason
  }

  const msg = out.choices[0].message
  msg.content = content
  if (reasoning) msg.reasoning_content = reasoning
  if (calls.size > 0) {
    msg.tool_calls = [...calls.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c)
    // OpenAI 的约定：只有工具调用时 content 为 null
    if (!content) msg.content = null
  }
  return out
}

function streamOut(records) {
  const body = new ReadableStream({
    async start(controller) {
      try {
        for await (const rec of records) {
          if (rec.data === "[DONE]") break
          controller.enqueue(enc.encode(`data: ${rec.data}\n\n`))
        }
        controller.enqueue(enc.encode("data: [DONE]\n\n"))
        controller.close()
      } catch (e) {
        controller.error(e)
      }
    },
    cancel() { records.return?.() },
  })
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  })
}

export async function respond(req, records) {
  if (req.stream) return streamOut(records)
  const body = await mergeChunks(records, req.model)
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}
