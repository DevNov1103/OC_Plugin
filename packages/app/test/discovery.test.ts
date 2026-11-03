import { describe, expect, test } from "bun:test"
import { bridgeWebSocketUrl, discoveryConnectionFingerprint } from "../src/main/discovery"

describe("instance discovery connection", () => {
  test("connects to the loopback bridge port, not the OpenCode server URL", () => {
    expect(bridgeWebSocketUrl({ port: 43_210 })).toBe("ws://127.0.0.1:43210")
  })

  test("rejects invalid bridge ports", () => {
    expect(() => bridgeWebSocketUrl({ port: 0 })).toThrow(RangeError)
    expect(() => bridgeWebSocketUrl({ port: 65_536 })).toThrow(RangeError)
  })

  test("reconnects when either the bridge port or token changes", () => {
    const original = discoveryConnectionFingerprint({ port: 10_001, token: "a" })
    expect(discoveryConnectionFingerprint({ port: 10_002, token: "a" })).not.toBe(original)
    expect(discoveryConnectionFingerprint({ port: 10_001, token: "b" })).not.toBe(original)
  })
})
