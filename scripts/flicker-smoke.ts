// Run alongside the pet to exercise real WS updates without calling a model.
import { startOpenCodePetPlugin } from "../packages/plugin/src/index"

const directory = `${process.cwd()}/flicker-smoke`
const id = `flicker-${process.pid}`
const runtime = await startOpenCodePetPlugin({ serverUrl: "http://127.0.0.1:9", directory, worktree: directory })
const event = (type: string, properties: Record<string, unknown>) => runtime.hooks.event({ event: { type, properties } })
let stopped = false
async function stop(): Promise<void> {
  if (stopped) return
  stopped = true
  await runtime.hooks.dispose()
  process.exit(0)
}
process.on("SIGINT", () => void stop())
process.on("SIGTERM", () => void stop())
console.log(`Flicker smoke PID ${process.pid}: 100 changing snapshots, then automatic cleanup.`)
await event("session.created", { info: { id, title: "通知刷新验证", directory } })
await event("session.status", { sessionID: id, status: { type: "busy" } })
// Allow the two-second discovery scan to connect first.
await Bun.sleep(3_000)
for (let count = 1; count <= 100 && !stopped; count++) {
  await event("session.updated", { info: { id, title: `通知刷新验证 · ${count}/100`, directory } })
  await event("todo.updated", { sessionID: id, todos: [
    { content: `连续更新 ${count}/100`, status: "in_progress" },
  ] })
  await Bun.sleep(100)
}
await event("session.idle", { sessionID: id })
await Bun.sleep(3_000)
await stop()
