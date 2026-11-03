/**
 * Isolated Electron soak test. Start this mock first, then start the development
 * app with OPENCODE_PET_VALIDATION_DIR matching --validation-dir and CDP enabled.
 * This script never starts/quits Electron or edits settings. All app interaction
 * goes through the agent-browser CLI and the normal renderer permission button.
 */
import { mkdir, unlink } from "node:fs/promises"
import { isAbsolute, join, relative, resolve, sep } from "node:path"
import type { ServerWebSocket } from "bun"
import {
  decodeClientMessage,
  encodeMessage,
  type DiscoveryRecord,
  type SessionState,
  type ServerMessage,
} from "../packages/protocol/src/index"

const workspace = resolve(import.meta.dir, "..")
const artifacts = join(workspace, "artifacts")
const defaults = {
  "validation-dir": join(artifacts, "validation-0.3.0-soak"),
  report: join(artifacts, "performance-soak-0.3.0.json"),
  "duration-seconds": "600",
  "warmup-seconds": "30",
  "sample-seconds": "25",
  "connect-timeout-seconds": "120",
  rate: "100",
  history: "2000",
  cdp: "9335",
  session: "petsoak",
  "browser-bin": "",
}

function options(): typeof defaults {
  const parsed = { ...defaults }
  for (let index = 2; index < process.argv.length; index++) {
    const flag = process.argv[index]!
    if (flag === "--help" || flag === "-h") {
      console.log(`Usage: bun scripts/performance-soak.ts [options]
  --validation-dir PATH       Isolated app userData, under workspace/artifacts
  --report PATH               JSON report, under workspace/artifacts
  --duration-seconds 600      Sustained load duration, excluding warmup
  --warmup-seconds 30         Initial low-rate (10 updates/sec) settling period
  --sample-seconds 25         CPU/memory/DOM sampling interval
  --connect-timeout-seconds 120
  --rate 100                 Sustained session upserts per second
  --history 2000             Initial historical idle sessions (at least 250)
  --cdp 9335 --session petsoak
  --browser-bin PATH         Optional native agent-browser executable

Start the mock, then launch the development app separately with
OPENCODE_PET_VALIDATION_DIR equal to --validation-dir and
--remote-debugging-port=9335. Ctrl+C stops only this mock and saves a report.`)
      process.exit(0)
    }
    const key = flag.replace(/^--/, "") as keyof typeof defaults
    if (!flag.startsWith("--") || !(key in parsed) || !process.argv[index + 1]) {
      throw new Error(`Unknown option or missing value: ${flag}`)
    }
    parsed[key] = process.argv[++index]!
  }
  return parsed
}

const args = options()
function numberOption(key: keyof typeof defaults, minimum: number, maximum: number): number {
  const value = Number(args[key])
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`--${key} must be between ${minimum} and ${maximum}`)
  }
  return value
}
function artifactPath(value: string): string {
  const path = resolve(workspace, value)
  const child = relative(artifacts, path)
  if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error(`Validation paths must be children of ${artifacts}: ${path}`)
  }
  return path
}
const validationDir = artifactPath(args["validation-dir"])
const reportPath = artifactPath(args.report)
const durationMS = numberOption("duration-seconds", 1, 86_400) * 1_000
const warmupMS = numberOption("warmup-seconds", 0, 3_600) * 1_000
const sampleMS = numberOption("sample-seconds", 1, 300) * 1_000
const connectTimeoutMS = numberOption("connect-timeout-seconds", 1, 600) * 1_000
const rate = numberOption("rate", 1, 10_000)
const historyCount = Math.floor(numberOption("history", 250, 10_000))
const cdp = Math.floor(numberOption("cdp", 1, 65_535))
if (!/^[a-zA-Z0-9_-]{1,60}$/.test(args.session)) throw new Error("Invalid agent-browser session name")

async function browserExecutable(): Promise<string> {
  if (args["browser-bin"]) return resolve(args["browser-bin"])
  if (process.platform === "win32" && process.env.APPDATA) {
    // npm's Windows .cmd/.ps1 wrappers need a shell; invoke its native binary
    // directly so the JavaScript payload never passes through shell quoting.
    const native = join(process.env.APPDATA, "npm", "node_modules", "agent-browser", "bin", "agent-browser-win32-x64.exe")
    if (await Bun.file(native).exists()) return native
  }
  const found = Bun.which("agent-browser")
  if (!found) throw new Error("agent-browser is unavailable; pass --browser-bin")
  return found
}
const browserBin = await browserExecutable()

async function browserEval<T>(javascript: string): Promise<T> {
  const subprocess = Bun.spawn([
    browserBin, "--session", args.session, "--cdp", String(cdp), "--json", "eval", "-b",
    Buffer.from(javascript, "utf8").toString("base64"),
  ], { stdout: "pipe", stderr: "ignore", timeout: 20_000 })
  const reader = subprocess.stdout.getReader()
  let deadline: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  try {
    // On Windows a newly started daemon may inherit the CLI's stdout handle.
    // Read its first complete JSON response, not EOF or the daemon's lifetime.
    const firstJSON = (async () => {
      const decoder = new TextDecoder()
      let output = ""
      while (true) {
        const { done, value } = await reader.read()
        output += done ? decoder.decode() : decoder.decode(value, { stream: true })
        if (output.length > 1_048_576) throw new Error("agent-browser returned an unexpectedly large response")
        if (output.trim()) {
          try { return JSON.parse(output.trim()) as { success?: boolean; error?: unknown; data?: { result?: unknown }; result?: unknown } } catch { /* The response may span multiple chunks. */ }
        }
        if (done) throw new Error(`agent-browser closed stdout before a complete JSON response: ${output.trim().slice(0, 500)}`)
      }
    })()
    const decoded = await Promise.race([
      firstJSON,
      new Promise<never>((_resolve, reject) => {
        deadline = setTimeout(() => {
          timedOut = true
          reject(new Error("agent-browser JSON response timed out after 20 seconds"))
        }, 20_000)
      }),
    ])
    if (decoded.success === false) throw new Error(`agent-browser: ${String(decoded.error)}`)
    const result = decoded.data?.result ?? decoded.result ?? decoded
    return (typeof result === "string" ? JSON.parse(result) : result) as T
  } finally {
    if (deadline) clearTimeout(deadline)
    // Do not await cancellation/EOF: the inherited daemon handle may remain open.
    void reader.cancel().catch(() => {})
    if (timedOut) {
      try { subprocess.kill() } catch { /* The short-lived CLI may already have exited. */ }
    }
  }
}

interface ProcessMetric { pid: number; type: string; cpuPercent: number; workingSetMB: number; privateMB: number }
interface Sample {
  elapsedSeconds: number
  phase: "warmup" | "load"
  diagnostics: { uptimeSeconds: number; sessionCount: number; connectionCount: number; processes: ProcessMetric[] }
  dom: {
    elements: number; cards: number; panelOpen: boolean; snapshots: number
    snapshotSessions: number; missingProtected: string[]; stableNodes: boolean
    eventLoopDelayMS: number; rendererHeapMB: number | null
  }
  sentUpserts: number
}
type MockSocket = ServerWebSocket<{ authenticated: boolean }>
const startedAt = Date.now()
const token = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "")
const directory = join(validationDir, "projects", "soak-project")
const sessions = new Map<string, SessionState>()
const activeIDs: string[] = []
const protectedIDs = ["history-0"]
function session(id: string, status: SessionState["status"], updatedAt: number): SessionState {
  const project = Number(id.match(/\d+$/)?.[0] ?? 0) % 2
  return { id, title: `Soak ${id}`, directory: join(validationDir, "projects", `soak-project-${project}`), status, todos: { total: 3, completed: status === "idle" ? 3 : 1 }, updatedAt }
}
for (let index = 0; index < historyCount; index++) {
  const old = session(`history-${index}`, "idle", startedAt - 86_400_000 - index * 100)
  sessions.set(old.id, old)
}
for (let index = 0; index < 6; index++) {
  const active = session(`busy-${index}`, "busy", startedAt)
  if (index === 0) active.parentID = "history-0"
  active.activity = { tool: "soak_mock", detail: "Local validation only", since: startedAt }
  sessions.set(active.id, active)
  activeIDs.push(active.id)
}
const retry = { ...session("retry-0", "retry", startedAt), retry: { attempt: 1, message: "Local retry validation" } }
const idleActivity = { ...session("activity-0", "idle", startedAt), activity: { tool: "soak_mock", since: startedAt } }
for (const active of [retry, idleActivity]) { sessions.set(active.id, active); activeIDs.push(active.id) }
for (let index = 0; index < 2; index++) {
  const permission = {
    ...session(`permission-${index}`, "idle", startedAt),
    permission: { id: `soak-permission-${index}`, title: "本地压力验证授权", patterns: ["本地 mock 操作，不执行文件或网络命令"], createdAt: startedAt },
  }
  sessions.set(permission.id, permission)
  protectedIDs.push(permission.id)
}
protectedIDs.push(...activeIDs)
const maxExpectedSessions = 200 + protectedIDs.length
const sockets = new Set<MockSocket>()
const samples: Sample[] = []
const errors: string[] = []
const permissionReplies: Array<{ sessionID: string; permissionID: string; response: string; valid: boolean; receivedAt: number }> = []
let authenticatedConnections = 0
let invalidAuth = 0
let sentUpserts = 0
let attemptedUpserts = 0
let phaseStartedAt = 0
let stopped = false
let interrupted = false
let tickTimer: ReturnType<typeof setInterval> | undefined
let permissionClicked = false
let browserReady = false
let discoveryPath = ""

function send(socket: MockSocket, message: ServerMessage): void { socket.send(encodeMessage(message)) }
const server = Bun.serve<{ authenticated: boolean }>({
  hostname: "127.0.0.1", port: 0,
  fetch(request, local) {
    if (local.upgrade(request, { data: { authenticated: false } })) return
    return new Response("Local pet soak mock", { status: 404 })
  },
  websocket: {
    open(socket) { sockets.add(socket) },
    message(socket, raw) {
      const message = decodeClientMessage(raw)
      if (!message) { socket.close(1008, "Invalid protocol frame"); return }
      if (!socket.data.authenticated) {
        if (message.type !== "auth" || message.token !== token) { invalidAuth++; socket.close(1008, "Authentication failed"); return }
        socket.data.authenticated = true
        authenticatedConnections++
        send(socket, { type: "snapshot", sessions: [...sessions.values()] })
        return
      }
      if (message.type === "ping") { send(socket, { type: "pong", ...(message.nonce ? { nonce: message.nonce } : {}) }); return }
      if (message.type !== "permission.reply") return
      const current = sessions.get(message.sessionID)
      const valid = current?.permission?.id === message.permissionID && message.sessionID === "permission-0" && message.response === "once"
      permissionReplies.push({ ...message, valid, receivedAt: Date.now() })
      send(socket, { type: "permission.replied", sessionID: message.sessionID, permissionID: message.permissionID, response: message.response, ok: valid,
        ...(valid ? {} : { error: "Unexpected local validation reply" }) })
      if (valid && current) {
        const { permission: _permission, ...completed } = current
        const next = { ...completed, updatedAt: Date.now() }
        sessions.set(next.id, next)
        const index = protectedIDs.indexOf(next.id)
        if (index >= 0) protectedIDs.splice(index, 1)
        send(socket, { type: "session.upsert", session: next })
      }
    },
    close(socket) { sockets.delete(socket) },
  },
})

function tick(): void {
  if (!phaseStartedAt || stopped) return
  const elapsed = Date.now() - phaseStartedAt
  const due = Math.floor(Math.min(elapsed, warmupMS) * 10 / 1_000 + Math.max(0, elapsed - warmupMS) * rate / 1_000)
  // A bounded burst prevents a paused mock from flooding the app on resumption.
  const count = Math.min(due - attemptedUpserts, Math.ceil(rate * 2))
  for (let index = 0; index < count; index++) {
    const sequence = ++attemptedUpserts
    const id = sequence % 10 === 0
      ? `history-${1 + (Math.floor(sequence / 10) % (historyCount - 1))}`
      : activeIDs[sequence % activeIDs.length]!
    const previous = sessions.get(id)!
    const updated = { ...previous, title: `Soak ${id} · ${sequence}`, updatedAt: Date.now(),
      todos: { ...previous.todos, ...(previous.status === "busy" ? { current: `Load update ${sequence}` } : {}) } }
    sessions.set(id, updated)
    let delivered = false
    for (const socket of sockets) {
      if (!socket.data.authenticated) continue
      send(socket, { type: "session.upsert", session: updated })
      delivered = true
    }
    if (delivered) sentUpserts++
  }
}

async function installProbe(): Promise<void> {
  const result = await browserEval<{ installed: boolean }>(`(() => {
    if (!window.opencodePet?.getDiagnostics) throw new Error('Diagnostics API is unavailable');
    window.__petPerformanceSoak?.stop();
    const selectors = ['.bubble', '.panel', '.toast', '.pet-button', '.fx-layer'];
    const nodes = selectors.map(selector => document.querySelector(selector));
    const probe = { snapshots: 0, sessions: [], selectors, nodes, stop: () => {} };
    probe.stop = window.opencodePet.onSnapshot(snapshot => { probe.snapshots++; probe.sessions = snapshot.sessions; });
    window.__petPerformanceSoak = probe;
    return JSON.stringify({ installed: true });
  })()`)
  browserReady = result.installed
}

async function takeSample(): Promise<void> {
  const data = await browserEval<Omit<Sample, "elapsedSeconds" | "phase" | "sentUpserts">>(`(async () => {
    const probe = window.__petPerformanceSoak;
    if (!probe) throw new Error('Soak probe was lost');
    const before = performance.now();
    await new Promise(resolve => setTimeout(resolve, 0));
    const eventLoopDelayMS = performance.now() - before;
    const diagnostics = await window.opencodePet.getDiagnostics();
    const ids = new Set(probe.sessions.map(session => session.id));
    return JSON.stringify({ diagnostics, dom: {
      elements: document.querySelectorAll('*').length,
      cards: document.querySelectorAll('.session-card').length,
      panelOpen: document.querySelector('.pet-button')?.getAttribute('aria-expanded') === 'true',
      snapshots: probe.snapshots, snapshotSessions: probe.sessions.length,
      missingProtected: ${JSON.stringify(protectedIDs)}.filter(id => !ids.has(id)),
      stableNodes: probe.selectors.every((selector, index) => probe.nodes[index] && probe.nodes[index].isConnected && probe.nodes[index] === document.querySelector(selector)),
      eventLoopDelayMS, rendererHeapMB: performance.memory ? performance.memory.usedJSHeapSize / 1048576 : null
    }});
  })()`)
  const elapsedSeconds = (Date.now() - phaseStartedAt) / 1_000
  const sample: Sample = { ...data, elapsedSeconds, phase: elapsedSeconds < warmupMS / 1_000 ? "warmup" : "load", sentUpserts }
  samples.push(sample)
  const processes = sample.diagnostics.processes
  const total = (field: "cpuPercent" | "workingSetMB" | "privateMB") => processes.reduce((sum, entry) => sum + entry[field], 0).toFixed(1)
  console.log(`[${sample.phase} ${elapsedSeconds.toFixed(0)}s] CPU=${total("cpuPercent")}% WS=${total("workingSetMB")}MB private=${total("privateMB")}MB sessions=${sample.diagnostics.sessionCount} DOM=${sample.dom.elements} cards=${sample.dom.cards} snapshots=${sample.dom.snapshots} upserts=${sentUpserts}`)
}

async function clickPermission(): Promise<void> {
  const result = await browserEval<{ clicked: boolean }>(`(async () => {
    const toggle = document.querySelector('.pet-button');
    if (toggle?.getAttribute('aria-expanded') !== 'true') toggle?.click();
    const start = performance.now();
    while (performance.now() - start < 4000) {
      const button = document.querySelector('[data-permission="soak-permission-0"][data-response="once"]');
      if (button && !button.disabled) { button.click(); return JSON.stringify({ clicked: true }); }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    return JSON.stringify({ clicked: false });
  })()`)
  permissionClicked = result.clicked
}

async function setPanelOpen(open: boolean): Promise<void> {
  await browserEval(`(() => {
    const toggle = document.querySelector('.pet-button');
    if (toggle && (toggle.getAttribute('aria-expanded') === 'true') !== ${open}) toggle.click();
    return JSON.stringify({ ok: true });
  })()`)
}

function memorySummary() {
  const load = samples.filter(sample => sample.phase === "load")
  const total = (sample: Sample, field: "workingSetMB" | "privateMB") => sample.diagnostics.processes.reduce((sum, process) => sum + process[field], 0)
  if (!load.length) return null
  return {
    firstWorkingSetMB: total(load[0]!, "workingSetMB"), lastWorkingSetMB: total(load.at(-1)!, "workingSetMB"),
    peakWorkingSetMB: Math.max(...load.map(sample => total(sample, "workingSetMB"))),
    firstPrivateMB: total(load[0]!, "privateMB"), lastPrivateMB: total(load.at(-1)!, "privateMB"),
    peakPrivateMB: Math.max(...load.map(sample => total(sample, "privateMB"))),
    interpretation: "Finite synthetic workload observation only; memory growth or a flat interval alone does not prove or disprove a long-term leak.",
  }
}

async function cleanup(): Promise<void> {
  stopped = true
  if (tickTimer) clearInterval(tickTimer)
  tickTimer = undefined
  if (browserReady) await browserEval(`(() => { window.__petPerformanceSoak?.stop(); delete window.__petPerformanceSoak; return JSON.stringify({ stopped: true }); })()`).catch(() => {})
  for (const socket of sockets) socket.close(1000, "Soak complete")
  server.stop(true)
  // Only our exact, unique discovery file is removed. Keep all settings/reports.
  if (discoveryPath) await unlink(discoveryPath).catch(error => { if (error.code !== "ENOENT") errors.push(`Discovery cleanup: ${String(error)}`) })
}
process.on("SIGINT", () => { interrupted = true; stopped = true })
process.on("SIGTERM", () => { interrupted = true; stopped = true })

try {
  const discoveryDir = join(validationDir, "instances")
  await mkdir(discoveryDir, { recursive: true })
  discoveryPath = join(discoveryDir, `soak-${process.pid}-${startedAt}.json`)
  const discovery: DiscoveryRecord = { pid: process.pid, port: server.port!, token, serverUrl: `http://127.0.0.1:${server.port}`, directory, worktree: directory, startedAt }
  await Bun.write(discoveryPath, JSON.stringify(discovery))
  console.log(`Soak mock ready: userData=${validationDir}; CDP=${cdp}; PID=${process.pid}`)
  console.log(`Waiting for separately launched app; ${historyCount} idle + 10 active; warmup=${warmupMS / 1_000}s; load=${durationMS / 1_000}s @ ${rate}/s. No user app will be started or closed.`)
  const waitStartedAt = Date.now()
  let lastConnectionError = ""
  while (!stopped && Date.now() - waitStartedAt < connectTimeoutMS) {
    if (authenticatedConnections > 0) {
      try { await installProbe(); break } catch (error) { lastConnectionError = String(error) }
    }
    await Bun.sleep(1_000)
  }
  if (!stopped && !browserReady) throw new Error(`App did not authenticate and expose diagnostics within the timeout. ${lastConnectionError}`)
  if (!stopped) {
    phaseStartedAt = Date.now()
    tickTimer = setInterval(tick, 100)
    await takeSample()
    let nextSample = sampleMS
    let permissionAttempted = false
    while (!stopped && Date.now() - phaseStartedAt < warmupMS + durationMS) {
      const elapsed = Date.now() - phaseStartedAt
      if (elapsed >= warmupMS && !permissionAttempted) {
        permissionAttempted = true
        await clickPermission()
        if (!permissionClicked) errors.push("Permission button was not found/clicked in the rendered task list")
      }
      if (elapsed >= nextSample) {
        try {
          await takeSample()
          // Alternate panel modes to observe collapsed and expanded rendering.
          await setPanelOpen(samples.length % 2 === 0)
        } catch (error) { errors.push(`Sampling: ${String(error)}`); console.warn(errors.at(-1)) }
        nextSample += sampleMS
      }
      await Bun.sleep(200)
    }
    if (!interrupted) await takeSample()
  }
} catch (error) {
  errors.push(String(error))
  console.error(String(error))
} finally {
  await cleanup()
  const load = samples.filter(sample => sample.phase === "load")
  // Only the first pre-update warmup sample may lack a renderer snapshot.
  // A missing/empty snapshot at any later sample must fail the checks.
  const observed = samples.filter((sample, index) => !(index === 0 && sample.phase === "warmup" && sample.dom.snapshotSessions === 0))
  const checks = {
    authenticated: authenticatedConnections > 0 && invalidAuth === 0,
    sustainedSamples: load.length >= Math.min(3, Math.max(1, Math.floor(durationMS / sampleMS))),
    boundedHistory: observed.length > 0 && observed.every(sample => sample.diagnostics.sessionCount > 0 && sample.diagnostics.sessionCount <= maxExpectedSessions && sample.dom.snapshotSessions > 0 && sample.dom.snapshotSessions <= maxExpectedSessions),
    protectedSessionsRetained: observed.length > 0 && observed.every(sample => sample.dom.snapshotSessions > 0 && sample.dom.missingProtected.length === 0),
    permissionReplyRoundTrip: permissionClicked && permissionReplies.some(reply => reply.valid),
    persistentNodesStable: samples.length > 0 && samples.every(sample => sample.dom.stableNodes),
    noSamplingErrors: errors.length === 0,
  }
  const passed = !interrupted && Object.values(checks).every(Boolean)
  const report = {
    startedAt: new Date(startedAt).toISOString(), finishedAt: new Date().toISOString(),
    outcome: interrupted ? "interrupted" : passed ? "passed" : "failed", checks,
    config: { validationDir, cdp, durationSeconds: durationMS / 1_000, warmupSeconds: warmupMS / 1_000, sampleSeconds: sampleMS / 1_000, targetUpsertsPerSecond: rate, initialHistory: historyCount, maxExpectedSessions },
    workload: { authenticatedConnections, invalidAuth, sentUpserts, attemptedUpserts, elapsedSeconds: phaseStartedAt ? (Date.now() - phaseStartedAt) / 1_000 : 0 },
    permissionReplies, memory: memorySummary(), samples, errors,
    limitations: ["Synthetic local loopback traffic; not a multi-hour real-world usage test.", "Process CPU/memory come from Electron diagnostics; agent-browser sampling itself adds intermittent overhead.", "The mock confirms normal UI → IPC → authenticated WS → acknowledgement flow; it performs no real protected operation."],
  }
  await mkdir(resolve(reportPath, ".."), { recursive: true })
  await Bun.write(reportPath, JSON.stringify(report, null, 2))
  console.log(`Soak ${report.outcome}; report=${reportPath}; checks=${JSON.stringify(checks)}`)
  process.exitCode = interrupted ? 130 : passed ? 0 : 1
}
