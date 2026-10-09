// 从本机 LobsterAI 桌面端的 sqlite 里读出登录信息。
// 表：CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)
//   auth_tokens -> {"accessToken":"…","refreshToken":"…"}
//   auth_user   -> {"yid","id","nickname"}
//
// 必须只读：桌面端可能正在运行，插件绝不写入它的库。

import { Database } from "bun:sqlite"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { jwtExp, accountOf } from "./jwt.mjs"

export function dbPath(env = process.env) {
  const home = env.HOME || env.USERPROFILE || ""
  if (process.platform === "win32") {
    const appdata = env.APPDATA || (home ? join(home, "AppData", "Roaming") : "")
    return join(appdata, "LobsterAI", "lobsterai.sqlite")
  }
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "LobsterAI", "lobsterai.sqlite")
  }
  const cfg = env.XDG_CONFIG_HOME || join(home, ".config")
  return join(cfg, "LobsterAI", "lobsterai.sqlite")
}

const parse = (s) => {
  try {
    const v = JSON.parse(String(s ?? ""))
    return v && typeof v === "object" ? v : null
  } catch { return null }
}

export function readCredentials(path) {
  if (!path || !existsSync(path)) return null
  let db
  try {
    // 只读打开：绝不改动桌面端的库
    db = new Database(path, { readonly: true })
    const rows = db.query("SELECT key, value FROM kv WHERE key IN ('auth_tokens','auth_user')").all()
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]))
    const tokens = parse(byKey.auth_tokens)
    const accessToken = String(tokens?.accessToken ?? "")
    if (!accessToken) return null
    const user = parse(byKey.auth_user) ?? {}
    const claims = accountOf(accessToken)
    return {
      accessToken,
      refreshToken: String(tokens?.refreshToken ?? ""),
      yid: user.yid ?? claims.yid,
      id: user.id ?? claims.id,
      nickname: user.nickname,
      expires: jwtExp(accessToken),
    }
  } catch {
    return null
  } finally {
    try { db?.close() } catch {}
  }
}

// 桌面端这条路只借一个身份，**不存 token**：
//   access/refresh 都留空，expires 为 0，靠 source:"desktop" 标记来源。
// token 每次用的时候现读（desktopToken），所以桌面端续期后插件自动跟着用新的。
//
// 为什么不把 token 抄一份：抄下来的 refreshToken 会是桌面端和插件共用的，
// 谁先续期谁就把对方踢下线。留空则 magpie 永不续期（expires 为 0），
// 桌面端的会话不受任何影响。
export function desktopSignIn(env = process.env) {
  const path = dbPath(env)
  const c = readCredentials(path)
  if (!c) {
    throw new Error(
      `没有在本机找到 LobsterAI 的登录信息（${path}）。` +
      "请先在 LobsterAI 桌面端登录，或改用「浏览器登录」。",
    )
  }
  return {
    type: "success",
    refresh: "",
    access: "",
    expires: 0,
    source: "desktop",
    accountId: c.yid ?? (c.id !== undefined ? String(c.id) : undefined),
    uid: c.id,
  }
}

// 桌面端账号的 token：每次现读，桌面端换了 token 插件立刻跟上。
// 读不到就是账号不可用（桌面端退出登录、库被删、文件被加密），
// 报 signIn:"expired" 让 magpie 给账号打上失效标记，提示用户重新登录。
export function desktopToken(env = process.env) {
  const c = readCredentials(dbPath(env))
  if (!c) {
    throw Object.assign(
      new Error("LobsterAI 桌面端未登录，或它的登录信息已不可读"),
      { signIn: "expired" },
    )
  }
  return c.accessToken
}
