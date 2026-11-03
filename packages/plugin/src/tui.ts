import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { isDiscoveryRecord, type DiscoveryRecord } from "@opencode-pet/protocol"
import { DISCOVERY_DIRECTORY } from "./discovery"
import { launchConfiguredPetApp } from "./launcher"

interface ToastInput {
  variant?: "info" | "success" | "warning" | "error"
  title?: string
  message: string
  duration?: number
}

interface KeymapCommand {
  namespace: "palette"
  name: string
  title: string
  desc: string
  category: string
  slashName: string
  run(input?: unknown): void | Promise<void>
}

interface LegacyCommand {
  title: string
  value: string
  description: string
  category: string
  slash: { name: string }
  onSelect(): void | Promise<void>
}

interface TuiApi {
  keymap?: {
    registerLayer?(layer: { commands: KeymapCommand[]; bindings: unknown[] }): unknown
  }
  command?: {
    register?(commands: () => LegacyCommand[]): unknown
  }
  ui: {
    toast(input: ToastInput): void
  }
  lifecycle?: {
    onDispose(callback: () => void | Promise<void>): unknown
  }
}

interface TuiPluginModule {
  id: string
  tui(api: TuiApi, options?: Record<string, unknown>, meta?: unknown): Promise<void>
}

async function discoveryRecords(): Promise<DiscoveryRecord[]> {
  let files: string[]
  try {
    files = await readdir(DISCOVERY_DIRECTORY)
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined
    if (code === "ENOENT") return []
    throw error
  }

  const records: DiscoveryRecord[] = []
  await Promise.all(
    files
      .filter((file) => file.endsWith(".json"))
      .map(async (file) => {
        try {
          const value = JSON.parse(await readFile(join(DISCOVERY_DIRECTORY, file), "utf8")) as unknown
          if (isDiscoveryRecord(value)) records.push(value)
        } catch {
          // A writer may be replacing a record; the next command run will retry.
        }
      }),
  )
  return records.sort((left, right) => right.startedAt - left.startedAt)
}

async function bridgeStatus(): Promise<ToastInput> {
  try {
    const records = await discoveryRecords()
    if (records.length === 0) {
      return {
        variant: "warning",
        title: "OpenCode Pet",
        message: "未发现桌宠桥接实例；请确认 server 插件已经启用。",
      }
    }
    const ports = records.slice(0, 4).map((record) => record.port).join(", ")
    const extra = records.length > 4 ? ` 等 ${records.length} 个` : ""
    return {
      variant: "info",
      title: "OpenCode Pet",
      message: `已发现 ${records.length} 个桥接实例（端口 ${ports}${extra}）。`,
    }
  } catch (error) {
    return {
      variant: "error",
      title: "OpenCode Pet",
      message: `无法读取桥接状态：${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

async function runPetCommand(api: TuiApi): Promise<void> {
  const launch = await launchConfiguredPetApp({ once: false })
  if (launch.status === "started" || launch.status === "already_started") {
    api.ui.toast({
      variant: "success",
      title: "OpenCode Pet",
      message: "已请求显示桌宠。",
    })
    return
  }
  if (launch.status === "error") {
    const status = await bridgeStatus()
    api.ui.toast({
      variant: "error",
      title: "OpenCode Pet",
      message: `${launch.message} ${status.message}`,
    })
    return
  }
  api.ui.toast(await bridgeStatus())
}

function registerDisposer(api: TuiApi, value: unknown): void {
  if (typeof value === "function") api.lifecycle?.onDispose(value as () => void | Promise<void>)
}

const tui = async (api: TuiApi): Promise<void> => {
  const run = () => runPetCommand(api)
  const registerLayer = api.keymap?.registerLayer
  if (typeof registerLayer === "function") {
    const dispose = registerLayer.call(api.keymap, {
      commands: [
        {
          namespace: "palette",
          name: "opencode-pet.show",
          title: "OpenCode Pet: 显示桌宠",
          desc: "显示桌宠；未配置桌面程序时显示桥接状态",
          category: "OpenCode Pet",
          slashName: "pet",
          run,
        },
      ],
      bindings: [],
    })
    registerDisposer(api, dispose)
    return
  }

  const legacyRegister = api.command?.register
  if (typeof legacyRegister === "function") {
    const dispose = legacyRegister.call(api.command, () => [
      {
        title: "OpenCode Pet: 显示桌宠",
        value: "opencode-pet.show",
        description: "显示桌宠；未配置桌面程序时显示桥接状态",
        category: "OpenCode Pet",
        slash: { name: "pet" },
        onSelect: run,
      },
    ])
    registerDisposer(api, dispose)
  }
}

const plugin: TuiPluginModule = {
  id: "opencode-pet",
  tui,
}

export default plugin
