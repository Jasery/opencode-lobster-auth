import { PROVIDER, NAME, API, CHAT_BASE, NPM, FALLBACK_MODELS } from "./lib/constants.mjs"
import { makeFetch } from "./lib/proxy.mjs"
import { modelsFromCatalog, profileOfFrom } from "./lib/models.mjs"
import { usageFrom } from "./lib/usage.mjs"
import { desktopSignIn, desktopToken } from "./lib/auth-import.mjs"
import { beginSignIn } from "./lib/auth-login.mjs"
import { jwtExp } from "./lib/jwt.mjs"

const REFRESH_LEAD = 6 * 3600 * 1000

// 每个账号的模型 → 思考档位，供请求管线查表
const profiles = new Map()

async function apiGet(path, token, timeout = 20_000) {
  const res = await fetch(API + path, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(timeout),
  })
  const text = await res.text()
  let v
  try { v = JSON.parse(text) } catch { throw new Error(`LobsterAI ${path}: 响应无法解析`) }
  if (res.status === 401) {
    throw Object.assign(new Error("LobsterAI 的登录已过期，请重新登录"), { signIn: "expired" })
  }
  if (v?.code !== 0) throw new Error(`LobsterAI ${path}: ${v?.message || `code ${v?.code}`}`)
  return v.data
}

// 取这次请求要用的 token。
// 桌面端导入的账号自己不存 token（见 lib/auth-import.mjs），每次现读 ——
// 桌面端续期后插件自动跟上。读不到就抛 signIn:"expired"。
async function tokenOf(auth) {
  if (!auth) return ""
  if (auth.source === "desktop") return desktopToken()
  return auth.type === "oauth" ? (auth.access ?? "") : (auth.key ?? "")
}

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

  auth: {
    provider: PROVIDER,
    refreshLead: REFRESH_LEAD,

    methods: [
      {
        type: "oauth",
        label: "浏览器登录（有道账号）",
        async authorize() {
          // 由 magpie 打开这个 url；插件不再自己开一次，否则会开两个标签页
          const pending = await beginSignIn()
          return {
            url: pending.url,
            instructions: "在浏览器里用有道账号登录，完成后回到这里。",
            method: "auto",
            callback: () => pending.finish(),
          }
        },
      },
      {
        // 必须是 oauth：api 类型会让 magpie 强制从 stdin 读一个 key，
        // 而这条路根本不需要用户输入任何东西（见设计文档 §4.3）。
        type: "oauth",
        label: "从本机 LobsterAI 导入登录",
        async authorize() {
          // url 留空：magpie 不打开任何页面，直接走 callback
          return {
            url: "",
            instructions: "直接使用本机 LobsterAI 桌面端已登录的账号。",
            method: "auto",
            async callback() {
              try {
                return desktopSignIn()
              } catch (e) {
                return { type: "failed", error: e.message }
              }
            },
          }
        },
      },
    ],

    // 只对路径 A（浏览器登录，有 refresh 和 expires）生效。
    // 路径 B（桌面端导入）的 refresh 是空串、expires 为 0，
    // magpie 不会调用这里，桌面端的会话因此不会被搅动。
    async refresh(auth) {
      if (auth?.type !== "oauth" || auth.source === "desktop" || !auth.refresh) return {}
      const res = await fetch(`${API}/auth/refresh`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refreshToken: auth.refresh }),
        signal: AbortSignal.timeout(30_000),
      })
      const text = await res.text()
      let v
      try { v = JSON.parse(text) } catch { throw new Error("LobsterAI 续期：响应无法解析") }
      if (v?.code !== 0 || !v?.data?.accessToken) {
        throw Object.assign(new Error(`LobsterAI 续期失败：${v?.message || `code ${v?.code}`}`), { signIn: "expired" })
      }
      const d = v.data
      return {
        access: String(d.accessToken),
        refresh: String(d.refreshToken ?? auth.refresh),
        // 上游可能不给新 token 的 exp；读不到就沿用旧的到期时间
        expires: jwtExp(d.accessToken) || auth.expires || 0,
      }
    },

    async loader(getAuth) {
      const auth = await getAuth()
      // 这里只是给 magpie 一个「看起来已登录」的信号；真正的 token
      // 由下面的 fetch 每次请求现取（桌面端账号尤其需要）。
      let token = ""
      try { token = await tokenOf(auth) } catch { return {} }
      if (!token) return {}
      return {
        baseURL: CHAT_BASE,
        apiKey: token,
        headers: {},
        fetch: makeFetch({
          getAuth,
          tokenOf,
          profileOf: (id) => profiles.get(String(id)),
          call: (input, init) => fetch(input, init),
        }),
      }
    },

    async usage(getAuth) {
      const auth = await getAuth()
      let token = ""
      try { token = await tokenOf(auth) } catch (e) {
        return { error: e.message, windows: [], signIn: e.signIn === "expired" ? "expired" : "kept" }
      }
      if (!token) return { error: "尚未登录", windows: [] }
      try {
        const [quota, profile] = await Promise.all([
          apiGet("/user/quota", token),
          apiGet("/user/profile-summary", token),
        ])
        // 插件自己不续期（交给 magpie 的 auth.refresh），所以这次请求用的
        // 就是存下来的 token —— 如实报 kept。社区插件报 renewed 是因为它们
        // 自己维护续期表，这里没有那张表，不该照抄。
        return usageFrom(quota, profile, "kept")
      } catch (e) {
        return {
          error: e.message,
          windows: [],
          signIn: e.signIn === "expired" ? "expired" : "kept",
        }
      }
    },
  },

  provider: {
    id: PROVIDER,
    async models(provider, { auth } = {}) {
      let token = ""
      try { token = await tokenOf(auth) } catch (e) {
        if (e.signIn === "expired") throw e
        return provider.models
      }
      if (!token) return provider.models
      try {
        const list = await apiGet(
          "/models/available?firstKeyfrom=official&latestKeyfrom=official",
          token,
        )
        if (!Array.isArray(list) || list.length === 0) return provider.models
        for (const [id, p] of Object.entries(profileOfFrom(list))) profiles.set(id, p)
        const out = modelsFromCatalog(list, { ...provider, id: PROVIDER })
        return Object.keys(out).length > 0 ? out : provider.models
      } catch (e) {
        // 登录失效要标记账号；其余情况保留原列表
        if (e.signIn === "expired") throw e
        return provider.models
      }
    },
  },
})

// 唯一允许的函数导出：magpie 会把每个导出的函数都当成一个插件加载
export const _internal = { PROVIDER, FALLBACK_MODELS, usageFrom, modelsFromCatalog }
