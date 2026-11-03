import { readFile, stat } from "node:fs/promises"
import { basename, dirname, extname, resolve, sep } from "node:path"
import type { SkinPackage } from "../shared/ipc"

const MAX_MANIFEST_BYTES = 1024 * 1024
const MAX_SPRITESHEET_BYTES = 25 * 1024 * 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function imageReference(value: unknown): string | undefined {
  if (typeof value === "string") return value
  if (!isRecord(value)) return undefined
  for (const key of ["path", "src", "image", "file"]) {
    if (typeof value[key] === "string") return value[key]
  }
  return undefined
}

function findSpritesheetReference(manifest: Record<string, unknown>): string | undefined {
  for (const key of ["spritesheet", "spriteSheet", "sprite_sheet", "sheet", "image", "texture"]) {
    const candidate = imageReference(manifest[key])
    if (candidate) return candidate
  }

  for (const containerKey of ["assets", "pet", "sprite", "animation"]) {
    const container = manifest[containerKey]
    if (!isRecord(container)) continue
    for (const [key, value] of Object.entries(container)) {
      if (!/(sprite.?sheet|sheet|image|texture)/i.test(key)) continue
      const candidate = imageReference(value)
      if (candidate) return candidate
    }
  }

  return undefined
}

function mimeType(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg"
    case ".webp":
      return "image/webp"
    case ".gif":
      return "image/gif"
    case ".svg":
      return "image/svg+xml"
    case ".png":
    default:
      return "image/png"
  }
}

function isWithinDirectory(filePath: string, directory: string): boolean {
  const normalizedDirectory = `${resolve(directory)}${sep}`.toLocaleLowerCase()
  return resolve(filePath).toLocaleLowerCase().startsWith(normalizedDirectory)
}

export async function loadSkin(manifestPath: string): Promise<SkinPackage> {
  const manifestStats = await stat(manifestPath)
  if (!manifestStats.isFile() || manifestStats.size > MAX_MANIFEST_BYTES) {
    throw new Error("pet.json is missing or too large")
  }

  const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as unknown
  if (!isRecord(parsed)) throw new Error("pet.json must contain a JSON object")

  const reference = findSpritesheetReference(parsed)
  if (!reference) throw new Error("pet.json does not declare a spritesheet")

  let spritesheetDataUrl: string
  if (reference.startsWith("data:image/")) {
    spritesheetDataUrl = reference
  } else {
    if (/^[a-z]+:\/\//i.test(reference)) {
      throw new Error("Remote spritesheets are not supported")
    }
    const packageDirectory = dirname(resolve(manifestPath))
    const spritesheetPath = resolve(packageDirectory, reference)
    if (!isWithinDirectory(spritesheetPath, packageDirectory)) {
      throw new Error("Spritesheet must stay inside the selected skin folder")
    }
    const imageStats = await stat(spritesheetPath)
    if (!imageStats.isFile() || imageStats.size > MAX_SPRITESHEET_BYTES) {
      throw new Error("Spritesheet is missing or too large")
    }
    const image = await readFile(spritesheetPath)
    spritesheetDataUrl = `data:${mimeType(spritesheetPath)};base64,${image.toString("base64")}`
  }

  const name = typeof parsed.name === "string" && parsed.name.trim().length > 0
    ? parsed.name.trim()
    : basename(dirname(resolve(manifestPath)))

  return {
    name,
    manifestPath: resolve(manifestPath),
    manifest: parsed,
    spritesheetDataUrl,
  }
}
