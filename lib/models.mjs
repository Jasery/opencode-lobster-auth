// /api/models/available 的条目 → magpie 的运行时模型。
// 运行时模型用嵌套的 capabilities；config 钩子用扁平字段（见 constants.configModel）。

import { NPM, DEFAULT_OUTPUT, DEFAULT_CONTEXT, configModel } from "./constants.mjs"
import { variantsOf } from "./thinking.mjs"

export function runtimeModel(entry, base = {}) {
  const id = String(entry.modelId ?? "")
  const image = !!entry.supportsImage
  const profile = entry.thinkingConfig
  const hasThinking = !!entry.supportsThinking && Array.isArray(profile?.options) && profile.options.length > 0

  return {
    ...base,
    id,
    providerID: base.providerID,
    name: String(entry.modelName ?? id),
    api: { id, url: "", npm: NPM },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: Number(entry.contextWindow) || DEFAULT_CONTEXT, output: DEFAULT_OUTPUT },
    capabilities: {
      temperature: true,
      reasoning: hasThinking,
      attachment: image,
      toolcall: true,
      input: { text: true, image, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
    variants: hasThinking ? variantsOf(profile) : {},
    // magpie 自己的字段：一次请求消耗的点数倍率
    rate: Number(entry.costMultiplier) || 0,
  }
}

export function modelsFromCatalog(list, provider) {
  const out = {}
  for (const entry of Array.isArray(list) ? list : []) {
    if (!entry || entry.accessible === false) continue
    const id = String(entry.modelId ?? "")
    if (!id) continue
    const was = provider?.models?.[id] ?? {}
    out[id] = runtimeModel(entry, { ...was, providerID: provider?.id })
  }
  return out
}

export function profileOfFrom(list) {
  const out = {}
  for (const entry of Array.isArray(list) ? list : []) {
    const id = String(entry?.modelId ?? "")
    if (id && entry.thinkingConfig) out[id] = entry.thinkingConfig
  }
  return out
}

// 未登录时 config 钩子用的扁平形状
export function configModels(list) {
  const out = {}
  for (const entry of Array.isArray(list) ? list : []) {
    if (!entry || entry.accessible === false) continue
    const id = String(entry.modelId ?? "")
    if (!id) continue
    out[id] = configModel({
      name: String(entry.modelName ?? id),
      context: Number(entry.contextWindow) || DEFAULT_CONTEXT,
      output: DEFAULT_OUTPUT,
      reasoning: !!entry.supportsThinking,
      image: !!entry.supportsImage,
    })
  }
  return out
}
