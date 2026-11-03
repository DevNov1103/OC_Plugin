import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { resolve } from "node:path"
import { launchConfiguredPetApp, PET_APP_ENV } from "../src/launcher"

class FakeChild extends EventEmitter {
  unrefCount = 0

  unref(): void {
    this.unrefCount += 1
  }
}

describe("launchConfiguredPetApp", () => {
  test("does nothing without the explicit environment variable", async () => {
    expect(await launchConfiguredPetApp({ env: {} })).toEqual({ status: "not_configured" })
  })

  test("rejects relative executable paths without spawning", async () => {
    let spawned = false
    const result = await launchConfiguredPetApp({
      env: { [PET_APP_ENV]: "pet.exe" },
      spawnImpl() {
        spawned = true
        return new FakeChild()
      },
    })
    expect(result.status).toBe("error")
    expect(spawned).toBe(false)
  })

  test("starts only once per OpenCode process when requested", async () => {
    const path = resolve(`fake-pet-${Date.now()}-${Math.random()}.exe`)
    let spawnCount = 0
    const options = {
      once: true,
      env: { [PET_APP_ENV]: path },
      statImpl: async () => ({ isFile: () => true }),
      spawnImpl: () => {
        spawnCount += 1
        const child = new FakeChild()
        queueMicrotask(() => child.emit("spawn"))
        return child
      },
    }

    expect((await launchConfiguredPetApp(options)).status).toBe("started")
    expect((await launchConfiguredPetApp(options)).status).toBe("already_started")
    expect(spawnCount).toBe(1)
  })
})
