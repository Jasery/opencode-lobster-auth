import { test, expect } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { dbPath, readCredentials, desktopSignIn, desktopToken } from "../lib/auth-import.mjs"

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url")
const TOKEN = `h.${b64({ sub: 67097, yid: "urs-phoneyd.abc@163.com", exp: 1793152423 })}.s`

function makeDb({ tokens = TOKEN, user = '{"yid":"urs-phoneyd.abc@163.com","id":67097,"nickname":"Ada"}' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "lobster-test-"))
  const file = join(dir, "lobsterai.sqlite")
  const db = new Database(file, { create: true })
  db.run("CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)")
  if (tokens !== null) {
    db.run("INSERT INTO kv VALUES (?,?,?)", ["auth_tokens", JSON.stringify({ accessToken: tokens, refreshToken: "r" }), 0])
  }
  if (user !== null) db.run("INSERT INTO kv VALUES (?,?,?)", ["auth_user", user, 0])
  db.close()
  return { dir, file }
}

test("dbPath is the desktop app's data directory", () => {
  const p = dbPath({ APPDATA: "C:\\Users\\x\\AppData\\Roaming" })
  expect(p).toContain("LobsterAI")
  expect(p.endsWith("lobsterai.sqlite")).toBe(true)
})

test("reads the token and the account", () => {
  const { dir, file } = makeDb()
  try {
    const c = readCredentials(file)
    expect(c.accessToken).toBe(TOKEN)
    expect(c.refreshToken).toBe("r")
    expect(c.nickname).toBe("Ada")
    expect(c.yid).toBe("urs-phoneyd.abc@163.com")
    expect(c.id).toBe(67097)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("a database without the keys reads as null", () => {
  const { dir, file } = makeDb({ tokens: null, user: null })
  try { expect(readCredentials(file)).toBeNull() }
  finally { rmSync(dir, { recursive: true, force: true }) }
})

test("a missing file reads as null, not a throw", () => {
  expect(readCredentials(join(tmpdir(), "definitely-absent-lobster.sqlite"))).toBeNull()
})

// 造一份「桌面端已经登录」的环境：目录按各平台的 dbPath 规则摆好
function makeDesktop({ tokens = TOKEN, user = '{"yid":"urs-phoneyd.abc@163.com","id":67097,"nickname":"Ada"}' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "lobster-desktop-"))
  const env = { APPDATA: dir, HOME: dir, USERPROFILE: dir, XDG_CONFIG_HOME: dir }
  const file = dbPath(env)
  mkdirSync(dirname(file), { recursive: true })
  const db = new Database(file, { create: true })
  db.run("CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)")
  if (tokens !== null) {
    db.run("INSERT INTO kv VALUES (?,?,?)", ["auth_tokens", JSON.stringify({ accessToken: tokens, refreshToken: "r" }), 0])
    if (user !== null) db.run("INSERT INTO kv VALUES (?,?,?)", ["auth_user", user, 0])
  }
  db.close()
  return { dir, env }
}

test("the desktop sign-in stores no token of its own", () => {
  const { dir, env } = makeDesktop()
  try {
    const r = desktopSignIn(env)
    expect(r.type).toBe("success")
    // 关键：一个字节的凭据都不留。抄一份 refreshToken 会让桌面端和插件
    // 共用同一个 token，谁先续期谁就把对方踢下线。
    expect(r.access).toBe("")
    expect(r.refresh).toBe("")
    expect(r.expires).toBe(0)
    expect(r.source).toBe("desktop")
    expect(r.accountId).toBe("urs-phoneyd.abc@163.com")
    // magpie 只认字符串 uid（源码 uidOf），存成数字等于没存
    expect(r.uid).toBe("67097")
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// magpie 支持一个插件挂多个账号。桌面端只有一个「当前登录」，所以插件的
// 桌面账号必须核对身份，否则桌面端换账号后，原账号会悄悄用上别人的 token：
// 卡片显示别人的余额、请求扣别人的积分、签到签在别人头上。
test("a desktop token read for a different account reports a changed account", () => {
  const { dir, env } = makeDesktop({
    user: '{"yid":"someone-else@163.com","id":99001,"nickname":"Bob"}',
  })
  try {
    let caught = null
    try { desktopToken(env, "urs-phoneyd.abc@163.com") } catch (e) { caught = e }
    expect(caught?.signIn).toBe("expired")
    expect(caught?.message).toContain("切换")
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("a desktop token read for the same account is returned", () => {
  const { dir, env } = makeDesktop()
  try {
    expect(desktopToken(env, "urs-phoneyd.abc@163.com")).toBe(TOKEN)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// 身份比对之前签入的老账号没有 accountId，不能因此就判定失效
test("an account signed in before identity was kept still reads its token", () => {
  const { dir, env } = makeDesktop()
  try {
    expect(desktopToken(env)).toBe(TOKEN)
    expect(desktopToken(env, undefined)).toBe(TOKEN)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("a desktop sign-in with nothing to read fails loudly", () => {
  const { dir, env } = makeDesktop({ tokens: null })
  try {
    expect(() => desktopSignIn(env)).toThrow(/LobsterAI/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("the desktop token is read fresh each time", () => {
  const { dir, env } = makeDesktop()
  try {
    expect(desktopToken(env)).toBe(TOKEN)
    // 桌面端续期后，插件下一次调用立刻用上新的 token
    const other = `h.${b64({ sub: 67097, yid: "urs-phoneyd.abc@163.com", exp: 1793152423 })}.s2`
    const db = new Database(dbPath(env))
    db.run("UPDATE kv SET value=? WHERE key='auth_tokens'", [JSON.stringify({ accessToken: other, refreshToken: "r" })])
    db.close()
    expect(desktopToken(env)).toBe(other)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("an unreadable desktop token is reported as a lapsed sign-in", () => {
  const { dir, env } = makeDesktop({ tokens: null })
  try {
    let caught = null
    try { desktopToken(env) } catch (e) { caught = e }
    expect(caught?.signIn).toBe("expired")
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// 桌面端把 auth_user 写成读不出身份的行（新账号还没落库、或行被写坏），
// 而 auth_tokens 里已经是别人的了 —— 这是串号最容易发生的时刻。
// 此时身份的兜底来源是 token 自己的 claims；连 claims 都没有就必须 fail-closed，
// 不能把 token 交出去。
test("a desktop token with no readable identity anywhere is not handed out", () => {
  const opaque = `h.${b64({ typ: "Bearer" })}.s` // 没有任何 yid / sub
  const { dir, env } = makeDesktop({ tokens: opaque, user: "{}" })
  try {
    let caught = null
    try { desktopToken(env, "urs-phoneyd.abc@163.com") } catch (e) { caught = e }
    expect(caught?.signIn).toBe("expired")
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// 身份有两个来源：auth_user 行、token 自己的 claims。行的 yid 丢了也不影响
// accountId —— readCredentials 会从 claims 兜底，所以同一账号的身份是稳定的。
test("an account's identity survives losing yid from the auth_user row", () => {
  const { dir, env } = makeDesktop()
  try {
    const signed = desktopSignIn(env)
    const db = new Database(dbPath(env))
    db.run("UPDATE kv SET value=? WHERE key='auth_user'", ['{"id":67097}'])
    db.close()
    // 行里没 yid 了，但 claims 里还有，身份不变，不该被判成换账号
    expect(() => desktopToken(env, signed.accountId, signed.uid)).not.toThrow()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// 只靠数字 id 也要能认出同一个号（yid 缺失时 accountId 退化成 id 的字符串）
test("an account stored by its numeric id is recognised by its uid", () => {
  const opaque = `h.${b64({ sub: 67097, exp: 1793152423 })}.s` // 无 yid
  const { dir, env } = makeDesktop({ tokens: opaque, user: '{"id":67097}' })
  try {
    const signed = desktopSignIn(env)
    expect(signed.accountId).toBe("67097")
    expect(() => desktopToken(env, signed.accountId, signed.uid)).not.toThrow()
    expect(() => desktopToken(env, "someone-else", "999")).toThrow()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

// yid 是数字时也要能比对：magpie 往返一轮后回来的是字符串
test("a numeric yid still compares equal to the stored string", () => {
  const tokens = `h.${b64({ sub: 67097, yid: 12345 })}.s`
  const { dir, env } = makeDesktop({ tokens, user: '{"yid":12345,"id":67097}' })
  try {
    const signed = desktopSignIn(env)
    expect(typeof signed.accountId).toBe("string")
    expect(() => desktopToken(env, signed.accountId, signed.uid)).not.toThrow()
    expect(() => desktopToken(env, "99999", "1")).toThrow()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

function updateDesktop(env, key, value) {
  const db = new Database(dbPath(env))
  try { db.run("UPDATE kv SET value=? WHERE key=?", [JSON.stringify(value), key]) }
  finally { db.close() }
}

// 切换账号不是原子更新：用户行还属于 A，token 已经属于 B。
test("a new token cannot borrow the old auth_user identity", () => {
  const { dir, env } = makeDesktop()
  try {
    const signed = desktopSignIn(env)
    const other = `h.${b64({ sub: 99001, yid: "other@example.test" })}.s`
    updateDesktop(env, "auth_tokens", { accessToken: other })
    expect(() => desktopToken(env, signed.accountId, signed.uid)).toThrow()
    expect(() => desktopToken(env)).toThrow() // 老账号也不能放过冲突快照
    expect(() => desktopSignIn(env)).toThrow()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

for (const user of [
  { yid: "other@example.test", id: 67097 }, // id 匹配不能掩盖 yid 冲突
  { yid: "urs-phoneyd.abc@163.com", id: 99001 }, // 反过来也一样
]) {
  test(`a conflicting identity field fails closed: ${JSON.stringify(user)}`, () => {
    const { dir, env } = makeDesktop()
    try {
      const signed = desktopSignIn(env)
      updateDesktop(env, "auth_user", user)
      let caught
      try { desktopToken(env, signed.accountId, signed.uid) } catch (e) { caught = e }
      expect(caught?.signIn).toBe("expired")
      expect(() => desktopSignIn(env)).toThrow()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
}

test("a token without identity cannot borrow it from auth_user", () => {
  const tokens = `h.${b64({ typ: "Bearer" })}.s`
  const { dir, env } = makeDesktop({ tokens })
  try {
    expect(() => desktopToken(env, "urs-phoneyd.abc@163.com", "67097")).toThrow()
    expect(() => desktopSignIn(env)).toThrow()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("a matching stored uid cannot hide a changed stored accountId", () => {
  const { dir, env } = makeDesktop()
  try {
    expect(() => desktopToken(env, "other@example.test", "67097")).toThrow()
    expect(() => desktopToken(env, "urs-phoneyd.abc@163.com", "99001")).toThrow()
    expect(() => desktopToken(env, undefined, "99001")).toThrow()
    expect(desktopToken(env, undefined, "67097")).toBe(TOKEN)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("an id-only sign-in still works after its verified user row gains yid", () => {
  const tokens = `h.${b64({ sub: 67097 })}.s`
  const { dir, env } = makeDesktop({ tokens, user: '{"id":67097}' })
  try {
    const signed = desktopSignIn(env)
    expect(signed.accountId).toBe("67097")
    updateDesktop(env, "auth_user", { id: "67097", yid: "same@example.test" })
    expect(desktopToken(env, signed.accountId, signed.uid)).toBe(tokens)
    expect(desktopSignIn(env).accountId).toBe("same@example.test")
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("unrelated user fields do not supply identity without a common token identifier", () => {
  const tokens = `h.${b64({ sub: 67097 })}.s`
  const { dir, env } = makeDesktop({ tokens, user: '{"yid":"unverified@example.test"}' })
  try {
    expect(desktopSignIn(env).accountId).toBe("67097")
    expect(() => desktopToken(env, "unverified@example.test")).toThrow()
    expect(desktopToken(env, "67097")).toBe(tokens)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("claims alone identify the same account when the user row disappears", () => {
  const { dir, env } = makeDesktop({ user: null })
  try {
    const signed = desktopSignIn(env)
    expect(signed.accountId).toBe("urs-phoneyd.abc@163.com")
    expect(desktopToken(env, signed.accountId, signed.uid)).toBe(TOKEN)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test("junk in the row reads as null", () => {
  const { dir, file } = makeDb({ tokens: null, user: null })
  try {
    const db = new Database(file)
    db.run("INSERT INTO kv VALUES (?,?,?)", ["auth_tokens", "not json", 0])
    db.close()
    expect(readCredentials(file)).toBeNull()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
