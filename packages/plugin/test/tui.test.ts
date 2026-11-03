import { describe, expect, test } from "bun:test"
import tuiPlugin from "../src/tui"

describe("OpenCode Pet TUI module", () => {
  test("registers /pet through the current keymap API", async () => {
    let layer: unknown
    let disposed: unknown
    const dispose = () => undefined
    await tuiPlugin.tui({
      keymap: {
        registerLayer(value) {
          layer = value
          return dispose
        },
      },
      ui: { toast() {} },
      lifecycle: {
        onDispose(value) {
          disposed = value
        },
      },
    })

    const command = (layer as { commands: Array<Record<string, unknown>> }).commands[0]
    expect(command?.name).toBe("opencode-pet.show")
    expect(command?.slashName).toBe("pet")
    expect(disposed).toBe(dispose)
  })

  test("falls back to the documented legacy command adapter", async () => {
    let commands: unknown
    await tuiPlugin.tui({
      command: {
        register(factory) {
          commands = factory()
          return undefined
        },
      },
      ui: { toast() {} },
    })

    const command = (commands as Array<{ slash?: { name?: string } }>)[0]
    expect(command?.slash?.name).toBe("pet")
  })
})
