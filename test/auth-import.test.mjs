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
function makeDesktop({ tokens = TOKEN } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "lobster-desktop-"))
  const env = { APPDATA: dir, HOME: dir, USERPROFILE: dir, XDG_CONFIG_HOME: dir }
  const file = dbPath(env)
  mkdirSync(dirname(file), { recursive: true })
  const db = new Database(file, { create: true })
  db.run("CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)")
  if (tokens !== null) {
    db.run("INSERT INTO kv VALUES (?,?,?)", ["auth_tokens", JSON.stringify({ accessToken: tokens, refreshToken: "r" }), 0])
    db.run("INSERT INTO kv VALUES (?,?,?)", ["auth_user", '{"yid":"urs-phoneyd.abc@163.com","id":67097,"nickname":"Ada"}', 0])
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
    expect(r.uid).toBe(67097)
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

test("junk in the row reads as null", () => {
  const { dir, file } = makeDb({ tokens: null, user: null })
  try {
    const db = new Database(file)
    db.run("INSERT INTO kv VALUES (?,?,?)", ["auth_tokens", "not json", 0])
    db.close()
    expect(readCredentials(file)).toBeNull()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
