// 上游的思考档位走私有字段，不是 reasoning_effort：
//   {"lobsterai_options":{"version":1,"thinking":{"level":"off"|"high"|"max"}}}
// 协议来自 LobsterAI 自带的 lobsterai-model-compat 插件
// （resources/cfmind/third-party-extensions/lobsterai-model-compat）。
//
// 实测（deepseek-flash，同一问题）：level=off 时 reasoning_content 约 0 字节，
// level=max 约 16.8KB，不带该字段约 19.3KB —— 即 off 会真正关掉思考。

export const OPTIONS_FIELD = "lobsterai_options"
export const OPTIONS_VERSION = 1
export const MARKER = "lobsterai_thinking"

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
const isLevel = (s) => LEVELS.includes(s)

// variants 的值对象会被 magpie 合并进请求体（社区插件据此传 reasoningEffort）。
// 这里放一个插件自读的标记，fetch 再把它翻译成 lobsterai_options。
export function variantsOf(profile) {
  const opts = profile?.options ?? []
  return Object.fromEntries(opts.map((o) => [o.level, { [MARKER]: o.level }]))
}

// 档位可能以多种形式到达：插件的标记、reasoning_effort、reasoningEffort、
// thinking.level。按 level 或 openclawLevel 查表，未命中用 defaultLevel。
export function levelOf(req, profile) {
  const opts = profile?.options ?? []
  const wanted = [
    req?.[MARKER],
    req?.reasoning_effort,
    req?.reasoningEffort,
    req?.thinking?.level,
  ].find((v) => typeof v === "string" && v !== "")

  if (wanted) {
    if (isLevel(wanted) && opts.some((o) => o.level === wanted)) return wanted
    const byOpenclaw = opts.find((o) => o.openclawLevel === wanted)
    if (byOpenclaw) return byOpenclaw.level
    if (isLevel(wanted)) return wanted
  }
  if (profile?.defaultLevel && isLevel(profile.defaultLevel)) return profile.defaultLevel
  return "off"
}

// 上游只在模型自带 thinkingConfig 时才接受 lobsterai_options。对没有档位表的
// 模型带上该字段是硬错误，实测 code 4000：
//   "lobsterai_options: model does not have a valid thinkingConfig"
// 29 个模型里有 21 个 thinkingConfig 是 null，因此必须按「有没有档位表」来
// 决定写不写 —— 桌面端的 lobsterai-model-compat 插件也是这么做的
// （index.ts 用 thinkingProfile.requestOptionsVersion 当闸门）。
export function applyThinking(req, profile) {
  // 先读再删：levelOf 的第一优先级就是插件自己的标记。
  const level = levelOf(req, profile)
  delete req[MARKER]
  const opts = profile?.options
  if (!Array.isArray(opts) || opts.length === 0) return
  req[OPTIONS_FIELD] = { version: OPTIONS_VERSION, thinking: { level } }
}

// Kimi K3 的额外契约（LobsterAI 的 kimiK3StreamWrapper.ts）：
// 采样参数由服务端固定，必须删掉；reasoning_effort 固定为 max；
// 历史里缺 reasoning_content 的 assistant tool_call 消息会被拒答。
const K3_FIXED = ["temperature", "top_p", "n", "presence_penalty", "frequency_penalty"]

export function isKimiK3(modelId) {
  return /^kimi-k3(?:$|[-.])/i.test(String(modelId ?? ""))
}

export function applyKimiK3(req) {
  delete req.thinking
  delete req.reasoningEffort
  for (const f of K3_FIXED) delete req[f]
  req.reasoning_effort = "max"
  if (!Array.isArray(req.messages)) return
  for (const m of req.messages) {
    if (m?.role !== "assistant") continue
    if (!Array.isArray(m.tool_calls) || m.tool_calls.length === 0) continue
    if (!("reasoning_content" in m)) m.reasoning_content = ""
  }
}
