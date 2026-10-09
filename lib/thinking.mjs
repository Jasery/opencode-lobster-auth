// 上游的思考档位走私有字段，不是 reasoning_effort：
//   {"lobsterai_options":{"version":1,"thinking":{"level":"off"|"high"|"max"}}}
// 协议来自 LobsterAI 自带的 lobsterai-model-compat 插件
// （resources/cfmind/third-party-extensions/lobsterai-model-compat）。
//
// 实测（deepseek-flash）：level=off 时 reasoning_content 精确为 0 字节，
// 不带该字段约 300~900 字节 —— 即 off 会真正关掉思考。
//
// 档位怎么从用户到达这里：magpie 不用 variants 的值对象，而是维护一条自己的
// 档位阶梯（none/minimal/low/medium/high/xhigh/max），把入参 reasoning_effort
// 映射到「模型声明过的那个档位名」，再以 reasoning_effort 下发。阶梯外的名字
// （off/disabled/enabled/adaptive/空串）会被直接丢掉 —— 所以声明里用 "off"
// 当档位名，那一档就永远够不着（实测：发 off 被丢弃，发 none 才送得到）。
// 因此对外一律用 magpie 的 "none" 表示最低档，写给上游时再换回 LobsterAI 的 "off"。

export const OPTIONS_FIELD = "lobsterai_options"
export const OPTIONS_VERSION = 1
export const MARKER = "lobsterai_thinking"

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"]
const isLevel = (s) => LEVELS.includes(s)

// 上游叫 off，magpie 的阶梯里只有 none
const WIRE_TO_MAGPIE = { off: "none" }
const MAGPIE_TO_WIRE = { none: "off" }
const nameForMagpie = (level) => WIRE_TO_MAGPIE[level] ?? level
const levelForWire = (name) => MAGPIE_TO_WIRE[name] ?? name

// variants 只用到「键名」，值对象不会到达插件（magpie 的 host 只上报
// Object.keys）。键名必须是 magpie 阶梯内的名字，否则那一档选不中。
export function variantsOf(profile) {
  const opts = profile?.options ?? []
  return Object.fromEntries(opts.map((o) => [nameForMagpie(o.level), { [MARKER]: o.level }]))
}

// 档位可能以多种形式到达：插件自己的标记、reasoning_effort、reasoningEffort、
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
    // magpie 下发的是它阶梯里的名字（最低档叫 none），先换回上游的叫法
    const level = levelForWire(wanted)
    if (isLevel(level) && opts.some((o) => o.level === level)) return level
    const byOpenclaw =
      opts.find((o) => o.openclawLevel === wanted) ?? opts.find((o) => o.openclawLevel === level)
    if (byOpenclaw) return byOpenclaw.level
    if (isLevel(level)) return level
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
// 返回是否真的写了：调用方据此决定要不要把 magpie 下发的 reasoning_effort
// 删掉（没翻译成功时留着它，上游自己认这个字段，删掉等于白扔一个控制）。
export function applyThinking(req, profile) {
  // 先读再删：levelOf 的第一优先级就是插件自己的标记。
  const level = levelOf(req, profile)
  delete req[MARKER]
  const opts = profile?.options
  if (!Array.isArray(opts) || opts.length === 0) return false
  req[OPTIONS_FIELD] = { version: OPTIONS_VERSION, thinking: { level } }
  return true
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
