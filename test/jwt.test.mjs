import { test, expect } from "bun:test"
import { jwtPayload, jwtExp, accountOf } from "../lib/jwt.mjs"

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url")
const token = (payload) => `x.${b64(payload)}.y`

test("reads the payload", () => {
  expect(jwtPayload(token({ sub: 67097 }))).toEqual({ sub: 67097 })
})

test("jwtExp returns milliseconds", () => {
  expect(jwtExp(token({ exp: 1793152423 }))).toBe(1793152423000)
})

test("accountOf reads yid and sub", () => {
  expect(accountOf(token({ sub: 67097, yid: "urs-phoneyd.abc@163.com" })))
    .toEqual({ yid: "urs-phoneyd.abc@163.com", id: 67097 })
})

test("malformed input is not fatal", () => {
  expect(jwtPayload("nope")).toBeNull()
  expect(jwtPayload("")).toBeNull()
  expect(jwtExp("nope")).toBe(0)
  expect(accountOf("nope")).toEqual({})
})
