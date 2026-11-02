import { test, expect } from "bun:test"
import { levelOf, variantsOf, applyThinking, isKimiK3, applyKimi } from "../lib/thinking.mjs"

// 实测自 deepseek-flash 的 thinkingConfig
const PROFILE = {
  options: [{ level: "off", openclawLevel: "off" }, { level: "high", openclawLevel: "high" }, { level: "max", openclawLevel: "xhigh" }],
  defaultLevel: "max",
}

// magpie 的档位阶梯里没有 "off"：声明成 off 的那一档永远选不中
// （实测：发 off 被丢弃，发 none 才送得到）。对外叫 none，写给上游时换回 off。
test("variants expose the lowest level as none, not off", () => {
  expect(variantsOf(PROFILE)).toEqual({
    none: { lobsterai_thinking: "off" },
    high: { lobsterai_thinking: "high" },
    max: { lobsterai_thinking: "max" },
  })
})

test("variants never advertise a level magpie cannot reach", () => {
  expect(Object.keys(variantsOf(PROFILE))).not.toContain("off")
})

// magpie 下发的是它自己阶梯里的名字，插件必须换回上游的叫法
test("levelOf maps magpie's none back to off", () => {
  expect(levelOf({ reasoning_effort: "none" }, PROFILE)).toBe("off")
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

test("a cached or direct level absent from the current profile uses its default", () => {
  expect(levelOf({ reasoning_effort: "adaptive" }, PROFILE)).toBe("max")
  expect(levelOf({ reasoning_effort: "medium" }, PROFILE)).toBe("max")
})

test("a profile without off or a valid default still picks an offered level", () => {
  expect(levelOf({}, { options: [{ level: "high" }], defaultLevel: "off" })).toBe("high")
})

for (const model of ["kimi-k3.1-pro", "kimi-k3.1-pro-highspeed"]) {
  test(`tool-call history repair is independent of forced max: ${model}`, () => {
    const req = { model, reasoning_effort: "low", messages: [
      { role: "assistant", tool_calls: [{ id: "a" }] },
      { role: "assistant", tool_calls: [{ id: "b" }], reasoning_content: "kept" },
      { role: "assistant", content: "plain" },
    ] }
    applyKimi(req, model)
    expect(req.reasoning_effort).toBe("low")
    expect(req.messages[0].reasoning_content).toBe("")
    expect(req.messages[1].reasoning_content).toBe("kept")
    expect(req.messages[2].reasoning_content).toBeUndefined()
  })
}

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

// 调用方靠这个返回值决定要不要删掉 magpie 下发的 reasoning_effort：
// 没翻译成功时得留着，上游自己认那个字段。
test("applyThinking reports whether it wrote the protocol field", () => {
  expect(applyThinking({ model: "m", messages: [] }, PROFILE)).toBe(true)
  expect(applyThinking({ model: "qwen3.8-flash", messages: [] }, undefined)).toBe(false)
  expect(applyThinking({ model: "kimi-k2.6", messages: [] }, { options: [] })).toBe(false)
})

test("isKimiK3 is the exact kimi-k3 id", () => {
  expect(isKimiK3("kimi-k3")).toBe(true)
  // kimi-k3.1-pro 实测认完整档位（none/low/max → 0B/20B/156B），
  // 压成 max 会把它刚声明出来的档位全部抹掉
  expect(isKimiK3("kimi-k3.1-pro")).toBe(false)
  expect(isKimiK3("kimi-k3.1-pro-highspeed")).toBe(false)
  expect(isKimiK3("kimi-k2.6")).toBe(false)
})

// 上游拒收非默认采样参数的，实测是整个 Kimi 家族，不只是 kimi-k3：
// kimi-k3 / kimi-k3.1-pro / kimi-k2.8-preview 带 temperature=0.7 都报
// 50204 invalid temperature: only 1 is allowed for this model
// 而「强制 reasoning_effort=max」只属于 kimi-k3 家族 —— k3.1-pro 实测认完整档位
// （none/low/max → 0B/20B/156B），压成 max 会悄悄改掉用户选的档位。
// 所以这两个契约必须分开：applyKimi 按模型挑该做哪几件。
test("applyKimi strips fixed sampling params across the whole kimi family", () => {
  for (const model of ["kimi-k3", "kimi-k3.1-pro", "kimi-k3.1-pro-highspeed", "kimi-k2.8-preview"]) {
    const req = { model, temperature: 0.7, top_p: 0.5, n: 2, presence_penalty: 0.5, frequency_penalty: 0.5, messages: [] }
    applyKimi(req, model)
    expect(req.temperature).toBeUndefined()
    expect(req.top_p).toBeUndefined()
    expect(req.n).toBeUndefined()
    expect(req.presence_penalty).toBeUndefined()
    expect(req.frequency_penalty).toBeUndefined()
  }
})

test("applyKimi leaves the level alone for kimi models without the max contract", () => {
  const req = { model: "kimi-k2.8-preview", reasoning_effort: "low", messages: [] }
  applyKimi(req, "kimi-k2.8-preview")
  expect(req.reasoning_effort).toBe("low")
})

test("applyKimi still forces max for kimi-k3 itself", () => {
  const req = { model: "kimi-k3", reasoning_effort: "none", messages: [] }
  applyKimi(req, "kimi-k3")
  expect(req.reasoning_effort).toBe("max")
})

// 收窄之后，k3.1-pro 的档位必须原样透传 —— 否则它声明出来的档位是假的
test("applyKimi no longer overrides kimi-k3.1-pro's level", () => {
  for (const lv of ["none", "low", "xhigh", "max"]) {
    const req = { model: "kimi-k3.1-pro", reasoning_effort: lv, messages: [] }
    applyKimi(req, "kimi-k3.1-pro")
    expect(req.reasoning_effort).toBe(lv)
  }
})

// 反向保护：非 Kimi 模型的采样参数不能被删（deepseek/glm/qwen 实测都收 temperature）
test("applyKimi leaves a non-kimi model's sampling params alone", () => {
  for (const model of ["deepseek-flash", "glm-5.3", "qwen3.8-max", "MiniMax-M3"]) {
    const req = { model, temperature: 0.7, top_p: 0.5, messages: [] }
    applyKimi(req, model)
    expect(req.temperature).toBe(0.7)
    expect(req.top_p).toBe(0.5)
  }
})

test("applyKimi fixes sampling and repairs tool-call reasoning for kimi-k3", () => {
  const req = {
    model: "kimi-k3", temperature: 0.7, top_p: 0.9, n: 1,
    presence_penalty: 0, frequency_penalty: 0, thinking: { type: "enabled" },
    reasoningEffort: "high",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", tool_calls: [{ id: "c", type: "function", function: { name: "f", arguments: "{}" } }] },
    ],
  }
  applyKimi(req, "kimi-k3")
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
