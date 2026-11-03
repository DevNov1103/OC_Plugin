import { startOpenCodePetPlugin } from "../packages/plugin/src/index"

const name = process.argv[2] ?? "demo-project"
const directory = `${process.cwd()}/${name}`
const sessionID = `demo-${process.pid}`
let resolvePermission: (() => void) | undefined
let cycle = 0

const api = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const pathname = new URL(request.url).pathname
    if (request.method === "POST" && /^\/permission\/[^/]+\/reply$/.test(pathname)) {
      const input = await request.json() as { reply?: string }
      if (!input.reply || !["once", "always", "reject"].includes(input.reply)) {
        return Response.json({ error: "Invalid reply" }, { status: 400 })
      }
      resolvePermission?.()
      return Response.json(true)
    }
    return new Response("Demo API", { status: 404 })
  },
})

const runtime = await startOpenCodePetPlugin({
  serverUrl: `http://127.0.0.1:${api.port}`,
  directory,
  worktree: directory,
})

const event = (type: string, properties: Record<string, unknown>) => runtime.hooks.event({ event: { type, properties } })
await event("session.created", { info: { id: sessionID, title: `${name} · 联调任务`, directory } })
await event("session.status", { sessionID, status: { type: "busy" } })
await event("todo.updated", {
  sessionID,
  todos: [
    { content: "读取项目", status: "completed" },
    { content: "执行受保护操作", status: "in_progress" },
    { content: "完成验证", status: "pending" },
  ],
})

async function ask(): Promise<void> {
  const permissionID = `demo-permission-${process.pid}-${++cycle}`
  await event("permission.asked", {
    id: permissionID,
    sessionID,
    permission: "demo_operation",
    patterns: ["仅用于本地验证的模拟操作"],
  })
  await new Promise<void>((resolve) => { resolvePermission = resolve })
  await event("permission.replied", { sessionID, requestID: permissionID, reply: "once" })
  await event("todo.updated", {
    sessionID,
    todos: ["读取项目", "执行受保护操作", "完成验证"].map((content) => ({ content, status: "completed" })),
  })
  await event("session.idle", { sessionID })
}

let stopped = false
async function stop(): Promise<void> {
  if (stopped) return
  stopped = true
  await runtime.hooks.dispose()
  void api.stop(true)
  process.exit(0)
}
process.on("SIGINT", () => void stop())
process.on("SIGTERM", () => void stop())
console.log(`Demo ${name} ready; PID ${process.pid}. Approve the card in the pet to finish.`)
await ask()
console.log(`Demo ${name} completed; press Ctrl+C to stop.`)
await new Promise(() => {})
