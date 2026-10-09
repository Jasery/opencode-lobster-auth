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

// 接口不提供输出上限，取一个保守值（见设计文档 §8）
export const DEFAULT_OUTPUT = 32000
export const DEFAULT_CONTEXT = 1000000

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
