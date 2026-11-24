import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, rm, readFile, writeFile, readdir, stat } from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import {
  DEFAULT_CONFIG,
  atomicWrite,
  configPaths,
  createSessionSaver,
  dateStamp,
  loadConfig,
  mergeAfterCompaction,
  pickPath,
  sessionFileName,
  sessionSlug,
  signature,
  slugify,
  timeStamp,
  transliterate,
  within,
  type FsLike,
  type SaverContext,
  type SaverEvent,
  type SessionInfo,
  type SessionMessageInfo,
} from "./session-saver-v2.ts"

// --- helpers ---

function memoryFs(files: Record<string, string> = {}): FsLike {
  const data = new Map(Object.entries(files))
  return {
    async readFile(file) {
      const content = data.get(file)
      if (content === undefined) throw new Error("ENOENT")
      return content
    },
    async writeFile(file, content) {
      data.set(file, content)
    },
    async mkdir() {},
    async rm(target) {
      data.delete(target)
    },
    async readdir(dir) {
      const names = new Set<string>()
      for (const key of data.keys()) {
        if (path.dirname(key) === dir) names.add(path.basename(key))
      }
      return [...names]
    },
    async stat(target) {
      if (!data.has(target)) throw new Error("ENOENT")
      return { isDirectory: () => false, isFile: () => true }
    },
    async rename(from, to) {
      const content = data.get(from)
      if (content === undefined) throw new Error("ENOENT")
      data.delete(from)
      data.set(to, content)
    },
  }
}

const msg = (id: string, extra: Partial<SessionMessageInfo> = {}): SessionMessageInfo => ({
  id,
  type: "assistant",
  time: { created: 1 },
  content: [{ type: "text", text: `text of ${id}` }],
  ...extra,
})

type FakeSession = { info: SessionInfo; messages: SessionMessageInfo[] }

/**
 * Push-driven stand-in for `ctx.event.subscribe`. `consumed` counts events the
 * plugin has fully processed: the generator resumes only when the plugin asks
 * for the next event, which it does after `await enqueue(handleEvent(event))`.
 */
function fakeEventStream() {
  const queue: SaverEvent[] = []
  let notify: (() => void) | undefined
  let stopped = false
  let consumed = 0
  return {
    get consumed() {
      return consumed
    },
    get stopped() {
      return stopped
    },
    push(event: SaverEvent) {
      queue.push(event)
      notify?.()
    },
    subscribe(options?: { signal?: AbortSignal }): AsyncIterable<SaverEvent> {
      const signal = options?.signal
      return {
        async *[Symbol.asyncIterator]() {
          try {
            while (true) {
              while (queue.length) {
                const event = queue.shift()!
                if (signal?.aborted) return
                yield event
                consumed++
              }
              if (signal?.aborted) return
              await new Promise<void>((resolve) => {
                notify = () => {
                  notify = undefined
                  resolve()
                }
              })
              if (signal?.aborted) return
            }
          } finally {
            stopped = true
          }
        },
      }
    },
  }
}

type Harness = {
  env: Env
  sessions: Map<string, FakeSession>
  stream: ReturnType<typeof fakeEventStream>
  send: (event: SaverEvent) => Promise<void>
  cleanup: () => Promise<void>
}

type Env = { worktree: string; home: string; clock: { value: Date } }

async function makeEnv(projectConfig?: string): Promise<Env> {
  const worktree = await mkdtemp(path.join(os.tmpdir(), "ss-wt-"))
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-home-"))
  if (projectConfig !== undefined) {
    await mkdir(path.join(worktree, ".opencode"), { recursive: true })
    await writeFile(path.join(worktree, ".opencode", "session-saver-v2.json"), projectConfig)
  }
  return { worktree, home, clock: { value: new Date(2026, 8, 16, 15, 8) } }
}

async function cleanup(env: Env) {
  await rm(env.worktree, { recursive: true, force: true })
  await rm(env.home, { recursive: true, force: true })
}

async function startPlugin(env: Env, sessions: Map<string, FakeSession>): Promise<Harness> {
  const stream = fakeEventStream()
  const ctx: SaverContext = {
    location: {
      directory: env.worktree,
      project: { id: "proj", directory: env.worktree, canonical: env.worktree },
    },
    session: {
      get: async ({ sessionID }) => {
        const entry = sessions.get(sessionID)
        if (!entry) throw new Error("Session not found")
        return entry.info
      },
      context: async ({ sessionID }) => sessions.get(sessionID)?.messages ?? [],
    },
    event: { subscribe: (options) => stream.subscribe(options) },
  }
  const dispose = await createSessionSaver({ now: () => env.clock.value, homedir: () => env.home })(ctx)

  let sent = 0
  const send = async (event: SaverEvent) => {
    sent++
    stream.push(event)
    const deadline = Date.now() + 5000
    while (stream.consumed < sent && !stream.stopped) {
      if (Date.now() > deadline) throw new Error("plugin did not consume the event stream")
      await new Promise((resolve) => setTimeout(resolve, 1))
    }
  }
  return { env, sessions, stream, send, cleanup: dispose }
}

function info(id: string, extra: Partial<SessionInfo> = {}): SessionInfo {
  return { id, title: id, time: { created: 1, updated: 1 }, location: { directory: undefined }, ...extra }
}

const created = (sessionID: string, parentID?: string): SaverEvent => ({
  type: "session.created",
  data: { sessionID, ...(parentID ? { parentID } : {}) },
})
const viewed = (sessionID: string): SaverEvent => ({ type: "session.viewed", data: { sessionID } })
const idle = (sessionID: string): SaverEvent => ({ type: "session.idle", data: { sessionID } })
const stepEnded = (sessionID: string): SaverEvent => ({ type: "session.step.ended", data: { sessionID } })
const executionSucceeded = (sessionID: string): SaverEvent => ({
  type: "session.execution.succeeded",
  data: { sessionID },
})
const executionInterrupted = (sessionID: string): SaverEvent => ({
  type: "session.execution.interrupted",
  data: { sessionID },
})
const renamed = (sessionID: string, title: string): SaverEvent => ({
  type: "session.renamed",
  data: { sessionID, title },
})
const locationShutdown = (): SaverEvent => ({ type: "location.shutdown", data: {} })
const tuiSelect = (sessionID: string): SaverEvent => ({ type: "tui.session.select", data: { sessionID } })
const deleted = (sessionID: string): SaverEvent => ({ type: "session.deleted", data: { sessionID } })

async function sessionFiles(root: string): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string) => {
    let entries: string[] = []
    try {
      entries = await readdir(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry)
      const s = await stat(full)
      if (s.isDirectory()) await walk(full)
      else if (entry.endsWith(".json") && entry !== ".index.json") out.push(path.relative(root, full))
    }
  }
  await walk(root)
  return out.sort()
}

async function readJsonAbs(file: string): Promise<any> {
  return JSON.parse(await readFile(file, "utf8"))
}

// --- unit tests ---

test("transliterate maps Cyrillic to Latin", () => {
  assert.equal(transliterate("Привет"), "privet")
  assert.equal(transliterate("Ёжик"), "yozhik")
  assert.equal(transliterate("ABC"), "abc")
})

test("slugify collapses non-alphanumerics", () => {
  assert.equal(slugify("Hello,  World!"), "hello_world")
  assert.equal(slugify("---"), "")
})

test("sessionSlug: transliteration, fallback, truncation", () => {
  assert.equal(sessionSlug("Первая сессия", "ses_x", DEFAULT_CONFIG), "pervaya_sessiya")
  assert.equal(sessionSlug("", "ses_abcdef1234567890", DEFAULT_CONFIG), "session_abcdef12")
  assert.equal(sessionSlug("a".repeat(100), "ses_x", DEFAULT_CONFIG), "a".repeat(80))
  assert.equal(sessionSlug("Разработка", "ses_x", { ...DEFAULT_CONFIG, transliterate: false }), "session_x")
  assert.equal(sessionSlug(undefined, "ses_x", DEFAULT_CONFIG), "session_x")
})

test("dateStamp / timeStamp / sessionFileName", () => {
  const date = new Date(2026, 8, 16, 15, 8)
  assert.equal(dateStamp(date), "2026-09-16")
  assert.equal(timeStamp(date), "15-08")
  assert.equal(sessionFileName(date, "Первая сессия", "ses_x", DEFAULT_CONFIG), "15-08_pervaya_sessiya")
})

test("within matches the root itself and descendants only", () => {
  assert.equal(within("/proj", "/proj"), true)
  assert.equal(within("/proj", "/proj/sub"), true)
  assert.equal(within("/proj", "/project"), false)
  assert.equal(within("/proj", "/other"), false)
  assert.equal(within(undefined, "/proj"), false)
  assert.equal(within("/proj", undefined), false)
})

test("signature is stable and sensitive to every component", () => {
  const session = { id: "s", title: "t", time: { updated: 1 } }
  const messages = [msg("m1"), msg("m2")]
  const base = signature(session, messages)
  assert.equal(signature({ id: "s", title: "t", time: { updated: 1 } }, [msg("m1"), msg("m2")]), base)
  assert.notEqual(signature({ id: "s", title: "t2", time: { updated: 1 } }, messages), base)
  assert.notEqual(signature({ id: "s", title: "t", time: { updated: 2 } }, messages), base)
  assert.notEqual(signature({ id: "s", title: "t" }, messages), base)
  assert.notEqual(signature(session, [msg("m1")]), base)
  assert.notEqual(signature(session, [msg("mX"), msg("m2")]), base)
  assert.notEqual(signature(session, [msg("m1", { time: { created: 1, completed: 5 } }), msg("m2")]), base)
})

test("mergeAfterCompaction keeps the history only when the context was compacted", () => {
  const history = [msg("m1"), msg("m2")]
  const compacted = [msg("mc", { type: "compaction" }), msg("m3")]
  assert.deepEqual(
    mergeAfterCompaction(history, compacted).map((m) => m.id),
    ["m1", "m2", "mc", "m3"],
  )
  // no compaction -> the context is used as is
  assert.deepEqual(mergeAfterCompaction(history, [msg("m3")]).map((m) => m.id), ["m3"])
  // nothing saved yet -> the context is used as is
  assert.deepEqual(mergeAfterCompaction(undefined, [msg("m3")]).map((m) => m.id), ["m3"])
  // already merged -> no duplicates
  assert.deepEqual(
    mergeAfterCompaction([...history, ...compacted], compacted).map((m) => m.id),
    ["m1", "m2", "mc", "m3"],
  )
})

test("loadConfig: defaults, precedence (project wins), invalid JSON skipped, clamped", async () => {
  assert.deepEqual(await loadConfig(memoryFs(), []), DEFAULT_CONFIG)

  const fs = memoryFs({
    "/home/u/.config/opencode/session-saver-v2.json": JSON.stringify({ root: "global-root", maxDescLen: 10 }),
    "/proj/.opencode/session-saver-v2.json": JSON.stringify({ root: "proj-root", minMessages: 2 }),
  })
  const cfg = await loadConfig(fs, configPaths("/proj", "/home/u"))
  assert.equal(cfg.root, "proj-root")
  assert.equal(cfg.maxDescLen, 10)
  assert.equal(cfg.minMessages, 2)

  const broken = memoryFs({
    "/home/u/.config/opencode/session-saver-v2.json": "not json",
    "/proj/.opencode/session-saver-v2.json": JSON.stringify({ maxDescLen: 0, minMessages: -3 }),
  })
  const clamped = await loadConfig(broken, configPaths("/proj", "/home/u"))
  assert.equal(clamped.root, DEFAULT_CONFIG.root)
  assert.equal(clamped.maxDescLen, 1)
  assert.equal(clamped.minMessages, 0)

  assert.deepEqual(configPaths("/proj", "/home/u"), [
    "/home/u/.config/opencode/session-saver-v2.json",
    "/proj/.opencode/session-saver-v2.json",
  ])
})

test("pickPath: fresh name, reuse by id, _2/_3 collisions", async () => {
  const root = "/r"
  const fresh = memoryFs()
  assert.equal(await pickPath(fresh, root, "2026-09-16", "15-08_a", "ses_1"), "2026-09-16/15-08_a.json")

  const sameId = memoryFs({ "/r/2026-09-16/15-08_a.json": JSON.stringify({ info: { id: "ses_1" } }) })
  assert.equal(await pickPath(sameId, root, "2026-09-16", "15-08_a", "ses_1"), "2026-09-16/15-08_a.json")

  const oneCollision = memoryFs({ "/r/2026-09-16/15-08_a.json": JSON.stringify({ info: { id: "ses_9" } }) })
  assert.equal(await pickPath(oneCollision, root, "2026-09-16", "15-08_a", "ses_1"), "2026-09-16/15-08_a_2.json")

  const twoCollisions = memoryFs({
    "/r/2026-09-16/15-08_a.json": JSON.stringify({ info: { id: "ses_9" } }),
    "/r/2026-09-16/15-08_a_2.json": JSON.stringify({ info: { id: "ses_8" } }),
  })
  assert.equal(await pickPath(twoCollisions, root, "2026-09-16", "15-08_a", "ses_1"), "2026-09-16/15-08_a_3.json")
})

test("atomicWrite: rename, and rm+rename fallback when rename fails", async () => {
  const ok = memoryFs({ "/r/f.json": "old" })
  await atomicWrite(ok, "/r/f.json", "new")
  assert.equal(await ok.readFile("/r/f.json", "utf8"), "new")
  assert.ok(!(await ok.readdir("/r")).includes("f.json.123.tmp"))

  const base = memoryFs({ "/r/f.json": "old" })
  let failFirst = true
  const flaky2: FsLike = {
    readFile: (file, enc) => base.readFile(file, enc),
    writeFile: (file, content) => base.writeFile(file, content),
    mkdir: (dir, opts) => base.mkdir(dir, opts),
    rm: (target, opts) => base.rm(target, opts),
    readdir: (dir) => base.readdir(dir),
    stat: (target) => base.stat(target),
    rename: async (from, to) => {
      if (failFirst) {
        failFirst = false
        throw new Error("EEXIST")
      }
      return base.rename(from, to)
    },
  }
  await atomicWrite(flaky2, "/r/f.json", "new2")
  assert.equal(await base.readFile("/r/f.json", "utf8"), "new2")
})

// --- integration tests ---

test("saves on switch, on turn end and on cleanup, with path scheme and index", async () => {
  const env = await makeEnv()
  const h = await startPlugin(
    env,
    new Map<string, FakeSession>([
      ["ses_aaa", { info: info("ses_aaa", { title: "Первая сессия" }), messages: [msg("m1")] }],
      ["ses_bbb", { info: info("ses_bbb", { title: "Second" }), messages: [msg("m1")] }],
    ]),
  )
  const root = path.join(env.worktree, ".ai-sessions")
  try {
    await h.send(created("ses_aaa"))
    assert.deepEqual(await sessionFiles(root), [])
    assert.deepEqual(await readJsonAbs(path.join(root, ".index.json")), { version: 2, sessions: {} })

    // an event of the very same session is not a switch and not a turn end
    await h.send(stepEnded("ses_aaa"))
    assert.deepEqual(await sessionFiles(root), [])

    await h.send(created("ses_bbb"))
    assert.deepEqual(await sessionFiles(root), ["2026-09-16/15-08_pervaya_sessiya.json"])
    const savedA = await readJsonAbs(path.join(root, "2026-09-16", "15-08_pervaya_sessiya.json"))
    assert.equal(savedA.info.id, "ses_aaa")
    assert.deepEqual(savedA.messages.map((m: SessionMessageInfo) => m.id), ["m1"])
    assert.deepEqual(Object.keys(savedA).sort(), ["info", "messages"])

    // the turn of the second session ends: it is saved right away
    await h.send(executionSucceeded("ses_bbb"))
    assert.deepEqual(await sessionFiles(root), [
      "2026-09-16/15-08_pervaya_sessiya.json",
      "2026-09-16/15-08_second.json",
    ])

    await h.cleanup()
    assert.deepEqual(await sessionFiles(root), [
      "2026-09-16/15-08_pervaya_sessiya.json",
      "2026-09-16/15-08_second.json",
    ])
    const index = await readJsonAbs(path.join(root, ".index.json"))
    assert.equal(index.version, 2)
    assert.equal(index.sessions.ses_aaa.path, "2026-09-16/15-08_pervaya_sessiya.json")
    assert.equal(index.sessions.ses_bbb.path, "2026-09-16/15-08_second.json")
  } finally {
    await cleanup(env)
  }
})

test("turn end saves the session without any switch or cleanup", async () => {
  const env = await makeEnv()
  const h = await startPlugin(
    env,
    new Map<string, FakeSession>([
      ["ses_aaa", { info: info("ses_aaa", { title: "Alpha" }), messages: [msg("m1"), msg("m2")] }],
    ]),
  )
  const root = path.join(env.worktree, ".ai-sessions")
  try {
    await h.send(created("ses_aaa"))
    assert.deepEqual(await sessionFiles(root), [])

    await h.send(executionSucceeded("ses_aaa"))
    assert.deepEqual(await sessionFiles(root), ["2026-09-16/15-08_alpha.json"])
    const saved = await readJsonAbs(path.join(root, "2026-09-16", "15-08_alpha.json"))
    assert.deepEqual(saved.messages.map((m: SessionMessageInfo) => m.id), ["m1", "m2"])

    // an interrupted turn is saved as well
    h.sessions.get("ses_aaa")!.messages.push(msg("m3"))
    h.sessions.get("ses_aaa")!.info.time!.updated = 2
    await h.send(executionInterrupted("ses_aaa"))
    const after = await readJsonAbs(path.join(root, "2026-09-16", "15-08_alpha.json"))
    assert.deepEqual(after.messages.map((m: SessionMessageInfo) => m.id), ["m1", "m2", "m3"])
  } finally {
    await cleanup(env)
  }
})

test("session.renamed re-saves the session under the new title", async () => {
  const env = await makeEnv()
  const h = await startPlugin(
    env,
    new Map<string, FakeSession>([
      ["ses_aaa", { info: info("ses_aaa", { title: "New session" }), messages: [msg("m1")] }],
    ]),
  )
  const root = path.join(env.worktree, ".ai-sessions")
  try {
    await h.send(created("ses_aaa"))
    await h.send(executionSucceeded("ses_aaa"))
    assert.deepEqual(await sessionFiles(root), ["2026-09-16/15-08_new_session.json"])

    h.sessions.get("ses_aaa")!.info.title = "Готовая сессия"
    h.sessions.get("ses_aaa")!.info.time!.updated = 2
    await h.send(renamed("ses_aaa", "Готовая сессия"))
    assert.deepEqual(await sessionFiles(root), ["2026-09-16/15-08_gotovaya_sessiya.json"])
    const index = await readJsonAbs(path.join(root, ".index.json"))
    assert.equal(index.sessions.ses_aaa.path, "2026-09-16/15-08_gotovaya_sessiya.json")
  } finally {
    await cleanup(env)
  }
})

test("location.shutdown saves the active session", async () => {
  const env = await makeEnv()
  const h = await startPlugin(
    env,
    new Map<string, FakeSession>([
      ["ses_aaa", { info: info("ses_aaa", { title: "Alpha" }), messages: [msg("m1")] }],
    ]),
  )
  const root = path.join(env.worktree, ".ai-sessions")
  try {
    await h.send(created("ses_aaa"))
    await h.send(locationShutdown())
    assert.deepEqual(await sessionFiles(root), ["2026-09-16/15-08_alpha.json"])
  } finally {
    await cleanup(env)
  }
})

test("compaction keeps the history saved before it", async () => {
  const env = await makeEnv()
  const h = await startPlugin(
    env,
    new Map<string, FakeSession>([
      [
        "ses_aaa",
        { info: info("ses_aaa", { title: "Alpha" }), messages: [msg("m1"), msg("m2")] },
      ],
    ]),
  )
  const root = path.join(env.worktree, ".ai-sessions")
  try {
    await h.send(created("ses_aaa"))
    await h.send(executionSucceeded("ses_aaa"))
    assert.deepEqual(await sessionFiles(root), ["2026-09-16/15-08_alpha.json"])

    // the context now starts with the compaction message and holds only the
    // post-compaction window - the already saved history must survive
    h.sessions.get("ses_aaa")!.messages = [
      msg("m_compact", { type: "compaction" }),
      msg("m3"),
    ]
    h.sessions.get("ses_aaa")!.info.time!.updated = 2
    await h.send(executionSucceeded("ses_aaa"))

    const saved = await readJsonAbs(path.join(root, "2026-09-16", "15-08_alpha.json"))
    assert.deepEqual(saved.messages.map((m: SessionMessageInfo) => m.id), ["m1", "m2", "m_compact", "m3"])
  } finally {
    await cleanup(env)
  }
})

test("session.viewed and tui.session.select switch the active session", async () => {
  const env = await makeEnv()
  const h = await startPlugin(
    env,
    new Map<string, FakeSession>([
      ["ses_aaa", { info: info("ses_aaa", { title: "Alpha" }), messages: [msg("m1")] }],
      ["ses_bbb", { info: info("ses_bbb", { title: "Beta" }), messages: [msg("m1")] }],
    ]),
  )
  const root = path.join(env.worktree, ".ai-sessions")
  try {
    await h.send(viewed("ses_aaa"))
    assert.deepEqual(await sessionFiles(root), [])
    await h.send(tuiSelect("ses_bbb"))
    assert.deepEqual(await sessionFiles(root), ["2026-09-16/15-08_alpha.json"])
    await h.send(viewed("ses_aaa"))
    assert.deepEqual(await sessionFiles(root), ["2026-09-16/15-08_alpha.json", "2026-09-16/15-08_beta.json"])
    await h.cleanup()
  } finally {
    await cleanup(env)
  }
})

test("dedup skips unchanged sessions; minute rollover moves path and removes old file", async () => {
  const env = await makeEnv()
  const h = await startPlugin(
    env,
    new Map<string, FakeSession>([
      ["ses_aaa", { info: info("ses_aaa", { title: "Alpha" }), messages: [msg("m1")] }],
      ["ses_bbb", { info: info("ses_bbb", { title: "Beta" }), messages: [msg("m1")] }],
      ["ses_ccc", { info: info("ses_ccc", { title: "Gamma" }), messages: [msg("m1")] }],
    ]),
  )
  const root = path.join(env.worktree, ".ai-sessions")
  try {
    await h.send(created("ses_aaa"))
    await h.send(created("ses_bbb"))
    await h.send(executionSucceeded("ses_bbb"))

    const betaFile = path.join(root, "2026-09-16", "15-08_beta.json")
    const mtimeBefore = (await stat(betaFile)).mtimeMs

    // switches back and forth over unchanged sessions: nothing may be rewritten
    await h.send(viewed("ses_ccc"))
    await h.send(viewed("ses_bbb"))
    assert.equal((await stat(betaFile)).mtimeMs, mtimeBefore)
    assert.deepEqual(await sessionFiles(root), [
      "2026-09-16/15-08_alpha.json",
      "2026-09-16/15-08_beta.json",
      "2026-09-16/15-08_gamma.json",
    ])

    env.clock.value = new Date(2026, 8, 16, 15, 9)
    h.sessions.get("ses_bbb")!.messages.push(msg("m2"))
    h.sessions.get("ses_bbb")!.info.time!.updated = 2
    await h.send(executionSucceeded("ses_bbb"))
    await h.cleanup()

    assert.deepEqual(await sessionFiles(root), [
      "2026-09-16/15-08_alpha.json",
      "2026-09-16/15-08_gamma.json",
      "2026-09-16/15-09_beta.json",
    ])
    const index = await readJsonAbs(path.join(root, ".index.json"))
    assert.equal(index.sessions.ses_bbb.path, "2026-09-16/15-09_beta.json")
  } finally {
    await cleanup(env)
  }
})

test("subagent sessions are never saved and never become active", async () => {
  const env = await makeEnv()
  const h = await startPlugin(
    env,
    new Map<string, FakeSession>([
      ["ses_aaa", { info: info("ses_aaa", { title: "Top" }), messages: [msg("m1")] }],
      [
        "ses_sub",
        { info: info("ses_sub", { title: "Sub child", parentID: "ses_aaa" }), messages: [msg("m1")] },
      ],
    ]),
  )
  const root = path.join(env.worktree, ".ai-sessions")
  try {
    await h.send(created("ses_aaa"))
    // parentID on the event payload
    await h.send(created("ses_sub", "ses_aaa"))
    // no parentID on the event, but the session itself is a child
    await h.send(viewed("ses_sub"))
    await h.send(idle("ses_sub"))
    await h.cleanup()

    assert.deepEqual(await sessionFiles(root), ["2026-09-16/15-08_top.json"])
  } finally {
    await cleanup(env)
  }
})

test("sessions outside the plugin location are ignored", async () => {
  const env = await makeEnv()
  const h = await startPlugin(
    env,
    new Map<string, FakeSession>([
      ["ses_aaa", { info: info("ses_aaa", { title: "Mine" }), messages: [msg("m1")] }],
      [
        "ses_other",
        {
          info: info("ses_other", { title: "Theirs", location: { directory: "/somewhere/else" } }),
          messages: [msg("m1")],
        },
      ],
      [
        "ses_sub",
        { info: info("ses_sub", { title: "Nested", location: { directory: path.join(env.worktree, "sub") } }), messages: [msg("m1")] },
      ],
    ]),
  )
  const root = path.join(env.worktree, ".ai-sessions")
  try {
    await h.send(created("ses_aaa"))
    await h.send(viewed("ses_other"))
    await h.send(viewed("ses_sub"))
    await h.cleanup()
    assert.deepEqual(await sessionFiles(root), [
      "2026-09-16/15-08_mine.json",
      "2026-09-16/15-08_nested.json",
    ])
  } finally {
    await cleanup(env)
  }
})

test("session.deleted removes file and index entry, clears active session", async () => {
  const env = await makeEnv()
  const h = await startPlugin(
    env,
    new Map<string, FakeSession>([
      ["ses_aaa", { info: info("ses_aaa", { title: "Alpha" }), messages: [msg("m1")] }],
      ["ses_bbb", { info: info("ses_bbb", { title: "Beta" }), messages: [msg("m1")] }],
    ]),
  )
  const root = path.join(env.worktree, ".ai-sessions")
  try {
    await h.send(created("ses_aaa"))
    await h.send(created("ses_bbb"))
    await h.send(executionSucceeded("ses_bbb"))
    assert.equal((await sessionFiles(root)).length, 2)

    await h.send(deleted("ses_bbb"))
    assert.deepEqual(await sessionFiles(root), ["2026-09-16/15-08_alpha.json"])
    const index = await readJsonAbs(path.join(root, ".index.json"))
    assert.equal(index.sessions.ses_bbb, undefined)
    assert.equal(index.sessions.ses_aaa.path, "2026-09-16/15-08_alpha.json")
    await h.cleanup()
  } finally {
    await cleanup(env)
  }
})

test("project config wins: custom root and minMessages are honored", async () => {
  const env = await makeEnv(JSON.stringify({ root: "custom-sessions", minMessages: 2 }))
  const h = await startPlugin(
    env,
    new Map<string, FakeSession>([
      ["ses_short", { info: info("ses_short", { title: "Short" }), messages: [msg("m1")] }],
      ["ses_long", { info: info("ses_long", { title: "Long Talk" }), messages: [msg("m1"), msg("m2")] }],
    ]),
  )
  try {
    await h.send(created("ses_short"))
    await h.send(created("ses_long"))
    await h.cleanup()

    await assert.rejects(stat(path.join(env.worktree, ".ai-sessions")))
    assert.deepEqual(await sessionFiles(path.join(env.worktree, "custom-sessions")), [
      "2026-09-16/15-08_long_talk.json",
    ])
  } finally {
    await cleanup(env)
  }
})

test("global config applies when project config is absent", async () => {
  const env = await makeEnv()
  await mkdir(path.join(env.home, ".config", "opencode"), { recursive: true })
  await writeFile(
    path.join(env.home, ".config", "opencode", "session-saver-v2.json"),
    JSON.stringify({ maxDescLen: 5 }),
  )
  const h = await startPlugin(
    env,
    new Map<string, FakeSession>([
      ["ses_aaa", { info: info("ses_aaa", { title: "Very Long Title" }), messages: [msg("m1")] }],
    ]),
  )
  try {
    await h.send(created("ses_aaa"))
    await h.cleanup()
    assert.deepEqual(await sessionFiles(path.join(env.worktree, ".ai-sessions")), ["2026-09-16/15-08_very_.json"])
  } finally {
    await cleanup(env)
  }
})

test("warm rebuild: index derived from existing files, dedup and delete work on rebuilt entries", async () => {
  const env = await makeEnv()
  const oldFile = path.join(env.worktree, ".ai-sessions", "2026-09-16", "15-08_old.json")
  await mkdir(path.dirname(oldFile), { recursive: true })
  const oldData = { info: info("ses_old", { title: "Old" }), messages: [msg("m1")] }
  await writeFile(oldFile, JSON.stringify(oldData, null, 2))

  const h = await startPlugin(
    env,
    new Map<string, FakeSession>([
      ["ses_old", { info: info("ses_old", { title: "Old" }), messages: [msg("m1")] }],
      ["ses_new", { info: info("ses_new", { title: "New" }), messages: [msg("m1")] }],
    ]),
  )
  const root = path.join(env.worktree, ".ai-sessions")
  try {
    await h.send(created("ses_old"))
    const index = await readJsonAbs(path.join(root, ".index.json"))
    assert.equal(index.sessions.ses_old.path, "2026-09-16/15-08_old.json")

    const mtimeBefore = (await stat(oldFile)).mtimeMs
    await h.send(created("ses_new"))
    await h.send(viewed("ses_old"))
    assert.equal((await stat(oldFile)).mtimeMs, mtimeBefore)

    await h.send(deleted("ses_old"))
    assert.deepEqual(await sessionFiles(root), ["2026-09-16/15-08_new.json"])
    const after = await readJsonAbs(path.join(root, ".index.json"))
    assert.equal(after.sessions.ses_old, undefined)
    assert.equal(after.sessions.ses_new.path, "2026-09-16/15-08_new.json")
    await h.cleanup()
  } finally {
    await cleanup(env)
  }
})

test("cleanup aborts the event stream and is safe to call twice", async () => {
  const env = await makeEnv()
  const h = await startPlugin(
    env,
    new Map<string, FakeSession>([
      ["ses_aaa", { info: info("ses_aaa", { title: "Alpha" }), messages: [msg("m1")] }],
    ]),
  )
  const root = path.join(env.worktree, ".ai-sessions")
  try {
    await h.send(created("ses_aaa"))
    await h.cleanup()
    assert.deepEqual(await sessionFiles(root), ["2026-09-16/15-08_alpha.json"])

    h.sessions.get("ses_aaa")!.messages.push(msg("m2"))
    await h.send(idle("ses_aaa"))
    await h.cleanup()
    assert.deepEqual(await sessionFiles(root), ["2026-09-16/15-08_alpha.json"])
  } finally {
    await cleanup(env)
  }
})