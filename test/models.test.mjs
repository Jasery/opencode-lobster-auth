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
  // 输出上限：实测 18 个可用模型全部接受 131072（glm-5.3 自报上限就是它），
  // 而 32000 会让长回答被截。524288 才 500。
  expect(m.limit).toEqual({ context: 1000000, output: 131072 })
  expect(m.capabilities.reasoning).toBe(true)
  expect(m.capabilities.toolcall).toBe(true)
  expect(m.capabilities.input.image).toBe(false)
  expect(m.rate).toBe(0.1)
})

test("thinking options become variants keyed by level", () => {
  expect(runtimeModel(ENTRY, {}).variants).toEqual({
    none: { lobsterai_thinking: "off" },
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

// ---- 没有 thinkingConfig 的模型（19 个可用里的 10 个）----
// 它们的 supportsThinking 是 true，上游也认 reasoning_effort、且分档确实有区别，
// 但原实现把 variants 留空、reasoning 置 false，于是界面上一档都选不了。
const NO_PROFILE = {
  modelId: "qwen3.8-max", modelName: "Qwen3.8-Max", supportsImage: true,
  supportsThinking: true, thinkingConfig: null, contextWindow: 1000000,
  costMultiplier: 0.91, accessible: true,
}

test("a model with no thinking profile still reports that it reasons", () => {
  expect(runtimeModel(NO_PROFILE, {}).capabilities.reasoning).toBe(true)
})

test("a model with no profile gets the levels measured for it", () => {
  const v = Object.keys(runtimeModel(NO_PROFILE, {}).variants)
  expect(v).toContain("none")
  expect(v).toContain("max")
})

// MiniMax-M3.1-Flash 实测拒收 none（"requires adaptive thinking"），
// qwen3.7-max / qwen3.7-plus 实测拒收 max。声明了它们就会让用户选中后 400。
test("a level the upstream refused is not offered", () => {
  const mm = runtimeModel({ ...NO_PROFILE, modelId: "MiniMax-M3.1-Flash" }, {})
  expect(Object.keys(mm.variants)).not.toContain("none")
  const q37 = runtimeModel({ ...NO_PROFILE, modelId: "qwen3.7-max" }, {})
  expect(Object.keys(q37.variants)).not.toContain("max")
})

// MiniMax-M3 的思考写在 content 的 <think> 里，reasoning_content 恒 0，
// 上游也不分档；只有「关」与「开」两种，中间档是假的。
test("a model whose upstream does not grade effort gets only none and max", () => {
  const mm = runtimeModel({ ...NO_PROFILE, modelId: "MiniMax-M3" }, {})
  expect(Object.keys(mm.variants).sort()).toEqual(["max", "none"])
})

test("a model that does not think gets no levels", () => {
  const m = runtimeModel({ ...NO_PROFILE, modelId: "some-embedding", supportsThinking: false }, {})
  expect(m.capabilities.reasoning).toBe(false)
  expect(m.variants).toEqual({})
})

// 有 profile 后请求走 lobsterai_options，旧 reasoning_effort 的测量不能直接合并。
test("the current thinking profile overrides previously measured levels", () => {
  const both = runtimeModel({ ...NO_PROFILE, modelId: "kimi-k3.1-pro", thinkingConfig: ENTRY.thinkingConfig }, {})
  expect(both.variants).toEqual({
    none: { lobsterai_thinking: "off" },
    high: { lobsterai_thinking: "high" },
    max: { lobsterai_thinking: "max" },
  })
})

for (const thinkingConfig of [null, ENTRY.thinkingConfig]) {
  test(`a measured model that no longer reasons declares no variants (profile=${!!thinkingConfig})`, () => {
    const m = runtimeModel({ ...NO_PROFILE, supportsThinking: false, thinkingConfig })
    expect(m.capabilities.reasoning).toBe(false)
    expect(m.variants).toEqual({})
  })
}

// 有档位表但不在实测表里的模型，仍然只用档位表（别凭空加档）
test("a profile-only model keeps exactly its profile's levels", () => {
  const m = runtimeModel({ ...ENTRY, modelId: "some-glm-model" }, {})
  expect(Object.keys(m.variants).sort()).toEqual(["high", "max", "none"])
})
