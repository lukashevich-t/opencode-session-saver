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
  pickPath,
  sessionFileName,
  sessionSlug,
  signature,
  slugify,
  timeStamp,
  transliterate,
  type FsLike,
} from "./session-saver.ts"

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

const msg = (id: string) => ({ info: { id }, parts: [{ id: `p-${id}` }] })

type FakeSession = { info: any; messages: any[] }

function fakeClient(sessions: Map<string, FakeSession>) {
  return {
    session: {
      get: async (args: any) => {
        const entry = sessions.get(args.path.id)
        if (!entry) return { error: true }
        return { data: entry.info }
      },
      messages: async (args: any) => ({ data: sessions.get(args.path.id)?.messages ?? [] }),
    },
  }
}

type Env = { worktree: string; home: string; clock: { value: Date } }

async function makeEnv(projectConfig?: string): Promise<Env> {
  const worktree = await mkdtemp(path.join(os.tmpdir(), "ss-wt-"))
  const home = await mkdtemp(path.join(os.tmpdir(), "ss-home-"))
  if (projectConfig !== undefined) {
    await mkdir(path.join(worktree, ".opencode"), { recursive: true })
    await writeFile(path.join(worktree, ".opencode", "session-saver.json"), projectConfig)
  }
  return { worktree, home, clock: { value: new Date(2026, 8, 16, 15, 8) } }
}

async function cleanup(env: Env) {
  await rm(env.worktree, { recursive: true, force: true })
  await rm(env.home, { recursive: true, force: true })
}

async function startPlugin(env: Env, sessions: Map<string, FakeSession>) {
  const plugin = createSessionSaver({ now: () => env.clock.value, homedir: () => env.home })
  const hooks: any = await plugin({
    client: fakeClient(sessions),
    directory: env.worktree,
    worktree: env.worktree,
  } as any)
  return hooks
}

const created = (id: string, parentID?: string) => ({
  event: { type: "session.created", properties: { info: { id, ...(parentID ? { parentID } : {}) } } },
})
const updated = (sessionID: string) => ({ event: { type: "message.updated", properties: { sessionID } } })
const deleted = (id: string) => ({ event: { type: "session.deleted", properties: { info: { id } } } })

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
})

test("dateStamp / timeStamp / sessionFileName", () => {
  const date = new Date(2026, 8, 16, 15, 8)
  assert.equal(dateStamp(date), "2026-09-16")
  assert.equal(timeStamp(date), "15-08")
  assert.equal(sessionFileName(date, "Первая сессия", "ses_x", DEFAULT_CONFIG), "15-08_pervaya_sessiya")
})

test("signature is stable and sensitive to every component", () => {
  const info = { title: "t", time: { updated: "u1" } }
  const messages = [msg("m1"), msg("m2")]
  const base = signature(info, messages)
  assert.equal(signature({ title: "t", time: { updated: "u1" } }, [msg("m1"), msg("m2")]), base)
  assert.notEqual(signature({ title: "t2", time: { updated: "u1" } }, messages), base)
  assert.notEqual(signature({ title: "t", time: { updated: "u2" } }, messages), base)
  assert.notEqual(signature(info, [msg("m1")]), base)
  assert.notEqual(signature(info, [msg("mX"), msg("m2")]), base)
  assert.notEqual(signature(info, [{ info: { id: "m1" }, parts: [{ id: "other" }] }, msg("m2")]), base)
  assert.notEqual(signature(info, [{ info: { id: "m1" } }, msg("m2")]), base)
})

test("loadConfig: defaults, precedence (project wins), invalid JSON skipped, clamped", async () => {
  assert.deepEqual(await loadConfig(memoryFs(), []), DEFAULT_CONFIG)

  const fs = memoryFs({
    "/home/u/.config/opencode/session-saver.json": JSON.stringify({ root: "global-root", maxDescLen: 10 }),
    "/proj/.opencode/session-saver.json": JSON.stringify({ root: "proj-root", minMessages: 2 }),
  })
  const cfg = await loadConfig(fs, configPaths("/proj", "/home/u"))
  assert.equal(cfg.root, "proj-root")
  assert.equal(cfg.maxDescLen, 10)
  assert.equal(cfg.minMessages, 2)

  const broken = memoryFs({
    "/home/u/.config/opencode/session-saver.json": "not json",
    "/proj/.opencode/session-saver.json": JSON.stringify({ maxDescLen: 0, minMessages: -3 }),
  })
  const clamped = await loadConfig(broken, configPaths("/proj", "/home/u"))
  assert.equal(clamped.root, DEFAULT_CONFIG.root)
  assert.equal(clamped.maxDescLen, 1)
  assert.equal(clamped.minMessages, 0)

  assert.deepEqual(configPaths("/proj", "/home/u"), [
    "/home/u/.config/opencode/session-saver.json",
    "/proj/.opencode/session-saver.json",
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

test("saves only on switch and dispose, with path scheme and index", async () => {
  const env = await makeEnv()
  try {
    const sessions = new Map<string, FakeSession>([
      ["ses_aaa", { info: { id: "ses_aaa", title: "Первая сессия" }, messages: [msg("m1")] }],
      ["ses_bbb", { info: { id: "ses_bbb", title: "Second" }, messages: [msg("m1")] }],
    ])
    const hooks = await startPlugin(env, sessions)

    await hooks.event(created("ses_aaa"))
    assert.deepEqual(await sessionFiles(path.join(env.worktree, "ai-sessions")), [])
    const emptyIndex = await readJsonAbs(path.join(env.worktree, "ai-sessions", ".index.json"))
    assert.deepEqual(emptyIndex, { version: 1, sessions: {} })

    await hooks.event(updated("ses_aaa"))
    assert.deepEqual(await sessionFiles(path.join(env.worktree, "ai-sessions")), [])

    await hooks.event(created("ses_bbb"))
    assert.deepEqual(await sessionFiles(path.join(env.worktree, "ai-sessions")), [
      "2026-09-16/15-08_pervaya_sessiya.json",
    ])
    const savedA = await readJsonAbs(path.join(env.worktree, "ai-sessions", "2026-09-16", "15-08_pervaya_sessiya.json"))
    assert.equal(savedA.info.id, "ses_aaa")
    assert.equal(savedA.messages.length, 1)

    await hooks.dispose()
    assert.deepEqual(await sessionFiles(path.join(env.worktree, "ai-sessions")), [
      "2026-09-16/15-08_pervaya_sessiya.json",
      "2026-09-16/15-08_second.json",
    ])
    const index = await readJsonAbs(path.join(env.worktree, "ai-sessions", ".index.json"))
    assert.equal(index.version, 1)
    assert.equal(index.sessions.ses_aaa.path, "2026-09-16/15-08_pervaya_sessiya.json")
    assert.equal(index.sessions.ses_bbb.path, "2026-09-16/15-08_second.json")
  } finally {
    await cleanup(env)
  }
})

test("dedup skips unchanged sessions; minute rollover moves path and removes old file", async () => {
  const env = await makeEnv()
  try {
    const sessions = new Map<string, FakeSession>([
      ["ses_aaa", { info: { id: "ses_aaa", title: "Alpha" }, messages: [msg("m1")] }],
      ["ses_bbb", { info: { id: "ses_bbb", title: "Beta" }, messages: [msg("m1")] }],
      ["ses_ccc", { info: { id: "ses_ccc", title: "Gamma" }, messages: [msg("m1")] }],
    ])
    const hooks = await startPlugin(env, sessions)

    await hooks.event(created("ses_aaa"))
    await hooks.event(created("ses_bbb"))
    await hooks.dispose()

    const betaFile = path.join(env.worktree, "ai-sessions", "2026-09-16", "15-08_beta.json")
    const mtimeBefore = (await stat(betaFile)).mtimeMs

    await hooks.event(created("ses_ccc"))
    await hooks.dispose()
    assert.equal((await stat(betaFile)).mtimeMs, mtimeBefore)

    env.clock.value = new Date(2026, 8, 16, 15, 9)
    sessions.get("ses_bbb")!.messages.push(msg("m2"))
    await hooks.event(updated("ses_bbb"))
    await hooks.dispose()

    assert.deepEqual(await sessionFiles(path.join(env.worktree, "ai-sessions")), [
      "2026-09-16/15-08_alpha.json",
      "2026-09-16/15-08_gamma.json",
      "2026-09-16/15-09_beta.json",
    ])
    const index = await readJsonAbs(path.join(env.worktree, "ai-sessions", ".index.json"))
    assert.equal(index.sessions.ses_bbb.path, "2026-09-16/15-09_beta.json")
  } finally {
    await cleanup(env)
  }
})

test("subagent sessions are never saved and never become active", async () => {
  const env = await makeEnv()
  try {
    const sessions = new Map<string, FakeSession>([
      ["ses_aaa", { info: { id: "ses_aaa", title: "Top" }, messages: [msg("m1")] }],
      ["ses_sub", { info: { id: "ses_sub", title: "Sub child", parentID: "ses_aaa" }, messages: [msg("m1")] }],
    ])
    const hooks = await startPlugin(env, sessions)

    await hooks.event(created("ses_aaa"))
    await hooks.event(created("ses_sub", "ses_aaa"))
    await hooks.event(updated("ses_sub"))
    await hooks.dispose()

    assert.deepEqual(await sessionFiles(path.join(env.worktree, "ai-sessions")), [
      "2026-09-16/15-08_top.json",
    ])
  } finally {
    await cleanup(env)
  }
})

test("session.deleted removes file and index entry, clears active session", async () => {
  const env = await makeEnv()
  try {
    const sessions = new Map<string, FakeSession>([
      ["ses_aaa", { info: { id: "ses_aaa", title: "Alpha" }, messages: [msg("m1")] }],
      ["ses_bbb", { info: { id: "ses_bbb", title: "Beta" }, messages: [msg("m1")] }],
    ])
    const hooks = await startPlugin(env, sessions)

    await hooks.event(created("ses_aaa"))
    await hooks.event(created("ses_bbb"))
    await hooks.dispose()
    assert.equal((await sessionFiles(path.join(env.worktree, "ai-sessions"))).length, 2)

    await hooks.event(deleted("ses_bbb"))
    assert.deepEqual(await sessionFiles(path.join(env.worktree, "ai-sessions")), [
      "2026-09-16/15-08_alpha.json",
    ])
    const index = await readJsonAbs(path.join(env.worktree, "ai-sessions", ".index.json"))
    assert.equal(index.sessions.ses_bbb, undefined)
    assert.equal(index.sessions.ses_aaa.path, "2026-09-16/15-08_alpha.json")
  } finally {
    await cleanup(env)
  }
})

test("project config wins: custom root and minMessages are honored", async () => {
  const env = await makeEnv(JSON.stringify({ root: "custom-sessions", minMessages: 2 }))
  try {
    const sessions = new Map<string, FakeSession>([
      ["ses_short", { info: { id: "ses_short", title: "Short" }, messages: [msg("m1")] }],
      ["ses_long", { info: { id: "ses_long", title: "Long Talk" }, messages: [msg("m1"), msg("m2")] }],
    ])
    const hooks = await startPlugin(env, sessions)

    await hooks.event(created("ses_short"))
    await hooks.event(created("ses_long"))
    await hooks.dispose()

    await assert.rejects(stat(path.join(env.worktree, "ai-sessions")))
    assert.deepEqual(await sessionFiles(path.join(env.worktree, "custom-sessions")), [
      "2026-09-16/15-08_long_talk.json",
    ])
  } finally {
    await cleanup(env)
  }
})

test("global config applies when project config is absent", async () => {
  const env = await makeEnv()
  try {
    await mkdir(path.join(env.home, ".config", "opencode"), { recursive: true })
    await writeFile(
      path.join(env.home, ".config", "opencode", "session-saver.json"),
      JSON.stringify({ maxDescLen: 5 }),
    )
    const sessions = new Map<string, FakeSession>([
      ["ses_aaa", { info: { id: "ses_aaa", title: "Very Long Title" }, messages: [msg("m1")] }],
    ])
    const hooks = await startPlugin(env, sessions)

    await hooks.event(created("ses_aaa"))
    await hooks.dispose()

    assert.deepEqual(await sessionFiles(path.join(env.worktree, "ai-sessions")), [
      "2026-09-16/15-08_very_.json",
    ])
  } finally {
    await cleanup(env)
  }
})

test("warm rebuild: index derived from existing files, dedup and delete work on rebuilt entries", async () => {
  const env = await makeEnv()
  try {
    const oldFile = path.join(env.worktree, "ai-sessions", "2026-09-16", "15-08_old.json")
    await mkdir(path.dirname(oldFile), { recursive: true })
    const oldData = { info: { id: "ses_old", title: "Old" }, messages: [msg("m1")] }
    await writeFile(oldFile, JSON.stringify(oldData, null, 2))

    const sessions = new Map<string, FakeSession>([
      ["ses_old", { info: { id: "ses_old", title: "Old" }, messages: [msg("m1")] }],
      ["ses_new", { info: { id: "ses_new", title: "New" }, messages: [msg("m1")] }],
    ])
    const hooks = await startPlugin(env, sessions)

    await hooks.event(created("ses_old"))
    const index = await readJsonAbs(path.join(env.worktree, "ai-sessions", ".index.json"))
    assert.equal(index.sessions.ses_old.path, "2026-09-16/15-08_old.json")

    const mtimeBefore = (await stat(oldFile)).mtimeMs
    await hooks.event(created("ses_new"))
    await hooks.dispose()
    assert.equal((await stat(oldFile)).mtimeMs, mtimeBefore)

    await hooks.event(deleted("ses_old"))
    assert.deepEqual(await sessionFiles(path.join(env.worktree, "ai-sessions")), [
      "2026-09-16/15-08_new.json",
    ])
  } finally {
    await cleanup(env)
  }
})
