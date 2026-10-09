import { test, expect } from "bun:test"
import { respond, mergeChunks } from "../lib/assemble.mjs"

async function* from(list) { for (const d of list) yield { event: "", data: d } }
const chunk = (delta, extra = {}) => JSON.stringify({
  id: "c1", object: "chat.completion.chunk", model: "deepseek-flash",
  choices: [{ index: 0, delta, finish_reason: extra.finish_reason ?? null }],
  ...(extra.usage ? { usage: extra.usage } : {}),
})

test("merges content, reasoning and streamed tool calls", async () => {
  const out = await mergeChunks(from([
    chunk({ content: "He", reasoning_content: "thi" }),
    chunk({ content: "llo", reasoning_content: "nk" }),
    chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "get_", arguments: "" } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: '{"a"' } }] }),
    chunk({ tool_calls: [{ index: 0, function: { arguments: ":1}" } }] }),
    chunk({}, { finish_reason: "tool_calls", usage: { prompt_tokens: 5, completion_tokens: 7 } }),
    "[DONE]",
  ]), "deepseek-flash")

  expect(out.object).toBe("chat.completion")
  expect(out.model).toBe("deepseek-flash")
  const msg = out.choices[0].message
  expect(msg.content).toBe("Hello")
  expect(msg.reasoning_content).toBe("think")
  expect(msg.tool_calls).toEqual([{
    id: "call_1", type: "function", function: { name: "get_", arguments: '{"a":1}' },
  }])
  expect(out.choices[0].finish_reason).toBe("tool_calls")
  expect(out.usage).toEqual({ prompt_tokens: 5, completion_tokens: 7 })
})

test("tool-only answers get a null content, not an empty string", async () => {
  const out = await mergeChunks(from([
    chunk({ tool_calls: [{ index: 0, id: "c", type: "function", function: { name: "f", arguments: "{}" } }] }),
    "[DONE]",
  ]), "m")
  expect(out.choices[0].message.content).toBeNull()
})

test("skips malformed records instead of throwing", async () => {
  const out = await mergeChunks(from(["not json", chunk({ content: "ok" }), "[DONE]"]), "m")
  expect(out.choices[0].message.content).toBe("ok")
})

test("non-streaming requests get one JSON body", async () => {
  const res = await respond({ stream: false, model: "m" }, from([chunk({ content: "hi" }), "[DONE]"]))
  expect(res.headers.get("content-type")).toBe("application/json")
  const body = await res.json()
  expect(body.choices[0].message.content).toBe("hi")
})

test("streaming requests get an SSE body ending in [DONE]", async () => {
  const res = await respond({ stream: true, model: "m" }, from([chunk({ content: "hi" })]))
  expect(res.headers.get("content-type")).toBe("text/event-stream")
  const text = await res.text()
  expect(text).toContain('data: {"id":"c1"')
  expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true)
})
