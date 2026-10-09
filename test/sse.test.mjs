import { test, expect } from "bun:test"
import { sse, first, chain } from "../lib/sse.mjs"

async function* from(list) { for (const s of list) yield new TextEncoder().encode(s) }
const collect = async (it) => { const out = []; for await (const r of it) out.push(r); return out }

test("parses events split across chunk boundaries", async () => {
  const got = await collect(sse(from(["data: {\"a\"", ":1}\n\n", "data: [DONE]\n\n"])))
  expect(got).toEqual([{ event: "", data: '{"a":1}' }, { event: "", data: "[DONE]" }])
})

test("carries event names and joins multi-line data", async () => {
  const got = await collect(sse(from(["event: error\ndata: {\"x\":\ndata: 1}\n\n"])))
  expect(got).toEqual([{ event: "error", data: '{"x":\n1}' }])
})

test("ignores comments and tolerates CRLF", async () => {
  const got = await collect(sse(from([": keep-alive\r\n\r\ndata: hi\r\n\r\n"])))
  expect(got).toEqual([{ event: "", data: "hi" }])
})

test("flushes a trailing event with no blank line", async () => {
  const got = await collect(sse(from(["data: tail"])))
  expect(got).toEqual([{ event: "", data: "tail" }])
})

test("first() peeks without losing the record", async () => {
  const { head, rest } = await first(sse(from(["data: one\n\ndata: two\n\n"])))
  expect(head).toEqual({ event: "", data: "one" })
  expect(await collect(rest)).toEqual([{ event: "", data: "one" }, { event: "", data: "two" }])
})

test("first() on an empty stream yields null", async () => {
  const { head } = await first(sse(from([])))
  expect(head).toBeNull()
})

test("chain replays held records then the rest", async () => {
  const got = await collect(chain([{ event: "", data: "held" }], sse(from(["data: live\n\n"]))))
  expect(got).toEqual([{ event: "", data: "held" }, { event: "", data: "live" }])
})
