// LobsterAI（有道龙虾）的固定事实：地址、客户端标识、未登录时的兜底模型表。
// 兜底表只在没登录时显示；登录后由 /api/models/available 的实时结果替换。

export const PROVIDER = "lobster"
export const NAME = "LobsterAI"
export const BASE = "https://lobsterai-server.youdao.com"
export const API = BASE + "/api"
export const CHAT_BASE = BASE + "/api/proxy/v1"
export const NPM = "@ai-sdk/openai-compatible"

export const LOGIN_URL = "https://lobsterai.youdao.com/portal#/login"
export const ICON = "https://lobsterai.youdao.com/portal/lobsterai-logo.png"

// 桌面端 2026.9.23 发的标识头；上游不强制，但可能影响特性开关
export const CLIENT_VERSION = "2026.9.23"
export const CAPABILITIES = "kimi-k3-agentic-v1,thinking-level-control-v1"

// 输出上限。接口的 maxTokens 字段恒为 null，所以靠实测：
// 2026-11-02 逐模型打 max_tokens=131072，18 个可用模型全部通过；glm-5.3 自己
// 报的上限就是 [1, 131072]。524288 才 HTTP 500。原来的 32000 会把长回答截掉，
// 而 magpie 会把这个数当 max_output_tokens 广告给 agent。
export const DEFAULT_OUTPUT = 131072
export const DEFAULT_CONTEXT = 1000000

// 没有 thinkingConfig 的模型：上游照样认 reasoning_effort，但**每个模型接受的
// 档位不一样**，2026-11-02 逐模型实测（十模型 × 七档，见设计文档 §5 补测）：
//   MiniMax-M3.1-Flash 拒收 none（"requires adaptive thinking"）
//   qwen3.7-max        拒收 max（只到 xhigh）
//   qwen3.7-plus       max 偶发 500
//   MiniMax-M3         思考写在 content 的 <think> 里，reasoning_content 恒 0，
//                      上游不分档，只有「关 / 开」
// 只列**实测接受且确实有区别**的档位。没列进来的模型一律不声明（显示成
// 「thinks, no levels」），宁少不多：声明了却选不动，用户以为能控，实际被忽略或 400。
export const MEASURED_LEVELS = {
  "kimi-k3.1-pro": ["none", "low", "medium", "high", "xhigh", "max"],
  "kimi-k2.8-preview": ["none", "low", "medium", "high", "xhigh", "max"],
  "qwen3.8-max": ["none", "low", "medium", "high", "xhigh", "max"],
  "qwen3.8-flash": ["none", "low", "medium", "high", "xhigh", "max"],
  "qwen3.8-omni-flash": ["none", "low", "medium", "high", "xhigh", "max"],
  "doubao-seed-2-1-pro-260915": ["none", "low", "medium", "high", "xhigh", "max"],
  "MiniMax-M3.1-Flash": ["medium", "high", "xhigh", "max"],
  "qwen3.7-max": ["none", "low", "medium", "high", "xhigh"],
  "qwen3.7-plus": ["none", "low", "medium", "high", "xhigh"],
  // 只有「关」与「开」两种真实状态
  "MiniMax-M3": ["none", "max"],
}

export function configModel({ name, context, output, reasoning, image }) {
  const input = ["text"]
  if (image) input.push("image")
  return {
    name,
    limit: { context: context || DEFAULT_CONTEXT, output: output || DEFAULT_OUTPUT },
    reasoning: !!reasoning,
    tool_call: true,
    modalities: { input, output: ["text"] },
  }
}

// 兜底：未登录时让用户看到 provider 存在。字段来自实测的模型目录。
export const FALLBACK_MODELS = {
  "deepseek-v4-pro": configModel({ name: "DeepSeek V4 Pro", reasoning: true }),
  "deepseek-flash": configModel({ name: "DeepSeek Flash", reasoning: true }),
  "glm-5.3": configModel({ name: "GLM-5.3", reasoning: true }),
  "kimi-k3": configModel({ name: "Kimi K3", reasoning: true, image: true }),
  "qwen3.8-max": configModel({ name: "Qwen3.8 Max", reasoning: true }),
}
