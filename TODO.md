# DevNeural TODO

Captured 2026-05-04. Living list. Tick when shipped.

## Polish (from agent E handover read)

- [-] Android push notification end-to-end test. Dropped per user.
- [x] PWA install prompt UX. Scaffold already implemented; only token mismatch fixed.
- [x] System panel sparklines. Already shipped (SparkAreaChart, 60-sample buffer, both metrics).
- [x] Axe a11y sweep across home, sessions, wiki, projects, system, reminders, orb. Zero violations after adding sr-only h1 to /orb.
- [x] `prefers-reduced-motion` audit. Existing global rule in `globals.css:253-255` already pins durations to 0ms. Orb particle pause via `cooldownTicks` finite when `prefers-reduced-motion: reduce` is a future-pass enhancement.
- [-] Tailwind arbitrary class cleanup (`text-[11px]` -> `text-nano`). Skipped: `text-nano` utility forces uppercase/tracked-out display, would change visual semantics for user-readable labels.
- [x] Scanned PDF OCR fallback. `pdf.ts` now rasterizes + OCRs via pdf-to-png-converter + tesseract.js when text density looks scanned. Bounded by page count + time.
- [x] Off-site git remote for wiki repo. `Omnib0mb3r/devneural-wiki` (private) created and pushed. Daemon-side scheduled push every 5 min via `wiki/push.ts`.

## Validation

- [ ] Trigger a real reinforcement event in conversation. Send Claude a prompt where the wiki should match, watch dashboard ReinforcementPanel for an `injected` row, then watch for `hit` / `raw-hit` after the reply lands. Confirms curator + reinforcement + panel chain end-to-end.

## Stream deck (virtual deck in dashboard)

- [x] Arrow tile foreground color: was greyed-out slate, now pure white for visibility.
- [x] Tile-tap focus and Nav-mode key inject. Routed through StreamDeck.App tray (commit `3147c41` in stream-deck repo, `59cfd2e` in DevNeural). Tray app holds the OS focus rights the bridge could not. Daemon writes to `%LOCALAPPDATA%\stream-deck\virtual-input\<sessionId>.in`, app's VirtualInputWatcher dispatches through the same WindowManager.FocusWindow + NavKeymap.InjectFor paths the physical deck uses.
- [x] Workspace resolution: ResolveVSCodeWindowSmart walks cwd segments deepest-to-shallowest so a session launched in a subdir (e.g. `07-daemon`) still resolves the workspace-root VS Code window (`DevNeural`).

## Deferred / future

- Phase 4 Orb data rebind. Force-directed UI shipped; pages-as-nodes data layer awaiting more accumulated wiki content.
- Phase 5 settings audit + personalized recovery docs. Mostly documentation.
- Audio/video binary smoke test post whisper.cpp + ffmpeg install.

## Phase Two queue (2026-05-09)

Full plan in `docs/spec/FUNCTIONAL-SPEC.md` section 17. Tracking in `docs/HANDOVER-2026-05-09-second-brain-strengthening.md` Phase Two section.

- [ ] **P2-0** ⚠ FIRST: Adversarial review of `docs/spec/FUNCTIONAL-SPEC.md` → output at `docs/spec/FUNCTIONAL-SPEC-REVIEW-001.md`. Must catch holes, contradictions, stale claims, missing edge cases, untested assumptions, architectural concerns at 10x scale, security gaps, Phase Two risks. Bullet list grouped by spec section.
- [ ] **P2-1** Lex personality customization: dials, per-mode few-shot, refusal contract, `SYSTEM_PROMPT_VERSION` versioning, in-prompt comments documenting WHY each block exists.
- [ ] **P2-2** L1 live awareness broadcaster (`07-daemon/src/lex/awareness-broadcaster.ts`): 5–15s tick, snapshot of active CC sessions + brainstorms + recent artifacts + flagged pages, push as system-message-shaped block to Lex's PTY.
- [ ] **P2-3** Lex feedback loop: per-turn thumbs up/down inline, regex-detected negative cues, aggregate per `SYSTEM_PROMPT_VERSION`, "worst-rated turns this week" dashboard surface.
- [ ] **P2-4** UI fine-tuning: brainstorm rows in /sessions, /wiki↔/orb deeplink, "now playing" indicator, mobile PWA polish, brainstorm-as-orb-node.
- [ ] **P2-5** Documentation refresh after P2-1 through P2-4.

## Operational

- [x] Audit and prune `~/.claude/settings.json.*.bak.*` backup files. Six stale backups deleted; `settings.json.bak` kept as canonical recovery point.
- [x] `silence-all-hooks.ps1` redesigned around a native silent-shim.exe. Stdin pipes through, child runs hidden, hook stdout reaches Claude. Build with `dotnet publish` in `07-daemon/scripts/silent-shim`, then `npm run silence-hooks`.
- [x] Bridge `focusWindow` + `injectKey` + nav PS helpers removed (commit `aee3053`). Bridge is now text-only.
- [x] deck-hook.sh double-escape bug fixed at source (stream-deck commit `605688b`). Segment-walk in C# is still useful as a fallback when Claude is launched from a workspace subdirectory.
