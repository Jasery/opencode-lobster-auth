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

const identityValue = (value) => {
  if (typeof value === "string") return value.trim() || undefined
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  return undefined
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
    // 两行可能分开更新。身份必须来自实际使用的 token；用户行只能在已有
    // 共同标识吻合、且没有任何冲突时补全字段，不能让旧用户行替新 token 作证。
    const fields = ["yid", "id"]
    const shared = fields.filter((key) => identityValue(claims[key]) !== undefined && identityValue(user[key]) !== undefined)
    const identityConflict = shared.some((key) => identityValue(claims[key]) !== identityValue(user[key]))
    const verifiedUser = shared.length > 0 && !identityConflict
    return {
      accessToken,
      refreshToken: String(tokens?.refreshToken ?? ""),
      yid: identityValue(claims.yid) !== undefined ? claims.yid : verifiedUser ? user.yid : undefined,
      id: identityValue(claims.id) !== undefined ? claims.id : verifiedUser ? user.id : undefined,
      identityConflict,
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
// 账号身份。magpie 支持一个插件挂多个账号，靠 accountId 区分，所以这个值
// 既是「这个号叫什么」，也是下次读桌面端时核对「还是不是同一个号」的依据。
// 优先用 yid（有道的账号标识），没有就退回数字 id 的字符串形式。
// yid 一律转成字符串：magpie 往返一轮后回来的是字符串，留着数字会让
// 同一个号在两侧比不相等，把好账号误判成「切换了账号」。
export function accountIdOf(c) {
  return identityValue(c?.yid) ?? identityValue(c?.id)
}

function requireIdentity(c) {
  if (c.identityConflict) {
    throw Object.assign(new Error("LobsterAI 桌面端 token 与账号身份不一致（可能正在切换账号），请稍后重新登录"), { signIn: "expired" })
  }
  if (!accountIdOf(c)) {
    throw Object.assign(new Error("LobsterAI 桌面端 token 的账号身份不可读，请重新登录本账号"), { signIn: "expired" })
  }
}

export function desktopSignIn(env = process.env) {
  const path = dbPath(env)
  const c = readCredentials(path)
  if (!c) {
    throw new Error(
      `没有在本机找到 LobsterAI 的登录信息（${path}）。` +
      "请先在 LobsterAI 桌面端登录，或改用「浏览器登录」。",
    )
  }
  requireIdentity(c)
  return {
    type: "success",
    refresh: "",
    access: "",
    expires: 0,
    source: "desktop",
    accountId: accountIdOf(c),
    // magpie 只认字符串 uid（源码 uidOf），存数字等于没存
    uid: identityValue(c.id),
  }
}

// 桌面端账号的 token：每次现读，桌面端换了 token 插件立刻跟上。
// 读不到就是账号不可用（桌面端退出登录、库被删、文件被加密），
// 报 signIn:"expired" 让 magpie 给账号打上失效标记，提示用户重新登录。
//
// expected 是这个账号签入时记下的身份，expectedUid 是当时记下的数字 id。
// 桌面端只有一个「当前登录」，换账号后现读到的就是别人的 token —— 不核对的话，
// 原账号会显示别人的余额、扣别人的积分、签到签在别人头上。
//
// 至少一个绑定标识要匹配，同时不能有其它可比较标识冲突。签入时只有数字 id、
// 后来补上 yid 的情况仍可按 id 识别；但 uid 相同不能掩盖已绑定 yid 的变化。
// 没保存绑定身份的老账号仍兼容；token 无身份或与用户行冲突时一律 fail-closed。
export function desktopToken(env = process.env, expected, expectedUid) {
  const c = readCredentials(dbPath(env))
  if (!c) {
    throw Object.assign(
      new Error("LobsterAI 桌面端未登录，或它的登录信息已不可读"),
      { signIn: "expired" },
    )
  }
  requireIdentity(c)
  const account = identityValue(expected)
  const uid = identityValue(expectedUid)
  if (account === undefined && uid === undefined) return c.accessToken
  const now = accountIdOf(c)
  const currentYid = identityValue(c.yid)
  const currentUid = identityValue(c.id)
  const accountWasUid = account !== undefined && (account === uid || account === currentUid)
  const conflict =
    (uid !== undefined && currentUid !== undefined && uid !== currentUid) ||
    (account !== undefined && currentYid !== undefined && account !== currentYid && !accountWasUid)
  const sameAccount =
    (account !== undefined && (account === now || account === currentUid)) ||
    (uid !== undefined && uid === currentUid)
  if (conflict || !sameAccount) {
    throw Object.assign(
      new Error(
        now
          ? `LobsterAI 桌面端已切换到其它账号（当前 ${now}，本账号 ${expected}），请重新登录本账号`
          : "LobsterAI 桌面端当前登录的账号身份不可读（可能刚切换过），请确认后在桌面端重新登录本账号",
      ),
      { signIn: "expired" },
    )
  }
  return c.accessToken
}
