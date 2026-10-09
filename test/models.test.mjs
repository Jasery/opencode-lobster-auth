import { test, expect } from "bun:test"
import { modelsFromCatalog, profileOfFrom, runtimeModel } from "../lib/models.mjs"

// 实测自 /api/models/available 的条目形状
const ENTRY = {
  modelId: "deepseek-flash", modelName: "DeepSeek Flash", provider: "LobsterAI",
  apiFormat: "openai", supportsImage: false, supportsThinking: true,
  thinkingConfig: {
    options: [{ level: "off", openclawLevel: "off" }, { level: "high", openclawLevel: "high" }, { level: "max", openclawLevel: "xhigh" }],
    defaultLevel: "max",
  },
  requestCapabilities: ["lobsterai-options-v1"],
  contextWindow: 1000000, costMultiplier: 0.1, accessible: true,
}

test("maps a catalog entry to a magpie model", () => {
  const m = runtimeModel(ENTRY, {})
  expect(m.id).toBe("deepseek-flash")
  expect(m.name).toBe("DeepSeek Flash")
  expect(m.limit).toEqual({ context: 1000000, output: 32000 })
  expect(m.capabilities.reasoning).toBe(true)
  expect(m.capabilities.toolcall).toBe(true)
  expect(m.capabilities.input.image).toBe(false)
  expect(m.rate).toBe(0.1)
})

test("thinking options become variants keyed by level", () => {
  expect(runtimeModel(ENTRY, {}).variants).toEqual({
    off: { lobsterai_thinking: "off" },
    high: { lobsterai_thinking: "high" },
    max: { lobsterai_thinking: "max" },
  })
})

test("image support reaches modalities and capabilities", () => {
  const m = runtimeModel({ ...ENTRY, supportsImage: true }, {})
  expect(m.capabilities.input.image).toBe(true)
})

test("inaccessible models are dropped", () => {
  const out = modelsFromCatalog([
    ENTRY,
    { ...ENTRY, modelId: "hidden", accessible: false },
  ], { models: {} })
  expect(Object.keys(out)).toEqual(["deepseek-flash"])
})

test("an empty catalog yields an empty map, not a crash", () => {
  expect(modelsFromCatalog([], { models: {} })).toEqual({})
})

test("profileOfFrom indexes thinking profiles by model id", () => {
  const p = profileOfFrom([ENTRY])
  expect(p["deepseek-flash"].defaultLevel).toBe("max")
})
