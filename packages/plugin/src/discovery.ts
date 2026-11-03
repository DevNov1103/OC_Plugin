import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { readFileSync, unlinkSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { DiscoveryRecord } from "@opencode-pet/protocol"

export const DISCOVERY_DIRECTORY = join(homedir(), ".opencode-pet", "instances")

export function discoveryPath(pid = process.pid, baseDirectory = DISCOVERY_DIRECTORY): string {
  return join(baseDirectory, `${pid}.json`)
}

export interface DiscoveryLease {
  path: string
  dispose(): Promise<void>
}

/** Writes a private, atomic discovery record and owns its deletion. */
export async function publishDiscovery(
  record: DiscoveryRecord,
  baseDirectory = DISCOVERY_DIRECTORY,
): Promise<DiscoveryLease> {
  const path = discoveryPath(record.pid, baseDirectory)
  const temporary = `${path}.${record.token.slice(0, 12)}.tmp`
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await chmod(dirname(path), 0o700).catch(() => undefined)
  try {
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
    await rename(temporary, path)
    await chmod(path, 0o600).catch(() => undefined)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }

  let disposed = false
  const removeSynchronously = () => {
    try {
      const current = JSON.parse(readFileSync(path, "utf8")) as unknown
      if (
        typeof current === "object" &&
        current !== null &&
        "token" in current &&
        (current as { token?: unknown }).token === record.token
      ) {
        unlinkSync(path)
      }
    } catch {
      // The process is exiting. A missing/replaced record must be left alone.
    }
  }
  process.once("exit", removeSynchronously)

  return {
    path,
    async dispose() {
      if (disposed) return
      disposed = true
      process.off("exit", removeSynchronously)
      try {
        const current = JSON.parse(await readFile(path, "utf8")) as unknown
        if (
          typeof current === "object" &&
          current !== null &&
          "token" in current &&
          (current as { token?: unknown }).token === record.token
        ) {
          await rm(path, { force: true })
        }
      } catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined
        if (code !== "ENOENT" && !(error instanceof SyntaxError)) throw error
      }
    },
  }
}
