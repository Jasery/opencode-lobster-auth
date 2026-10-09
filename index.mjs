import { PROVIDER, NAME, API, NPM, ICON, FALLBACK_MODELS } from "./lib/constants.mjs"

export const LobsterAuthPlugin = async () => ({
  config: async (cfg) => {
    cfg.provider ??= {}
    cfg.provider[PROVIDER] ??= {
      name: NAME,
      npm: NPM,
      api: API,
      models: FALLBACK_MODELS,
    }
  },
})

// 唯一允许的函数导出：magpie 会把每个导出的函数都当成一个插件加载
export const _internal = { FALLBACK_MODELS }
