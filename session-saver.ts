import type { Hooks, Plugin } from "@opencode-ai/plugin"
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

type Config = {
  root: string
  minMessages: number
  maxDescLen: number
  transliterate: boolean
  deleteOnSessionDelete: boolean
}

type IndexEntry = {
  path: string
  signature: string
}

const sessionSaver: Plugin = async ({ client, directory, worktree }) => {
  const usableWorktree = worktree && path.resolve(worktree) !== "/"
  const baseDir = usableWorktree ? worktree : directory
  const config = await loadConfig(baseDir)
  const root = path.isAbsolute(config.root) ? config.root : path.join(baseDir, config.root)

  const sessionMap = new Map<string, IndexEntry>()
  const topLevelCache = new Map<string, boolean>()
  let activeSession: string | undefined
  let tail = Promise.resolve()
  let warm = false

  const indexFile = path.join(root, ".index.json")

  function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = tail.then(fn, fn)
    tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async function readJson<T>(file: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(file, "utf8")) as T
    } catch {
      return undefined
    }
  }

  async function atomicWrite(file: string, content: string) {
    await mkdir(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    await writeFile(tmp, content)
    try {
      await rename(tmp, file)
    } catch {
      await rm(file, { force: true })
      await rename(tmp, file)
    }
  }

  function signature(info: any, messages: any[]): string {
    const body = messages
      .map((message) => [message.info.id, (message.parts || []).map((part: any) => part.id).join(",")].join(":"))
      .join("|")
    return JSON.stringify([info.title, info.time?.updated ?? null, messages.length, body])
  }

  function transliterate(input: string): string {
    return [...input.toLowerCase()].map((char) => CYRILLIC[char] ?? char).join("")
  }

  function slugify(input: string): string {
    return input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
  }

  function describe(info: any, id: string): string {
    let slug = slugify(config.transliterate ? transliterate(info.title || "") : info.title || "")
    if (!slug) slug = `session_${String(id).replace(/^ses_/, "").slice(0, 8)}`
    if (slug.length > config.maxDescLen) slug = slug.slice(0, config.maxDescLen)
    return slug
  }

  function pad(value: number): string {
    return String(value).padStart(2, "0")
  }

  function dateStamp(date: Date): string {
    return [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join("-")
  }

  function timeStamp(date: Date): string {
    return [pad(date.getHours()), pad(date.getMinutes())].join("-")
  }

  function toAbs(rel: string): string {
    return path.join(root, rel)
  }

  async function pickPath(dir: string, name: string, id: string): Promise<string> {
    for (let attempt = 0; ; attempt++) {
      const suffix = attempt === 0 ? "" : `_${attempt + 1}`
      const rel = path.join(dir, `${name}${suffix}.json`)
      let exists = false
      try {
        await stat(toAbs(rel))
        exists = true
      } catch {}
      if (!exists) return rel
      const existing = await readJson<{ info?: { id?: string } }>(toAbs(rel))
      if (existing?.info?.id === id) return rel
    }
  }

  async function listJsonFiles(dir: string): Promise<string[]> {
    const out: string[] = []
    let entries: string[] = []
    try {
      entries = await readdir(dir)
    } catch {
      return out
    }
    for (const entry of entries) {
      const full = path.join(dir, entry)
      let entryStat
      try {
        entryStat = await stat(full)
      } catch {
        continue
      }
      if (entryStat.isDirectory()) {
        out.push(...(await listJsonFiles(full)))
      } else if (entryStat.isFile() && entry.endsWith(".json") && entry !== ".index.json") {
        out.push(full)
      }
    }
    return out
  }

  async function isTopLevel(id: string): Promise<boolean> {
    const cached = topLevelCache.get(id)
    if (cached !== undefined) return cached
    let top = true
    try {
      const res = await client.session.get({ path: { id } })
      if (!res.error && res.data?.parentID) top = false
    } catch {}
    topLevelCache.set(id, top)
    return top
  }

  async function saveIndex() {
    const payload = JSON.stringify({ version: 1, sessions: Object.fromEntries(sessionMap) }, null, 2)
    await atomicWrite(indexFile, payload)
  }

  async function rebuildIndex() {
    const found = new Set<string>()
    for (const file of await listJsonFiles(root)) {
      try {
        const data = await readJson<{ info?: any; messages?: any[] }>(file)
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
    topLevelCache.clear()
    activeSession = undefined
    await saveIndex()
    warm = true
  }

  async function saveSession(id: string) {
    try {
      if (!id || !(await isTopLevel(id))) return
      const sessionRes = await client.session.get({ path: { id } })
      if (sessionRes.error || !sessionRes.data) return
      const info: any = sessionRes.data
      const messagesRes: any = await client.session.messages({ path: { id } })
      const messages: any[] = messagesRes.data || []
      if (messages.length < config.minMessages) return
      const sig = signature(info, messages)
      const previous = sessionMap.get(id)
      if (previous && previous.signature === sig) return
      const now = new Date()
      const rel = await pickPath(dateStamp(now), `${timeStamp(now)}_${describe(info, id)}`, id)
      const abs = toAbs(rel)
      await atomicWrite(abs, JSON.stringify({ info, messages }, null, 2))
      if (previous && previous.path !== rel) {
        await rm(toAbs(previous.path), { force: true })
      }
      sessionMap.set(id, { path: rel, signature: sig })
      await saveIndex()
    } catch (error) {
      console.error("[session-saver] save failed", error)
    }
  }

  async function removeSession(id: string) {
    try {
      if (!config.deleteOnSessionDelete) return
      const previous = sessionMap.get(id)
      if (!previous) return
      await rm(toAbs(previous.path), { force: true })
      sessionMap.delete(id)
      await saveIndex()
    } catch (error) {
      console.error("[session-saver] delete failed", error)
    }
  }

  async function finalizeSwitch(id: string) {
    if (!(await isTopLevel(id))) return
    if (activeSession && activeSession !== id) await saveSession(activeSession)
    activeSession = id
  }

  async function onSessionEvent(id: string) {
    if (!id) return
    if (activeSession && activeSession !== id) {
      await finalizeSwitch(id)
    } else if (!activeSession) {
      if (await isTopLevel(id)) activeSession = id
    }
  }

  const event: Hooks["event"] = async ({ event }) => {
    await enqueue(async () => {
      const current: any = event
      const type: string = current?.type || ""
      const properties: any = current?.properties || {}
      try {
        if (type === "session.created") {
          if (properties?.info?.id && !properties.info.parentID) {
            await finalizeSwitch(String(properties.info.id))
          }
        } else if (type === "session.deleted") {
          const id = properties?.info?.id
          if (id) {
            await removeSession(String(id))
            if (activeSession === id) activeSession = undefined
          }
        } else if (
          type === "message.updated" ||
          type === "message.part.updated" ||
          type === "session.status" ||
          type === "session.idle" ||
          type === "session.compacted" ||
          type === "session.diff" ||
          type === "todo.updated" ||
          type === "command.executed" ||
          type === "permission.updated" ||
          type === "tui.session.select"
        ) {
          await onSessionEvent(properties?.sessionID || properties?.sessionId)
        }
      } catch (error) {
        console.error("[session-saver] event failed", type, error)
      }
    })
  }

  const dispose = async () => {
    await Promise.race([
      enqueue(async () => {
        if (!warm) return
        if (activeSession) await saveSession(activeSession)
      }),
      new Promise((resolve) => setTimeout(resolve, 4000)),
    ])
  }

  await enqueue(async () => {
    try {
      await rebuildIndex()
    } catch (error) {
      console.error("[session-saver] init rebuild failed", error)
    }
  })

  return { event, dispose }
}

async function loadConfig(baseDir: string): Promise<Config> {
  const defaults: Config = {
    root: "ai-sessions",
    minMessages: 1,
    maxDescLen: 80,
    transliterate: true,
    deleteOnSessionDelete: true,
  }
  const candidates = [
    path.join(os.homedir(), ".config", "opencode", "session-saver.json"),
    path.join(baseDir, ".opencode", "session-saver.json"),
  ]
  const merged: Config = { ...defaults }
  for (const file of candidates) {
    try {
      Object.assign(merged, JSON.parse(await readFile(file, "utf8")))
    } catch {}
  }
  merged.maxDescLen = Math.max(1, merged.maxDescLen)
  merged.minMessages = Math.max(0, merged.minMessages)
  return merged
}

export default sessionSaver