# AGENTS.md

Single-file opencode V2 plugin (`session-saver-v2.ts`): auto-exports top-level opencode sessions as JSON in the **V2 `SessionTransferData` format** (`{ info, messages }`) into `ai-sessions/` in the project root. There is **no** `package.json` and no build — the source is `session-saver-v2.ts`, the tests are `session-saver-v2.test.ts` (plain `node:test`, no framework), plus `README.md` (human-facing docs, Russian).

This is the V2 rewrite of `/media/tim/Ventoy32/work/ai/opencode-session-saver` (which targets 1.18.x). The old plugin cannot run on V2 at all: V2 logs `PluginModule.LoadError` for a V1-shaped file and skips it. The two **can** share the deployment directory (`~/.config/opencode/plugins/` holds `session-saver.ts` for 1.18.x and `session-saver-v2.ts` for 2.x) — each loader catches the foreign file per plugin and keeps working (V2: WARN `failed to load plugin`; V1: WARN `failed to load plugin`, server still starts). Verified against the 1.18.25 binary (`rQ()`/`Gy()` in the loader) and against the 2.1.4 log.

## V2 API contract (verified against the 2.1.4 desktop bundle + `@opencode/plugin@2.1.4`)

- V2 loads `export default { id, setup(ctx) }` (Promise) or `{ id, effect(ctx) }` (Effect) and **ignores** the V1 `server()` export and every V1 hook. A V1-shaped file fails at load with `PluginModule.LoadError: Plugin must export a default definition with an id and an effect or setup function` — a WARN in the log, and the plugin silently does nothing.
- `Plugin.define()` is an identity function, so a plain `{ id, setup }` object is a valid definition and keeps the plugin dependency-free. The structural `SaverContext` type in `session-saver-v2.ts` is a hand-written subset of the real `Context`; `session-saver-v2.ts` intentionally has **no import from `@opencode/plugin`** so the file stays dependency-free at runtime.
- Events come from `ctx.event.subscribe({ signal })` (an `AsyncIterable`), and the payload field is **`data`**, not V1's `properties`. Events are the durable event-sourced variants (`{ type, data, location?, durable? }`).
- There is no `ctx.session.messages`. The only transcript reader is `ctx.session.context({ sessionID })`, which returns the full transcript **unless the session was compacted** — after compaction it returns only the post-compaction messages plus the compaction message (that message is the *first* element of the returned array). The V2 HTTP API does have `/api/session/:id/message` and `/api/experimental/session/:id/export`, but neither is reachable from the plugin context (no base URL, no token, no client).
- Event names follow the V2 union (`@opencode/schema/event-manifest`): `session.execution.succeeded|failed|interrupted`, `session.idle`, `session.renamed`, `session.viewed`, `session.created`, `session.deleted`, `session.step.ended`, `session.text.ended`, `session.reasoning.ended`, `session.tool.called`, `session.compaction.*`, `session.status`, `session.metadata.updated`, `session.synthetic`, `tui.session.select`, `location.shutdown`. All of them carry `data.sessionID` (except `location.shutdown`).
- `ctx.session.get({ sessionID })` returns `SessionInfo` with `parentID` (subagent detection) and `title`.
- `ctx.location` = `{ directory, workspaceID?, project: { id, directory, canonical } }`; it replaces V1's `directory`/`worktree` pair.
- `setup` returns a cleanup function that replaces V1's `dispose()`. After cleanup the plugin instance is gone: the event stream is aborted and further events are not processed. Tests must never send events after cleanup.

## Verification

Tests — unit (pure helpers, in-memory fs) and integration (fake `ctx`, tmp dirs, injected clock/homedir, full `session.created`/`session.viewed`/`session.deleted`/cleanup sequences — no running opencode needed):

```sh
node --test session-saver-v2.test.ts
```

Requires Node ≥ 23.6 (native TS type stripping; node 24 is installed on this host). Keep it that way: no package.json, no bundler, no test framework — do not add them. The injection seam is `createSessionSaver({ now, fs, homedir })`, which returns the `setup` function; the default export wires it to the real fs/clock/homedir — that's what opencode loads.

Typecheck (the repo has no `node_modules` by design, so run tsc from a scratch dir; TS ≥ 7 does not auto-include `@types/node`, hence `--types node`):

```sh
mkdir -p /tmp/ss-tsc-v2 && cd /tmp/ss-tsc-v2
npm init -y >/dev/null && npm i -D typescript @types/node
cp "$OLDPWD"/session-saver-v2.ts "$OLDPWD"/session-saver-v2.test.ts .
npx tsc --noEmit --strict --types node --allowImportingTsExtensions \
  --module esnext --moduleResolution bundler --target esnext \
  session-saver-v2.ts session-saver-v2.test.ts
```

Contract check against the real V2 types — proves `SaverContext` is a subset of `Context` and that the default export is a valid `Plugin`. Keep this passing whenever `SaverContext` is touched:

```sh
cd /tmp/ss-tsc-v2
npm i -D @opencode/plugin@2.1.4 @types/json-schema
cat > compat-check.ts <<'EOF'
import type { Context, Plugin as PluginDefinition } from "@opencode/plugin/promise/plugin"
import saver, { type SaverContext } from "./session-saver-v2.ts"
declare const realCtx: Context
const _structural: SaverContext = realCtx
const _plugin: PluginDefinition = saver
void [_structural, _plugin]
EOF
npx tsc --noEmit --strict --types node --allowImportingTsExtensions \
  --module esnext --moduleResolution bundler --target esnext \
  session-saver-v2.ts session-saver-v2.test.ts compat-check.ts
```

Drift check against the deployed copy:

```sh
diff session-saver-v2.ts ~/.config/opencode/plugins/session-saver-v2.ts
```

## Deployment gotcha

The repo is just the source location. The running plugin lives at `~/.config/opencode/plugins/session-saver-v2.ts`; edits in this repo have **no effect** until copied there and the V2 service reloaded:

```sh
cp session-saver-v2.ts ~/.config/opencode/plugins/session-saver-v2.ts
~/.config/ai.opencode.desktop/cli/2.1.4-x64/opencode-cli plugin list | grep session-saver
grep -a 'failed to load plugin' ~/.local/share/opencode/log/opencode.log | tail -3
```

V2 watches config directories and hot-reloads local plugin files, but restart the desktop app when in doubt. `plugin list` prints the plugin ID; a broken plugin shows `-` as its ID. The V1 file in the same directory always shows `-` on V2 (and the V2 file shows `-` on V1) — that is expected and harmless.

## Behavior invariants to preserve

These are the subtle parts the code implements; don't break them while editing. The final truth on behavior is `session-saver-v2.ts` itself — the invariants below summarize it, and where they disagree with the code, the code wins. `session-saver-v2.test.ts` pins these: change the tests in the same edit whenever you change behavior deliberately:

- **Save timing**: a session is saved when its turn ends (`session.execution.succeeded` / `.failed` / `.interrupted`, plus `session.idle`), when it is renamed (`session.renamed`), on activity switches, on `location.shutdown` and on cleanup — never per message/token. Subagent/subtask sessions (`parentID` set) are never saved or treated as switches.
- **Turn end is the primary save point**: in the GUI the user never "switches away", and the cleanup callback does not always run (the desktop app kills the server), so `SAVE_EVENT_TYPES` events must save their own session instead of only switching the watched one. Verified live on 2.1.4: `session.idle` is *not* published by the server (it only sets `session.time.idle`), `session.execution.succeeded` is.
- **All async work** must go through the `enqueue()` queue (serializes writes). Cleanup races completion against a 4s timeout, and skips work until `warm` (index rebuild) finishes.
- **Index is derived from the exported files** (`rebuildIndex()` scans JSONs, uses `info.id`), not from opencode's database. `sessionMap` maps `sessionID → {path, signature}`. The index format is `{ version: 2, sessions }`.
- **Output shape** is exactly `{ info, messages }` — nothing else, so `POST /api/experimental/session/import` accepts the file unchanged (plus `location`).
- **Signature dedup**: unchanged sessions (same title, update time, message count, and message ids/timestamps) are skipped; on path change the old file is removed only after the new write succeeds. Writes are atomic (tmp file + rename).
- **Compaction must not wipe the archive**: `ctx.session.context()` returns only the post-compaction window (it starts with the `compaction` message), so `mergeAfterCompaction()` glues the previously saved messages back in front of it. Only the `compaction` message at the head of the context triggers the merge.
- **Path scheme** `ai-sessions/<YYYY-MM-DD>/<HH-MM>_<slug>.json`: slug = slugified title (transliterated Cyrillic → Latin), truncated to `maxDescLen` (default 80), fallback `session_<8chars>` of the id. Same session within the same minute reuses/overwrites its file; different sessions get `_2`, `_3`, … suffixes.
- **Order of readiness checks in handlers**: `isSavable(id)` (with cached lookup) must gate save/activation so subagent activity — and activity from another project — never becomes "active". `isSavable` rejects a session when `info.parentID` is set or `info.location.directory` lies outside the plugin instance's project (`project.canonical` / `project.directory` / `location.directory`), because the V2 event stream is server-wide, not per location.
- When `session.deleted` fires and `deleteOnSessionDelete` is on, remove the file + index entry, and clear `activeSession` if it pointed at the deleted session.
- A cleanup call aborts the event stream; it is idempotent and must not be followed by more events.

## Config

Config is JSON merged over defaults in `loadConfig()`. Precedence: global `~/.config/opencode/session-saver-v2.json`, then project `.opencode/session-saver-v2.json` (project wins). `root` is resolved relative to `baseDir` = the location's canonical project root (falling back to the project directory, then the location directory), skipping any candidate that resolves to `/`.

## Runtime output

`ai-sessions/` (including `.index.json`) is generated by the plugin at runtime, not source. Per the intended cross-PC workflow it's meant to be committed/synced. Files written by this V2 version are in the V2 format and are only importable by opencode 2.x; the V1-format files from the old plugin live in the other projects' `ai-sessions/` directories and stay importable by 1.18.x only.