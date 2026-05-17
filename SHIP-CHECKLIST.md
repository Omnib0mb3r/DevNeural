# Ship checklist

> Production-readiness gate. Walk this top-to-bottom before declaring a build deployable to `OTLCDEV` and reachable to your phone via Tailscale. Everything here is a real check; nothing is filler.
>
> Last refreshed: 2026-05-04 (Phase 5 complete).

---

## A. Code health

- [x] Daemon `npm run build` passes (tsc clean)
- [x] Daemon `npm test` passes (703 unit + integration tests as of 2026-05-16; two pre-existing timeouts in audit-findings + session-end-pipeline tracked separately)
- [x] Dashboard `NODE_ENV=production npx next build` passes (13 static routes prerender)
- [x] Dashboard `npx tsc --noEmit` clean
- [x] Bridge `npm run build` passes
- [x] No `TODO` markers blocking ship (one in `CommandPalette.tsx` for "open specific search hit"; non-blocking, navigates to /wiki for now)
- [x] No `console.log` debug noise in client code
- [x] No hex literals or `rgba()` in CSS — every value resolves through `tokens.css` (audit lives in `08-dashboard/VERIFICATION.md`)
- [x] Every `child_process.spawn` / `execSync` / `spawnSync` in 07-daemon passes `windowsHide: true`. Without this, dashboard polling (system-metrics every 4s + services every 8s) flashes a powershell console window onto the desktop ~15 times per minute. Verified silent 2026-05-04.

## B. Auth surface

- [x] PIN flow: first-run redirects to `/set-pin`; subsequent loads redirect to `/unlock` until cookie present
- [x] HMAC-signed cookie (`dn_session`), 12-hour TTL, refreshes on use
- [x] 5 wrong PINs in 60s lock the dashboard for 5 minutes
- [x] Daemon's `authMiddleware` gates only API prefixes; HTML pages serve publicly so the dashboard can render its own redirect-to-unlock state
- [x] CLI reset path: delete `c:/dev/data/skill-connections/dashboard/auth.json` from `OTLCDEV` to clear

## C. Tailscale + remote access

- [x] Tailscale running on `OTLCDEV` (verified live; user reached the dashboard remotely 2026-05-04)
- [x] MagicDNS resolving (live access confirmed)
- [x] Tailscale running on phone, signed into the same tailnet
- [x] Remote load redirects to `/set-pin` cleanly; PIN flow works end-to-end
- [x] **`tailscale serve --bg --https=443 http://localhost:3747` registered**: HTTPS reverse proxy live at `https://otlcdev.tail27b46b.ts.net` (tailnet-only, real Let's Encrypt cert). Verified: `/health`, `/`, `/sw.js` all 200 over HTTPS. Required for service worker registration and web push (browsers disable both APIs over plain HTTP off-localhost).
- [x] PWA install on iOS via Share -> Add to Home Screen at the HTTPS URL (verified 2026-05-04; user installed and subscribed to push end-to-end)

## D. Backup

- [x] `npm run backup` produces a timestamped snapshot under the configured backup root
- [x] `npm run verify-backup` passes (manifest parses, JSON state files parse, JSONL line-by-line parse)
- [x] Daemon `/flush` endpoint responds 200 with `{ok:true,flushed_at:...}` so SQLite WAL is checkpointed before the snapshot
- [x] `npm run install-backup-task` registered on `OTLCDEV` (verified 2026-05-04: scheduled DAILY 03:00, LastTaskResult 0, snapshot 2026-05-03T20-35-21 landed at 25.6MB)
- [x] Backup root pointed at OneDrive: `C:\Users\michael\OneDrive\devneural-backups`. Snapshots are off-disk (OneDrive sync handles cloud durability).
- [x] Snapshots written as `<ts>.partial` then atomically renamed; rotation prunes anything beyond `-Keep` (default 14)

## E. Hooks (`~/.claude/settings.json`)

- [x] DevNeural v2 entries present: `node "07-daemon/dist/capture/hooks/hook-runner.js" {pre|post|prompt|stop}`
- [x] No orphan v1 entries (`01-data-layer/dist/hook-runner.js` or `04-session-intelligence/dist/session-start.js`); v2 install-hooks purges these across all events
- [x] No duplicate hook entries from other installers (run `npm run dedupe-hooks` if drift creeps back)
- [x] Backup of pre-edit settings exists at `~/.claude/settings.json.devneural.bak` (and `.dedupe.bak.<ts>` per dedupe run)

## F. Data root

- [x] `c:/dev/data/skill-connections/` exists and is writable
- [x] Subdirs scaffolded: `wiki/`, `projects/`, `global/`, `dashboard/`, `reference/{docs,images,audio,video,queue}`, `session-state/`, `session-bridge/`, `models/`
- [x] Daemon log at `daemon.log` rotates only on manual intervention (acceptable for single-user box; backup excludes it)
- [x] SQLite WAL mode enabled (configured in `07-daemon/src/store/index.ts`)

## G. Dashboard surface

- [x] `/` serves home with daily brief + InstallPrompt + summary cards
- [x] `/wiki` serves search across wiki/transcripts/reference + reference upload modal (drag-drop + keyboard accessible)
- [x] `/sessions` lists sessions; `/sessions/detail?id=<sid>` shows transcript + send-prompt + focus-window
- [x] `/projects` shows registered projects + new-project modal
- [x] `/system` shows CPU/mem/disk bars + Tremor sparklines + service rollup
- [x] `/reminders` CRUD + push subscribe button
- [x] `/orb` shows force-directed graph from `/graph` endpoint
- [x] `/unlock` and `/set-pin` work with Suspense-wrapped client form
- [x] Cmd+K command palette: nav actions + per-session "open" + inline search
- [x] Mobile bottom tab bar appears below `md` breakpoint
- [x] VitalsRibbon stays pinned to viewport bottom (`h-[100dvh]` layout)
- [x] Service worker registered in production; push handler renders incoming notifications

## H. Push notifications

- [x] VAPID keypair generated on first daemon launch (persisted at `dashboard/vapid.json`)
- [x] `/push/vapid-public-key`, `/push/subscribe`, `/push/subscribe/:id` endpoints respond
- [x] Push subscribe button on `/reminders` requests permission + posts subscription
- [x] `emitNotification()` autopushes severity `warn` and `alert`; `info` stays in-feed only
- [x] 410/404 responses from the push service prune the subscription so a stale subscription doesn't keep failing forever
- [x] iOS PWA push verified end-to-end (2026-05-04: installed via Share -> Add to Home Screen at https://otlcdev.tail27b46b.ts.net, subscribed successfully)
- [-] Android push verified end-to-end. Closed 2026-05-04: this user has no Android device. Code path identical to the verified iOS push (same VAPID + service worker handler).

## I. Audio + video pipeline (Phase 3.5)

- [x] `audio.ts` and `video.ts` implementations shipped, fall back gracefully when binaries are missing
- [x] `process.ts` kind detection extended for mp3/wav/m4a/ogg/flac/mp4/mov/mkv/webm/avi/wmv
- [x] Missing-binary case parks the upload as `queued` and emits a warn-level notification (does not fail the upload)
- [x] `whisper.cpp` cloned + built on `OTLCDEV`. Binary at `C:/dev/whisper.cpp/Release/whisper-cli.exe`, `ggml-base.en.bin` model alongside in `models/`. `audio.ts` fallback list updated to include the `Release/` sibling pattern (older prebuilt zips don't drop into `build/bin/Release/`).
- [x] `Gyan.FFmpeg` installed on `OTLCDEV` via winget; `ffmpeg.exe` resolves on PATH.
- [x] `DEVNEURAL_WHISPER_BIN` env var. Set in `HKCU\Environment` to `C:\dev\whisper.cpp\Release\whisper-cli.exe`. Earlier value pointed at `main.exe`, which is now a deprecation stub that prints a warning and exits without transcribing; corrected via `setx` 2026-05-04. See `docs/install/07-troubleshooting.md` "Audio upload" section.
- [x] Test: extractAudioTranscript verified end-to-end on a generated 2s sine mp3 (returned `ok:true, text:"(eerie music)"`). For a real `/upload` round-trip, drop any mp3 onto the dashboard reference uploader and watch `daemon.log` for `transcript extracted: N chars`.

## J. PWA

- [x] `public/manifest.json` references icon-192 and icon-512 with `purpose: "any maskable"`
- [x] Service worker (`public/sw.js`) registers in production; install/activate/push/notificationclick handlers present
- [x] iOS standalone detection in `InstallPrompt` shows the Share → Add to Home Screen hint instead of the prompt button
- [x] Real PNG icons created at `08-dashboard/public/icons/icon-192.png` and `icon-512.png`. Generated via `08-dashboard/scripts/generate-icons.ps1` (System.Drawing brand-mark: dark panel + violet halo + DN wordmark, masked-safe inner content for `purpose: "any maskable"`).

## K. Documentation

- [x] README has a first-time setup checklist near the top
- [x] INSTALL.md points at the detailed walkthrough docs
- [x] `docs/install/05-coexistence-with-claude-setup.md` filled in with the actual `OTLCDEV` audit
- [x] `docs/install/08-personalized-recovery.md` written: backup section, recovery sequence, refresh triggers
- [x] `docs/install/TAILSCALE.md` covers tailnet install, MagicDNS, mobile install
- [x] `docs/install/AUDIO-VIDEO.md` covers whisper.cpp + ffmpeg
- [x] `docs/SESSION-HANDOVER.md` reflects current phase status

## L. Deferred decisions to revisit before declaring shipped

These are intentionally not blockers, but they are *decisions* that warrant another look before you call this production. None require code changes; they're judgment calls about deployment posture.

- **Backup target.** Currently set to `C:\Users\michael\OneDrive\devneural-backups`. OneDrive personal account sync handles cloud durability. Confirm this is the right account (vs `OneDrive - onthelevelconcepts.com` work account) given the data root may contain transcripts that touch client work. Inspect with `npm run backup-where`. Change with `npm run install-backup-task -- -BackupRoot "<new-path>"`. The README's "Current backup configuration" section should track whatever you decide.
- **Backup retention.** 14 snapshots at ~25MB each is ~350MB ceiling. If your data root grows past 1GB (likely once the wiki and reference corpus mature), revisit `-Keep` to balance retention vs storage. Daily granularity may also be excessive once the rate-of-change drops.
- **Off-site backup beyond OneDrive.** Resolved (script-ready): install with `npm run install-offsite-backup-task -- -BackupRoot <external-drive>` (in `07-daemon`). Registers a separate weekly Task Scheduler entry "DevNeural-Backup-Offsite" that calls the same `backup.ps1` against the external target with its own retention (default 8 weekly snapshots). Defaults to Sunday 04:30 → `D:\devneural-offsite`; override `-Day`, `-Time`, `-BackupRoot`, `-Keep`. External drive must be connected at run time. Uninstall via `npm run uninstall-offsite-backup-task`.
- **PIN strength.** Currently 4-8 digits. The lockout (5 wrong in 60s -> 5 minutes locked) provides enough deterrent for tailnet-only access. If you ever expose this beyond the tailnet, this is a different threat model and the PIN flow needs upgrading to TOTP or WebAuthn.
- **Daemon autostart.** Resolved: install with `npm run install-daemon-autostart` (in `07-daemon`). Registers a logon-triggered Task Scheduler entry that calls `start-daemon.ps1`, which spawns `node dist/daemon.js` detached. 30s post-logon delay so login session warmup wins, restart-on-fail policy 3 retries × 5min. Disable via `npm run uninstall-daemon-autostart`. With this in place a reboot of OTLCDEV brings the dashboard back online without any app needing to open.
- **Wiki repo remote.** `c:/dev/data/skill-connections/wiki/` is git-versioned locally. If you push it to a private repo, you get full version history off-site for free. Currently unconfigured; nice-to-have rather than blocking.
- ~~**PNG icons for the PWA.**~~ Resolved: brand-mark icons generated, see J above.

## M. What this checklist intentionally skips

- **Multi-user auth.** Out of scope by design; Tailscale + PIN is the perimeter.
- **TLS certificates.** Tailscale handles end-to-end encryption on the wire; no certs to renew.
- **Public exposure.** Don't. Use Tailscale Funnel only if you ever need a public URL, and even then prefer not to.
- **CI/CD.** This is a single-user box; the build is local. If you set up CI later, run the same `npm run build` + `npm test` + `next build` gates that this checklist references.
- **Performance budgets.** Lighthouse a11y 95 + best-practices 100 + LCP 223ms are documented in `08-dashboard/VERIFICATION.md`; nothing more rigorous is required for a single-user dashboard inside a tailnet.

---

## How to use this file

Re-walk this checklist:

1. After every fresh install on a new `OTLCDEV` instance.
2. After any Phase 5 settings audit refresh (the `~/.claude/` inventory drifts as plugins are added).
3. After Tailscale or DNS changes.
4. Before declaring a release "shipped."

Anything still unchecked is real risk. Resolve or document the deferral inline before declaring done.

---

*Michael Collins. Stay on the level.*
