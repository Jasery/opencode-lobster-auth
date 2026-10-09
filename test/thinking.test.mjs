import { test, expect } from "bun:test"
import { levelOf, variantsOf, applyThinking, isKimiK3, applyKimiK3 } from "../lib/thinking.mjs"

// 实测自 deepseek-flash 的 thinkingConfig
const PROFILE = {
  options: [{ level: "off", openclawLevel: "off" }, { level: "high", openclawLevel: "high" }, { level: "max", openclawLevel: "xhigh" }],
  defaultLevel: "max",
}

test("variants are keyed by level and carry a plugin marker", () => {
  expect(variantsOf(PROFILE)).toEqual({
    off: { lobsterai_thinking: "off" },
    high: { lobsterai_thinking: "high" },
    max: { lobsterai_thinking: "max" },
  })
})

test("levelOf prefers the plugin marker", () => {
  expect(levelOf({ lobsterai_thinking: "high" }, PROFILE)).toBe("high")
})

test("levelOf accepts reasoning_effort and maps through openclawLevel", () => {
  expect(levelOf({ reasoning_effort: "xhigh" }, PROFILE)).toBe("max")
})

test("levelOf accepts reasoningEffort", () => {
  expect(levelOf({ reasoningEffort: "off" }, PROFILE)).toBe("off")
})

test("levelOf falls back to the profile default", () => {
  expect(levelOf({}, PROFILE)).toBe("max")
})

test("levelOf with no profile yields off", () => {
  expect(levelOf({}, undefined)).toBe("off")
})

test("applyThinking writes the protocol field and drops the marker", () => {
  const req = { model: "m", lobsterai_thinking: "high", messages: [] }
  applyThinking(req, PROFILE)
  expect(req.lobsterai_options).toEqual({ version: 1, thinking: { level: "high" } })
  expect("lobsterai_thinking" in req).toBe(false)
})

// 29 个模型里有 21 个 thinkingConfig 是 null。给这些模型带上 lobsterai_options
// 会被上游直接拒掉（实测 code 4000："model does not have a valid thinkingConfig"），
// 所以没有档位表时绝不能写这个字段。
test("applyThinking writes nothing for a model without a thinking profile", () => {
  const req = { model: "qwen3.8-flash", messages: [] }
  applyThinking(req, undefined)
  expect("lobsterai_options" in req).toBe(false)
})

test("applyThinking writes nothing when the profile has no options", () => {
  const req = { model: "kimi-k2.6", messages: [] }
  applyThinking(req, { options: [], defaultLevel: "off" })
  expect("lobsterai_options" in req).toBe(false)
})

test("applyThinking still drops the marker when it writes nothing", () => {
  const req = { model: "m", lobsterai_thinking: "high", messages: [] }
  applyThinking(req, undefined)
  expect("lobsterai_thinking" in req).toBe(false)
  expect("lobsterai_options" in req).toBe(false)
})

test("isKimiK3 matches the family but not unrelated ids", () => {
  expect(isKimiK3("kimi-k3")).toBe(true)
  expect(isKimiK3("kimi-k3-auto-max")).toBe(true)
  expect(isKimiK3("kimi-k2.6")).toBe(false)
})

test("applyKimiK3 fixes sampling and repairs tool-call reasoning", () => {
  const req = {
    model: "kimi-k3", temperature: 0.7, top_p: 0.9, n: 1,
    presence_penalty: 0, frequency_penalty: 0, thinking: { type: "enabled" },
    reasoningEffort: "high",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", tool_calls: [{ id: "c", type: "function", function: { name: "f", arguments: "{}" } }] },
    ],
  }
  applyKimiK3(req)
  expect(req.temperature).toBeUndefined()
  expect(req.top_p).toBeUndefined()
  expect(req.n).toBeUndefined()
  expect(req.presence_penalty).toBeUndefined()
  expect(req.frequency_penalty).toBeUndefined()
  expect(req.thinking).toBeUndefined()
  expect(req.reasoningEffort).toBeUndefined()
  expect(req.reasoning_effort).toBe("max")
  expect(req.messages[1].reasoning_content).toBe("")
  expect("reasoning_content" in req.messages[0]).toBe(false)
})
