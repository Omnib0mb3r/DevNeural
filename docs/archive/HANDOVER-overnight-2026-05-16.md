# Overnight Handover 2026-05-16

Date: 2026-05-16, generated ~03:10 local.
Operator: Lex (DevNeural Testing brainstorm anchor `4bbafb48`).
Worker: DevNeural session `2d87f4ca-d6c7-497a-b041-4147fe7b0678`.

## Headline

Entire queued backlog shipped autonomously. 11 commits since `c527234`,
no stop conditions triggered, no destructive escalations. All
typecheck + targeted vitest suites green per push. Two checklist
items deferred for human-in-loop (reinforcement smoke, Stream Deck
physical verify). Branch in sync with origin/master.

## Commits this run (newest first)

```
c29a954 fix(dashboard): terminal mirror auto-scroll with timed resume
39aa803 fix(daemon): no-store on every HTML send path
fee5916 feat(lex): unify voice + text turns into one transcript stream
358f1f4 fix(lex): typed textarea injects now show in transcript panel
dc60128 docs(agents): ban chained-destructive Bash in CLAUDE.md
0fe27f1 feat(lex): dashboard voice controls as Lex tools
2778443 fix(lex): dedupe prompt archive by content + backfill modes at boot
a263465 docs(smoke): lex session rewrite verification 2026-05-16
42d8d9b feat(daemon): supervise next dev as managed child
393d4f5 fix(voice): unlock SharedArrayBuffer + singleton VAD/ORT init
3e436a3 feat(supervisor): auto-advance toggle + recent panel + Lex-cron handoff (phase 4)
```

## Themes shipped

1. **Autonomous supervisor phase 4 (`3e436a3`)**. Operator-facing
   toggle for `auto_advance_mode` (off / shadow / live) plus a
   recent-decisions panel powered by the supervisor's audit log.
   Lex-cron handoff doc lands the cron schedule and the runtime
   knobs so the operator can flip live without code edits. Phases
   1-3 (status-footer protocol, backlog sqlite, shadow loop) shipped
   earlier in the queue; phase 4 closes the surface.

2. **Voice WASM/VAD OOM fix (`393d4f5`)**. Daemon onSend hook +
   Next dev `async headers()` emit COOP=same-origin + COEP=require-corp
   + CORP=same-origin so the dashboard tab is `crossOriginIsolated`
   and ORT can pick the threaded WASM build with a SharedArrayBuffer-
   backed growable Memory. Stops the "no available backend found.
   ERR: [wasm] RangeError: Out of memory" cascade on VAD remount.
   Singleton vad-web import via `getVadModule()` so remount reuses
   the configured ORT instance instead of re-running the pin and
   re-instantiating WASM every mount. `VAD_NUM_THREADS` bumps to 2
   when the tab is isolated, stays at 1 otherwise so non-isolated
   fallback keeps working.

3. **Dashboard supervisor (`42d8d9b`)**. Daemon manages a single
   `next dev -p 3000` child process so dashboard edits rebuild
   without a separate terminal. Toggle: `runtime_config.dashboard
   _supervisor_enabled` (row > env > CI=true → off > default on).
   Restart loop doubles backoff on fast crash, resets after a long
   run; `taskkill /t /f` tears the next compiler-worker tree on
   Windows.

4. **Prompt-archive dedupe + boot backfill (`2778443`)**. Found two
   real defects: `listVersionsSorted` was picking up
   `refusal-contract*.md` siblings (empty hash, sorted last) so the
   latest-entry dedupe check always compared the new hash to "" and
   wrote every assembly. And the dedupe checked only the latest
   entry, so an A → B → A sequence wrote A twice. Filter the regex
   to the `<ts>__<hash>` shape, switch dedupe to a full-archive
   hash scan. Added `backfillPromptVersions(assembler, modes)` +
   `buildLexSystemPromptStable(mode)`; daemon walks the canonical
   modes once at boot so the step-21 A/B replay harness has a
   baseline per mode on a fresh checkout.

5. **Lex dashboard voice controls (`0fe27f1`)**. `POST /voice/mute`,
   `/voice/unmute`, `/voice/stop` fan `voice-mute` / `voice-unmute` /
   `voice-disable` frames over the existing `/voice/lex-ws` sockets.
   Body `{ bind_key?, reason? }` targets a single connection or
   broadcasts to every active voice client. `broadcastVoiceControl`
   in `lex-voice-ws.ts` is the shared seam: same registry the
   spoken voice-command path uses, so HTTP and voice commands
   deliver identical frames and the browser handler stays one code
   path. `/voice/stop` maps to `voice-disable` (stop voice session,
   keep brainstorm) not `session-end` (which would tear the
   brainstorm row down). API_SURFACE block in the system prompt
   documents the three endpoints so Lex sees them as tools.

6. **Project-level CLAUDE.md (`dc60128`)**. Bans chained
   destructive Bash (cd && rm && rm). Reason: Claude Code's
   permission matcher evaluates a chained command as one token
   against the allow-list, so allow patterns for `rm <path>` do not
   decompose the chain and every routine multi-rm sweep tripped a
   prompt. Path-(a) fix per the discussion; path-(b) (PreToolUse
   hook reimplementing the matcher) deferred unless this drifts
   back.

7. **Dashboard typed-textarea -> transcript panel (`358f1f4`)**.
   `injectM.onSuccess(data, text)` now emits a user turn to the
   transcript bus alongside the voice STT path. The typed input
   went straight to `ptyInject` before and never showed in
   `LexTranscriptHistoryPanel`. Local turn id prefix `u-typed-`
   distinguishes source.

8. **Transcript ingestion unifies voice + text (`fee5916`)**.
   `brainstorm-jsonl-ingestor` tails every active brainstorm's CC
   jsonl from a per-session byte offset and inserts a
   `brainstorm_chunks` row for each user / assistant turn.
   Idempotent via deterministic chunk id (= cc turn uuid) + INSERT
   OR REPLACE on the PK, so the voice WS path and the ingestor
   converge on the same row. Voice WS user-side insert removed
   (was duplicating with `randomUUID` against the ingestor's
   `uuid` row); assistant insert now also uses the cc turn uuid so
   the ingestor's re-insert is a true no-op. Typed inputs + text-
   mode Lex replies finally land in the same transcript artifact
   with jsonl write-order and `user` / `lex` speaker tags.

9. **Dashboard stale-shell fix (`39aa803`)**. Two inline HTML send
   paths (early SPA-vs-API collision guard + SPA fallback)
   bypassed fastify-static's `setHeaders` callback. iOS Safari and
   desktop Chrome cached the un-headered shell across deploys.
   Both inline paths now set `Cache-Control: no-store, no-cache,
   must-revalidate` + Pragma + Expires before send. SW, post-build
   SW version stamp, and hashed `_next/static/**` caching were all
   already correct; the bug was confined to the two inline paths.

10. **Terminal mirror auto-scroll (`c29a954`)**. Auto-tail with
    timed resume. Viewport pinned to bottom by default; scroll up
    pauses tail without yanking the user back; after 4s of no
    further scroll activity, snap back to bottom and resume.
    Logic lives in `lib/terminal-auto-scroll.ts` behind a
    scheduler seam so the state machine is testable without
    xterm. Controller wired into `TerminalMirror` via
    `term.onScroll` + dispose on cleanup.

## Parked items (still parked)

- **Reinforcement-event end-to-end smoke** (TODO.md line 18).
  Needs a real user-prompt-submit hook firing from a separate
  Claude Code session against a wiki match. I am the Claude; I
  cannot synthesise the user side. Three execution paths
  available: watch-mode (tail `/reinforcement/events` while you
  type in a parallel CC session — confirms full chain), wiring
  smoke (curl endpoints + synthetic event — confirms endpoints
  only), fixture injection (write fake injected + raw-hit rows —
  confirms panel render only). User picked: defer to morning.

- **Stream Deck physical render** of the brainstorm tile group.
  Confirmed via curl that `GET /lex/anchor-tiles` returns the
  expected payload (single tile for "DevNeural Testing",
  phase=thinking, current_pty_id matches the anchor row). Physical
  deck verification needs a human at the keyboard. Tracked in
  `docs/SMOKE-lex-session-rewrite-2026-05-16.md`.

## Open verification items

- **VAD remount on a real iPhone** (393d4f5). Daemon must be
  rebuilt + restarted so the new COOP/COEP onSend hook lands on
  the static-served dashboard. Then open `/lex` on the phone,
  start voice, mute, unmute, switch tab, return, confirm VAD does
  NOT cascade into the RangeError. Verify
  `window.crossOriginIsolated === true` in the page console.

- **Dashboard supervisor live spawn** (42d8d9b). Restart the
  daemon and tail `/system/log` for the `[dashboard-supervisor]
  spawning next dev -p 3000 (attempt #1)` line. Then edit a
  dashboard file and confirm HMR fires without a manual `npm run
  dev` in a separate terminal.

- **Cache-Control on inline HTML send paths** (39aa803). After
  daemon rebuild, hit `curl -I http://127.0.0.1:3747/lex` and
  confirm the response carries `Cache-Control: no-store, no-cache,
  must-revalidate`. Then hit `curl -I http://127.0.0.1:3747/` (the
  fastify-static path) and confirm the same. iPhone home-screen
  PWA shortcut should pick up the next deploy without a manual
  "reload page" tap.

- **Voice control tools live** (0fe27f1). Restart the daemon
  (running build predates the routes; current 404). Then
  `curl -X POST http://127.0.0.1:3747/voice/stop -H "Content-Type:
  application/json" -d '{"reason":"smoke"}'` from a worker session
  and confirm the dashboard voice panel flips off.

- **Brainstorm jsonl ingestor live** (fee5916). Restart the
  daemon, wait 5s, then check `/brainstorms/4bbafb48-bbfd-47e6-
  b076-e1a58a334303/chunks` and confirm the row count tracks the
  CC jsonl length. Type a message in `/lex` (don't speak), wait
  5s, refresh the chunks endpoint, confirm the typed turn landed
  with `role='user'`.

- **Terminal mirror auto-scroll resume** (c29a954). After
  dashboard rebuild + reload, scroll up in the TerminalMirror,
  wait 4s without further scrolling, confirm the viewport snaps
  back to the bottom and starts tailing again. New output while
  scrolled up should NOT pull the viewport down.

- **Lex session rewrite smoke** (a263465). Three operator items
  in `docs/SMOKE-lex-session-rewrite-2026-05-16.md`: Stream Deck
  render confirmation, real-session end button, spawn branch
  click-through on a dormant anchor.

## Daemon bounce required

Five of the items above need the daemon process to be restarted
so the newly built `dist/` actually serves the new code:

- COOP/COEP headers (393d4f5)
- Dashboard supervisor (42d8d9b)
- Voice control routes (0fe27f1)
- Brainstorm jsonl ingestor (fee5916)
- Inline HTML no-store (39aa803)

Running daemon currently at pid 55564, uptime ~6.9k seconds. The
prompt-archive boot backfill (2778443) and the auto-advance toggle
(3e436a3) also benefit from a bounce, though both fall back to
ad-hoc behaviour when not yet booted.

Suggested order: stage the dashboard rebuild first
(`cd 08-dashboard && npm run build`), then bounce the daemon
(`pwsh -c "Stop-Process -Id 55564 -Force"` followed by the lazy
spawn that a fresh hook fires), then walk the verification list.

## Suggested first-look in the morning

1. `git -C C:/dev/Projects/DevNeural log --oneline origin/master..HEAD`
   to confirm everything in the headline pushed. Should return
   empty.
2. Bounce the daemon per the above. Watch the daemon log for the
   `[dashboard-supervisor] spawning next dev` line and the
   `prompt-archive backfill: written=...` line on boot.
3. Walk the verification list. Most items are 30-second curl /
   click checks.
4. Tick the closed backlog items in `TODO.md` and clear the parked
   reinforcement-smoke item once you decide on watch-mode vs
   fixture-injection.
5. Empty the queue means the morning is open for the next batch.
   The two outstanding parents in the planning surface are the
   Phase Two implementation gates (P2-0 adversarial review still
   pending per memory note) and any voice/PWA polish that surfaces
   during the verification pass.
