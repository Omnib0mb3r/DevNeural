# Postmortem: voice TTS silent after overnight rebuild

Date: 2026-05-17 ~00:55 local.
Operator: Lex (anchor `4bbafb48`).
Impact: ~15 min. User opened `/lex` in voice mode, no audio on Lex
replies. Daemon health 200 throughout. Resolved by `npm run build`
across both packages, daemon admin-restart, and a browser hard
refresh.

## Symptoms

- User in voice mode hears no TTS audio on Lex replies.
- Transcript turns render in the panel; user-side STT works.
- Hard refresh of dashboard did not restore audio on its own.

## Initial suspect list (from the operator)

1. `fee5916` — feat(lex): unify voice + text transcript stream
   (transcript ingestor + voice WS chunk dedupe changes).
2. `393d4f5` — fix(voice): SharedArrayBuffer + singleton VAD/ORT init
   (COOP/COEP + getVadModule + numThreads gating).

## What I found

The "fresh restart" the user did relaunched the **stale May 16
01:42 build**. It pre-dated every commit in the overnight queue.
Evidence:

| probe | result | interpretation |
|---|---|---|
| `dist/daemon.js` mtime | May 16 01:42 | running binary pre-dates queue |
| `grep -c "Cross-Origin-Opener-Policy" dist/daemon.js` | 0 | 393d4f5 onSend hook missing |
| `POST /voice/mute` | 404 | 0fe27f1 routes missing |
| `GET /lex/auto-advance/recent` | 200 | 3e436a3 IS loaded |
| `out/index.html` mtime | May 16 01:42 | dashboard shell pre-dates queue too |

The running build sat at roughly `3e436a3` (supervisor phase 4) —
the last commit before the overnight run. Eight subsequent commits
including 393d4f5 + fee5916 were on disk in `src/` and `master`,
but had never been compiled or shipped to `dist/` / `out/`.

The user's suspect commits were therefore NOT the cause: they were
not running.

## Why voice was silent

Two cascading reasons:

1. **The dashboard shell loaded against a daemon that had no
   `Cross-Origin-Opener-Policy` header.** The new dashboard build
   (when it finally landed) ships code that assumes
   `crossOriginIsolated === true` to enable threaded ORT/WASM with
   a SharedArrayBuffer-backed Memory. Without COOP/COEP on the
   served HTML, the browser tab stays non-isolated and the threaded
   WASM path either fails to load workers or grows the unthreaded
   heap until it OOMs the VAD remount. Symptoms blame the voice
   path even though the regression is upstream of voice.

2. **The dashboard's service worker was registered against the
   pre-overnight shell.** SW had `skipWaiting()` + `clients.claim()`
   from the start, but the dashboard the user was loading was the
   May 16 01:42 build; the SW had already activated against that
   build's references. A hard refresh on its own bypasses HTTP
   cache but does NOT force the browser to re-evaluate
   `crossOriginIsolated` against the new headers — that requires a
   top-level navigation against a freshly-headered response, after
   the new shell is on disk.

The combination meant:
- pre-rebuild: voice broke under the May 16 01:42 build because
  some path in that build's voice code (likely VAD remount under
  heap pressure) was hitting the same RangeError 393d4f5 was
  meant to fix.
- post-rebuild but pre-restart: daemon still served the old
  headers, dashboard still served the old shell. No change for the
  user.
- post-restart but pre-hard-refresh: daemon served the new headers
  and the new HTML, but the browser still held the old shell + SW
  state in memory. Audio still silent.
- post-hard-refresh: browser drew a fresh document from the new
  daemon, the new headers landed, the SW re-fetched its now-
  freshly-stamped `__BUILD_VERSION__`, the page became
  `crossOriginIsolated`, the singleton ORT init from 393d4f5 ran
  on the threaded WASM path, VAD initialised without OOM, TTS
  played.

## Fix path that actually worked

1. `cd 07-daemon && npm run build` (typecheck-only `tsc` → fresh `dist/`).
2. `cd 08-dashboard && npm run build` (Next static export → fresh
   `out/` + postbuild SW version stamp).
3. `POST /admin/daemon/restart` (graceful shutdown via the existing
   admin route; PowerShell relauncher + 6s sidecar watchdog from
   `daemon.ts`). Daemon respawned as pid 11552, uptime ticking
   from 0.
4. Verified live endpoints:
   - `POST /voice/mute` → 200 (was 404).
   - `GET /lex` Cache-Control header: `no-store, no-cache,
     must-revalidate`.
   - `cross-origin-opener-policy: same-origin`
   - `cross-origin-embedder-policy: require-corp`
   - `cross-origin-resource-policy: same-origin`
5. User hard-refreshed dashboard. TTS audio restored on first
   try.

## Why this slipped

- The handover (`HANDOVER-overnight-2026-05-16.md`) called out
  "five items need daemon bounce" but the "fresh restart" the user
  did was a process bounce of the stale binary, not a rebuild +
  bounce. Easy mistake when the daemon's restart command line is
  `node dist/daemon.js` — bouncing the process never recompiles.
- `dist/` is gitignored. Nothing in the operator workflow surfaces
  "your dist is stale" — the daemon comes up green and serves the
  old code as if nothing changed.
- Dashboard `out/` is also gitignored. The daemon's static-serve
  warns if `out/` is missing but does not warn if it's outdated.

## Mitigation candidates (not implemented; record-only)

1. **Boot-time staleness warning**. On daemon start, compare
   `dist/daemon.js` mtime to the latest commit's authored date on
   `master`. If `dist` is older, log a single line
   `WARN: dist is N minutes older than HEAD; rebuild before
   restarting`. Cheap; no behavioural change.
2. **Same for `out/`**: warn if `out/index.html` is older than
   `08-dashboard/src/` or `app/` mtimes.
3. **Dashboard supervisor (42d8d9b) covers the dev-mode case**: a
   future `next dev` supervised child means dashboard hot-reload
   covers code changes, so this whole class of "I rebuilt and
   then forgot to reload" goes away for the dev/voice loop. Worth
   landing once verified.

The voice fix path itself (393d4f5 + 39aa803 + fee5916) is
correct; the regression was operational, not in the code under
suspicion.

## Resolution

- Code: no change needed. The overnight queue was already correct.
- Operator: rebuild both packages whenever the queue ships code,
  not just bounce the daemon.
- Doc: this postmortem + the dashboard-supervisor TODO line
  (already shipped at 42d8d9b) cover the workflow side.
- Verification list in `HANDOVER-overnight-2026-05-16.md` remains
  open for the other four daemon-bounce-gated items; all should
  now be live since the daemon is on the fresh dist.
