// /api/models/available 的条目 → magpie 的运行时模型。
// 运行时模型用嵌套的 capabilities；config 钩子用扁平字段（见 constants.configModel）。

import { NPM, DEFAULT_OUTPUT, DEFAULT_CONTEXT, configModel, MEASURED_LEVELS } from "./constants.mjs"
import { variantsOf, variantsFromLevels } from "./thinking.mjs"

export function runtimeModel(entry, base = {}) {
  const id = String(entry.modelId ?? "")
  const image = !!entry.supportsImage
  const profile = entry.thinkingConfig
  const hasProfile = Array.isArray(profile?.options) && profile.options.length > 0
  // 上游自报「会思考」就认：10 个没有 thinkingConfig 的模型 supportsThinking 也是
  // true，上游同样认 reasoning_effort。原来按「有没有档位表」判，把这 10 个
  // 报成不思考，界面上连 reasoning 都不显示。
  const reasoning = !!entry.supportsThinking

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
      reasoning,
      attachment: image,
      toolcall: true,
      input: { text: true, image, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
    // 两个档位来源可能同时存在：上游某天给某个模型补了 thinkingConfig，而它也在
    // 实测表里。合并而不是二选一 —— 否则那一档会从实测的 6 档静默降回 3 档。
    // 档位表的键名已按 magpie 阶梯命名（off→none），直接并集即可。
    // 未实测过的模型只有档位表那几档；两样都没有就不声明（显示 thinks, no levels）。
    variants: mergeVariants(profile, hasProfile, MEASURED_LEVELS[id]),
    // magpie 自己的字段：一次请求消耗的点数倍率
    rate: Number(entry.costMultiplier) || 0,
  }
}

function mergeVariants(profile, hasProfile, measured) {
  const fromProfile = hasProfile ? variantsOf(profile) : {}
  const fromMeasured = variantsFromLevels(measured)
  if (Object.keys(fromMeasured).length === 0) return fromProfile
  if (Object.keys(fromProfile).length === 0) return fromMeasured
  return { ...fromProfile, ...fromMeasured }
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
