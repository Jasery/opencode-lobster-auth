import { test, expect } from "bun:test"
import { PROVIDER, NAME, BASE, CHAT_BASE, NPM, FALLBACK_MODELS, configModel } from "../lib/constants.mjs"

test("provider identity is stable", () => {
  expect(PROVIDER).toBe("lobster")
  expect(NAME).toBe("LobsterAI")
  expect(BASE).toBe("https://lobsterai-server.youdao.com")
  expect(CHAT_BASE).toBe("https://lobsterai-server.youdao.com/api/proxy/v1")
  expect(NPM).toBe("@ai-sdk/openai-compatible")
})

test("fallback catalog is non-empty and shaped for magpie", () => {
  const ids = Object.keys(FALLBACK_MODELS)
  expect(ids.length).toBeGreaterThan(0)
  for (const id of ids) {
    const m = FALLBACK_MODELS[id]
    expect(m.name).toBeTruthy()
    expect(m.limit.context).toBeGreaterThan(0)
    expect(m.limit.output).toBeGreaterThan(0)
  }
})

test("configModel emits the flat shape the config hook needs", () => {
  const m = configModel({ name: "X", context: 1000, output: 100, reasoning: true, image: false })
  expect(m).toEqual({
    name: "X",
    limit: { context: 1000, output: 100 },
    reasoning: true,
    tool_call: true,
    modalities: { input: ["text"], output: ["text"] },
  })
})
