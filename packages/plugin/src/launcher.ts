import { spawn as nodeSpawn, type ChildProcess } from "node:child_process"
import { stat as nodeStat } from "node:fs/promises"
import { isAbsolute, normalize } from "node:path"

export const PET_APP_ENV = "OPENCODE_PET_APP"

export type PetAppLaunchResult =
  | { status: "not_configured" }
  | { status: "started"; path: string }
  | { status: "already_started"; path: string }
  | { status: "error"; path?: string; message: string }

interface ChildProcessLike {
  once(event: "spawn", listener: () => void): unknown
  once(event: "error", listener: (error: Error) => void): unknown
  unref(): void
}

export interface PetAppLauncherOptions {
  /** Suppress duplicate launches in this OpenCode process. */
  once?: boolean
  env?: Record<string, string | undefined>
  statImpl?: (path: string) => Promise<{ isFile(): boolean }>
  spawnImpl?: (path: string) => ChildProcessLike
}

const launchRegistryKey = Symbol.for("opencode-pet.launch-registry.v1")

function launchRegistry(): Map<string, Promise<PetAppLaunchResult>> {
  const target = globalThis as typeof globalThis & {
    [launchRegistryKey]?: Map<string, Promise<PetAppLaunchResult>>
  }
  target[launchRegistryKey] ??= new Map()
  return target[launchRegistryKey]
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function spawnDetached(path: string): ChildProcess {
  return nodeSpawn(path, [], {
    detached: true,
    shell: false,
    stdio: "ignore",
    windowsHide: true,
  })
}

async function start(
  appPath: string,
  options: PetAppLauncherOptions,
): Promise<PetAppLaunchResult> {
  try {
    const info = await (options.statImpl ?? nodeStat)(appPath)
    if (!info.isFile()) {
      return { status: "error", path: appPath, message: `${PET_APP_ENV} must point to an executable file` }
    }

    const child = (options.spawnImpl ?? spawnDetached)(appPath)
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve)
      child.once("error", reject)
    })
    child.unref()
    return { status: "started", path: appPath }
  } catch (error) {
    return { status: "error", path: appPath, message: errorMessage(error) }
  }
}

/**
 * Starts only the executable explicitly named by OPENCODE_PET_APP. No shell is
 * involved. The Electron app owns cross-process single-instance behavior.
 */
export async function launchConfiguredPetApp(
  options: PetAppLauncherOptions = {},
): Promise<PetAppLaunchResult> {
  const configured = options.env?.[PET_APP_ENV] ?? process.env[PET_APP_ENV]
  if (!configured) return { status: "not_configured" }
  if (!isAbsolute(configured)) {
    return {
      status: "error",
      path: configured,
      message: `${PET_APP_ENV} must be an absolute executable path`,
    }
  }

  const appPath = normalize(configured)
  if (!options.once) return start(appPath, options)

  const registry = launchRegistry()
  const existing = registry.get(appPath)
  if (existing) {
    const previous = await existing
    return previous.status === "started" || previous.status === "already_started"
      ? { status: "already_started", path: appPath }
      : previous
  }

  const pending = start(appPath, options)
  registry.set(appPath, pending)
  const result = await pending
  if (result.status === "error") registry.delete(appPath)
  return result
}
