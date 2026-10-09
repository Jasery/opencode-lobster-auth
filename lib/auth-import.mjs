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

// 存成 {type:"api"}：没有 expires，magpie 因此永不续期（见设计文档 §4.3），
// 桌面端的会话不会被搅动。
export function importAuth(env = process.env) {
  const path = dbPath(env)
  const c = readCredentials(path)
  if (!c) {
    throw new Error(
      `没有在本机找到 LobsterAI 的登录信息（${path}）。` +
      "请先在 LobsterAI 桌面端登录，或改用「浏览器登录」。",
    )
  }
  const metadata = {}
  if (c.yid) metadata.accountId = c.yid
  if (c.nickname) metadata.nickname = c.nickname
  if (c.expires) metadata.expires = c.expires
  return { type: "success", key: c.accessToken, metadata }
}
