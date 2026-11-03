import type { DiscoveryRecord } from "@opencode-pet/protocol"

export function bridgeWebSocketUrl(record: Pick<DiscoveryRecord, "port">): string {
  if (!Number.isInteger(record.port) || record.port < 1 || record.port > 65_535) {
    throw new RangeError("Discovery record contains an invalid bridge port")
  }
  return `ws://127.0.0.1:${record.port}`
}

export function discoveryConnectionFingerprint(
  record: Pick<DiscoveryRecord, "port" | "token">,
): string {
  return `${record.port}\u0000${record.token}`
}
