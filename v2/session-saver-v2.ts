import { readFile, writeFile, mkdir, rm, readdir, stat, rename } from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"

const CYRILLIC: Record<string, string> = {
  а: "a",
  б: "b",
  в: "v",
  г: "g",
  д: "d",
  е: "e",
  ё: "yo",
  ж: "zh",
  з: "z",
  и: "i",
  й: "y",
  к: "k",
  л: "l",
  м: "m",
  н: "n",
  о: "o",
  п: "p",
  р: "r",
  с: "s",
  т: "t",
  у: "u",
  ф: "f",
  х: "h",
  ц: "ts",
  ч: "ch",
  ш: "sh",
  щ: "sch",
  ъ: "",
  ы: "y",
  ь: "",
  э: "e",
  ю: "yu",
  я: "ya",
}

export type Config = {
  root: string
  minMessages: number
  maxDescLen: number
  transliterate: boolean
  deleteOnSessionDelete: boolean
}

export type IndexEntry = {
  path: string
  signature: string
}

export type StatLike = { isDirectory(): boolean; isFile(): boolean }

export type FsLike = {
  readFile: (file: string, encoding: "utf8") => Promise<string>
  writeFile: (file: string, content: string) => Promise<void>
  mkdir: (dir: string, options: { recursive: boolean }) => Promise<unknown>
  rm: (target: string, options?: { force?: boolean }) => Promise<void>
  readdir: (dir: string) => Promise<string[]>
  stat: (target: string) => Promise<StatLike>
  rename: (from: string, to: string) => Promise<void>
}

const realFs: FsLike = {
  readFile: (file, encoding) => readFile(file, encoding),
  writeFile: (file, content) => writeFile(file, content),
  mkdir: (dir, options) => mkdir(dir, options),
  rm: (target, options) => rm(target, options),
  readdir: (dir) => readdir(dir),
  stat: (target) => stat(target),
  rename: (from, to) => rename(from, to),
}

export const DEFAULT_CONFIG: Config = {
  root: ".ai-sessions",
  minMessages: 1,
  maxDescLen: 80,
  transliterate: true,
  deleteOnSessionDelete: true,
}

/**
 * Session-scoped events that mean "activity is happening in session X".
 *
 * v1 names (`message.updated`, `message.part.updated`, `todo.updated`,
 * `command.executed`, `permission.updated`, `permission.asked`, `session.diff`)
 * do not exist in the v2 event union. These are their v2 counterparts: low
 * frequency lifecycle events, so the queue is never flooded by deltas.
 *
 * These events only *switch* the watched session: the session that was active
 * until now is saved, the new one becomes active. Events that finish a turn
 * are listed in `SAVE_EVENT_TYPES` instead — they save their own session.
 */
export const SWITCH_EVENT_TYPES: readonly string[] = [
  "session.created",
  "session.viewed",
  "session.metadata.updated",
  "session.status",
  "session.synthetic",
  "session.compaction.started",
  "session.compaction.ended",
  "session.step.ended",
  "session.text.ended",
  "session.reasoning.ended",
  "session.tool.called",
  "tui.session.select",
]

/**
 * Events that finish a turn of a session: its transcript is final and can be
 * written to disk right away.
 *
 * Without them the plugin would only save a session when the user switches to
 * another one — in the GUI that means "never" if the app is closed right after
 * the answer, because the cleanup callback does not always get a chance to run.
 */
export const SAVE_EVENT_TYPES: readonly string[] = [
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
  "session.idle",
  "session.renamed",
]

// --- v2 server API types (structural subset of @opencode/plugin@2.1.4) ---

export type SessionInfo = {
  id: string
  parentID?: string
  title?: string
  time?: { created?: number; updated?: number; idle?: number; viewed?: number; archived?: number }
  location?: { directory?: string }
  [key: string]: unknown
}

export type SessionMessageInfo = {
  id: string
  type?: string
  time?: { created?: number; completed?: number }
  [key: string]: unknown
}

export type SaverEvent = {
  type: string
  data?: { sessionID?: string; [key: string]: unknown }
  [key: string]: unknown
}

export type SaverLocation = {
  directory: string
  workspaceID?: string
  project?: { id?: string; directory?: string; canonical?: string }
}

export type SaverContext = {
  location: SaverLocation
  session: {
    get: (input: { sessionID: string }) => Promise<SessionInfo>
    context: (input: { sessionID: string }) => Promise<SessionMessageInfo[]>
  }
  event: {
    subscribe: (options?: { signal?: AbortSignal }) => AsyncIterable<SaverEvent>
  }
}

// --- pure helpers (unit-testable) ---

export function transliterate(input: string): string {
  return [...input.toLowerCase()].map((char) => CYRILLIC[char] ?? char).join("")
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
}

export function sessionSlug(
  title: string | undefined,
  id: string,
  config: Pick<Config, "transliterate" | "maxDescLen">,
): string {
  const source = title || ""
  let slug = slugify(config.transliterate ? transliterate(source) : source)
  if (!slug) slug = `session_${String(id).replace(/^ses_/, "").slice(0, 8)}`
  if (slug.length > config.maxDescLen) slug = slug.slice(0, config.maxDescLen)
  return slug
}

export function pad(value: number): string {
  return String(value).padStart(2, "0")
}

export function dateStamp(date: Date): string {
  return [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join("-")
}

export function timeStamp(date: Date): string {
  return [pad(date.getHours()), pad(date.getMinutes())].join("-")
}

export function sessionFileName(
  date: Date,
  title: string | undefined,
  id: string,
  config: Pick<Config, "transliterate" | "maxDescLen">,
): string {
  return `${timeStamp(date)}_${sessionSlug(title, id, config)}`
}

/**
 * v2 sessions have no parts array, so the signature is built from the flat
 * message ids plus the session update time. Both move whenever the transcript
 * grows or an in-flight message is streamed into.
 */
export function signature(info: SessionInfo, messages: SessionMessageInfo[]): string {
  const body = messages
    .map((message) => [String(message.id), message.time?.completed ?? message.time?.created ?? null].join(":"))
    .join("|")
  return JSON.stringify([info.title ?? null, info.time?.updated ?? null, messages.length, body])
}

/**
 * After a compaction `ctx.session.context()` returns only the post-compaction
 * window — it starts with the compaction message. The export written before the
 * compaction still holds the pre-compaction history, so the two are merged:
 * otherwise saving after a compaction would wipe the archived transcript.
 */
export function mergeAfterCompaction(
  previous: SessionMessageInfo[] | undefined,
  current: SessionMessageInfo[],
): SessionMessageInfo[] {
  if (!previous?.length) return current
  if (current[0]?.type !== "compaction") return current
  const ids = new Set(current.map((message) => message.id))
  const history = previous.filter((message) => !ids.has(message.id))
  if (!history.length) return current
  return [...history, ...current]
}

/** True when `dir` is `root` or lives inside it. */
export function within(root: string | undefined, dir: string | undefined): boolean {
  if (!root || !dir) return false
  const normalizedRoot = path.resolve(root)
  const normalizedDir = path.resolve(dir)
  if (normalizedDir === normalizedRoot) return true
  return normalizedDir.startsWith(normalizedRoot.endsWith(path.sep) ? normalizedRoot : normalizedRoot + path.sep)
}

// --- fs-backed helpers (fs injected for unit tests) ---

export async function readJson<T>(fs: FsLike, file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T
  } catch {
    return undefined
  }
}

export async function atomicWrite(fs: FsLike, file: string, content: string) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await fs.writeFile(tmp, content)
  try {
    await fs.rename(tmp, file)
  } catch {
    await fs.rm(file, { force: true })
    await fs.rename(tmp, file)
  }
}

export async function pickPath(fs: FsLike, root: string, dir: string, name: string, id: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const suffix = attempt === 0 ? "" : `_${attempt + 1}`
    const rel = path.join(dir, `${name}${suffix}.json`)
    const abs = path.join(root, rel)
    let exists = false
    try {
      await fs.stat(abs)
      exists = true
    } catch {}
    if (!exists) return rel
    const existing = await readJson<{ info?: { id?: string } }>(fs, abs)
    if (existing?.info?.id === id) return rel
  }
}

async function statEntry(fs: FsLike, target: string): Promise<StatLike | undefined> {
  try {
    return await fs.stat(target)
  } catch {
    return undefined
  }
}

export async function listJsonFiles(fs: FsLike, dir: string): Promise<string[]> {
  const out: string[] = []
  let entries: string[] = []
  try {
    entries = await fs.readdir(dir)
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = path.join(dir, entry)
    const entryStat = await statEntry(fs, full)
    if (!entryStat) continue
    if (entryStat.isDirectory()) {
      out.push(...(await listJsonFiles(fs, full)))
    } else if (entryStat.isFile() && entry.endsWith(".json") && entry !== ".index.json") {
      out.push(full)
    }
  }
  return out
}

export function configPaths(baseDir: string, homedir: string): string[] {
  return [
    path.join(homedir, ".config", "opencode", "session-saver-v2.json"),
    path.join(baseDir, ".opencode", "session-saver-v2.json"),
  ]
}

export async function loadConfig(fs: FsLike, paths: string[]): Promise<Config> {
  const merged: Config = { ...DEFAULT_CONFIG }
  for (const file of paths) {
    try {
      Object.assign(merged, JSON.parse(await fs.readFile(file, "utf8")))
    } catch {}
  }
  merged.maxDescLen = Math.max(1, merged.maxDescLen)
  merged.minMessages = Math.max(0, merged.minMessages)
  return merged
}

// --- plugin ---

export type SessionSaverDeps = {
  now?: () => Date
  fs?: FsLike
  homedir?: () => string
}

/**
 * OpenCode V2 server plugin. V2 loads `{ id, setup }` and ignores the V1
 * `server()` export, so the plugin is shaped as a factory that returns the
 * `setup` function. `deps` is the seam the tests drive.
 */
export function createSessionSaver(deps: SessionSaverDeps = {}) {
  return async (ctx: SaverContext): Promise<() => Promise<void>> => {
    const fs = deps.fs ?? realFs
    const now = deps.now ?? (() => new Date())
    const homedir = deps.homedir ?? (() => os.homedir())

    const project = ctx.location.project
    const roots = [project?.canonical, project?.directory, ctx.location.directory].filter(
      (value): value is string => typeof value === "string" && value !== "" && path.resolve(value) !== "/",
    )
    const baseDir = roots[0] ?? ctx.location.directory
    const config = await loadConfig(fs, configPaths(baseDir, homedir()))
    const root = path.isAbsolute(config.root) ? config.root : path.join(baseDir, config.root)

    const sessionMap = new Map<string, IndexEntry>()
    const savableCache = new Map<string, boolean>()
    let activeSession: string | undefined
    let tail = Promise.resolve()
    let warm = false
    let closed = false

    const indexFile = path.join(root, ".index.json")

    function enqueue<T>(fn: () => Promise<T>): Promise<T> {
      const run = tail.then(fn, fn)
      tail = run.then(
        () => undefined,
        () => undefined,
      )
      return run
    }

    function toAbs(rel: string): string {
      return path.join(root, rel)
    }

    function logError(scope: string, error: unknown) {
      console.error(`[session-saver-v2] ${scope} failed`, error)
    }

    async function sessionInfo(id: string): Promise<SessionInfo | undefined> {
      try {
        return await ctx.session.get({ sessionID: id })
      } catch {
        return undefined
      }
    }

    /**
     * A session is savable when it is a top-level session (no `parentID`, i.e.
     * not a subagent run) and it belongs to this plugin instance's project.
     * Cached because the event stream reports the same session repeatedly.
     */
    async function isSavable(id: string): Promise<boolean> {
      const cached = savableCache.get(id)
      if (cached !== undefined) return cached
      const info = await sessionInfo(id)
      let savable = true
      if (!info) savable = false
      else if (info.parentID) savable = false
      else if (info.location?.directory && roots.length && !roots.some((entry) => within(entry, info.location?.directory)))
        savable = false
      savableCache.set(id, savable)
      return savable
    }

    async function saveIndex() {
      const payload = JSON.stringify({ version: 2, sessions: Object.fromEntries(sessionMap) }, null, 2)
      await atomicWrite(fs, indexFile, payload)
    }

    async function rebuildIndex() {
      const found = new Set<string>()
      for (const file of await listJsonFiles(fs, root)) {
        try {
          const data = await readJson<{ info?: SessionInfo; messages?: SessionMessageInfo[] }>(fs, file)
          if (!data?.info?.id) continue
          const id = String(data.info.id)
          found.add(id)
          sessionMap.set(id, {
            path: path.relative(root, file),
            signature: signature(data.info, data.messages || []),
          })
        } catch {}
      }
      for (const id of [...sessionMap.keys()]) {
        if (!found.has(id)) sessionMap.delete(id)
      }
      savableCache.clear()
      activeSession = undefined
      await saveIndex()
      warm = true
    }

    async function saveSession(id: string) {
      try {
        if (!id || !(await isSavable(id))) return
        const info = await sessionInfo(id)
        if (!info) return
        const context = await ctx.session.context({ sessionID: id })
        if (context.length < config.minMessages) return
        const messages = mergeAfterCompaction(await savedMessages(id), context)
        const sig = signature(info, messages)
        const previous = sessionMap.get(id)
        if (previous && previous.signature === sig) return
        const date = now()
        const rel = await pickPath(fs, root, dateStamp(date), sessionFileName(date, info.title, id, config), id)
        const abs = toAbs(rel)
        await atomicWrite(fs, abs, JSON.stringify({ info, messages }, null, 2))
        if (previous && previous.path !== rel) {
          await fs.rm(toAbs(previous.path), { force: true })
        }
        sessionMap.set(id, { path: rel, signature: sig })
        await saveIndex()
      } catch (error) {
        logError("save", error)
      }
    }

    /** Messages of the export that is already on disk for that session. */
    async function savedMessages(id: string): Promise<SessionMessageInfo[] | undefined> {
      const previous = sessionMap.get(id)
      if (!previous) return undefined
      const data = await readJson<{ messages?: SessionMessageInfo[] }>(fs, toAbs(previous.path))
      return data?.messages
    }

    async function removeSession(id: string) {
      try {
        if (!config.deleteOnSessionDelete) return
        const previous = sessionMap.get(id)
        if (!previous) return
        await fs.rm(toAbs(previous.path), { force: true })
        sessionMap.delete(id)
        savableCache.delete(id)
        await saveIndex()
      } catch (error) {
        logError("delete", error)
      }
    }

    async function finalizeSwitch(id: string) {
      if (!(await isSavable(id))) return
      if (activeSession && activeSession !== id) await saveSession(activeSession)
      activeSession = id
    }

    async function saveActiveSession() {
      if (!activeSession) return
      await saveSession(activeSession)
    }

    async function onSessionEvent(id: string | undefined) {
      if (!id) return
      if (activeSession && activeSession !== id) {
        await finalizeSwitch(id)
      } else if (!activeSession) {
        if (await isSavable(id)) activeSession = id
      }
    }

    async function handleEvent(event: SaverEvent) {
      const type = String(event?.type || "")
      const data = event?.data
      try {
        if (type === "session.deleted") {
          const id = data?.sessionID
          if (id) {
            await removeSession(String(id))
            if (activeSession === id) activeSession = undefined
          }
        } else if (type === "session.created") {
          if (data?.sessionID && !data.parentID) await finalizeSwitch(String(data.sessionID))
        } else if (type === "location.shutdown") {
          // the location goes away (window closed): flush before the plugin dies
          await saveActiveSession()
        } else if (SAVE_EVENT_TYPES.includes(type)) {
          // the turn is over: the transcript of that session is final
          const id = data?.sessionID ? String(data.sessionID) : undefined
          if (id) await saveSession(id)
        } else if (SWITCH_EVENT_TYPES.includes(type)) {
          await onSessionEvent(data?.sessionID ? String(data.sessionID) : undefined)
        }
      } catch (error) {
        logError(`event ${type}`, error)
      }
    }

    async function pump() {
      const controller = new AbortController()
      void (async () => {
        try {
          for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
            if (closed) return
            await enqueue(() => handleEvent(event))
          }
        } catch (error) {
          if (!closed) logError("event stream", error)
        }
      })()
      return controller
    }

    const controller = await pump()

    await enqueue(async () => {
      try {
        await rebuildIndex()
      } catch (error) {
        logError("init rebuild", error)
      }
    })

    return async () => {
      closed = true
      controller.abort()
      await Promise.race([
        enqueue(async () => {
          if (!warm) return
          await saveActiveSession()
        }),
        new Promise((resolve) => setTimeout(resolve, 4000)),
      ])
    }
  }
}

export default {
  id: "session-saver-v2",
  setup: (ctx: SaverContext) => createSessionSaver()(ctx),
}