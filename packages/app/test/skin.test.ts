import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { loadSkin } from "../src/main/skin"

const sevenMoods = [
  "idle",
  "thinking",
  "working",
  "permission",
  "celebrate",
  "error",
  "retry",
] as const

async function withTemporaryManifest(
  manifest: Record<string, unknown>,
  assertion: (manifestPath: string) => Promise<void>,
): Promise<void> {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "opencode-pet-skin-test-"))
  try {
    const manifestPath = join(temporaryDirectory, "pet.json")
    await Bun.write(manifestPath, JSON.stringify(manifest))
    await assertion(manifestPath)
  } finally {
    // `temporaryDirectory` is the exact directory returned by mkdtemp above.
    await rm(temporaryDirectory, { recursive: true, force: true })
  }
}

describe("pet skin loading", () => {
  test("loads the bundled seven-state sample as an embedded image", async () => {
    const manifestPath = fileURLToPath(new URL("../resources/skins/sample/pet.json", import.meta.url))
    const skin = await loadSkin(manifestPath)
    const animations = skin.manifest.animations as Record<string, Record<string, unknown>>

    expect(skin.name).toBe("紫色小伙伴 · 示例皮肤")
    expect(skin.spritesheetDataUrl).toStartWith("data:image/svg+xml;base64,")
    expect(Object.keys(animations).sort()).toEqual([...sevenMoods].sort())
    for (const mood of sevenMoods) {
      expect(animations[mood]).toMatchObject({
        row: expect.any(Number),
        frames: expect.any(Number),
        fps: expect.any(Number),
      })
    }
  })

  test("validates the optional Boba adapter and loads a locally supplied sprite sheet", async () => {
    const manifestPath = fileURLToPath(new URL("../resources/skins/boba/pet.json", import.meta.url))
    const manifest = await Bun.file(manifestPath).json()
    const animations = manifest.animations as Record<string, Record<string, unknown>>

    expect(manifest.name).toBe("Boba")
    expect(manifest.spritesheet).toBe("spritesheet.webp")
    expect(manifest.frameWidth).toBe(192)
    expect(manifest.frameHeight).toBe(208)
    expect(animations["drag-left"]).toMatchObject({ row: 2, frames: 8, fps: 7.5 })
    expect(animations["drag-right"]).toMatchObject({ row: 1, frames: 8, fps: 7.5 })

    const spritesheetPath = fileURLToPath(new URL("../resources/skins/boba/spritesheet.webp", import.meta.url))
    if (existsSync(spritesheetPath)) {
      const skin = await loadSkin(manifestPath)
      expect(skin.spritesheetDataUrl).toStartWith("data:image/webp;base64,")
    }
  })

  test("rejects a remote spritesheet", async () => {
    await withTemporaryManifest(
      { name: "remote", spritesheet: "https://example.com/pet.png" },
      async (manifestPath) => {
        await expect(loadSkin(manifestPath)).rejects.toThrow("Remote spritesheets are not supported")
      },
    )
  })

  test("rejects a spritesheet that escapes the selected folder", async () => {
    await withTemporaryManifest(
      { name: "escape", spritesheet: "../outside.png" },
      async (manifestPath) => {
        await expect(loadSkin(manifestPath)).rejects.toThrow("Spritesheet must stay inside the selected skin folder")
      },
    )
  })
})
