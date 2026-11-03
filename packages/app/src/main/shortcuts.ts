import type { ShortcutPreferences } from "../shared/ipc"

interface ShortcutBackend {
  register(accelerator: string, callback: () => void): boolean
  unregister(accelerator: string): void
}

/** Register all-or-nothing so a conflicting custom shortcut cannot disable the previous pair. */
export class ShortcutController {
  private current: ShortcutPreferences = { toggle: "", tasks: "" }
  constructor(private readonly backend: ShortcutBackend, private readonly actions: Record<keyof ShortcutPreferences, () => void>) {}

  configure(next: ShortcutPreferences): void {
    if (next.toggle === this.current.toggle && next.tasks === this.current.tasks) return
    const previous = this.current
    this.unregister(previous)
    try {
      this.register(next)
      this.current = { ...next }
    } catch (error) {
      this.unregister(next)
      try { this.register(previous) } catch { /* A different app may have claimed a released key. */ }
      throw error
    }
  }

  dispose(): void {
    this.unregister(this.current)
    this.current = { toggle: "", tasks: "" }
  }

  private register(preferences: ShortcutPreferences): void {
    for (const key of ["toggle", "tasks"] as const) {
      const accelerator = preferences[key]
      if (!accelerator) continue
      try {
        if (this.backend.register(accelerator, this.actions[key])) continue
      } catch { /* Electron rejects malformed accelerators with an exception. */ }
      throw new Error(`快捷键 ${accelerator} 无效或已被其他程序占用，请换一个组合`)
    }
  }

  private unregister(preferences: ShortcutPreferences): void {
    for (const accelerator of Object.values(preferences)) if (accelerator) this.backend.unregister(accelerator)
  }
}
