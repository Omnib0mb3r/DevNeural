# DevNeural Architecture Map

> **In progress.** Built from per-package deep traversal. Each section is the authoritative map for that package. Last updated: 2026-05-22.

This doc replaces guesswork. When Lex needs to know how a piece works, the answer is here. If something is wrong, fix this doc.

Pending sections (filled by per-package agents):
- [ ] 07-daemon (orchestrator, all modules, all routes, all tables)
- [ ] 08-dashboard (every page, every component, every daemon route it hits)
- [ ] 09-bridge (VSIX, presence files, paste injection)
- [ ] 05-voice-interface (Whisper STT, Piper TTS, audio bundling)
- [ ] 06-notebooklm-integration (current state)
- [ ] 03-web-app (legacy, kept for reference)
- [ ] Cross-cutting: hooks, live_state block, brainstorm lifecycle, smart-compact, cross-session inject

Partial high-level pass from earlier exploration is below; will be replaced by per-package deep maps as they land.

---

## High-level summary (partial, will be superseded)

- 07-daemon: Fastify orchestrator on :3747. SQLite + vector store + wiki + PTY hosting + voice WS + bridge presence + cross-session inject + smart-compact + curator + reinforcement.
- 08-dashboard: Next.js 15 static export. Pages: /sessions, /lex, /brainstorms, /wiki, /reminders, /system, /meetings.
- 09-bridge: VS Code VSIX. Writes `.bridge-presence/<cwd>.json`. Polled by daemon, used to auto-bind manually-launched CC sessions to brainstorms.
- 05-voice-interface: Whisper STT + Piper TTS workers.
- 06-notebooklm-integration: scaffolding only.
- 03-web-app: legacy React+Vite, superseded by 08-dashboard.

---

## 09-bridge — Complete File Map

> VS Code extension (`omnib0mb3r.devneural-bridge`) that delivers daemon-queued prompts into the Claude Code terminal hosted in this VS Code window, writes presence files so the daemon knows which window owns which CC session, and (with proposed-API enabled) mirrors terminal output back to the daemon for the dashboard's xterm view.

### Activation events

- `onStartupFinished` (the only event in `package.json`). Bridge activates as soon as VS Code finishes starting up; it does not wait for a workspace or terminal.
- Proposed API gate: `enabledApiProposals: ["terminalDataWriteEvent"]`. Terminal-output mirroring requires launching VS Code with `--enable-proposed-api omnib0mb3r.devneural-bridge` (or adding it to `%APPDATA%/Code/User/argv.json`). Without it the prompt-delivery loop still works; only the mirror is disabled.

### Source files

| Relative path | Purpose | Key exports |
| ---            | ---     | ---         |
| `src/extension.ts` | Extension entry. Activation, watcher tick, terminal resolution, presence write, workspace-inject, terminal-output mirror, command registrations. | `activate(context)`, `deactivate()` |
| `src/presence.ts` | Pure presence-payload builder + multi-window-safe filename helper. Vscode-free so it is unit-testable. | `writePresenceFiles`, `buildPresencePayload`, `presenceFilename`, `legacyPresenceFilename`, types `WorkspaceFolderLike` / `PresencePayload` / `WritePresenceOptions` / `BuildPayloadOptions` |
| `src/bridge-payload.ts` | Bracketed-paste wrapping + atomic body+`\r` builder. Encapsulates the 2026-05-14 missing-Enter regression fix. | `buildBridgePayload`, `wrapBracketedPaste`, `needsBracketedPaste`, `BRACKETED_PASTE_START`/`_END`/`_THRESHOLD` |
| `src/cc-session-latch.ts` | Sticky cwd -> cc_session_id resolver. Scans `~/.claude/projects/<slug>/*.jsonl` by mtime with a 60s anti-flap supersession window. | `CcSessionLatch` (class with `resolve(cwd)`, `clear()`, `snapshot()`), `SUPERSEDE_WINDOW_MS` |
| `src/slug.ts` | Project-slug encoder (`C:\dev\X` -> `C--dev-X`). Mirrors daemon/`07-daemon/src/dashboard/sessions.ts` and `~/.claude/projects/` naming. | `cwdToSlug(cwd)` |
| `tests/bridge-payload.test.ts` | Vitest for bracketed-paste wrapping and Enter assembly (pins the inject-missing-Enter regression). | (vitest specs) |
| `tests/cc-session-latch.test.ts` | Vitest for first-sight, same-UUID refresh, cross-UUID supersession window. | (vitest specs) |
| `tests/presence.test.ts` | Vitest for filename layout (legacy vs bridge-id), payload shape, deliverability flag. | (vitest specs) |
| `tests/slug.test.ts` | Vitest for slash + colon flattening parity. | (vitest specs) |

### Every command registered

| Command id | Registered in | Handler behavior |
| ---        | ---           | ---              |
| `devneural.bridge.status` | `src/extension.ts` (`activate`, ~line 1489) | Dumps `{enabled, configEnabled, dataRoot, bridgeDir, terminalPattern, terminals[], workspaces[], watching, offsetsTracked}` to the `DevNeural Bridge` output channel and an `showInformationMessage`. |
| `devneural.bridge.toggle` | `src/extension.ts` (~line 1512) | Flips an in-memory `enabled` flag and calls `startWatching` / `stopWatching`. Does NOT persist; survives only until VS Code reload. |
| `devneural.bridge.openClaudeTerminal` | `src/extension.ts` (~line 1525) | Quick-pick over `vscode.window.terminals`. Writes the picked name (lowercased) into `devneural.bridge.terminalNamePattern` at `ConfigurationTarget.Workspace`. |

Configuration keys (from `package.json` `contributes.configuration`):

- `devneural.bridge.enabled` (boolean, default `true`).
- `devneural.bridge.dataRoot` (string, default `C:/dev/data/skill-connections`). Must match daemon's `DEVNEURAL_DATA_ROOT`.
- `devneural.bridge.terminalNamePattern` (string, default `claude`). Case-insensitive substring match against terminal names.

### Watcher cadence and entry points

- Tick interval: `setInterval(tick, 750)` started by `startWatching()` (`src/extension.ts` line 1118).
- `tick()` (line 932) runs in order each interval: `writeHeartbeat()` -> `writePresence()` -> `processFile()` over every `.in` in the bridge dir -> `processWorkspaceInjects()`.
- On first run in a new workspace (no offsets file), `startWatching()` advances every existing `.in` cursor to EOF so the bridge does not replay backlog from before install (line 1095).

### Files under `.bridge-presence/` and adjacent state

All paths are rooted at `<dataRoot>/session-bridge/` (default `C:/dev/data/skill-connections/session-bridge/`).

| Path | Write frequency | Payload | Purpose |
| ---  | ---             | ---     | ---     |
| `.heartbeat` | Every 750ms tick (`writeHeartbeat`, line 761) | `String(Date.now())` (epoch ms as text). | Daemon refuses to queue prompts unless this file's mtime is <30s old. Prevents a closed VS Code window from buffering prompts that dump on next reload. |
| `.bridge-presence/<cwd-key>__<bridge-id>.json` | Every tick via `writePresenceFiles` (per top-level workspace folder) | `{workspace, cwd, bridge_id, updated_at (ISO), cc_session_ids?: string[], has_terminal_for_uuid?: Record<uuid, boolean>}` (see `src/presence.ts` `PresencePayload`). | Daemon polls this dir, flips matching `project_session` rows live, dedupes multi-window connections by `bridge_id`, routes cross-session inject to a presence file whose `has_terminal_for_uuid[<target uuid>] === true`. |
| `.bridge-presence/<cwd-key>.json` | Scrubbed on activate/deactivate only | Legacy single-file-per-cwd shape, pre-2026-05-22. | Removed by `clearPresence()` so a stale legacy presence does not survive a window close. `legacyPresenceFilename()` in `src/presence.ts`. |
| `.mirror-state.json` | Debounced 500ms after each mirror state change (`writeMirrorStateDebounced`, line 1184) | `MirrorState` shape: `{updated_at, api_available, subscribed, reason, tracked_terminals, last_flush_at, last_flush_session_id, last_flush_bytes, last_resolution_failure_at, last_resolution_failure_reason, last_post_error, last_post_error_at}`. | Daemon and dashboard surface mirror health (e.g. "proposed API not enabled") without the user opening VS Code's output panel. |
| `.offsets/<workspace-key>.json` | Debounced 500ms after every offset advance (`saveOffsetsDebounced`, line 94) | `Record<filePath, byteOffset>`. | Per-window cursor persistence so VS Code reload does not replay the entire bridge inbox backlog. Keyed by sanitized workspace folder path. |
| `.workspace-inject/*.json` | Read+claim (renamed to `.claim`) and deleted by `processWorkspaceInjects` (line 974). Dashboard "Start Claude" buttons write here. | `WorkspaceInjectMarker = {workspace, command, queued_at}`. | Dashboard has no `session_id` yet for new Claude sessions, so it keys the marker by workspace path. Owning bridge opens a fresh terminal at that cwd, sends `command + \r`, deletes the marker. TTL 10min. |
| `<sessionId>.in` (read-only consumer) | n/a (daemon writer). Cursor saved to `.offsets/`. | NDJSON. Each line: `BridgeMessage = {queued_at: ISO, text?: string, commit?: boolean}`. | Per-session inbox. `commit=true` (default) -> paste + Enter; `commit=false` -> paste into input buffer without Enter (curator suggestions). Markers older than 90s are skipped as stale. |

### Paste-injection mechanism

Implementation: `handleMessage()` in `src/extension.ts` (line 383) plus `buildBridgePayload()` in `src/bridge-payload.ts`.

Sequence per inbox message:

1. Resolve target terminal asynchronously (`findTargetTerminalAsync`, line 304). If unresolved AND in-flight, return `'retry'`; offset does NOT advance (bug 3c fix 2026-05-22, line 404).
2. `terminal.show(true)`.
3. Compute `wrapped = buildBridgePayload(text, commit)`. If text contains `\n` OR `text.length > 200`, wrap in `\x1b[200~ ... \x1b[201~` (xterm bracketed paste). `commit=true` appends `\r` AFTER the terminator in the SAME string so PTY write is atomic (fixes 2026-05-14 missing-Enter race).
4. `terminal.sendText(wrapped, false)` (the `false` second arg suppresses VS Code adding its own newline).
5. If `commit`, schedule a `setTimeout(() => terminal.sendText('\r', false), 120)` safety-net bare-CR (line 457). Empirically required on multi-hundred-char wrapped payloads where the bracketed-paste envelope occasionally swallows the original `\r`. If the original `\r` already committed, the safety-net `\r` is a TUI no-op (per memory `feedback_always_fire_cr_after_inject.md`).
6. Outcome `'delivered'` -> advance offset; `'dropped'` -> advance offset (parse error or sendText throw); `'retry'` -> halt the file's chain until next tick.

Stale-message gate: messages whose `queued_at` is >90s old are logged `[skip-stale]` and skipped without delivery; offset still advances via a chained no-op (line 721).

Per-file in-flight chain (`FileChainState`, line 599): each `.in` has its own promise tail so handler latency can't interleave deliveries from the same session out of order. The chain tracks `committedOffset` and a `halted` flag that pauses further enqueues while a `'retry'` is outstanding.

### Terminal auto-bind logic

Three-pass resolution in `findTargetTerminalAsync()` (`src/extension.ts` line 304):

1. **Name pattern** (line 309): active terminal first if its `name.toLowerCase().includes(terminalNamePattern)`; else iterate `vscode.window.terminals` from most-recent backward for a name match.
2. **Process-tree auto-detect** (line 322): for each terminal, call `isClaudeTerminal(t)` which awaits `t.processId` then `findClaudeDescendant(pid)` (line 196). `findClaudeDescendant` walks the Windows process tree from a snapshot of `Get-CimInstance Win32_Process` (line 234, 4s-cached, replaces deprecated `wmic`), BFS over `(pid -> ppid)` children, returns true if any descendant's `CommandLine` matches `/claude/i`. Cache: `claudeTerminalCache: Map<Terminal, {value, ts}>` with a 5s negative-entry TTL so a shell that didn't yet have claude running becomes eligible later (line 165).
3. **Aggressive last-resort** (line 342): per user direction 2026-05-21, the bridge must never prompt for a terminal pick. Falls through to the active terminal; if no active, the most-recently-created one. Logged via `channel.appendLine('[auto-bind] ...')`.

If all three fail, `noticeNoTerminal()` (line 375) logs to the output channel only. No UI prompt. The marker stays in the inbox via `'retry'` until another bridge picks it up or it ages out into `[skip-stale]`.

Sticky cwd -> cc_session_id resolution: `CcSessionLatch` (`src/cc-session-latch.ts`) replaces the prior 30s mtime-window scan. Per Task E (2026-05-13), latch-first lookup runs before the daemon `/sessions` cache fallback in `writePresence` (line 855) to break the self-reinforcing stale-id loop after `/clear`.

Per-UUID deliverability flag (bug 3b, 2026-05-22): `hasClaudeTerminalInThisWindow()` (line 887) is consulted by `writePresenceFiles` so the daemon can route `/lex/inject-cross-session` away from windows that latched a UUID but currently have no terminal. Cold cache returns `false` plus fires a background warmup (line 898).

### Terminal-output mirror (proposed-API)

Implementation: `startTerminalMirror()` (line 1248). Subscribes to `vscode.window.onDidWriteTerminalData`; buffers per-terminal data with a 16ms debounced flush.

- Resolution chain in `resolveSessionForTerminal` (line 1285): (1) Stream Deck identity dir `%LOCALAPPDATA%/stream-deck/identity/<sessionId>.json` (matches `Cwd` field); (2) ancestor-walk over the daemon `/sessions` cache (refreshed every 3s, `refreshDaemonSessions`, line 1220). Positive resolutions cached per Terminal; misses are not cached so a deferred session start eventually resolves.
- Flush target: `POST http://127.0.0.1:3747/sessions/<sessionId>/terminal-stream` with `{data, cols?, rows?}` (terminal dimensions forwarded from `(t as any).dimensions` so the dashboard xterm can size its grid to the source).

### External interface summary

- Filesystem watched: `<dataRoot>/session-bridge/*.in` (poll, 750ms).
- Filesystem written: see table above (`.heartbeat`, `.bridge-presence/`, `.mirror-state.json`, `.offsets/`, `.workspace-inject/*.claim`).
- Filesystem read (sticky latch): `~/.claude/projects/<slug>/*.jsonl` (stat-only, no read).
- Filesystem read (session cwd resolve): `<dataRoot>/session-state/<sessionId>.meta.json`, falling back to first 8KB of `~/.claude/projects/<slug>/<sessionId>.jsonl`.
- Filesystem read (mirror resolve): `%LOCALAPPDATA%/stream-deck/identity/*.json`.
- Daemon endpoints called: `GET http://127.0.0.1:3747/sessions` (active-session cache refresh, every 3s while mirror active), `POST http://127.0.0.1:3747/sessions/<id>/terminal-stream` (mirror flush, ~16ms debounce).
- Ports: 3747 (DevNeural daemon).

---

## 05-voice-interface — Complete File Map

> Archived per `README.md`. The pre-Phase-7 v1 voice CLI: a one-shot Node entry point that parses an intent locally (NLP fallback to Anthropic Haiku), hits the API server's graph endpoints, formats a natural-language reply on stdout, and posts orb-focus events back to the daemon. **Nothing here ships at runtime.** The live voice stack lives in `07-daemon/src/voice/` and `08-dashboard/components/VoiceClient.tsx`.

### Source files

| Relative path | Purpose | Key exports | External interface |
| ---            | ---     | ---         | ---                |
| `src/index.ts` | CLI entry. Resolves project identity, parses intent, executes API request, formats reply, fires orb events, writes to stdout. | `main()` (implicit) | stdout; reads `process.cwd()`; calls `01-data-layer` identity resolver. |
| `src/intent/types.ts` | Intent + IntentResult shapes. | `IntentName`, `IntentResult`, `VoiceResponse` | (types only) |
| `src/intent/parser.ts` | Two-stage pipeline: local NLP first; defer to Haiku if confidence <0.75; gate output by 0.60/0.85 thresholds (clarification vs hedging). | `parseIntent(query)`, `ParsedIntent` | Composes local + Haiku parsers; never throws. |
| `src/intent/local-parser.ts` | Local-only Bayesian classifier (`natural.BayesClassifier`) + keyword fast-path. Trained at module load from ~100 in-file examples. | `parseLocalIntent(query)`, `normalizeConfidence(probs)` | None. |
| `src/intent/haiku-parser.ts` | Anthropic Haiku-4-5 JSON-mode fallback parser. Zod-validates the response. Returns frozen `UNREACHABLE_RESULT` on any API/parse/validation failure. | `parseWithHaiku(query)`, `UNREACHABLE_RESULT` | Anthropic Messages API (`claude-haiku-4-5`, max_tokens 256). |
| `src/routing/api-client.ts` | Picks the API URL (`DEVNEURAL_API_URL` env or `http://localhost:${DEVNEURAL_PORT ?? 3747}`) and provides a `fetchWithTimeout` helper (5s default). | `buildApiConfig()`, `fetchWithTimeout(url, ms)`, types `GraphNode` / `GraphEdge` / `GraphResponse` / `ApiClientConfig` | HTTP GET; daemon port 3747. |
| `src/routing/intent-map.ts` | Maps each `IntentName` to the appropriate `02-api-server` GET sequence. Two-step label resolution for `get_node` and named `get_connections`. | `executeIntentRequest(intent, projectId, config)`, `resolveLabel(name, nodes)`, `IntentApiResult` | Daemon endpoints: `GET /graph`, `GET /graph/top?limit=100`, `GET /graph/subgraph?project=<id>`, `GET /graph/node/<id>`. |
| `src/formatter/response.ts` | Per-intent natural-language renderer. Hedging prefix when confidence in [0.60, 0.85). Prints a "graph isn't running" message when apiResult is null. | `formatResponse(intent, apiResult, hedging)` | None (pure). |
| `src/formatter/orb-events.ts` | Best-effort `POST /voice/command` to fire `voice:focus` / `voice:highlight` / `voice:clear` events to the orb. | `sendOrbEvents(intent, apiResult)` | `POST http://localhost:${DEVNEURAL_PORT ?? 3747}/voice/command` (5s timeout, swallows all errors). |
| `src/identity/index.ts` | Re-exports identity resolver from `01-data-layer/dist`. | `ProjectIdentity`, `ProjectSource`, `resolveProjectIdentity` | Reads identity files via `01-data-layer`. |
| `dist/` | Compiled tsc output mirroring `src/`. Stale build artifact. | (compiled) | n/a. |
| `tests/*` | Vitest specs covering entry point, parser pipeline, local/Haiku parsers, intent map, response formatter, orb events, e2e. | (vitest specs) | None. |

### Whisper STT entry points

None. There is no Whisper integration in this directory. The live Whisper pipeline lives in `07-daemon/src/voice/` (referenced from `README.md`). This package's "voice" input is the literal CLI argument `process.argv[2]`. The browser path (`03-web-app/webview/voice.ts` and `08-dashboard/components/VoiceClient.tsx`) uses the Web Speech API and a daemon WS, not anything in `05-voice-interface`.

### Piper TTS entry points

None. There is no Piper integration in this directory. Output is plain text written to `process.stdout` by `src/index.ts`. Live Piper lives in `07-daemon/src/voice/`.

### Audio bundling

None in this directory. Audio bundling (per memory `project_devneural_phase7_diarization.md` and adjacent Phase 7 notes) is in `07-daemon/src/voice/audio-bundle*` and `meeting-audio-purge`.

### IPC with daemon

- HTTP GET to `02-api-server` (port 3747): `/graph`, `/graph/top?limit=N`, `/graph/subgraph?project=<id>`, `/graph/node/<id>` (see `src/routing/intent-map.ts`).
- HTTP POST to `/voice/command` (port 3747) for `voice:focus` / `voice:highlight` / `voice:clear` orb events (see `src/formatter/orb-events.ts`). 5-second `AbortSignal.timeout`; failures swallowed.

### Activation / build

- `npm run build` (`tsc`) produces `dist/`.
- `npm test` runs the Vitest suite.
- No daemon module imports from this directory (`README.md` line 11). Treat the package as historical reference only.

---

## 06-notebooklm-integration — Complete File Map

> Spec target is "NotebookLM cluster materials + recommendation engine" (`spec.md`). Actual implementation in `src/` is the **devneural-obsidian-sync** CLI: reads daily session logs, asks Claude Haiku to summarize the day, writes the result into an Obsidian vault. NotebookLM integration itself is unbuilt; what is on disk is the scaffolding (planning markdown for 8 sections in `sections/`) plus a working obsidian-sync subset (sections 01-07 implemented per `implementation/code_review/`).

### Current state

- **Scaffolding**: yes. 8 sections planned (`sections/section-01-setup.md` through `section-08-cli-integration.md`). Per-section deep-implement reviews exist for 01-07; section 08 has only an `-interview.md` (no diff), implying CLI integration is partial. The original spec's cluster-detection / NotebookLM upload / recommendation engine are not in `src/`.
- **What does work** (the Obsidian-sync subset): a `generate-summary` CLI that reads `<data_root>/logs/<date>.jsonl`, calls Anthropic Haiku, and writes Markdown into an Obsidian vault.
- `package.json` name is `devneural-obsidian-sync` (not `devneural-notebooklm`). The directory name is legacy.

### Source files

| Relative path | Purpose |
| ---            | ---     |
| `src/generate-summary.ts` | CLI entry. `runPipeline(opts)` orchestrates: load config -> read session log for date -> extract graph insights -> Haiku summary -> render Markdown -> write to vault. `parseArgs` supports `--date`, `--project`, `--dry-run`, `--force`, `--config`, `--help`. |
| `src/config.ts` | Zod-validated `ObsidianSyncConfig` loader. Defaults: `notes_subfolder='DevNeural/Projects'`, `api_base_url='http://localhost:3747'`, `prepend_sessions=true`, `claude_model='claude-haiku-4-5-20251001'`. `checkApiKey()` enforces `ANTHROPIC_API_KEY`. |
| `src/types.ts` | Shared types: `ObsidianSyncConfig`, `LogEntry`, `ConnectionEvent`, `SessionData`, `GraphInsight`, `SessionSummary`. |
| `src/session/log-reader.ts` | Reads `<data_root>/logs/<date>.jsonl`, returns `SessionData` (or null if no log). |
| `src/session/graph-reader.ts` | Reads `weights.json` (from `01-data-layer`) or queries `02-api-server`. Emits `GraphInsight[]` describing new connections, high-weight edges, weight milestones. |
| `src/summary/generator.ts` | Anthropic Haiku summarizer. Extracts tool names + file basenames from session log, prompts Claude for `what_i_worked_on` / `graph_insights` / `lessons_learned`. Returns placeholder text on failure. |
| `src/summary/renderer.ts` | Pure `renderSummary(summary)` -> Markdown block (`## Session: <date>`, `### What I worked on`, `### Graph insights`, lessons-learned). |
| `src/obsidian/writer.ts` | Filesystem writer into the vault. `deriveSlug(projectId)` produces a stable filename. Inserts new session content under `<!-- DEVNEURAL_SESSIONS_START -->` marker (prepend semantics). Exports `writeSessionEntry`, `resolveNotePath`. |
| `tests/*.test.ts` + `tests/fixtures/sample-weights.json` | Vitest coverage per module + an end-to-end integration test. |
| `config.example.json` | Template for the user's local `config.json`. |
| `spec.md`, `claude-spec.md`, `claude-plan.md`, `claude-plan-tdd.md`, `claude-research.md`, `claude-interview.md`, `claude-integration-notes.md`, `deep_plan_config.json` | Planning docs (deep-plan output). |
| `sections/section-0[1-8]-*.md` + `sections/.prompts/*` + `sections/index.md` | Per-section implementation plans (deep-plan section files). |
| `implementation/code_review/section-0[1-8]-{diff,interview}.md` | Per-section deep-implement code-review artifacts. Section 08 has only an interview, no diff. |
| `implementation/deep_implement_config.json` | Deep-implement runner config. |
| `reviews/iteration-1-opus.md` | Cross-LLM review notes. |

### External interfaces

- Reads: `<data_root>/logs/<date>.jsonl`, `<data_root>/weights.json` (via `01-data-layer`), optionally `02-api-server` graph endpoints (`api_base_url`, default `http://localhost:3747`).
- Writes: `<vault_path>/<notes_subfolder>/<slug>.md` (Obsidian vault).
- Anthropic API: `claude-haiku-4-5-20251001` via `@anthropic-ai/sdk`. Requires `ANTHROPIC_API_KEY`.
- No daemon-side surfacing; no schedule trigger; user runs the CLI manually (`npm run dev` -> `tsx src/generate-summary.ts`).

### What is NOT here

- No NotebookLM API client.
- No community-detection / Louvain clustering.
- No recommendation engine.
- No daemon route registers this package's CLI; nothing in `07-daemon` imports from `06-notebooklm-integration`.

---

## 03-web-app — Complete File Map

> Legacy first-pass DevNeural 3D orb visualization. Vite + Three.js single-page app. **Superseded by `08-dashboard`** (Next.js); the web-app's panes/handlers have been re-implemented under `08-dashboard/components/orb/` and friends. Kept on disk for reference and for the rendering math the dashboard still cribs from.

### Current state

- Standalone Vite dev server (`npm run dev`). Connects to the daemon WS at `ws://localhost:3747/ws` for live `connection:new` events plus snapshot rebroadcasts; runs an entirely client-side Three.js orb with bloom postprocessing, organic edge curves, and synaptic-pulse animations.
- Two parallel code trees coexist: `src/` (newer modular split) and `webview/` (older flat layout). The `src/main.ts` entry mixes both (`import ... from '../webview/...'`) — the webview tree is the source of truth for the rendering primitives (`renderer.ts`, `camera.ts`, `nodes.ts`, `edges.ts`, `orb.ts`, etc.) while `src/` adds the newer graph builder + physics + WS client wiring on top.
- Build script (`tsc && vite build`) still passes locally; the on-disk `dist/` is months-old (April 2026) and not refreshed.

### Source files (top-level + `src/`)

| Relative path | Purpose |
| ---            | ---     |
| `index.html` | Single page. Mounts `#devneural-canvas` and loads `/src/main.ts` as an ES module. Inline CSS for full-bleed canvas + a `#devneural-loading` placeholder. |
| `vite.config.ts`, `vitest.config.ts`, `tsconfig.json`, `package.json` | Standard Vite + Vitest config. Deps: `three@^0.183`, `three-forcegraph@^1.43`. |
| `src/main.ts` | Application bootstrap. Builds the scene, wires camera controller, voice, search, tooltip, raycasting, click/double-click handling, and the synaptic-pulse animation loop. Connects to `ws://localhost:3747/ws` and applies any pending snapshot. |
| `src/animationTick.ts` | Returns the per-frame callback for `startAnimationLoop`. Freezes physics/breathing in manual camera mode; camera tick always runs. |
| `src/types.ts` | `GraphNode`, `GraphEdge`, `GraphSnapshot`, `WsMessage` (snapshot + connection:new + voice events). |
| `src/graph/builder.ts` | Builds Three.js meshes for nodes (per-type material) and `Line2` edges with `LineGeometry`/`LineMaterial`. Exports `build`, `recomputeEdgeHeat`, `updateEdgeDrift`, `createEdgeMesh`, `getEdgeBaseColors`, `N_SEGMENTS`. |
| `src/graph/edge-curve.ts` | Deterministic seeded-random organic edge curves. `CURVE_SEGMENTS = 24`. |
| `src/graph/types.ts` | `NodeType` ('project' \| 'skill' \| 'tool'), `OrbNode`, `OrbEdge`, `SceneState`. |
| `src/orb/physics.ts` | Pure force-simulation (gravity + repulsion + spring) over `PhysicsNode`/`PhysicsEdge`. `createSimulation()` returns `{tick, reset, isCooled}`. |
| `src/orb/renderer.ts` | `initRenderer(canvas)` -> `{scene, camera, renderer, controls}` with OrbitControls. |
| `src/orb/visuals.ts` | Color/material tables per node type. `getMaterialForNode`, `getMaterialForNodeType`, `getEdgeColor`, `getEdgeOpacity`, `getEdgeLinewidth`. No `three` import so it's testable headless. |
| `src/orb/interaction.ts` | Hover/click selection state. `InteractionState`, `resetHoverState()`. |
| `src/ui/hud.ts` | Inline-CSS HUD overlay: status indicator, camera toggle, return-to-auto button, search input, voice button, legend. `initHud`, `setConnectionStatus`, `setCameraMode`, `updateVoiceStatus`. |
| `src/ws/client.ts` | Reconnecting WebSocket client (1s -> 30s exponential backoff). Holds a pending snapshot until the scene is ready. `connect(url, sceneRef, isReady)`. |
| `src/ws/handlers.ts` | Per-message dispatcher: `handleSnapshot`, `handleConnectionNew`, `handleVoiceFocus`, `handleVoiceHighlight`, `handleVoiceClear`. `SceneRef` interface (consumed by `main.ts`). |
| `tests/**` | Vitest specs for graph builder, edge curve, interaction, physics, renderer, visuals, ui/hud, ws/handlers. |

### Source files (`webview/`)

The flat-layout legacy tree. `src/main.ts` cross-imports from here.

| Relative path | Purpose |
| ---            | ---     |
| `webview/renderer.ts` | `createScene(canvas)` -> `{scene, camera, controls, startAnimationLoop}`. EffectComposer + UnrealBloomPass + OutputPass. `ORB_RADIUS = 60`. `addResizeListener`. |
| `webview/camera.ts` | `createCameraController(camera, controls, getNodePosition)`. Camera state machine: `'full-sphere' | 'single-focus' | 'multi-focus' | 'manual'`. `onActiveProjectsChanged`, `onUserInteraction`, `returnToAuto`, `focusOnCluster`, `tick(deltaMs)`. |
| `webview/animation.ts` | InstancedMesh animation helpers: glow, opacity, breathing. |
| `webview/edges.ts` | `Line2`/`LineGeometry`/`LineMaterial` edge primitives. Cool-to-warm gradient over the weight distribution. |
| `webview/hud.ts` | Older HUD definition (parallels `src/ui/hud.ts`). |
| `webview/nodes.ts` | InstancedMesh-based node rendering. Exports `nodeIndexMap` (`Map<id, {mesh, index}>`). |
| `webview/orb.ts` | `ThreeForceGraph`-based legacy orb wrapper. Imports `three-forcegraph`. |
| `webview/nodeActions.ts` | `createTooltip()` (DOM tooltip controller for project/skill/tool hovers), `deriveGitHubUrl(nodeId)` (project URL derivation for double-click open). |
| `webview/search.ts` | `detectVoiceIntent(transcript)` (regex over phrases like "zoom out", "show all"), `evaluateQuery(query, nodes, edges)`. |
| `webview/voice.ts` | Web Speech API wrapper. `VoiceStatus = 'unavailable' | 'idle' | 'listening' | 'error'`, `VoiceController`, `VoiceCallbacks`. |
| `webview/camera.ts` (CameraState type) | Used by both `src/ui/hud.ts` and `src/animationTick.ts`. |
| `webview/__tests__/*` | Vitest specs covering animation, animationTick, camera, edges, gap-coverage, hud, integration, nodeActions, nodes, search, voice. |

### External interfaces

- WebSocket: `ws://localhost:3747/ws` (daemon). Messages handled: snapshot, `connection:new`, `voice:focus`, `voice:highlight`, `voice:clear`.
- HTTP: none (the orb is push-only via WS; voice events going OUT use the browser's Web Speech API, not the daemon).
- Filesystem: none.
- Ports listened on: none (browser app).
- Hosting: Vite dev server on default port (5173) during `npm run dev`. Production build dumps static files into `dist/`.

### Why it's legacy

- All live orb work has moved to `08-dashboard/components/orb/` (Next.js). The dashboard reuses the same daemon WS contract.
- The HUD here was the single-pane prototype; the dashboard is the Phase Two multi-pane form factor (per memory `feedback_devneural_dashboard_form_factor.md`).
- No daemon module references this package. Treat changes here as throwaway unless explicitly resurrecting the standalone orb.

---

## 08-dashboard  -  Complete File Map

Next.js 15 app-router, static export. All paths absolute relative to `C:\dev\Projects\DevNeural\08-dashboard\`. Daemon is reached on same origin (Next rewrites in dev, daemon serves static export in prod). All `fetch()` calls go through `lib/daemon-client.ts` unless noted otherwise.

### app/  -  page routes

- `C:\dev\Projects\DevNeural\08-dashboard\app\layout.tsx`
  - Root layout. Loads Inter / Inter Tight / JetBrains Mono. Mounts `Providers` + `RegisterServiceWorker`.
  - Manifest: `/manifest.json`. Theme color `#0a0c10`.
- `C:\dev\Projects\DevNeural\08-dashboard\app\providers.tsx`
  - `Providers` (client). Wraps tree in `QueryClientProvider` + `VoiceClient` (mounted once at root so WS / mic / AudioContext survive nav).
- `C:\dev\Projects\DevNeural\08-dashboard\app\page.tsx`
  - `HomePage` (`/`). Renders `AppShell` + `KpiStrip` + `DailyBrief` + `ProjectsGrid` (compact) + `Orb` (compact, 280px) + `ReinforcementPanel` + `InstallPrompt`.
  - Daemon (indirect): `/dashboard/daily-brief`, `/stats/loc`, `/stats/kpi`, `/stats/curator-health`, `/stats/brainstorm-kpi`, `/stats/outbound`, `/projects`, `/projects/anchor-tiles`, `/sessions`, `/graph`, `/dashboard/reinforcement`.
- `C:\dev\Projects\DevNeural\08-dashboard\app\brainstorms\page.tsx`
  - `BrainstormsPage` (`/brainstorms`). `AppShell` + `BrainstormList` (kind=brainstorm).
- `C:\dev\Projects\DevNeural\08-dashboard\app\brainstorms\backfill-review\page.tsx`
  - `BackfillReviewPage` (`/brainstorms/backfill-review`). Borderline-band candidates one-click link / reject + run-backfill trigger.
  - Daemon: `listBackfillReview` (`GET /brainstorms/backfill-review`), `linkBackfillReview` (`POST .../link`), `rejectBackfillReview` (`POST .../reject`), `triggerBackfillBrainstorms` (`POST /admin/backfill/brainstorms`).
- `C:\dev\Projects\DevNeural\08-dashboard\app\brainstorms\detail\page.tsx`
  - `BrainstormDetailPage` (`/brainstorms/detail?id=`). Static shell + Suspense. Wraps `BrainstormDetailRoute`.
- `C:\dev\Projects\DevNeural\08-dashboard\app\brainstorms\detail\BrainstormDetailRoute.tsx`
  - Client-only inner. Reads `?id=` via `useSearchParams`. Renders `BrainstormDetail`.
- `C:\dev\Projects\DevNeural\08-dashboard\app\drafts\page.tsx`
  - `DraftsPage` (`/drafts`). Lists pending `wiki_drafts`; opens `DraftEditor` on row click.
  - Daemon: `listDrafts` (`GET /drafts?status=pending`).
- `C:\dev\Projects\DevNeural\08-dashboard\app\help\page.tsx`
  - `HelpPage` (`/help`). Fetches markdown sections from `/help/*.md` and renders via `MarkdownPanel`. Has client search filter.
  - Static asset fetches: `/help/voice-commands.md`, `/help/keyboard-shortcuts.md`, `/help/pages-overview.md`, `/help/workflows.md`, `/help/glossary.md`.
- `C:\dev\Projects\DevNeural\08-dashboard\app\lex\page.tsx`
  - `LexPage` (`/lex`). Manages live Lex PTY (cwd ending in `/brainstorm`), inject form (Ctrl+Enter), screenshot paste, transcript history, artifacts panel, terminal mirror.
  - Daemon: `listPtys` (`GET /pty`), `ptyInject` (`POST /pty/:id/inject`), `uploadScreenshot` (`POST /uploads/screenshot`), `lexAnchors` (`GET /lex/anchors`), `createLexAnchor` (`POST /lex/anchors`), `endLexAnchor` (`POST /lex/anchors/:id/end`).
  - Mounts `voice-panel-mount` portal target (VoiceClient portals full panel here).
- `C:\dev\Projects\DevNeural\08-dashboard\app\meetings\page.tsx`
  - `MeetingsPage` (`/meetings`). `AppShell` + `MeetingList`.
- `C:\dev\Projects\DevNeural\08-dashboard\app\meetings\detail\page.tsx`
  - `MeetingDetailPage` (`/meetings/detail?id=`). Static shell + Suspense. Wraps `MeetingDetailRoute`.
- `C:\dev\Projects\DevNeural\08-dashboard\app\meetings\detail\MeetingDetailRoute.tsx`
  - Client inner. Reads `?id=`; renders `MeetingDetail`.
- `C:\dev\Projects\DevNeural\08-dashboard\app\orb\page.tsx`
  - `OrbPage` (`/orb`). Full-viewport `UnifiedOrb` (from `src\orb\`).
- `C:\dev\Projects\DevNeural\08-dashboard\app\projects\page.tsx`
  - `ProjectsPage` (`/projects`). `AppShell` + `ProjectsGrid` + `NewProjectModal` (on click).
- `C:\dev\Projects\DevNeural\08-dashboard\app\reminders\page.tsx`
  - `RemindersPage` (`/reminders`). `AppShell` + `RemindersPanel`.
- `C:\dev\Projects\DevNeural\08-dashboard\app\sessions\page.tsx`
  - `SessionsPage` (`/sessions`). `AppShell` + `SessionsTable` + `NewProjectModal` (on click).
- `C:\dev\Projects\DevNeural\08-dashboard\app\sessions\detail\page.tsx`
  - `SessionDetailPage` (`/sessions/detail?id=&q=`). Static shell + Suspense. Wraps `SessionDetailRoute`.
- `C:\dev\Projects\DevNeural\08-dashboard\app\sessions\detail\SessionDetailRoute.tsx`
  - Client inner. Reads `?id=` + optional `?q=` (search query). Renders `TerminalMirror` + `SendPromptForm` + `SessionDetail` + `RelatedReferences` (when q set).
- `C:\dev\Projects\DevNeural\08-dashboard\app\settings\page.tsx`
  - `SettingsPage` (`/settings`). `AppShell` + `VoiceSettingsPanel`.
- `C:\dev\Projects\DevNeural\08-dashboard\app\system\page.tsx`
  - `SystemPage` (`/system`). Stacks `SystemPanel`, `PauseModeToggle`, `VoiceDiagnosticsPanel`, `LexColdStartPreloadPanel`, `PanicAuditPanel`, `SmartCompactPanel`, `SmartCompactAuditPanel`, `AutoAdvanceModePanel`, `LintFindingsPanel`.
- `C:\dev\Projects\DevNeural\08-dashboard\app\wiki\page.tsx`
  - `WikiPage` (`/wiki`). `WikiSearch` (Suspense-wrapped, reads `useSearchParams`) + `ReferenceList` + `UploadModal`.

### components/  -  UI components

- `AppShell.tsx:12`  -  `AppShell`. Page chrome: `TopBar` + `StreamDeck` + main + `RightRail` + `VitalsRibbon` + `CommandPalette` + `LexEasterEgg` + mobile tab bar. No daemon calls.
- `AudioPlayer.tsx:26`  -  `AudioPlayer`. Brainstorm audio playback with cue jumps. No daemon calls.
- `AutoAdvanceModePanel.tsx:63`  -  `AutoAdvanceModePanel`. Off/shadow/live mode selector + recent decisions feed. Daemon: `autoAdvanceToggle` (`GET /lex/auto-advance/toggle`), `setAutoAdvanceToggle` (`POST /lex/auto-advance/toggle`), `recentAutoAdvance` (`GET /lex/auto-advance/recent`).
- `BackfillPanel.tsx:193`  -  `BackfillPanel`. Raw/wiki backfill start/cancel/status. Daemon: `backfillStatus` (`GET /admin/backfill/status`), `backfillStart` (`POST /admin/backfill/{raw|wiki}`), `backfillCancel` (`POST /admin/backfill/{mode}/cancel`).
- `BrainstormDetail.tsx:25`  -  `BrainstormDetail({id})`. Brainstorm transcript + audio cues + artifacts + supervises-picker. Daemon: `getBrainstormApi`, `getBrainstormCuesApi`, `getBrainstormChunksApi`, `lexAnchor`, `lexSessionArtifacts`, `patchLexAnchor`.
- `BrainstormList.tsx:24`  -  `BrainstormList({initialKind})`. Daemon: `listBrainstormsApi` (`GET /brainstorms?kind=...`).
- `CommandPalette.tsx:17`  -  `CommandPalette`. Cmd-K palette. Listens for `open-cmdk` event. Daemon: `searchAll` (`POST /search/all`), `sessions` (`GET /sessions`).
- `DailyBrief.tsx:94`  -  `DailyBrief`. Header digest + whats-new markdown. Daemon: `dailyBrief` (`GET /dashboard/daily-brief`).
- `DiagnosticsPanel.tsx:36`  -  `DiagnosticsPanel`. Store / LLM / embedder / lint queue stats. Daemon: `diagnostics` (`GET /dashboard/diagnostics`).
- `DraftEditor.tsx:31`  -  `DraftEditor({draft,onClose})`. Modal edit/promote/discard for a wiki draft. Daemon: `patchDraft` (`PATCH /drafts/:id`), `promoteDraft` (`POST /drafts/:id/promote`), `discardDraft` (`POST /drafts/:id/discard`).
- `Icon.tsx:19`  -  `Icon({name,size,...})`. Lucide-react wrapper. No daemon calls.
- `InjectionRow.tsx:32`  -  `InjectionRow`. One curator injection row with "mark wrong" action. Daemon: `curatorWrong` (`POST /curator/wrong`).
- `InstallPrompt.tsx:31`  -  `InstallPrompt`. PWA `beforeinstallprompt` capture + button. No daemon.
- `KpiStrip.tsx:146`  -  `KpiStrip`. Composite KPI rows + sub-cards (`CuratorHealthCard`, `BrainstormKpiTiles`, `OutboundCard`). Daemon: `statsLoc` (`GET /stats/loc`), `statsKpi` (`GET /stats/kpi`).
- `LexArtifactsPanel.tsx:144`  -  `LexArtifactsPanel({brainstormId,active})`. Lists Lex artifacts for current session. Daemon: `lexSessionArtifacts` (`GET /lex/sessions/:id/artifacts`), `lexArtifact` (`GET /lex/artifacts/:kind/:id`).
- `LexColdStartPreloadPanel.tsx:162`  -  `LexColdStartPreloadPanel`. Off/shadow/live toggle + recent preload events + injection log. Daemon: `coldStartPreloadToggle`, `setColdStartPreloadToggle`, `coldStartPreloadEvents`, `injectionLog`.
- `LexEasterEgg.tsx:24`  -  `LexEasterEgg`. Konami code listener. No daemon. Pulls `lib\lex` `secret_panel` quip.
- `LexSessionList.tsx:65`  -  `LexSessionList`. Past anchors list with collapse toggle. Daemon: `lexAnchors` (`GET /lex/anchors`), `patchLexAnchor`, `createLexAnchor`, `openLexAnchor`, `endLexAnchor`. Exports `PAST_SESSIONS_COLLAPSE_KEY = "devneural.lex.past-sessions.collapsed"`.
- `LexThumbs.tsx:17`  -  `LexThumbs({turn_id,prompt_version,brainstorm_id})`. Up/down feedback per Lex turn. Daemon: `lexFeedback` (`POST /lex/feedback`).
- `LexTranscriptHistoryPanel.tsx:27`  -  `LexTranscriptHistoryPanel`. Subscribes to `transcript-bus` events, renders rolling turn history. No daemon calls (event-bus driven).
- `LintFindingsPanel.tsx:43`  -  `LintFindingsPanel`. Audit findings + ack/resolve/dismiss + trigger lint / self-audit. Daemon: `listAuditFindings`, `updateAuditFinding`, `triggerLintNow`, `triggerSelfAudit`.
- `LogTail.tsx:25`  -  `LogTail`. Tails daemon log with filter. Daemon: `logTail` (`GET /dashboard/log-tail`).
- `MarkdownPanel.tsx:25`  -  `MarkdownPanel({markdown})`. Minimal markdown renderer. No daemon.
- `MeetingDetail.tsx:23`  -  `MeetingDetail({id})`. Meeting consent ack, action items, keep-audio, promote-to-wiki. Daemon: `getMeeting`, `consentAckMeeting`, `setMeetingKeepAudio`, `addMeetingActionItem`, `updateMeetingActionItem`, `promoteMeetingToWiki`.
- `MeetingList.tsx:14`  -  `MeetingList`. Daemon: `listMeetings` (`GET /meetings`).
- `NavGrid.tsx:88`  -  `NavGrid({sessionId,projectLabel,onClose})`. Arrow-key 3x3 nav grid that POSTs `sendSessionKey` to daemon. Daemon: `sendSessionKey` (`POST /sessions/:id/key`).
- `NewProjectModal.tsx:14`  -  `NewProjectModal({onClose})`. Daemon: `createProject` (`POST /projects/new`).
- `Orb.tsx:127`  -  `Orb({compact})`. Force-directed wiki-only graph. Daemon: `graph` (`GET /graph`). Wraps `OrbCanvas`.
- `OrbCanvas.tsx`  -  `forwardRef` wrapper around `react-force-graph-2d` exposing `zoomToFit`/`d3Force`/`centerAt`. Client-only.
- `PanicAuditPanel.tsx:32`  -  `PanicAuditPanel`. Recent panic-button fires. Daemon: `recentPanics` (`GET /panic/recent`).
- `PanicButton.tsx:36`  -  `PanicButton`. Big red button. Daemon: `firePanic` (`POST /panic`).
- `PauseModeToggle.tsx:21`  -  `PauseModeToggle`. Persists `pause_mode` in runtime config. Daemon: `listRuntimeConfig` (`GET /runtime-config`), `setRuntimeConfig` (`POST /runtime-config/:key`).
- `ProjectsGrid.tsx:38`  -  `ProjectsGrid({compact,limit})`. Project tiles with session counts + anchor tiles. Daemon: `projects` (`GET /projects`), `sessions` (`GET /sessions`), `listProjectAnchorTiles` (`GET /projects/anchor-tiles`).
- `PushSubscribeButton.tsx:41`  -  `PushSubscribeButton`. Web Push subscribe. Daemon: `vapidPublicKey` (`GET /push/vapid-public-key`), `subscribePush` (`POST /push/subscribe`).
- `ReferenceList.tsx:19`  -  `ReferenceList`. Daemon: `referenceDocs` (`GET /reference`).
- `RegisterServiceWorker.tsx:5`  -  `RegisterServiceWorker`. Registers `/sw.js`. No daemon.
- `ReinforcementPanel.tsx:64`  -  `ReinforcementPanel`. Recent reinforcement events. Daemon: `reinforcement` (`GET /dashboard/reinforcement`).
- `RelatedReferences.tsx:35`  -  `RelatedReferences({query})`. Daemon: `searchAll` (`POST /search/all`, collection=`reference_chunk`).
- `RemindersPanel.tsx:14`  -  `RemindersPanel`. Daemon: `reminders`, `createReminder`, `completeReminder`, `deleteReminder` on `/reminders` + `/reminders/:id`.
- `RightRail.tsx:20`  -  `RightRail`. Reminders + activity (notifications) feed + correction button. Daemon: `reminders`, `notifications` (`GET /notifications`), `completeReminder`, `dismissNotification` (`POST /notifications/:id/dismiss`), `correctWikiPage` (`POST /admin/wiki/correct/:id`).
- `SendPromptForm.tsx:18`  -  `SendPromptForm({sessionId})`. Inject prompt into a CC session. Daemon: `queuePrompt` (`POST /sessions/:id/prompt`), `focusSession` (`POST /sessions/:id/focus`), `bridgeStatus` (`GET /dashboard/bridge-status`), `uploadScreenshot`.
- `SessionDetail.tsx:70`  -  `SessionDetail({sessionId,query})`. Daemon: `sessionDetail` (`GET /sessions/:id`), `queuePrompt`, `clearPendingPrompt` (`DELETE /sessions/:id/pending-prompt`).
- `SessionsTable.tsx:19`  -  `SessionsTable`. Daemon: `sessions`, `startClaude` (`POST /projects/:id/start-claude`).
- `SmartCompactAuditPanel.tsx:52`  -  `SmartCompactAuditPanel`. Recent smart-compact events. Daemon: `recentSmartCompacts` (`GET /lex/smart-compact/recent`).
- `SmartCompactPanel.tsx:55`  -  `SmartCompactPanel`. Off/shadow/live selector. Daemon: `smartCompactToggle` (`GET /lex/smart-compact/toggle`), `setSmartCompactToggle` (`POST /lex/smart-compact/toggle`).
- `StatusDot.tsx:18`  -  `StatusDot`. Visual indicator. No daemon.
- `StreamDeck.tsx:84`  -  `StreamDeck`. Sidebar tiles of live sessions + Lex anchors. Daemon: `sessions`, `lexAnchorTiles` (`GET /lex/anchor-tiles`), `focusSession`.
- `SupervisesPicker.tsx:36`  -  `SupervisesPicker`. Picks project anchor a brainstorm supervises. Daemon: `listProjectAnchorTiles`.
- `SupervisionModeToggle.tsx:70`  -  `SupervisionModeToggle({anchorId,mode,...})`. polling/event/off mode flip. Daemon: `patchProjectAnchor` (`PATCH /projects/:id`).
- `SystemPanel.tsx:200`  -  `SystemPanel`. System metrics + services + daemon restart + clear local storage. Daemon: `systemMetrics` (`GET /dashboard/system-metrics`), `services` (`GET /services`), `daemonRestart` (`POST /admin/daemon/restart`), `fetch("/health")` direct. Calls `localStorage.clear()` + `sessionStorage.clear()` on reset.
- `TerminalMirror.tsx:300`  -  `TerminalMirror({sessionId})`. xterm.js mirror. Daemon: `sessions`, `listPtys`, `fetch("/dashboard/bridge-status")`. WebSocket: `/sessions/:id/terminal-ws`.
- `TopBar.tsx:46`  -  `TopBar({activeTab})`. App-bar with tabs, search trigger, notifications bell, voice pill, panic. Daemon: `dashboardHealth` (`GET /dashboard/health`), `notifications` (`?surface=bell`), `dismissNotification` (`scope=bell`).
- `TranscriptHistory.tsx:43`  -  `TranscriptHistory`. Capped turn list with collapse toggle. Uses `lib\transcript-collapse` (key `devneural.lex.transcript.collapsed`).
- `UploadModal.tsx:13`  -  `UploadModal({onClose,onUploaded})`. Daemon: `uploadReference` (`POST /upload`).
- `VitalsRibbon.tsx:14`  -  `VitalsRibbon`. Bottom strip CPU/mem/services. Daemon: `systemMetrics`, `services`.
- `VoiceClient.tsx:287`  -  `VoiceClient({children})`. Root voice provider. Manages mic / VAD / WS / TTS / wake-word / watchdog. Mounted once at `Providers`. Portals full pill into `#voice-panel-mount` on `/lex`. Daemon: `listPtys` (filters for `/brainstorm` cwd), `fetch("/voice/whisper-prewarm")`, `fetch("/voice/piper-status")`, `fetch("/voice/set-speed")`, `fetch("/voice/set-vad-redemption")`, `fetch("/voice/set-voice")`. WebSocket: `/voice/lex-ws` (binary).
  - localStorage keys: `lex-tts-speed`, `lex-barge-cooldown-ms`, `lex-vad-sensitivity`, `lex-mic-gain`, `lex-vad-redemption-ms`.
  - Exports: `useVoice`, `VoiceClient`, `VoicePillView`, `VoiceTopBarPill`.
- `VoiceDiagnosticsPanel.tsx:62`  -  `VoiceDiagnosticsPanel`. Voice ring-buffer + health log. Uses `lib\voice-log` `getVoiceLog`, `fetchVoiceHealth` (`GET /dashboard/voice-health`).
- `VoiceErrorPill.tsx:29`  -  `VoiceErrorPill`. Inline voice error w/ retry. No daemon calls.
- `VoiceSettingsPanel.tsx:39`  -  `VoiceSettingsPanel`. Sliders for VAD, mic gain, barge cooldown. Daemon: `fetch("/voice/piper-status")`, `fetch("/voice/set-vad-sensitivity")`, `fetch("/voice/set-mic-gain")`, `fetch("/voice/set-barge-cooldown")`. localStorage: `lex-barge-cooldown-ms`, `lex-vad-sensitivity`, `lex-mic-gain`. Emits via `voice-settings-bus`.
- `WikiPageModal.tsx:49`  -  `WikiPageModal({id,onClose})`. Daemon: `wikiPage` (`GET /wiki/page/:id`), `searchAll`.
- `WikiSearch.tsx:63`  -  `WikiSearch`. Daemon: `searchAll` (`POST /search/all`).

#### components/kpi/

- `kpi\BrainstormKpiTiles.tsx:67`  -  `BrainstormKpiTiles`. Daemon: `statsBrainstormKpi` (`GET /stats/brainstorm-kpi`).
- `kpi\CuratorHealthCard.tsx:87`  -  `CuratorHealthCard`. Daemon: `statsCuratorHealth` (`GET /stats/curator-health`).
- `kpi\OutboundCard.tsx:32`  -  `OutboundCard`. Daemon: `statsOutbound` (`GET /stats/outbound`).

### lib/  -  helpers

- `lib\daemon-client.ts`  -  Thin daemon API client. ~70 typed endpoints. Single `request()` helper handles JSON / FormData, `credentials: include`, JSON-mismatch guards. Exports: `DaemonError` plus typed types and functions for `dashboardHealth`, `dailyBrief`, `reinforcement`, `systemMetrics`, `logTail`, `diagnostics`, `backfillStatus`/`Start`/`Cancel`, `daemonRestart`, `services`, `sessions`, `startClaude`, `listPtys`, `ptyInject`, `ptyKill`, `statsLoc`, `statsKpi`, `statsCuratorHealth`, `statsBrainstormKpi`, `statsOutbound`, `lexAnchors`/`lexAnchor`/`createLexAnchor`/`openLexAnchor`/`patchLexAnchor`/`endLexAnchor`/`deleteLexAnchor`/`lexAnchorTiles`, `listBrainstormsApi`/`getBrainstormApi`/`getBrainstormCuesApi`/`getBrainstormChunksApi`, `listBackfillReview`/`linkBackfillReview`/`rejectBackfillReview`, `listAuditFindings`/`updateAuditFinding`/`triggerLintNow`/`triggerSelfAudit`/`curatorWrong`, `listRuntimeConfig`/`setRuntimeConfig`, `listMeetings`/`getMeeting`/`consentAckMeeting`/`setMeetingKeepAudio`/`addMeetingActionItem`/`updateMeetingActionItem`/`promoteMeetingToWiki`, `lexFeedback`, `listLexPromptVersions`, `lexAwarenessRecent`, `triggerLexReplay`, `triggerBackfillBrainstorms`, `listDrafts`/`getDraft`/`patchDraft`/`discardDraft`/`promoteDraft`, `lexSessionArtifacts`/`lexArtifact`, `sessionDetail`, `bridgeStatus`, `queuePrompt`, `focusSession`, `clearPendingPrompt`, `uploadScreenshot`, `sendSessionKey`, `searchAll`, `reminders`/`createReminder`/`completeReminder`/`deleteReminder`, `notifications`/`dismissNotification`, `correctWikiPage`, `projects`/`createProject`, `graph`, `graphUnified`, `wikiPage`, `vapidPublicKey`/`subscribePush`/`unsubscribePush`, `referenceDocs`, `firePanic`/`fireProjectInterrupt`/`recentPanics`, `patchProjectAnchor`/`listProjectAnchorTiles`, `recentSmartCompacts`, `autoAdvanceToggle`/`setAutoAdvanceToggle`/`recentAutoAdvance`, `smartCompactToggle`/`setSmartCompactToggle`, `coldStartPreloadToggle`/`setColdStartPreloadToggle`/`coldStartPreloadEvents`/`injectionLog`, `uploadReference`.
- `lib\lex.ts`  -  Lex personality kit. Exports: `LexCategory`, `lexPickStable(cat,key)`, `lexPick(cat)`, `lexMotd()`, `KONAMI`, `isKonami(buf)`. No daemon.
- `lib\platform-mod-key.ts`  -  Cmd vs Ctrl resolver. Exports: `ModKey`, `pickModKey`, `pickModKeyStrict`, `resolveModKey()` (hard-coded to `Ctrl` for Windows-only build).
- `lib\session-helpers.ts`  -  Exports: `projectFromSlug(slug)`, `relTime(ms)`, `sessionsByProject(list)`.
- `lib\terminal-auto-scroll.ts`  -  Terminal mirror auto-scroll state machine. Exports: `DEFAULT_RESUME_MS=4000`, `createAutoScrollController(opts)`.
- `lib\transcript-bus.ts`  -  DOM CustomEvent bus for Lex transcript turns. Events: `lex:transcript-turn`, `lex:transcript-status`, `lex:transcript-clear`. Exports: `emitTranscriptTurn`/`Status`/`Clear`, `onTranscriptTurn`/`Status`/`Clear`, types `TranscriptTurn`, `TranscriptStatus`.
- `lib\transcript-collapse.ts`  -  localStorage helpers for collapse-toggle panels. Exports: `createCollapseStore(key)`, `COLLAPSED_STORAGE_KEY = "devneural.lex.transcript.collapsed"`, `readCollapsedState`, `writeCollapsedState`.
- `lib\voice-audio-warm.ts`  -  AudioContext warm helper. Exports: `warmAudioContext(opts)`.
- `lib\voice-log.ts`  -  Voice ring buffer. Exports: `VOICE_LOG_CAP=100`, `logVoice(kind,msg,...)`, `getVoiceLog()`, `computeReconnectBackoffMs(attempt)`, `VOICE_LOG_EVENT_NAME`. Hangs ring buffer on `window.__lexVoiceLog`.
- `lib\voice-ort-config.ts`  -  Configures `onnxruntime-web` for `@ricky0123/vad-web`. Exports: `VAD_WASM_PATHS='/vad/'`, `VAD_NUM_THREADS`, `VAD_SIMD`, `VAD_PROXY`, `configureVadOrt`, `getVadModule()`, `resetVadModuleCache()`, `isVadModuleConfigured()`.
- `lib\voice-settings-bus.ts`  -  Same-window CustomEvent channel for voice setting updates. Event: `lex:voice-settings-update`. Exports: `emitVoiceSettingUpdate`, `onVoiceSettingUpdate`, types.
- `lib\voice-wake-word.ts`  -  Client wake-word matcher. Exports: `matchWakeWord(text)`, `createDedupe(windowMs=1500)`, `getSpeechRecognitionCtor()`, `processWakeResults(event,opts)`, types `VoiceCommandKind`, `SpeechRecognitionLike`, etc.
- `lib\voice-watchdog.ts`  -  TTS / AudioContext watchdog. Exports: `FRAME_TIMEOUT_MS=30000`, `BUFFER_STALL_MS=10000`, `runWatchdogChecks(state,nowMs)`, `postVoiceHealth(events)` (POST `/dashboard/voice-health`), `fetchVoiceHealth(limit)` (GET `/dashboard/voice-health`).
- `lib\wake-log.ts`  -  Wake-word ring buffer. Exports: `WAKE_LOG_CAP=20`, `logWake(msg,data)`. Hangs ring buffer on `window.__lexWakeLog`.

### src/  -  newer panels (Lane B / orb v2)

- `src\orb\UnifiedOrb.tsx`  -  `UnifiedOrb`. Force-directed graph for brainstorm + wiki + project + meeting nodes. Daemon: `graphUnified` (`GET /graph/unified`). Wraps shared `OrbCanvas`.
- `src\orb\SidePanel.tsx`  -  `SidePanel({node,...})`. Connection list with click-to-jump to `/wiki?page=`, `/brainstorms/detail?id=`, `/meetings/detail?id=`, `/projects`.
- `src\orb\FilterChips.tsx`  -  `FilterChips({filters,onChange})`. Brainstorm/wiki/project/meeting toggle chips.
- `src\orb\colors.ts`  -  Canvas color constants (`COLOR_BRAINSTORM`, `COLOR_MEETING`, `COLOR_PROJECT`, `COLOR_WIKI_*`, glow rgb tuples, helpers `nodeColor`/`nodeGlowRgb`/`edgeStrokeColor`).
- `src\orb\types.ts`  -  Shared orb types (`UnifiedNodeKind`, `UnifiedEdgeKind`, `WikiStatus`, `UnifiedGraphNode`, `UnifiedGraphEdge`, `ForceUnifiedNode`, `ForceUnifiedLink`).
- `src\system\JanitorApprovalsPanel.tsx`  -  Janitor audit findings (open + source=janitor). Direct fetch: `GET /audit-findings?source=janitor&status=open`.
- `src\system\RetrievalTracePanel.tsx`  -  Retrieval trace timeline. Direct fetch: `GET /lex/retrieval-trace`.

### tests/  -  vitest

- `tests\LexSessionList.test.tsx`  -  Capped scroll height + collapse-toggle localStorage persistence pins.
- `tests\SmartCompactAuditPanel.test.tsx`  -  Empty state, tone-coded actions, payload expand toggle.
- `tests\SmartCompactPanel.test.tsx`  -  Three-segment selector renders + optimistic flip + footer reflects toggle response.
- `tests\SupervisionModeToggle.test.tsx`  -  Three-mode buttons render, aria-pressed tracks mode, click flip + rollback on rejection.
- `tests\TranscriptHistory.test.tsx`  -  Renders last N turns, "Lex is thinking..." placeholder, collapse persists to localStorage.
- `tests\VoicePillView.test.tsx`  -  Mic + speaker icon taps fire mute setters; mute icons swap; unread-silent badge appears.
- `tests\daemon-client-toggle-bodies.test.ts`  -  Pins POST body shape for Smart Compact / Cold Start Preload toggles (regression: no double-stringify).
- `tests\platform-mod-key.test.ts`  -  Pure helper pins for mac vs non-mac across UA-CH + legacy `navigator.platform`.
- `tests\terminal-auto-scroll.test.ts`  -  Auto-scroll state machine transitions (follow, scroll-up arms timer, resume fires `scrollToBottom`, dispose cancels).
- `tests\vad-tap-worklet.test.ts`  -  Asserts VAD parallel-capture migrated off `ScriptProcessorNode` to `AudioWorkletNode`.
- `tests\voice-audio-warm.test.ts`  -  `warmAudioContext` creates + resumes + plays silent frame inside gesture (first-reply-silent regression).
- `tests\voice-log.test.ts`  -  Ring buffer push/cap/event + exponential backoff schedule for WS reconnect.
- `tests\voice-mic-init.test.tsx`  -  ORT pin reaches the right module record; error pill shows full text (no truncate).
- `tests\voice-wake-word.test.ts`  -  Match precedence (mute > disable), case insensitivity, dedupe blocks same-kind re-fire.

### public/  -  static assets

- `public\manifest.json`  -  PWA manifest. `start_url=/`, theme `#0a0c10`, icons 192/512.
- `public\sw.js`  -  Service worker. `SW_VERSION` token rewritten post-build by `scripts\postbuild-sw-version.mjs`. Push handler (`reminder` + `attention` event types).
- `public\icons\icon-192.png`, `public\icons\icon-512.png`  -  PWA icons.
- `public\help\*.md`  -  Help markdown: `glossary.md`, `keyboard-shortcuts.md`, `pages-overview.md`, `voice-commands.md`, `workflows.md`. Fetched by `/help` page.
- `public\vad-tap.worklet.js`  -  AudioWorkletProcessor for VAD parallel capture tap.
- `public\vad\`  -  ONNX Runtime Web WASM bundle + Silero VAD models (`silero_vad_v5.onnx`, `silero_vad_legacy.onnx`, `vad.worklet.bundle.min.js`, full `ort.*.mjs` matrix for wasm / webgpu / webgl / jspi / asyncify / threaded variants).

### Page routes table

| URL | File | Daemon endpoints |
|---|---|---|
| `/` | `app\page.tsx` | `/dashboard/daily-brief`, `/stats/loc`, `/stats/kpi`, `/stats/curator-health`, `/stats/brainstorm-kpi`, `/stats/outbound`, `/projects`, `/projects/anchor-tiles`, `/sessions`, `/graph`, `/dashboard/reinforcement` |
| `/brainstorms` | `app\brainstorms\page.tsx` | `/brainstorms` |
| `/brainstorms/backfill-review` | `app\brainstorms\backfill-review\page.tsx` | `/brainstorms/backfill-review`, `/admin/backfill/brainstorms` |
| `/brainstorms/detail?id=` | `app\brainstorms\detail\page.tsx` | `/brainstorms/:id`, `/brainstorms/:id/cues`, `/brainstorms/:id/chunks`, `/lex/anchors/:id`, `/lex/sessions/:id/artifacts`, `/lex/anchors/:id` (PATCH) |
| `/drafts` | `app\drafts\page.tsx` | `/drafts`, `/drafts/:id` (PATCH/promote/discard) |
| `/help` | `app\help\page.tsx` | none (static `/help/*.md`) |
| `/lex` | `app\lex\page.tsx` | `/pty`, `/pty/:id/inject`, `/uploads/screenshot`, `/lex/anchors`, `/lex/anchors/:id/end`, `/lex/sessions/:id/artifacts`, `/voice/lex-ws` (WS) |
| `/meetings` | `app\meetings\page.tsx` | `/meetings` |
| `/meetings/detail?id=` | `app\meetings\detail\page.tsx` | `/meetings/:id`, `/meetings/:id/consent-ack`, `/meetings/:id/keep-audio`, `/meetings/:id/action-items`, `/meetings/:id/promote-to-wiki` |
| `/orb` | `app\orb\page.tsx` | `/graph/unified` |
| `/projects` | `app\projects\page.tsx` | `/projects`, `/sessions`, `/projects/anchor-tiles`, `/projects/new` |
| `/reminders` | `app\reminders\page.tsx` | `/reminders` (GET/POST), `/reminders/:id` (PATCH/DELETE), `/push/vapid-public-key`, `/push/subscribe` |
| `/sessions` | `app\sessions\page.tsx` | `/sessions`, `/projects/:id/start-claude`, `/projects/new` |
| `/sessions/detail?id=&q=` | `app\sessions\detail\page.tsx` | `/sessions/:id`, `/sessions/:id/prompt`, `/sessions/:id/focus`, `/sessions/:id/pending-prompt` (DELETE), `/sessions/:id/terminal-ws` (WS), `/sessions/:id/key`, `/dashboard/bridge-status`, `/uploads/screenshot`, `/search/all` |
| `/settings` | `app\settings\page.tsx` | `/voice/piper-status`, `/voice/set-vad-sensitivity`, `/voice/set-mic-gain`, `/voice/set-barge-cooldown` |
| `/system` | `app\system\page.tsx` | `/dashboard/system-metrics`, `/services`, `/health`, `/admin/daemon/restart`, `/runtime-config`, `/runtime-config/:key`, `/dashboard/voice-health`, `/lex/cold-start-preload/toggle`, `/lex/cold-start-preload/events`, `/lex/injection-log`, `/panic/recent`, `/lex/smart-compact/toggle`, `/lex/smart-compact/recent`, `/lex/auto-advance/toggle`, `/lex/auto-advance/recent`, `/audit-findings`, `/audit-findings/:id/:action`, `/admin/lint/run`, `/admin/self-audit/run` |
| `/wiki` | `app\wiki\page.tsx` | `/search/all`, `/wiki/page/:id`, `/reference`, `/upload` |

`AppShell` is on every page above and adds: `/dashboard/health`, `/notifications`, `/notifications/:id/dismiss`, `/reminders`, `/admin/wiki/correct/:id` via TopBar + RightRail + StreamDeck + VitalsRibbon + CommandPalette.

### localStorage keys table

| Key | Owner | Purpose |
|---|---|---|
| `devneural.lex.transcript.collapsed` | `lib\transcript-collapse.ts:52` (consumed by `TranscriptHistory.tsx`) | Lex transcript history panel collapsed flag |
| `devneural.lex.past-sessions.collapsed` | `components\LexSessionList.tsx:23` | Past sessions list collapsed flag |
| `lex-tts-speed` | `components\VoiceClient.tsx:184` | TTS playback speed (0.5..2.0) |
| `lex-barge-cooldown-ms` | `components\VoiceClient.tsx:194` + `VoiceSettingsPanel.tsx:7` | Barge-in cooldown ms |
| `lex-vad-sensitivity` | `components\VoiceClient.tsx:204` + `VoiceSettingsPanel.tsx:13` | VAD positive-speech threshold |
| `lex-mic-gain` | `components\VoiceClient.tsx:213` + `VoiceSettingsPanel.tsx:19` | Mic input gain multiplier |
| `lex-vad-redemption-ms` | `components\VoiceClient.tsx:226` | VAD redemption frames (ms) |

sessionStorage: only used as `sessionStorage.clear()` in `SystemPanel.tsx:392` reset path; no keys written.

### WebSocket endpoints table

| WS URL | File:line | Purpose | Binary? |
|---|---|---|---|
| `/sessions/:id/terminal-ws` | `components\TerminalMirror.tsx:663` | xterm.js mirror of a CC PTY's output stream | yes (arraybuffer) |
| `/voice/lex-ws` | `components\VoiceClient.tsx:1638` | Voice WS: mic frames up, PCM TTS frames down, transcript / status JSON | yes (arraybuffer) |

---

## 07-daemon — Complete File Map

Built from a full traversal of `07-daemon/src/` (130 .ts files, ~44.9k LOC) on 2026-05-22. Entry point is `daemon.ts`; runtime artifacts land under `C:/dev/data/skill-connections/` (DATA_ROOT, env `DEVNEURAL_DATA_ROOT`). Default HTTP bind `0.0.0.0:3747` (env `DEVNEURAL_PORT` / `DEVNEURAL_BIND`).

### Root

#### `daemon.ts`
- Purpose: Daemon entrypoint. Owns Fastify, watchers, schedulers, PTY host, shutdown.
- Key exports: `main()` (orchestrator); local `logger(msg)` writes to `daemon.log`.
- Routes registered inline: `GET /health`, `GET /projects`, `POST /search`, `POST /sync` (410 Gone), `POST /reseed`, `POST /curate`, `POST /summarize`, `POST /glossary`, `POST /decay`, `POST /lint`, `POST /whats-new`, `POST /flush`, `GET /page/:id`, `GET /glossary/:projectId`, `GET /session/:sessionId/summary`, `GET /session/:sessionId/task`, `POST /task`, `POST /ingest`. Static SPA fallback for `08-dashboard/out`.
- Singletons / side effects: `Store.open`, migrations, `VramMonitor`, `initGpuQueue`, bridge-presence loop, distillation-backfill scheduler, worker-event listener, heartbeat poster, raw-chunks cull cron, meeting-audio purge cron, self-audit cron, lint-nightly cron, reminder sweep cron, smart-compact scheduler, worker-stall watcher, memory-janitor cron, personality-guard watcher, brainstorm-jsonl-ingestor, dashboard-supervisor, prompt-archive backfill, transcript / fs / git watchers, decay interval, SIGUSR1 coalescer.
- Long timers: every interval listed in "Schedulers" table below.

#### `paths.ts`
- Purpose: All filesystem path helpers. Reads `DEVNEURAL_DATA_ROOT` (default `C:/dev/data/skill-connections`).
- Key exports: `DATA_ROOT`, `projectsRoot()`, `globalDir()`, `projectDir(id)`, `observationsFile`, `observationsArchive`, `projectMetaFile`, `transcriptsFile`, `signalCounterFile`, `lastPurgeFile`, `projectsRegistry()`, `daemonPidFile()`, `daemonLockDir()`, `daemonLogFile()`, `daemonSocketFile()`, `wikiRoot/PagesDir/PendingDir/ArchiveDir/SchemaFile/IndexFile/LogFile/WhatsNewFile`, `wikiGlossaryDir/File`, `sessionStateDir`, `sessionSummaryFile/TaskFile/MetaFile`, `lexPromptsRoot/VersionsDir/FewShotDir/FewShotFile`, `lexRefusalContractFile`, `lexRefusalContractMeetingFile`, `lexReplayRoot`, `brainstormsRoot/Dir/AudioDir/AudioFile/CuesFile`, `referenceRoot/QueueDir/DocsDir/ImagesDir/AudioDir/VideoDir`, `ensureDir`, `ensureProjectDir`, `ensureDataRoot`.

#### `types.ts`
- Purpose: Cross-module type definitions.
- Key exports: `Observation`, `ProjectIdentity`, `ProjectRegistryEntry`, `HookPayload`, `HookPhase`.

### `capture/` — hooks + watchers

#### `capture/fs-watcher.ts`
- Purpose: Chokidar watch over `C:/dev/Projects` (env `DEVNEURAL_FS_ROOT`); writes `Observation` rows.
- Exports: `startFsWatcher({ log })`.
- Side effects: persistent chokidar handle (recursive ReadDirectoryChangesW on Windows).

#### `capture/git-watcher.ts`
- Purpose: Polls registered projects for HEAD/branch changes (`DEVNEURAL_GIT_POLL_MS`, default 30s); writes observations.
- Exports: `startGitWatcher({ log })`.

#### `capture/observations.ts`
- Purpose: Append + rotate `observations.jsonl`; signal-counter bookkeeping.
- Exports: `appendObservation`, `bumpSignalCounter`, `purgeOldArchivesOncePerDay`.
- FS paths: `<projectDir>/observations.jsonl`, `.archive`, `.last-purge`, `.observer-signal-counter`.

#### `capture/secret-scrub.ts`
- Purpose: Regex scrub of API keys, tokens, passwords from observation text.
- Exports: `scrubSecrets(input)`, `scrubObject(value)`.

#### `capture/transcript-watcher.ts`
- Purpose: Tails CC jsonl under `~/.claude/projects/<slug>/<session>.jsonl`; persists each new turn into the project's `transcripts.jsonl` plus a raw_chunks row (embedded later).
- Exports: `ingestTranscriptFile`, `resetTranscriptOffset`, `startTranscriptWatcher`, types `TranscriptWatcher`, `WatcherOptions`.

#### `capture/hooks/hook-runner.ts`
- Purpose: Standalone CLI invoked by every CC hook (PreToolUse/PostToolUse/UserPromptSubmit/Stop/Notification/SessionStart). Resolves project identity, scrubs, appends observation, signals daemon every N events, lazy-spawns daemon.
- Always exits 0.

#### `capture/hooks/install-hooks.ts`
- Purpose: Idempotent registration of hook entries into `~/.claude/settings.json`, with VBS shim on Windows to suppress console flash.
- Reads/writes: `~/.claude/settings.json`.

### `cli/`

#### `cli/setup.ts`
- Purpose: `devneural-setup` one-command bootstrap: ensure data root, wiki scaffolding, ollama check, hook install.

#### `cli/status.ts`
- Purpose: `devneural-status`: prints PID, wiki health, hook presence; exits non-zero on issues.

### `corpus/`

#### `corpus/scan.ts`
- Purpose: Source scanners for first-boot corpus ingest.
- Exports: `scanSkills`, `scanProjects`, `scanCommits`, `scanSessions`, `ScanOptions`.
- Scans `~/.claude/skills/`, `C:/dev/Projects/<repo>/{README.md, CLAUDE.md, devneural.jsonc, OTLC-Brainstorm.MD}`, `~/.claude/projects/<slug>/<session>.jsonl`, last 6 months of git commits.

#### `corpus/seed.ts`
- Purpose: Drives initial corpus ingest with token-budget ceiling. Writes state to `<DATA_ROOT>/corpus-seed.state.json`.
- Exports: `runSeed`, `hasSeeded`, `SeedOptions`, `SeedResult`.

### `curation/`

#### `curation/curator.ts`
- Purpose: Composes UserPromptSubmit injection payload (wiki page summary + glossary + current-task + last-summary).
- Exports: `curate`, `shouldInject`, `blacklistPageForSession`, `clearSessionBlacklist`, `CurationInput`, `CurationOutput`.

#### `curation/current-task.ts`
- Purpose: Per-session current-task memory under `<DATA_ROOT>/session-state/<id>.task.md`.
- Exports: `updateCurrentTask`, `readCurrentTask`, `readCurrentTaskBody`.

#### `curation/glossary.ts`
- Purpose: Per-project glossary at `<wiki>/glossary/<projectId>.md`.
- Exports: `updateGlossary`, `readGlossary`, `writeGlossary`, `parseGlossary`, `matchTerms`, `GlossaryEntry`, `GlossaryUpdate`, `GlossaryResult`.

#### `curation/session-summarizer.ts`
- Purpose: Rolling per-session digest at `<DATA_ROOT>/session-state/<id>.summary.md`; meta at `.meta.json`.
- Exports: `updateSummary`, `shouldSummarize`, `loadMeta`, `readSummary`.

#### `curation/index.ts`
- Purpose: Barrel re-export of curator/summarizer/glossary/current-task.

### `dashboard/` (largest subsystem)

#### `dashboard/auth-secret.ts`
- Purpose: HMAC secret persistence at `<DATA_ROOT>/dashboard/auth.json` for cross-session inject token.
- Exports: `getAuthSecret`, `rotateAuthSecret`.

#### `dashboard/bridge-presence.ts`
- Purpose: Reconciles VS Code bridge presence files under `<bridgeDir>/.bridge-presence/*.json` into `project_session` anchor rows.
- Exports: `startBridgePresenceLoop`, `reconcileBridgePresence`, `decodeBridgeMarker`.
- Tunables: `DEVNEURAL_BRIDGE_PRESENCE_INTERVAL_MS` (1s), `DEVNEURAL_BRIDGE_TIMEOUT_MS` (30s).
- Tables: writes `project_session` (status, current_session_id, current_bridge_id, previous_session_id, last_seen_ms).

#### `dashboard/daily-brief.ts`
- Purpose: Home-page summary (project count, active sessions, whats-new freshness).
- Exports: `getDailyBrief`.

#### `dashboard/dashboard-supervisor.ts`
- Purpose: Owns `next dev` child for `08-dashboard/`. Toggle via runtime_config `dashboard_supervisor_enabled` or env `DEVNEURAL_DASHBOARD_SUPERVISOR`; CI=true forces off.
- Exports: `startDashboardSupervisor`, `DashboardSupervisorHandle`.

#### `dashboard/graph.ts`
- Purpose: Wiki graph builder for `/graph` endpoint (nodes + cross-ref edges).
- Exports: `buildGraph`, `GraphNode`, `GraphEdge`.

#### `dashboard/lex-attention.ts`
- Purpose: Real-time attention pushes (decision-shaped question detection, stall fires, custom).
- Exports: `fireForLexTurn`, `fireForStall`, `fireForCustom`, `detectAttentionInText`.
- Tunable: `DEVNEURAL_QUIET_HOURS` (default 22-08).

#### `dashboard/notifications.ts`
- Purpose: Append-only `<DATA_ROOT>/dashboard/notifications.jsonl` plus in-process EventEmitter and dismiss state.
- Exports: `emitNotification`, `listNotifications`, `dismissNotification`, `unreadCount`, `notificationEvents`, types `Notification`, `Severity`, `NotificationScope`.

#### `dashboard/panic-routes.ts`
- Purpose: Panic button surfaces.
- Exports: `registerPanicRoutes(app, db, ptyInject, log)`, `firePanic`, `fireProjectInterrupt`.
- Routes: `POST /panic`, `POST /projects/:id/interrupt`, `GET /panic/recent`.
- Tables: writes `panic_log`.
- Const: `PANIC_PAYLOAD='\x1b\x1b'`.

#### `dashboard/panic-target.ts`
- Purpose: Single-target resolver for `/panic` (one-live, busy-phase, last-seen-wins, none).
- Exports: `resolvePanicTarget`, `ResolveOptions`, `PhaseLabel`.

#### `dashboard/pending-prompt.ts`
- Purpose: In-memory store of CC permission/elicitation prompts waiting for user; TTL 10min.
- Exports: `setPending`, `getPending`, `clearPending`, `PendingPrompt`.

#### `dashboard/projects-anchor-tiles.ts`
- Purpose: Stream Deck tile builder for live `project_session` anchors.
- Exports: `buildProjectAnchorTiles`, `ProjectAnchorTile`.

#### `dashboard/projects-new.ts`
- Purpose: "+ New Project" flow (clone dev-template, register, emit workspace-inject marker for bridge).
- FS path: `<DATA_ROOT>/session-bridge/.workspace-inject/`.
- Exports: `queueProjectBootstrap`, `createProject`.

#### `dashboard/projects-routes.ts`
- Purpose: Project anchor REST.
- Exports: `registerProjectAnchorRoutes(app, db, log)`.
- Routes: `GET /projects/anchor-tiles`, `GET /projects/:id`, `GET /projects/anchors/by-session/:uuid`, `POST /projects/:id/open`, `POST /projects/:id/end`, `PATCH /projects/:id`, `DELETE /projects/:id`.
- Tables: r/w `project_session`, `project_transcript_ref`.

#### `dashboard/pty-host.ts`
- Purpose: Daemon-owned PTY host on top of `node-pty`. Spawns `claude` for both project anchors and Lex anchors; pumps stdout into terminal-stream ring, accepts inject via `/pty/:id/inject`.
- Exports: `ptyInject`, `listPtys`, `ptyKill`, `getPty`, `spawnPty`, `spawnLex`, `getLivePtyIds`, `bindBrainstormSessionId`, `isBrainstormCwd`, `getBrainstormByPty`.
- Side effects: long-lived child processes; integration with `terminal-stream`.

#### `dashboard/push.ts`
- Purpose: Web push via VAPID. Keypair at `<DATA_ROOT>/dashboard/vapid.json`; subs append-only at `push-subscriptions.jsonl`.
- Exports: `sendPush`, `vapidPublicKey`, `loadSubscriptions`, `addSubscription`, `removeSubscription`.

#### `dashboard/reminder-push.ts`
- Purpose: Reminder due-sweep web-push dispatch with persistent dedupe ledger at `<DATA_ROOT>/dashboard/reminder-pushes.jsonl`.
- Exports: `firePushForReminder`, `loadPushedReminderIds`.

#### `dashboard/reminders.ts`
- Purpose: Append-only `<DATA_ROOT>/dashboard/reminders.jsonl` (replay-to-state).
- Exports: `createReminder`, `listReminders`, `updateReminder`, `completeReminder`, `archiveReminder`, `deleteReminder`, `Reminder`.

#### `dashboard/routes.ts` (~5340 LOC, biggest single file)
- Purpose: Main Fastify route binder, plus shared resolver helpers.
- Exports: `registerDashboardRoutes(app, store, log)`, `resolveSupervisedTargetSession`, `coldStartPreloadMode`, `parseColdStartPreloadValue`, `COLD_START_PRELOAD_CONFIG_KEY`.
- Mounts sub-modules: `registerProjectAnchorRoutes`, `registerPanicRoutes`, `registerSmartCompactRoutes`.
- Routes: see Fastify Routes table below.
- Tables touched (r/w): essentially every table in index.db (most paths read project_session, lex_session, brainstorm_sessions, smart_compact_log, cross_session_injection_log, wiki_drafts, audit_findings, lex_feedback, lex_backlog_items, runtime_config, panic_log, voice_health_log, lex_retrieval_log, curator_log/signal, meeting_action_items, backfill_review_queue).

#### `dashboard/search-all.ts`
- Purpose: Unified search across wiki_pages, raw_chunks, reference_chunks with 5-tier source class priority.
- Exports: `searchAll`, `SearchAllOptions`, `SearchAllHit`, `SourceClass`.

#### `dashboard/services.ts`
- Purpose: Reads `<DATA_ROOT>/dashboard/config.jsonc`; pings each defined service (http/tcp/process/cmd/file).
- Exports: `checkAll`, `rollupStatus`, `ServiceDef`, `ServiceResult`.

#### `dashboard/session-phase.ts`
- Purpose: In-memory `Map<sessionId, {phase, updated_at}>` with 60s decay back to idle.
- Exports: `setPhase`, `getPhase`, `SessionPhase`.

#### `dashboard/sessions.ts` (~980 LOC)
- Purpose: Lists CC sessions on disk, derives phase from jsonl tail, queue prompts/suggestions/nav keys for bridge.
- Exports: `listSessions`, `getSession`, `getTranscript`, `queueSessionPrompt`, `queueSessionSuggestion`, `queueSessionKey`, `deriveContextFromTail`, `derivePhaseFromTail`, `derivePendingPromptFromTail`.
- FS paths: `~/.claude/projects/<slug>/<session>.jsonl`, `<DATA_ROOT>/session-bridge/`.

#### `dashboard/smart-compact-injector.ts`
- Purpose: Shared PTY+bridge injector resolver used by both /lex/smart-compact/fire and the scheduler. Sends bare CR nudge ~850ms after commit=true paste.
- Exports: `makeSmartCompactInjector`, `awaitNewSessionReady`, `capturePreClearJsonlSet`, `ccProjectsDirForCwd`, `SessionReadyResult`.

#### `dashboard/smart-compact-routes.ts` (~900 LOC)
- Purpose: Smart-compact REST surface + evaluator.
- Exports: `registerSmartCompactRoutes(app, db, injector, log)`, `evaluateTrigger`, `evaluateSmartCompact`, `fireSmartCompact`, `isShadow`, `defaults`, `WRAP_AND_COMMIT_PROMPT`.
- Routes: `POST /lex/smart-compact/evaluate`, `POST /lex/smart-compact/fire`, `GET /lex/smart-compact/recent`, `GET /lex/smart-compact/toggle`, `POST /lex/smart-compact/toggle`.
- Tables: writes `smart_compact_log`.

#### `dashboard/smart-compact-scheduler.ts`
- Purpose: 60s tick walking live anchors -> evaluateSmartCompact -> fire/wrap. Tunable `DEVNEURAL_SMART_COMPACT_TICK_MS`.
- Exports: `runSmartCompactTick`.

#### `dashboard/superseded.ts`
- Purpose: After /clear, registers prior session id at `<DATA_ROOT>/superseded-sessions.json` so listSessions filters it out (7-day retention).
- Exports: `markSuperseded`, `isSuperseded`.

#### `dashboard/system-metrics.ts`
- Purpose: CPU/memory/disk/uptime via `os` + minor Windows shell-outs.
- Exports: `getSystemMetrics`, `CpuMetric`, `MemoryMetric`, `DiskMetric`.

#### `dashboard/terminal-stream.ts`
- Purpose: Per-session 256KB ring buffer + WebSocket fan-out. Bridge writes via `/sessions/:id/terminal-stream`.
- Exports: `pushTerminalData`, `subscribeTerminal`, `getTerminalReplay`, `getTerminalSubscribers`.

#### `dashboard/toast-fallback.ts`
- Purpose: Windows BurntToast PowerShell fallback when no PWA subs.
- Exports: `tryToastFallback`.

#### `dashboard/unified-graph.ts`
- Purpose: Unified node graph (brainstorm + wiki + project + meeting) for `/graph/unified`.
- Exports: `buildUnifiedGraph(db)`, `UnifiedNodeKind`, `UnifiedEdgeKind`.

#### `dashboard/worker-event-detect.ts`
- Purpose: Pure detectors over jsonl tails: idle, permission_denied, test_failure, commit.
- Exports: `detectCommit`, `detectIdle`, `detectPermissionDenied`, `detectTestFailure`, `AnchorTailState`.

#### `dashboard/worker-event-killswitch.ts`
- Purpose: Demotes runaway anchor's supervision_mode to 'polling' and emits warn notification.
- Exports: `bindKillSwitch`, `KillSwitchDeps`.

#### `dashboard/worker-event-listener.ts`
- Purpose: Chokidar over all CC jsonls; binds detector + router + inject. Only fires for `supervision_mode='event'` anchors.
- Exports: `startWorkerEventListener`, `processChange`.

#### `dashboard/worker-event-router.ts`
- Purpose: Pure router with WorkerEventGate (rate limit + hard ceiling >20/10min), payload assembly, inject into Lex.
- Exports: `WorkerEventGate`, `resolveLexTargetSession`, `routeWorkerEvent`, `WorkerEvent`, `WorkerEventType`, `RouteResult`.

#### `dashboard/worker-stall-watch.ts`
- Purpose: 60s tick walking live anchors; classifies tool-stall (>5min, env `DEVNEURAL_STALL_TOOL_MS`) or no-response (>3min, `DEVNEURAL_STALL_USER_MS`); fires `fireForStall` with cooldown `DEVNEURAL_STALL_COOLDOWN_MS`.
- Exports: `runWorkerStallTick`, `readTail`.

#### `dashboard/worker-status-footer.ts`
- Purpose: Parser for `worker-status` machine-readable footer (HTML comment or fenced ```worker-status```).
- Exports: `parseWorkerStatusFooter`, `WorkerStatusFooter`.

### `db/`

#### `db/migrate.ts`
- Purpose: Versioned migration runner reading `07-daemon/scripts/migrations/*.{sql,ts}`. Records in `_migrations` table.
- Exports: `runMigrations`, `MigrationResult`.

#### `db/outbound-guard.ts`
- Purpose: PB-2/BF-4 outbound wrapper enforcing daily cap, voice-session-provenance refuse, full audit row in `outbound_log`.
- Exports: `outboundCall`, `OutboundRefused`, `OutboundCall`.
- Tunables: `DEVNEURAL_OUTBOUND_DAILY_CAP_CALLS` (200), `DEVNEURAL_OUTBOUND_DAILY_CAP_BYTES` (5MiB).

### `embedder/`

#### `embedder/index.ts`
- Purpose: Lazy @xenova/transformers MiniLM pipeline (`DEVNEURAL_EMBED_MODEL`, default `Xenova/all-MiniLM-L6-v2`, dim 384).
- Exports: `embedOne`, `warmUp`, `getEmbedDim`, `getModelId`, `setEmbedderLogger`, `embedderStats`.

### `gpu/`

#### `gpu/queue.ts`
- Purpose: In-process GPU job queue with 4 priority lanes (curator, voice, ingest, lint). VRAM gate for lanes 2-3; `drainSessionId` hook for session-end.
- Exports: `initGpuQueue`, `enqueueGpuJob`, `drainSessionId`, `gpuQueueStats`.

#### `gpu/vram-monitor.ts`
- Purpose: nvidia-smi poller (5s default); exposes `vramOk()`; fail-open if no nvidia-smi.
- Exports: `VramMonitor`, `VramSample`, `VramMonitorOptions`.
- Tunables: `DEVNEURAL_VRAM_FLOOR_MB` (1024).

### `heartbeat/`

#### `heartbeat/poster.ts`
- Purpose: POST tiny JSON to `DEVNEURAL_HEARTBEAT_URL` every 60s; writes `heartbeat_log` rows. No-op when URL unset.
- Exports: `createHeartbeatPoster`.

### `identity/`

#### `identity/project-id.ts`
- Purpose: Resolves project id from cwd (git remote -> path hash). 12-char sha256 id.
- Exports: `resolveProjectIdentity`, `normalizeRemote`, `hashId`.

#### `identity/registry.ts`
- Purpose: Persisted project registry at `<DATA_ROOT>/projects.json`; per-project `project.json`.
- Exports: `listProjects`, `recordIdentity`, `getProject`.

### `lifecycle/`

#### `lifecycle/guards.ts`
- Purpose: Hook profile + entrypoint allowlist + cooperative skip env (`DEVNEURAL_SKIP_OBSERVE`, `DEVNEURAL_HOOK_PROFILE`).
- Exports: `evaluateGuards`, `GuardResult`.

#### `lifecycle/pid.ts`
- Purpose: `daemon.pid` lifecycle, `daemon.lock` spawn lock.
- Exports: `readPid`, `writePid`, `removeStalePid`, `isAlive`, `acquireSpawnLock`.

#### `lifecycle/shutdown-hook.ts`
- Purpose: Module-level shutdown closure registry used by `/admin/daemon/restart`.
- Exports: `setShutdownHook`, `hasShutdownHook`, `triggerShutdown`, `ShutdownFn`.

#### `lifecycle/signals.ts`
- Purpose: SIGUSR1 coalescer (single in-flight handler + latched rerun).
- Exports: `SignalCoalescer`.

#### `lifecycle/spawn.ts`
- Purpose: Lazy daemon spawn from hook-runner with spawn-lock dedupe.
- Exports: `ensureDaemonRunning`.

### `llm/`

#### `llm/anthropic.ts`
- Purpose: Anthropic provider (claude-haiku-4-5 ingest/self-query, claude-sonnet-4-6 lint/reconcile). Prompt caching.
- Exports: `AnthropicProvider`.

#### `llm/index.ts`
- Purpose: Provider factory keyed on `DEVNEURAL_LLM_PROVIDER` (ollama|anthropic|none).
- Exports: `pickProvider`, `providerStatus`, `callValidated`, `LlmNotConfiguredError`, `ProviderName`.

#### `llm/ollama.ts`
- Purpose: Ollama provider at `http://localhost:11434`. Default `qwen3:8b`.
- Exports: `OllamaProvider`.

#### `llm/types.ts`
- Purpose: Provider-neutral types.
- Exports: `LlmRole`, `SystemBlock`, `CallOptions`, `CallResult`, `LlmProvider`, `ModelIds`, `LlmNotConfiguredError`.

#### `llm/validator.ts`
- Purpose: JSON parse + schema check + repair retries + optional self-critique. `DEVNEURAL_LLM_REPAIR_RETRIES` (2).
- Exports: `validateOnce`, `validateWithRepair`, `Validator`, `ValidationResult`.

### `lex/` (35 files; the supervisor brain)

#### `lex/anchor-tiles.ts`
- Purpose: Stream Deck tile builder for live `lex_session` anchors.
- Exports: `buildAnchorTiles`, `AnchorTile`.

#### `lex/artifact-parser.ts`
- Purpose: Scans assistant turns for `artifact:` fenced JSON blocks; persists to disk; updates `brainstorm_sessions.artifacts_json`; fan-out notes-summary to reminders.
- Exports: `parseArtifactsFromTurn`, `persistArtifact`, supported kinds: `research-note`, `wiki-draft`, `project-intent`, `notes-summary`.

#### `lex/auto-advance-supervisor.ts`
- Purpose: Phase-3 autonomous supervisor loop (shadow/live). Quiescence checks, worker-status footer required, atomic backlog claim, inject. Writes `auto_advance_log`.
- Exports: `runAutoAdvanceTick`, `startAutoAdvanceSupervisor`, `AutoAdvanceMode`.

#### `lex/awareness.ts`
- Purpose: Diff-only awareness event broadcaster (`audit-finding`, `reminder-due`, `draft-auto-dropped`, `canary-fail`); recent_context() helper.
- Exports: `emitAwarenessEvent`, `getRecentAwareness`, `setAwarenessMode`, `AwarenessEventKind`.

#### `lex/backlog-store.ts`
- Purpose: Thin wrapper over `lex_backlog_items` with atomic claim primitive (UPDATE...WHERE CAS).
- Exports: `setStore`, `claimBacklogItem`, `listBacklog`, `insertBacklog`, `updateBacklog`.

#### `lex/brainstorm-distillation.ts`
- Purpose: BF-7 session-end Pass-2 distillation -> `wiki_drafts` rows. Local LLM only (BF-4 blocks anthropic).
- Exports: `distillBrainstorm`, `DistillationResult`.

#### `lex/brainstorm-jsonl-ingestor.ts`
- Purpose: 5s tick reading every active brainstorm CC jsonl; inserts `brainstorm_chunks` (INSERT OR REPLACE keyed on CC turn uuid).
- Exports: `startBrainstormJsonlIngestor`.

#### `lex/brainstorm-store.ts`
- Purpose: Brainstorm session record helpers + global store accessor.
- Exports: `setStore`, `getStore`, `createBrainstorm`, `getBrainstorm`, `getBrainstormByPty`, `getBrainstormByClaudeSessionId`, `listBrainstorms`, `updateBrainstorm`, `appendArtifact`, `setBrainstormPhaseTwo`.

#### `lex/cc-project-slug.ts`
- Purpose: Canonical slug encoder (cwd -> hyphenated lowercase) + case-insensitive resolve against `~/.claude/projects/`.
- Exports: `rootToSlug`, `resolveCcProjectDir`.

#### `lex/chunk-retrieval.ts`
- Purpose: LX-10 bounded brainstorm chunk retrieval (vector store primary, sqlite FTS5 fallback).
- Exports: `chunkSearch`, `ChunkSearchHit`.

#### `lex/compaction-supervisor.ts`
- Purpose: End-of-turn compaction supervisor: invokes shouldTriggerCompaction over `message.usage`; on positive runs session-end-pipeline then spawns fresh Lex.
- Exports: `runCompactionTurn`, `CompactionSupervisorDeps`.

#### `lex/compaction-trigger.ts`
- Purpose: Pure 75% context-ratio detector.
- Exports: `shouldTriggerCompaction`, `DEFAULT_COMPACTION_RATIO`, `CompactionTriggerInput`.

#### `lex/cross-session-inject.ts`
- Purpose: HMAC-gated cross-session inject. Writes `cross_session_injection_log`. Auto-CR nudge after every commit=true.
- Exports: `crossSessionInject`, `verifyCrossSessionToken`, `mintCrossSessionToken`.

#### `lex/cross-session-resolve.ts`
- Purpose: Fix-15 stale-uuid -> live-uuid redirect; dormant park outcome.
- Exports: `resolveAnchorForInject`, `ResolveAnchorOutcome`.

#### `lex/distillation-generator.ts`
- Purpose: LLM-backed sibling distillation generator (one-sentence summary). Local-only (BF-4).
- Exports: `createLlmDistillationGenerator`, `CreateGeneratorOptions`.

#### `lex/distillation-scheduler.ts`
- Purpose: 10-min interval scheduler binding generator to `runDistillationBackfill`.
- Exports: `startDistillationBackfillScheduler`.

#### `lex/docs-index.ts`
- Purpose: Reads `docs/INDEX.md` for per-turn live_state Tier-3 injection.
- Exports: `loadDocsIndex`, `DEFAULT_DOCS_INDEX_PATH`, `MAX_INDEX_ENTRIES`.

#### `lex/feedback-memories.ts`
- Purpose: Loads brainstorm cwd's `memory/*.md` frontmatter where `type: feedback`; renders block for system prompt.
- Exports: `loadFeedbackMemories`, `renderFeedbackMemoriesBlock`, `LoadFeedbackMemoriesResult`.

#### `lex/lex-cold-start-preamble.ts`
- Purpose: Race-free force-distill of recent siblings then assembles preamble (sibling index + last-2 distillations + recent turns) injected via SessionStart hook.
- Exports: `preloadColdStartSiblings`, `assembleColdStartPreamble`.

#### `lex/lex-session-store.ts`
- Purpose: Helpers over `lex_session` + `lex_transcript_ref`.
- Exports: `createLexSession`, `getLexSession`, `listLexSessions`, `updateLexSession`, `appendTranscriptRef`, `listTranscriptRefs`.

#### `lex/memory-janitor.ts`
- Purpose: LX-14 weekly cosine-only merge/contradiction detector; writes `audit_findings` source='janitor'.
- Exports: `runMemoryJanitor`.

#### `lex/personality-guard.ts`
- Purpose: chokidar over `<DATA_ROOT>/lex-prompts/`; emits audit-finding on writes; optional Windows icacls DENY.
- Exports: `startPersonalityGuardWatcher`, `applyIcacls`, `PERSONALITY_GUARD_RULE`.

#### `lex/prompt-archive.ts`
- Purpose: Atomic disk archive of every Lex system-prompt revision at `<DATA_ROOT>/lex-prompts/<version>.md`.
- Exports: `archivePromptVersion`, `readPromptVersion`, `listPromptVersions`, `backfillPromptVersions`.

#### `lex/prompt-blocks.ts`
- Purpose: Per-mode few-shot + refusal contract loaders (disk-backed with defaults).
- Exports: `loadFewShotBlock`, `loadRefusalContract`, `LexMode`.

#### `lex/replay-pty.ts`
- Purpose: Hermetic PTY runner for A/B replay (temp cwd outside DATA_ROOT/brainstorm).
- Exports: `runHermeticVersion`, `HermeticTurnResult`.

#### `lex/replay.ts`
- Purpose: A/B replay harness; writes diff to `<DATA_ROOT>/lex-replay-output/<ts>/diff.md`.
- Exports: `runLexReplay`, `ReplayInput`, `ReplayPair`.

#### `lex/session-end-lock.ts`
- Purpose: Per-session funnel lock so concurrent end paths run pipeline once.
- Exports: `withSessionEndLock`.

#### `lex/session-end-pipeline.ts`
- Purpose: 8-step session-end pipeline (stop chunks, drain GPU, persist transcript, force-flush ingest, Pass 2 -> drafts, finalize audio bundle, summarize, mark ended).
- Exports: `runSessionEndPipeline`.

#### `lex/sibling-distillation-backfill.ts`
- Purpose: Bounded backfill of older siblings with NULL `last_summary` (default 5/run, started_ms DESC).
- Exports: `runDistillationBackfill`, `BACKFILL_DEFAULT_LIMIT`, `BackfillOptions`.

#### `lex/sibling-distillation-preload.ts`
- Purpose: Top-N preload at spawn; persists via updateBrainstorm.
- Exports: `preloadSiblingDistillations`, `DistillationGenerator`.

#### `lex/sibling-index.ts`
- Purpose: Sibling index for cold-start prompt; transcript_refs primary path, label-match fallback.
- Exports: `buildSiblingIndex`, `extractTurnPairsFromJsonl`.

#### `lex/six-section-resume.ts`
- Purpose: Structured resume builder (Goal/Current/Files/Changed/Failed/Next). Empty sections dropped.
- Exports: `buildSixSectionResume`, `ResumeInput`.

#### `lex/smart-compact.ts`
- Purpose: Pure evaluators consumed by smart-compact routes.
- Exports: `evaluateTrigger`, `isShadow`, `ctxPctFromJsonl`, `Phase`, `EvalAction`.

#### `lex/snapshot-context.ts`
- Purpose: Per-turn live_state block prepended to every voice utterance (projects + sessions + reminders + curator alerts + docs index).
- Exports: `buildLiveStateBlock`.

#### `lex/spawn-lex-session.ts`
- Purpose: Generates CC session uuid, computes transcript path, persists `lex_transcript_ref` BEFORE PTY spawn.
- Exports: `prepareLexSpawn`, `spawnLexSession`.

#### `lex/spawn-prompt.ts`
- Purpose: Composes per-spawn header (new vs reopen with ordered transcript catch-up protocol) wrapping buildLexSystemPromptVersioned.
- Exports: `buildSpawnPrompt`, `LexSpawnVariant`.

#### `lex/system-prompt.ts` (~877 LOC)
- Purpose: Lex system prompt composer; 6 layers (identity, modes, artifacts, API, self-check, live snapshot).
- Exports: `buildLexSystemPrompt`, `buildLexSystemPromptVersioned`, `buildLexSystemPromptStable`, `BuildLexSystemPromptResult`.

#### `lex/thread-doc.ts`
- Purpose: Session-end thread-doc generator at `<DATA_ROOT>/lex/thread-docs/<id>.md`; loaded into next spawn within 7 days.
- Exports: `writeThreadDoc`, `loadMostRecentThreadDoc`.

#### `lex/tool-gate.ts`
- Purpose: Intercepts WebSearch when internal-vocab term detected; emits awareness event.
- Exports: `evaluateToolGate`, `ToolGateDecision`.

#### `lex/worker-handoff.ts`
- Purpose: Worker-side context handoff doc (4 sections: where left off / active task / next up / blockers) for SessionStart inject.
- Exports: `buildWorkerHandoff`, `WorkerHandoffInput`, `clearWorkerHandoff`.

### `reference/` (corpus uploads)

#### `reference/audio.ts`
- Purpose: Audio transcription via whisper.cpp `whisper-cli`/`main` shellout.
- Exports: `extractAudioTranscript`, `AudioExtractResult`.

#### `reference/chunk.ts`
- Purpose: Paragraph-aware chunker (~800 chars, ~100 overlap).
- Exports: `chunkText`, `Chunk`.

#### `reference/image.ts`
- Purpose: Tesseract.js OCR.
- Exports: `extractImage`, `ImageExtractResult`.

#### `reference/pdf.ts`
- Purpose: pdf-parse with OCR fallback (pdf-to-png-converter + tesseract.js).
- Exports: `extractPdf`, `PdfExtractResult`.

#### `reference/process.ts`
- Purpose: Upload pipeline (extract -> chunk -> embed -> reference_chunks vector + reference_meta + reference_fts rows).
- Exports: `ingestUpload`, `IngestUploadResult`.

#### `reference/store.ts`
- Purpose: `ReferenceStore` over its own VectorStore collection + sqlite tables `reference_meta`, `reference_fts`.
- Exports: `ReferenceStore`, `ReferenceChunkMetadata`, `ReferenceDocMeta`.

#### `reference/video.ts`
- Purpose: ffmpeg demux to WAV + whisper transcription; optional frame OCR.
- Exports: `extractVideoTranscript`, `VideoExtractResult`.

### `reinforcement/`

#### `reinforcement/index.ts` (~708 LOC)
- Purpose: Hit/correction tracker over curator injections; weight updates, promotion, archive; periodic decay.
- Exports: `recordInjection`, `processAssistantTurn`, `processUserPrompt`, `decayInactivePages`, `loadPage`, `applyWeightUpdate`, `markPagePromoted`, `markPageArchived`.

#### `reinforcement/raw-chunks-cull.ts`
- Purpose: OP-4 daily cull of aged raw_chunks_meta rows (default 180d). Never touches brainstorm_chunks.
- Exports: `cullRawChunks`, `CullOptions`, `CullResult`.
- Tables: writes `raw_chunks_archived` (created here on demand).

### `store/`

#### `store/index-db.ts` (~2761 LOC)
- Purpose: Single `IndexDb` class wrapping `better-sqlite3` with WAL, foreign_keys ON. Hosts both the legacy schema (`migrate()`) and all CRUD helpers.
- Tables CREATEd inline (legacy): `raw_chunks_meta`, `wiki_pages_meta`, `wiki_fts` (FTS5), `cross_refs`, `schema_meta`, `runtime_config`, `brainstorm_sessions`.
- File: `<DATA_ROOT>/index.db`.

#### `store/index.ts`
- Purpose: `Store` facade; opens VectorStore collections (`raw_chunks`, `wiki_pages`) + IndexDb.
- Exports: `Store`, `RawChunkMetadata`, `WikiPageMetadata`.

#### `store/vector-store.ts`
- Purpose: Native in-process float32 vector store with linear cosine. Appendable `.meta.jsonl` + atomic `.vec` + `.head.json` per collection.
- Exports: `VectorStore`.

### `voice/`

#### `voice/audio-bundle.ts`
- Purpose: Per-session audio bundling (PCM stream to `<id>.pcm.tmp`, finalize WAV header + cues JSON atomic write).
- Exports: `appendUtterance`, `finalize`, `discard`, `AudioBundleState`.

#### `voice/lex-voice-commands.ts`
- Purpose: Lex voice-command matcher (panic / end_session / mute / unmute / standby / listen / disable; requires "lex" prefix).
- Exports: `matchLexVoiceCommand`, `LexVoiceCommand`.

#### `voice/lex-voice-ws.ts` (~1627 LOC)
- Purpose: Voice WS handler (bind session, stream PCM, whisper transcribe, inject into Lex PTY, watch jsonl for assistant turn, Piper TTS streaming, barge-in cancel).
- Exports: `attachLexVoiceWs`, `getVoiceWsStats`.

#### `voice/meeting-audio-purge.ts`
- Purpose: Daily cron deleting WAV+cues older than `DEVNEURAL_MEETING_AUDIO_MAX_AGE_DAYS` (30) unless `keep_audio=1`.
- Exports: `purgeMeetingAudio`, `PurgeOptions`, `PurgeResult`.

#### `voice/panic-voice.ts`
- Purpose: Single matcher for `lex emergency stop`.
- Exports: `matchesPanicCommand`.

#### `voice/piper.ts` (~614 LOC)
- Purpose: piper.exe subprocess streaming 22050Hz mono PCM with barge-in kill.
- Exports: `synthesizeStream`, `piperStatus`, `setPiperVoice`, `setPiperSpeed`.

#### `voice/select-tts-content.ts`
- Purpose: Pure: decides which assistant jsonl content should be spoken (`end_turn` full, `tool_use` pre-tool ack only).
- Exports: `selectTtsContent`, `hashSegment`, `AssistantJsonlRecord`.

#### `voice/whisper.ts`
- Purpose: whisper.cpp `whisper-server.exe` subprocess (cuBLAS); POST `/inference` per utterance.
- Exports: `transcribe`, `whisperStatus`, `whisperPrewarm`.

### `wiki/`

#### `wiki/audit-doc-ingest.ts`
- Purpose: Synthetic brainstorm rows from `voice-review.md` + `docs/audit/*.md` (provenance='audit-document').
- Exports: `ingestAuditDocs`, `AuditIngestResult`.

#### `wiki/auto-ingest.ts`
- Purpose: Cursor-driven ingest from each project's `transcripts.jsonl`. SIGUSR1 trigger + 5min cron.
- Exports: `runAutoIngest`, `startAutoIngestInterval`.

#### `wiki/backfill-brainstorms.ts`
- Purpose: BF-13/BF-14 one-shot backfill of legacy brainstorms -> brainstorm_chunks + wiki lineage (3 bands).
- Exports: `runBackfillBrainstorms`.

#### `wiki/backfill.ts` (~712 LOC)
- Purpose: One-time raw/wiki backfill of every `~/.claude/projects/<slug>/<session>.jsonl`. Resumable cursor at `<DATA_ROOT>/.backfill-{raw|wiki}.json`.
- Exports: `runBackfillRaw`, `runBackfillWiki`, `getBackfillStatus`, `cancelBackfill`.

#### `wiki/candidates.ts`
- Purpose: Multi-signal ingest candidate selection (embedding + cross-ref hops + entity overlap + FTS).
- Exports: `selectCandidates`, `CandidatePage`, `CandidateOptions`.

#### `wiki/ingest.ts` (~940 LOC)
- Purpose: Two-pass ingest (filter -> write). Applies diffs to disk + sqlite + vector store + log; commits wiki git repo.
- Exports: `runIngest`, `IngestInput`, `IngestResult`, `forceIngestProject`.

#### `wiki/lint-queue.ts`
- Purpose: Debounced (60s) lint scheduler triggered by every wiki mutation; single-flight with latched rerun.
- Exports: `initLintQueue`, `scheduleLint`, `lintQueueStatus`.

#### `wiki/lint.ts`
- Purpose: Sampled maintenance pass: pending pages + low-weight canonical + 50 random canonical + flagged. Auto-applies safe repairs.
- Exports: `runLint`, `LintResult`.
- Tables: writes `audit_findings` source='lint'.

#### `wiki/push.ts`
- Purpose: Periodic `git push` of wiki repo (default 5min). No-op when no remote.
- Exports: `startWikiPushInterval`.

#### `wiki/repair.ts`
- Purpose: One-shot cross-ref href normaliser over all wiki pages.
- Exports: `runRepair`, `WikiRepairResult`.

#### `wiki/scaffolding.ts`
- Purpose: Ensures wiki dir tree, DEVNEURAL.md spec copy, index.md, log.md.
- Exports: `ensureWiki`, `WikiScaffoldResult`.

#### `wiki/schema.ts`
- Purpose: Wiki page parser/writer/validator (YAML frontmatter + sections).
- Exports: `parsePage`, `readPage`, `writePage`, `PageFrontmatter`, `PageSections`, `ParsedPage`, `PageStatus`.

#### `wiki/self-audit.ts`
- Purpose: LLM rates N random canonical pages; writes `audit_findings` source='self-audit'.
- Exports: `runSelfAudit`, `SelfAuditResult`.

#### `wiki/whats-new.ts`
- Purpose: Weekly digest at `<wiki>/whats-new.md` from wiki log + reinforcement log + mtimes. No LLM.
- Exports: `generateWhatsNew`.

---

### Complete SQLite Table Catalog

DB file: `<DATA_ROOT>/index.db` (better-sqlite3, WAL, foreign_keys=ON). Schema is the union of `store/index-db.ts` (legacy `migrate()`) and `07-daemon/scripts/migrations/*.{sql,ts}` applied by `db/migrate.ts`.

| Table | Purpose | Columns | Written by | Read by |
|---|---|---|---|---|
| `_migrations` | Versioned migration ledger | filename PK, checksum, applied_at | `db/migrate.ts` | `db/migrate.ts` |
| `raw_chunks_meta` | Metadata for every transcript chunk | id PK, project_id, session_id, timestamp_ms, kind, role, byte_length, model_id (mig 002) | transcript-watcher, backfill raw, brainstorm-summary (session-end pipeline) | search routes, /lex/recall, reinforcement, raw-chunks-cull |
| `raw_chunks_archived` | Cull archive of raw_chunks_meta | id PK, project_id, session_id, timestamp_ms, kind, role, byte_length, archived_at | `reinforcement/raw-chunks-cull.ts` (created on demand) | forensics |
| `wiki_pages_meta` | Wiki metadata (filter/sort surface) | id PK, title, trigger, insight, status, weight, hits, corrections, created_ms, last_touched_ms, projects_json, human_edited | wiki/ingest, wiki/lint, reinforcement (decay/promote) | curator, search, dashboard graph |
| `wiki_fts` | FTS5 over title/trigger/insight/body | page_id UNINDEXED, title, trigger, insight, body | wiki/ingest, wiki/lint | wiki candidate selection, /lex/recall |
| `cross_refs` | Wiki page-to-page edges | from_page, to_page (composite PK) | wiki/ingest | graph builders |
| `schema_meta` | Internal version pin | key PK, value | bootstrap | bootstrap |
| `runtime_config` | Generic key/value runtime overrides | key PK, value, updated_at, updated_by | /runtime-config/:key, toggle routes | many (pause_mode, smart_compact, cold_start_preload, default_supervision_mode, dashboard_supervisor_enabled, auto_advance_mode) |
| `brainstorm_sessions` | First-class brainstorm/meeting record | id PK, claude_session_id, pty_id, cwd, user_label, derived_label, mode, status, started_ms, ended_ms, turn_count, topic_tags_json, artifacts_json, last_summary, last_summary_ms; mig 004 adds project_slug, audio_path, distilled_at, kind, attendees, meeting_topic, consent_acked, consent_acked_at, consent_acked_by, keep_audio, provenance; mig 014 adds prompt_version | brainstorm-store, session-end-pipeline, spawn-lex-session, audit-doc-ingest, meeting-audio-purge | /brainstorms, /meetings, lex/sibling-index, search-all, /lex/anchors |
| `wiki_meta` (mig 001) | Wiki-scope KV (e.g. frontmatter_schema_version) | key PK, value | wiki/scaffolding | wiki/ingest |
| `brainstorm_chunks` (mig 003) | Full brainstorm transcript chunks | id PK, brainstorm_id FK, turn_index, role, mode, text, model_id, no_decay, created_at | brainstorm-jsonl-ingestor, session-end-pipeline, backfill-brainstorms, audit-doc-ingest | chunk-retrieval, memory-janitor, /brainstorms/:id/chunks |
| `wiki_drafts` (mig 005) | Pending drafts from session-end distillation | id PK, brainstorm_id FK, page_slug, page_title, body_markdown, confidence, status (pending/promoted/discarded/auto-promoted/auto-dropped/superseded), created_at, resolved_at, resolved_by | brainstorm-distillation, /meetings/:id/promote-to-wiki | /drafts routes |
| `outbound_log` (mig 006) | Every off-host call attempt (PB-2/BF-4) | id PK, destination, purpose, payload_class, contains_voice_session_source, payload_bytes, request_at, response_status, response_at, error, failure_code; trigger `outbound_no_voice_session` blocks brainstorm-/meeting-/voice-session payloads | db/outbound-guard | /stats/outbound |
| `curator_log` (mig 007) | Curator inject/silence decisions | id PK, prompt_id UNIQUE, session_id, project_slug, decision, page_slug, score, threshold, confidence, source_class, created_at | curator path (hook) | /stats/curator-health |
| `curator_signal` (mig 007) | Hit/correction/click/wrong signals | id PK, curator_log_id FK, prompt_id, signal, source, weight, created_at | reinforcement, /curator/wrong | /stats/curator-health |
| `lex_feedback` (mig 008) | Inline LexThumbs votes | id PK, turn_id, brainstorm_id, prompt_version, vote, reason, created_at | /lex/feedback POST | /lex/feedback GET, up-rate route |
| `audit_findings` (mig 010, expanded mig 016) | Cross-source audit surface | id PK, source (lint/self-audit/canary/user-flag/schema-regression/janitor), severity, page_slug, brainstorm_id, finding, detail, status, created_at, resolved_at | wiki/lint, wiki/self-audit, lex/memory-janitor, lex/personality-guard, /audit-findings | /audit-findings, snapshot-context, dashboard panels |
| `heartbeat_log` (mig 011) | Daemon heartbeat ticks | id PK, ts, daemon_pid, daemon_version, status (posted/ack/no-ack/watcher-alarm), detail | heartbeat/poster | /system status |
| `crossproject_fallback_log` (mig 012) | No-tags fallback audit | id PK, candidate_slug, reason, participating_projects, created_at | wiki/ingest cross-project | forensics |
| `backfill_review_queue` (mig 013) | Manual review of borderline brainstorm-wiki pairs | id PK, brainstorm_id, candidate_page_slug, cosine, band, status, created_at, resolved_at, resolved_by | backfill-brainstorms | /brainstorms/backfill-review |
| `meeting_action_items` (mig 013a) | Extracted from notes-summary artifacts | id PK, meeting_id FK, text, assignee, due, reminder_id, status, source_turn_index, created_at, resolved_at | session-end-pipeline (meetings) | /meetings/:id, /meetings/:id/action-items |
| `lex_retrieval_log` (mig 015) | Every retrieval decision Lex makes | id PK, brainstorm_id, ts, query, kind (grep/chunks/wiki/web), results_json, decision | chunk-retrieval, /lex/recall, tool-gate | /lex/retrieval-trace |
| `cross_session_injection_log` (mig 017, widened mig 024/029/032) | Cross-session inject audit | id PK, ts, target_session, caller_label, text_preview, text_length, decision (accepted/rejected_auth/rejected_allowlist/rejected_pty/shadow/redirected/dispatched_dead_session/rejected_anchor_dormant/no_deliverable_bridge), reject_reason, brainstorm_id, payload_text (mig 030) | cross-session-inject | /lex/injection-log |
| `lex_session` (mig 018) | Durable Lex anchor | id PK, created_ms, title, derived_title, status (live/dormant), current_pty_id, cwd; mig 025 adds supervises_project_anchor_id FK -> project_session | lex-session-store, spawn-lex-session | /lex/anchors, sibling-index |
| `lex_transcript_ref` (mig 018) | Ordered CC jsonl pointers per lex_session | id PK AUTOINCREMENT, lex_session_id FK, cc_session_id UNIQUE, transcript_path, started_ms, ended_ms, ordering | spawn-lex-session, lex-session-store | sibling-index, /lex/anchors/:id |
| `project_session` (mig 019) | Durable per-project anchor | id PK, project_slug UNIQUE, cwd UNIQUE, title, status, current_session_id, current_bridge_id, current_pty_id, created_ms, last_seen_ms; mig 022 adds supervision_mode; mig 027 adds auto_advance_owner + auto_advance_epoch; mig 029 adds previous_session_id | bridge-presence reconcile, projects-routes, auto-advance-supervisor | anchor-tiles, panic-target, smart-compact |
| `project_transcript_ref` (mig 019) | Ordered CC jsonl pointers per project anchor | id PK, anchor_id FK, cc_session_id UNIQUE, jsonl_path, opened_ms, closed_ms | bridge-presence, projects-routes | projects-routes, worker-event-listener |
| `panic_log` (mig 020) | Audit row per panic-button fire | id PK, ts, target_anchor_id, target_pty_id, target_session_id, clicked_ms, caller, result | panic-routes | /panic/recent |
| `smart_compact_log` (mig 021, payload mig 023) | Audit per smart-compact decision | id PK, ts, anchor_id, cc_session_id, caller, reason, action (fire/wrap/shadow/noop), pre_ctx_pct, post_ctx_pct, summary_preview, payload_text | smart-compact-routes, scheduler | /lex/smart-compact/recent |
| `lex_backlog_items` (mig 026) | Canonical autonomous-supervisor backlog | id PK, title, status (queued/in-flight/done/parked), priority, added_at, injected_at, done_at, commit_shas, claimed_by, claimed_at, claimed_turn_uuid, anchor_id FK lex_session, notes | backlog-store (atomic claim), /lex/backlog | /lex/backlog, auto-advance-supervisor |
| `auto_advance_log` (mig 028) | Auto-advance tick decisions | id PK, created_at, anchor_id FK, turn_uuid, item_id, mode (off/shadow/live), decision (shadow/would-inject/accepted/skip/error), reason, would_inject_preview, footer_status, footer_needs_attention, epoch | auto-advance-supervisor | /lex/auto-advance/recent |
| `voice_health_log` (mig 031) | Dashboard voice watchdog telemetry | id INTEGER PK AUTOINCREMENT, ts_ms, check_kind, status, heal_attempt, recovered | dashboard `/dashboard/voice-health` POST | `/dashboard/voice-health` GET |
| `reference_meta` (reference/store.ts) | Reference doc metadata | doc_id PK, filename, kind, project_id, tags_json, upload_ts, page_count, char_count, chunk_count, status, error, warnings_json | reference/process | /reference |
| `reference_fts` (reference/store.ts) | FTS5 over reference text | doc_id UNINDEXED, filename, text | reference/process | /reference search |

---

### Complete Fastify Route Catalog

Mounted at `0.0.0.0:3747` (env `DEVNEURAL_BIND` / `DEVNEURAL_PORT`). All routes return JSON unless noted. Static SPA from `08-dashboard/out` mounted at `/`.

| Method | Path | Purpose | File |
|---|---|---|---|
| GET | /health | Daemon liveness + audio/embedder/llm status | daemon.ts:751 |
| GET | /projects | Legacy project registry | daemon.ts:785 |
| POST | /search | Vector search raw_chunks or wiki_pages | daemon.ts:790 |
| POST | /sync | 410 Gone (deprecated monday) | daemon.ts:828 |
| POST | /reseed | Run corpus seed | daemon.ts:837 |
| POST | /curate | Trigger curator path | daemon.ts:842 |
| POST | /summarize | Update session summary | daemon.ts:863 |
| POST | /glossary | Update project glossary | daemon.ts:886 |
| POST | /decay | Manual decay sweep | daemon.ts:906 |
| POST | /lint | Run lint pass | daemon.ts:911 |
| POST | /whats-new | Regenerate whats-new digest | daemon.ts:917 |
| POST | /flush | Flush vector store + SQLite WAL checkpoint | daemon.ts:929 |
| GET | /page/:id | Read wiki page raw + frontmatter | daemon.ts:947 |
| GET | /glossary/:projectId | Read glossary | daemon.ts:968 |
| GET | /session/:sessionId/summary | Read summary | daemon.ts:974 |
| GET | /session/:sessionId/task | Read current-task | daemon.ts:980 |
| POST | /task | Update current-task | daemon.ts:986 |
| POST | /ingest | Manual ingest call | daemon.ts:1001 |
| POST | /panic | Global panic | panic-routes.ts:155 |
| POST | /projects/:id/interrupt | Anchor-pinned panic | panic-routes.ts:179 |
| GET | /panic/recent | Audit feed | panic-routes.ts:204 |
| GET | /projects/anchor-tiles | Stream Deck tiles | projects-routes.ts:314 |
| GET | /projects/:id | Anchor detail + transcript refs | projects-routes.ts:326 |
| GET | /projects/anchors/by-session/:uuid | Resolve anchor from CC uuid | projects-routes.ts:350 |
| POST | /projects/:id/open | Spawn or bind | projects-routes.ts:372 |
| POST | /projects/:id/end | Flip dormant | projects-routes.ts:389 |
| PATCH | /projects/:id | Rename | projects-routes.ts:400 |
| DELETE | /projects/:id | Cascade delete | projects-routes.ts:419 |
| GET | /dashboard/health | Dashboard health | routes.ts:278 |
| GET | /dashboard/daily-brief | Home page summary | routes.ts:293 |
| GET | /dashboard/reinforcement | Reinforcement metrics | routes.ts:302 |
| GET | /dashboard/system-metrics | CPU/mem/disk | routes.ts:352 |
| GET | /dashboard/diagnostics | Diagnostic bundle | routes.ts:360 |
| GET | /dashboard/log-tail | Tail daemon.log | routes.ts:392 |
| POST | /dashboard/voice-health | Voice watchdog telemetry ingest | routes.ts:432 |
| GET | /dashboard/voice-health | Voice health log read | routes.ts:470 |
| GET | /graph | Wiki graph | routes.ts:478 |
| GET | /graph/unified | Unified node graph | routes.ts:481 |
| GET | /wiki/page/:id | Wiki page detail | routes.ts:484 |
| GET | /services | Service status manifest | routes.ts:549 |
| GET | /sessions | List CC sessions | routes.ts:555 |
| GET | /sessions/:id | Session detail | routes.ts:633 |
| GET | /sessions/:id/transcript | Transcript chunks | routes.ts:647 |
| POST | /sessions/:id/prompt | Queue prompt for bridge | routes.ts:660 |
| GET | /dashboard/bridge-status | Bridge presence summary | routes.ts:679 |
| POST | /sessions/:id/suggest | Queue suggestion | routes.ts:687 |
| POST | /sessions/:id/focus | Focus bridge terminal | routes.ts:704 |
| POST | /sessions/:id/key | Inject nav key | routes.ts:715 |
| POST | /sessions/:id/phase | Set phase | routes.ts:733 |
| POST | /sessions/:id/pending-prompt | Set pending prompt | routes.ts:753 |
| DELETE | /sessions/:id/pending-prompt | Clear pending | routes.ts:775 |
| GET | /sessions/:id/pending-prompt | Read pending | routes.ts:781 |
| POST | /sessions/:id/lex-pulse | Lex push pulse | routes.ts:815 |
| POST | /sessions/:id/terminal-stream | Bridge writes terminal bytes | routes.ts:851 |
| GET | /sessions/:id/terminal-replay | Replay terminal ring | routes.ts:872 |
| GET | /sessions/:id/terminal (WS) | Live terminal fan-out | routes.ts:880 |
| GET | /pty | List PTYs | routes.ts:904 |
| GET | /lex/anchors | List Lex anchors | routes.ts:927 |
| GET | /lex/anchors/:id | Anchor detail | routes.ts:966 |
| POST | /lex/anchors | Create anchor | routes.ts:1003 |
| POST | /lex/anchors/:id/open | Spawn or rebind | routes.ts:1119 |
| PATCH | /lex/anchors/:id | Rename | routes.ts:1195 |
| POST | /lex/anchors/:id/end | End | routes.ts:1245 |
| GET | /lex/anchor-tiles | Stream Deck tiles | routes.ts:1266 |
| DELETE | /lex/anchors/:id | Delete | routes.ts:1270 |
| GET | /lex/sessions/:id/artifacts | List artifacts | routes.ts:1311 |
| GET | /lex/artifacts/:kind/:id | Read artifact | routes.ts:1429 |
| POST | /lex/sessions/:id/artifacts | Append artifact | routes.ts:1456 |
| GET | /voice/whisper-status | Whisper status | routes.ts:1480 |
| POST | /voice/whisper-prewarm | Prewarm whisper | routes.ts:1485 |
| GET | /voice/piper-status | Piper status | routes.ts:1494 |
| POST | /voice/set-voice | Set Piper voice | routes.ts:1499 |
| POST | /voice/set-speed | Set TTS speed | routes.ts:1517 |
| POST | /voice/set-barge-cooldown | Barge cooldown | routes.ts:1531 |
| POST | /voice/set-vad-sensitivity | VAD sensitivity | routes.ts:1546 |
| POST | /voice/set-vad-redemption | VAD redemption | routes.ts:1561 |
| POST | /voice/set-mic-gain | Mic gain | routes.ts:1576 |
| POST | /voice/synthesize | One-shot TTS | routes.ts:1588 |
| GET | /voice/lex-ws (WS) | Lex voice WS | routes.ts:1610 |
| POST | /voice/mute | Mute TTS | routes.ts:1632 |
| POST | /voice/unmute | Unmute TTS | routes.ts:1633 |
| POST | /voice/stop | Stop TTS | routes.ts:1634 |
| POST | /voice/transcribe | One-shot transcribe | routes.ts:1636 |
| GET | /pty/:id/output | PTY output snapshot | routes.ts:1672 |
| POST | /pty/spawn-lex | Spawn Lex PTY | routes.ts:1679 |
| POST | /pty/:id/inject | Inject text into PTY | routes.ts:1793 |
| POST | /pty/:id/resize | Resize PTY | routes.ts:1809 |
| DELETE | /pty/:id | Kill PTY | routes.ts:1829 |
| POST | /sessions/:id/inject | Inject via bridge | routes.ts:1844 |
| POST | /sessions/clear-supersede | Mark superseded | routes.ts:1860 |
| POST | /search/all | Unified search | routes.ts:1876 |
| POST | /lex/recall | Recall for Lex | routes.ts:1916 |
| POST | /lex/chunk-search | Brainstorm chunk search | routes.ts:1981 |
| POST | /lex/steer/:sessionOrPty | Steer message | routes.ts:2008 |
| POST | /lex/capture | Capture inline artifact | routes.ts:2027 |
| GET | /lex/snapshot | Live snapshot | routes.ts:2066 |
| GET | /reminders | List reminders | routes.ts:2150 |
| POST | /reminders | Create | routes.ts:2152 |
| PATCH | /reminders/:id | Update | routes.ts:2174 |
| DELETE | /reminders/:id | Delete | routes.ts:2202 |
| POST | /reminders/:id/archive | Archive | routes.ts:2208 |
| GET | /notifications | List | routes.ts:2215 |
| POST | /notifications | Create | routes.ts:2233 |
| POST | /notifications/:id/dismiss | Dismiss | routes.ts:2264 |
| GET | /push/vapid-public-key | VAPID pubkey | routes.ts:2276 |
| POST | /push/subscribe | Subscribe | routes.ts:2281 |
| DELETE | /push/subscribe/:id | Unsubscribe | routes.ts:2299 |
| GET | /push/subscriptions | List subs | routes.ts:2305 |
| POST | /projects/new | New project flow | routes.ts:2316 |
| POST | /projects/:id/start-claude | Start Claude in workspace | routes.ts:2353 |
| POST | /uploads/screenshot | Upload screenshot | routes.ts:2420 |
| POST | /upload | Upload reference doc | routes.ts:2481 |
| GET | /reference | List reference docs | routes.ts:2532 |
| GET | /reference/:doc_id | Reference doc detail | routes.ts:2542 |
| GET | /stats/loc | Lines-of-code stats | routes.ts:2566 |
| GET | /stats/kpi | KPI rollup | routes.ts:2856 |
| GET | /stats/curator-health | Curator KPIs | routes.ts:2978 |
| GET | /stats/brainstorm-kpi | Brainstorm KPIs | routes.ts:3018 |
| GET | /stats/outbound | Outbound log summary | routes.ts:3061 |
| GET | /admin/backfill/status | Backfill status | routes.ts:3123 |
| POST | /admin/backfill/raw | Start raw backfill | routes.ts:3128 |
| POST | /admin/backfill/wiki | Start wiki backfill | routes.ts:3142 |
| POST | /admin/repair/wiki-cross-refs | Repair cross-refs | routes.ts:3160 |
| POST | /admin/wiki/correct/:id | Correct page | routes.ts:3170 |
| POST | /admin/wiki/promote/:id | Promote pending -> canonical | routes.ts:3187 |
| POST | /admin/daemon/restart | Graceful restart | routes.ts:3245 |
| POST | /admin/backfill/:mode/cancel | Cancel backfill | routes.ts:3344 |
| GET | /brainstorms | List brainstorms | routes.ts:3361 |
| GET | /brainstorms/:id | Brainstorm detail | routes.ts:3393 |
| GET | /brainstorms/:id/chunks | Chunks for a brainstorm | routes.ts:3409 |
| GET | /brainstorms/:id/cues | Audio cues JSON | routes.ts:3424 |
| GET | /brainstorms/:id/audio | Audio WAV stream | routes.ts:3451 |
| GET | /meetings | List meetings | routes.ts:3505 |
| GET | /meetings/:id | Meeting detail | routes.ts:3524 |
| POST | /meetings/:id/consent-ack | Ack consent | routes.ts:3551 |
| POST | /meetings/:id/keep-audio | Pin audio | routes.ts:3567 |
| POST | /meetings/:id/action-items | Add action item | routes.ts:3579 |
| PATCH | /meetings/:id/action-items/:aid | Update action item | routes.ts:3608 |
| POST | /meetings/:id/promote-to-wiki | Meeting -> wiki draft | routes.ts:3629 |
| POST | /lex/feedback | Submit thumbs vote | routes.ts:3690 |
| GET | /lex/feedback | List feedback | routes.ts:3723 |
| GET | /lex/feedback/up-rate/:version | Up-rate per version | routes.ts:3738 |
| GET | /lex/awareness/recent | Recent awareness events | routes.ts:3747 |
| POST | /lex/awareness/emit | Emit awareness event | routes.ts:3759 |
| POST | /lex/awareness/mode | Set awareness mode | routes.ts:3781 |
| GET | /lex/retrieval-trace | Retrieval log | routes.ts:3795 |
| GET | /lex/prompts/versions | List archived prompt versions | routes.ts:3817 |
| POST | /admin/lex-replay | A/B replay run | routes.ts:3822 |
| GET | /lex/prompts/:version | Read archived prompt | routes.ts:3842 |
| GET | /audit-findings | List audit findings | routes.ts:3858 |
| POST | /audit-findings/:id/:action | ack/resolve/dismiss | routes.ts:3883 |
| POST | /admin/lint/run | Trigger lint | routes.ts:3909 |
| POST | /admin/self-audit/run | Trigger self-audit | routes.ts:3919 |
| POST | /admin/janitor/run | Trigger memory janitor | routes.ts:3930 |
| POST | /lex/inject-cross-session | HMAC-gated cross-session inject | routes.ts:3950 |
| POST | /auth/cross-session-token | Mint HMAC token | routes.ts:4141 |
| POST | /worker/clear-handoff | Clear worker handoff doc | routes.ts:4196 |
| POST | /lex/cold-start-preload | Cold-start preload (SessionStart hook) | routes.ts:4225 |
| GET | /lex/cold-start-preload/toggle | Read toggle | routes.ts:4444 |
| POST | /lex/cold-start-preload/toggle | Set toggle | routes.ts:4459 |
| GET | /lex/cold-start-preload/events | Recent shadow events | routes.ts:4495 |
| GET | /lex/auto-advance/toggle | Read auto-advance mode | routes.ts:4529 |
| POST | /lex/auto-advance/toggle | Set auto-advance mode | routes.ts:4544 |
| GET | /lex/auto-advance/recent | Auto-advance log | routes.ts:4579 |
| GET | /lex/backlog | Read backlog | routes.ts:4616 |
| POST | /lex/backlog | Create/update backlog | routes.ts:4630 |
| GET | /lex/injection-log | Cross-session inject log | routes.ts:4739 |
| POST | /curator/wrong | Mark wrong inject | routes.ts:4766 |
| GET | /runtime-config | Read all runtime config | routes.ts:4797 |
| POST | /runtime-config/:key | Set runtime config | routes.ts:4802 |
| GET | /brainstorms/backfill-review | Review queue | routes.ts:4825 |
| POST | /brainstorms/backfill-review/:id/link | Link review item | routes.ts:4839 |
| POST | /brainstorms/backfill-review/:id/reject | Reject review item | routes.ts:4870 |
| POST | /admin/backfill/brainstorms | Run brainstorm backfill | routes.ts:4890 |
| GET | /drafts | List wiki drafts | routes.ts:4908 |
| GET | /drafts/:id | Draft detail | routes.ts:4916 |
| PATCH | /drafts/:id | Update draft | routes.ts:4926 |
| POST | /drafts/:id/discard | Discard draft | routes.ts:4964 |
| POST | /drafts/:id/promote | Promote to pending wiki page | routes.ts:4986 |
| POST | /lex/smart-compact/evaluate | Evaluate compact | smart-compact-routes.ts:776 |
| POST | /lex/smart-compact/fire | Fire compact | smart-compact-routes.ts:794 |
| GET | /lex/smart-compact/recent | Recent log | smart-compact-routes.ts:848 |
| GET | /lex/smart-compact/toggle | Read toggle | smart-compact-routes.ts:864 |
| POST | /lex/smart-compact/toggle | Set toggle | smart-compact-routes.ts:876 |

### WebSocket endpoints (daemon side)

| Path | Purpose | File |
|---|---|---|
| GET /sessions/:id/terminal | Live per-session terminal fan-out (256KB ring + new bytes) | routes.ts:880 |
| GET /voice/lex-ws | Lex voice WS (PCM in, transcript/TTS PCM out, barge-in control) | routes.ts:1610 |

Fastify plugins registered: `@fastify/cookie`, `@fastify/multipart` (limit env `DEVNEURAL_UPLOAD_MAX_BYTES`, default 100MB, 1 file), `@fastify/websocket`, `@fastify/static`.

---

### Schedulers, intervals, crons

All wired in `daemon.ts`. Every timer `.unref()`s so it does not pin the event loop.

| Job | Default cadence | Env tunable(s) | Source |
|---|---|---|---|
| HTTP per-request timing log | per-req | silent paths excluded inline | daemon.ts:717 |
| Bridge presence loop | 1s interval, 30s freshness | DEVNEURAL_BRIDGE_PRESENCE_INTERVAL_MS, DEVNEURAL_BRIDGE_TIMEOUT_MS | daemon.ts:161 |
| Distillation backfill scheduler (LLM) | first +30s, then 10min | DEVNEURAL_DISTILL_SCHEDULER_INTERVAL_MS, DEVNEURAL_DISTILL_SCHEDULER_FIRST_FIRE_MS | daemon.ts:183 + lex/distillation-scheduler.ts |
| Worker event listener | event-driven (chokidar) | n/a | daemon.ts:200 |
| Heartbeat poster | 60s | DEVNEURAL_HEARTBEAT_INTERVAL_MS, DEVNEURAL_HEARTBEAT_URL | daemon.ts:211 |
| Raw-chunks cull | first +60s, then 24h | DEVNEURAL_RAW_CHUNK_CULL_INTERVAL_MS, DEVNEURAL_RAW_CHUNK_CULL_AGE_DAYS | daemon.ts:219 |
| Meeting audio purge | first +90s, then 24h | DEVNEURAL_MEETING_AUDIO_PURGE_INTERVAL_MS, DEVNEURAL_MEETING_AUDIO_MAX_AGE_DAYS | daemon.ts:241 |
| Self-audit | first +15min, then 7d | DEVNEURAL_SELF_AUDIT_INTERVAL_MS | daemon.ts:272 |
| Lint nightly | first +5min, then 24h | DEVNEURAL_LINT_NIGHTLY_INTERVAL_MS | daemon.ts:301 |
| Reminder due sweep | first +30s, then 5min | DEVNEURAL_REMINDER_SWEEP_INTERVAL_MS | daemon.ts:323 |
| Sibling distill backfill (LLM) | first +60s, then 6h | DEVNEURAL_DISTILL_BACKFILL_INTERVAL_MS, DEVNEURAL_DISTILL_BACKFILL_LIMIT | daemon.ts:377 |
| Smart-compact tick | first +90s, then 60s | DEVNEURAL_SMART_COMPACT_TICK_MS, DEVNEURAL_SMART_COMPACT_ENABLED | daemon.ts:446 |
| Worker stall watch | first +120s, then 60s | DEVNEURAL_STALL_TICK_MS, DEVNEURAL_STALL_TOOL_MS (5min), DEVNEURAL_STALL_USER_MS (3min), DEVNEURAL_STALL_COOLDOWN_MS | daemon.ts:509 |
| Memory janitor | first +20min, then 7d | DEVNEURAL_JANITOR_INTERVAL_MS | daemon.ts:544 |
| Personality guard | chokidar | n/a | daemon.ts:570 |
| Auto-resume wiki backfill | 5s after boot if cursor incomplete | DEVNEURAL_AUTO_RESUME_WIKI=0 disables | daemon.ts:1172 |
| Auto-ingest interval | 5min | DEVNEURAL_AUTO_INGEST_INTERVAL_MS | daemon.ts:1243 + wiki/auto-ingest.ts |
| Wiki push | 5min | DEVNEURAL_WIKI_PUSH_INTERVAL_MS | daemon.ts:1256 + wiki/push.ts |
| Reinforcement decay | 24h | DEVNEURAL_DECAY_INTERVAL_MS=0 disables | daemon.ts:1272 |
| Brainstorm jsonl ingestor | 5s | n/a | lex/brainstorm-jsonl-ingestor.ts |
| VRAM monitor | 5s | DEVNEURAL_VRAM_BACKOFF_MS, DEVNEURAL_VRAM_FLOOR_MB | gpu/vram-monitor.ts |
| Git watcher | 30s | DEVNEURAL_GIT_POLL_MS | capture/git-watcher.ts |
| Session phase decay | 60s passive | n/a | dashboard/session-phase.ts |
| Notification retention | 30d on read | n/a | dashboard/notifications.ts |
| Superseded session retention | 7d on read | n/a | dashboard/superseded.ts |

---

### Filesystem layout

`<dataRoot>` = `C:/dev/data/skill-connections` (env `DEVNEURAL_DATA_ROOT`).

```
<dataRoot>/
  daemon.pid                                  process lock
  daemon.lock/                                spawn-race lock dir
  daemon.log                                  rotating log (single file)
  daemon.sock                                 reserved
  index.db                                    SQLite + FTS5 (WAL: index.db-wal, -shm)
  projects.json                               project registry
  projects/<id>/
    project.json                              per-project identity
    observations.jsonl                        capture log
    observations.archive                      rotated capture
    transcripts.jsonl                         daemon-side transcript mirror
    .observer-signal-counter                  hook signal cadence
    .last-purge                               archive purge cursor
  global/                                     placeholder
  wiki/                                       git repo (locally committed)
    DEVNEURAL.md                              schema doc
    index.md                                  index
    log.md                                    operation log
    whats-new.md                              weekly digest
    pages/<id>.md                             canonical pages
    pending/<id>.md                           pending pages
    archive/<id>.md                           archived pages
    glossary/<projectId>.md                   per-project glossary
  session-state/
    <sessionId>.summary.md                    rolling session digest
    <sessionId>.task.md                       current-task memory
    <sessionId>.meta.json                     summary cursor
  session-bridge/
    .workspace-inject/                        markers for bridge "open + type"
    (bridge mailbox files)                    legacy bridge prompts
  superseded-sessions.json                    /clear successor map
  lex-prompts/
    <version>.md                              archived system-prompt revisions
    few-shot/<mode>.md                        per-mode few-shot
    refusal-contract.md                       refusal block
    refusal-contract-meeting.md               meeting variant
  lex-replay-output/<ts>/
    diff.md, version-a.txt, version-b.txt    A/B replay artifacts
  brainstorms/<brainstormId>/
    audio/<brainstormId>.wav                  PCM-derived WAV
    audio/<brainstormId>.cues.json            turn cue list
    audio/<brainstormId>.pcm.tmp              transient append-only PCM
  reference/
    queue/                                    upload queue
    docs/                                     processed docs
    images/                                   processed images
    audio/                                    processed audio
    video/                                    processed video
  dashboard/
    auth.json                                 HMAC root secret
    vapid.json                                VAPID keypair
    push-subscriptions.jsonl                  Web push subs
    notifications.jsonl                       Notification log
    reminders.jsonl                           Reminder log
    reminder-pushes.jsonl                     Push dedupe ledger
    config.jsonc                              Service status manifest
  lex/thread-docs/<brainstormId>.md           Session-end handoff doc
  chroma/collections/                         legacy path; vector store collections (raw_chunks, wiki_pages, reference_chunks) live as `.vec` + `.meta.jsonl` + `.head.json` files
  corpus-seed.state.json                      Initial corpus seed cursor
  .backfill-raw.json                          Raw backfill cursor
  .backfill-wiki.json                         Wiki backfill cursor
```

Outside `<dataRoot>`:

```
~/.claude/
  settings.json                               Hook registrations (install-hooks.ts)
  projects/<slug>/<sessionId>.jsonl           CC transcript files (read by transcript-watcher, lex/sibling-index, sessions list, worker-event-listener)
C:/dev/Projects/                              FS watcher root (env DEVNEURAL_FS_ROOT)
C:/dev/Projects/DevNeural/docs/INDEX.md      Tier-3 docs index injected per turn (env DEVNEURAL_REPO_ROOT)
C:/dev/Projects/<repo>/                       Project roots (resolveProjectIdentity targets)
C:/dev/piper/piper/piper.exe                 Piper TTS binary (env DEVNEURAL_PIPER_BIN)
C:/dev/piper/voices/                          Piper voice .onnx files (env DEVNEURAL_PIPER_VOICE)
C:/dev/whisper.cpp/cublas/Release/whisper-server.exe  Whisper server (env DEVNEURAL_WHISPER_BIN)
C:/dev/whisper.cpp/models/ggml-medium.en.bin  Whisper model (env DEVNEURAL_WHISPER_MODEL)
<bridgeDir>/.bridge-presence/<workspace>.json VS Code bridge presence (polled every 1s)
C:/tmp/lex-backlog-queue.json                Legacy JSON backlog (superseded by lex_backlog_items table, mig 026)
```

---

### Notable cross-cutting invariants

- Every voice-session-derived payload (`payload_class LIKE 'brainstorm-%'` or `'meeting-%'`, or `contains_voice_session_source=1`) is blocked from outbound by the SQLite trigger `outbound_no_voice_session` plus the application-layer outbound-guard (BF-4/PB-2).
- `cross_session_injection_log.decision` CHECK constraint grew across migrations 017/024/029/032; current valid set: `accepted | rejected_auth | rejected_allowlist | rejected_pty | shadow | redirected | dispatched_dead_session | rejected_anchor_dormant | no_deliverable_bridge`.
- `auto_advance_log.decision` valid set: `shadow | would-inject | accepted | skip | error` (mig 028).
- `panic_log.result` valid set: `accepted | pty_not_found | no_target` (mig 020).
- `smart_compact_log.action` valid set: `fire | wrap | shadow | noop` (mig 021).
- Anchors enforce `supervision_mode IN ('polling','event','off')` via application code (mig 022 + `parseSupervisionModeValue`). Runtime override key: `default_supervision_mode`.
- COOP/COEP/CORP headers (`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`, `Cross-Origin-Resource-Policy: same-origin`) stamped on every response (daemon.ts:743) so onnxruntime-web's threaded WASM build can grow past single-thread heap.
- Browser HTML navigations on routes that collide with API paths (`/sessions`, `/projects`, `/reminders`) are short-circuited to the matching `<route>.html` static file via an onRequest hook (daemon.ts:664) so the SPA renders instead of leaking JSON.
- HTML responses always carry `Cache-Control: no-store, no-cache, must-revalidate`; `/_next/static/**` carries `public, max-age=31536000, immutable` (daemon.ts:1057).
