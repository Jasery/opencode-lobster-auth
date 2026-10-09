import { test, expect } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { dbPath, readCredentials } from "../lib/auth-import.mjs"

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

test("junk in the row reads as null", () => {
  const { dir, file } = makeDb({ tokens: null, user: null })
  try {
    const db = new Database(file)
    db.run("INSERT INTO kv VALUES (?,?,?)", ["auth_tokens", "not json", 0])
    db.close()
    expect(readCredentials(file)).toBeNull()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
