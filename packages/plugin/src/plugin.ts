import openCodePet from "./index"
import { launchConfiguredPetApp, type PetAppLaunchResult } from "./launcher"

interface OpenCodePetHooks {
  event?(input: unknown): Promise<void>
  dispose?(): Promise<void>
}

type UnknownRecord = Record<string, unknown>

function record(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as UnknownRecord)
    : undefined
}

async function logLaunchError(input: unknown, result: PetAppLaunchResult): Promise<void> {
  if (result.status !== "error") return
  const client = record(record(input)?.client)
  const app = record(client?.app)
  const log = app?.log
  if (typeof log === "function") {
    try {
      await log.call(app, {
        body: {
          service: "opencode-pet",
          level: "warn",
          message: `Could not launch OPENCODE_PET_APP: ${result.message}`,
        },
      })
      return
    } catch {
      // Fall through to stderr only when the structured logger is unavailable.
    }
  }
  console.warn(`[opencode-pet] Could not launch OPENCODE_PET_APP: ${result.message}`)
}

async function server(input: unknown): Promise<OpenCodePetHooks> {
  const hooks = await openCodePet(input)
  const launch = await launchConfiguredPetApp({ once: true })
  await logLaunchError(input, launch)
  return hooks
}

/** Target-specific module shape supported by OpenCode 1.18.29+. */
export default {
  id: "opencode-pet",
  server,
}
