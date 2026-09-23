# Investigator Pipeline + Project Lifecycle — SPEC

Status: SPEC (design frozen from brainstorm, not yet built). 2026-06-19.
Source brainstorm (full rationale): `C:\dev\data\skill-connections\brainstorm\INVESTIGATOR-PIPELINE-PLAN.md`.
Nature: a big STRUCTURAL change, NOT a from-scratch rebuild. The supervision/inject loop already works and must be preserved (see Regression Guard).
Inaugural acceptance test (the bug that started this): on the live "DevNeural Testing" anchor, stale ref count goes from 28/118 to 0 after a distill checkpoint, and `ref_summary_ms >= latest_chunk_ms` for every ref.

---

## 1. Where we are now

Current-state audit (evidence-based, 2026-06-19). Sources: `docs/SMOKE-TEST.md`, `docs/bugs/README.md`. HARD RULE learned today: "shipped in code" != "working." Three states, not one.

**VERIFIED working (safe to rely on / guard):**
- Test suite at MODULE/API level: ~1161 daemon + 138 dashboard (was 1123/138 at the 2026-06-01 smoke). Module-level only, NOT hardware.
- Terminal / PTY binding (drive-letter canonicalization, 19de12c). Confirmed working; only open bug is low-sev name-match ergonomics (`docs/bugs/2026-05-23-bridge-terminal-name-fragility.md`).
- Bridge presence / worker discovery, both launch paths (fixed 2026-05-22).
- Cross-session inject DELIVERY to the worker (Fix 32 + bridge); Lex<->worker back-and-forth + pushback works in practice. CAVEAT: the voice-PTY-paste path has an OPEN high-sev regression (below).

**SHIPPED but NOT hardware-verified (do NOT call these "working"):**
- Cold-start preload chain (Fix 52-56): module/API probes green; live brainstorm first-reply vetting (smoke 6.7) NOT done.
- SessionStart hook blocks landing live (smoke 4.1/4.2): dist-verified, live unverified.
- Coalesce Phase B+C (Fix 57): shipped, live unverified.
- Loose-ends gate / grooming push / scope header / anchor seeding (smoke 1.x, 2.4, 3.3, 6.x): mostly module-probe-only.

**KNOWN BROKEN (fix not written, or being replaced):**
- Single-TTS stream / double-talk: Fix 51 shipped + unit-tested, but the live overlap check (smoke 5.1) NEVER ran, and the user confirms it is NOT working in practice. The HAIKU voice tier is the real fix. (Listing this as "working" earlier was the exact mistake this project exists to kill.)
- Voice PTY paste-no-commit regression (OPEN, high): `docs/bugs/2026-05-29-voice-pty-paste-no-commit-regression.md`.
- Tier-5 diagnosed-only (no fix written): Fix 24 mid-reply TTS truncation; Fix 25 mic input/sensitivity sliders; Fix 26 "Lex hold up" wake-phrase kills mic.
- MANY bug-log entries are "fixed (pending soak)" = NOT confirmed.

The core bug (the gap this spec closes):
- Brainstorm distillations go stale and are never refreshed on a live, long-running anchor. 28/118 stale, oldest 24 days.
- Root cause: the only scheduled distiller (`07-daemon/src/lex/sibling-distillation-backfill.ts`) selects candidates by `last_summary` PRESENCE and excludes any row that already has a summary (`looksLikeSelfAudit`). Staleness is defined by TIMESTAMP (`isRefStale`: `latest_chunk_ms > ref_summary_ms`). Writer and reader use different keys -> a once-distilled session is never re-distilled. stale-watcher only rings a bell; session-end never fires on a 38-day anchor.

## 2. Target architecture (condensed; full rationale in the brainstorm doc)

- **Model split.** Investigator = Opus (ephemeral). Lex = Opus (single source of truth, in control). Voice = Haiku (single mouth). Ollama = downstream lint + wiki. Workers = the hands.
- **Investigator is EPHEMERAL** (`claude -p`, headless): spawn -> one job -> write artifact -> die. Fires on: boot (Start Voice), session end, crash-detect on restart, rolling idle checkpoints. A cheap always-on watcher (daemon) triggers it. ONE engine does cold-start + distill + handoff + crash recovery + worker grounding (no separate distiller).
- **Distiller fix (first sliver).** Select candidates by staleness (`latest_chunk_ms > ref_summary_ms`/`last_summary_ms`), run via the headless Opus channel (BF-4 exempt), bump BOTH `ref_summary_ms` AND `last_summary_ms` on success, fire on rolling checkpoints, never serve a stale distillation as fresh.
- **Single source of truth.** Lex owns the state of record. Investigator feeds Lex; haiku derives its digest FROM Lex; ollama is downstream. No independent reasoning.
- **Cold-start report persistence.** Per-anchor `cold-start/` folder, timestamped reports, newest = the seed Lex boots from (file == seed). Read prior as a PRIOR (validate + correct), archive don't discard, newest timestamp = last-clean-boot marker for crash recovery.
- **Voice layer.** Haiku = single mouth (kills double-talk structurally) + front desk. Two channels: DATA (questions queue, daemon flushes to Lex at the stop-hook turn boundary, coalesced) and CONTROL (stop/quiet/abort interrupt immediately, never queued). Deny-by-default whitelist (answers only conversational glue, queues everything else). Renderer not re-thinker (verbatim preserve-list for numbers/decisions/negations). Presents AS Lex (forebrain/subconscious, one persona, first-person; worker is the only "he"). Owns the heartbeat.
- **One voice, many projects.** Conscious voice is foreground-only (one project in focus); every other active project runs a headless per-project driver (subconscious), silent. Same identity, shared persisted state. Background escalations queue/surface at a gap or via push, never grab the voice.
- **Supervision = daemon reflexes + Lex judgment.** Daemon: always-on, cheap, mechanical (stall/process/permission/activity), enforces the danger circuit-breaker, triggers the investigator. Lex: holds the spec, catches semantic drift ("SQLite when we said Postgres"), in control. Drift prevention is PRIMARILY upstream at the precise, spec-grounded inject; watchers are the backstop; worker pushback (judged on merit) is the safety valve.
- **Brainstorm IS the TDD (keystone).** Brainstorm -> dialed plan -> the plan becomes the test suite (what the test is + what passing is, result-level). Lex drives the worker to green. A passing-but-wrong test upgrades the brainstorm STANDARDS (cumulative, cross-project). Done = green, never "worker said done."
- **Test harness = neutral daemon** (not worker, not Lex). Two tiers: code suite (exit code) + runtime probes against live state. Every check must be a runnable probe (hardens the Spec->TDD gate); soft/feel checks use an explicit LLM-judge/user spot-check, flagged. Evidence logged.
- **Lifecycle dashboard (Projects page rework, ADDS not replaces).** New Project -> Spec -> TDD -> Execution -> Test -> Bug handling. Each gate has an objective exit criterion (state machine). Empty cold start = the "new project" trigger. Project STAGE is part of restored state; greeting is stage-aware. Existing live view (open sessions) survives inside the page.
- **Escalation bar.** Lex extrapolates from plan direction; escalate ONLY when unsure AND irreversible, or new scope, or contradicts a decision. Contract = RESULTS + FRAMEWORK; implementation is Lex's to change freely (done-checks written at result level). Backstops: investigate-before-extrapolate, log + surface every autonomous call.
- **Danger gate.** Reversibility x blast radius. Reversible/in-sandbox -> autonomous; irreversible/out-of-sandbox -> always pause. ENFORCED via worker permission mode (standard/acceptEdits, never bypass; denials route to Lex -> user). Git = in-sandbox safety net. Lex watching the tail handles trajectory; the permission gate is the circuit breaker for the irreversible instant.
- **Investigator integrity (it's a SPOF).** Citations not assertions; a cheap deterministic fact-validator (SHA exists, count matches a query, latest decision is latest); greeting = human backstop; degrade to a thin honest report, never a confident wrong one.

## 2b. Smart-clear sequence (worker context-fill reseed)

The 5th investigator trigger: fires when the worker's context nears full. Upgrades the current "smart-compact" to run on the investigator engine. Full choreography (owner-specified 2026-06-19):

1. Investigator spins up (ephemeral), reads the WORKER jsonl + Lex state + the plan + the docs.
2. Investigator drafts TWO artifacts: (a) a recommended SAFE stopping point, (b) the restart/reseed prompt. Hands both to Lex.
3. Lex tells the worker to stop at that point.
4. Worker stops, then clears (/clear).
5. Lex WAITS for the clear to complete, then injects the restart prompt (the reseed).
6. Lex watches the restart and TRAILS the worker's new jsonl (new session id, found by mtime) to confirm it actually resumed on task (after-vet).
7. Lex reports back to the investigator; the investigator updates its log (audit record of the clear), then closes.

Constraints:
- **Trigger threshold:** default **40%** context usage, ADJUSTABLE in settings. Fires at 40% (not at the limit) deliberately: it leaves a ~20% buffer up to the ~60% preferred clear point, giving the worker runway to reach a safe stopping point before the clear actually happens. Wind down early, land gracefully, never get chopped off mid-step. If the worker has not landed by ~60%, Lex forces the stop (commit-first).
- **Safe stopping point:** a clean boundary, after a commit / between steps, NEVER mid-edit. If there is uncommitted WIP, the stopping point becomes "commit first, then stop," so the clear never eats work.
- **Reseed obeys adaptive sufficiency:** enough to resume (what it is doing, what is next, the decisions, verified state like HEAD), self-assessed, NOT the dumped transcript, NOT a fixed budget.
- **Division of labor:** investigator ASSEMBLES (stopping point + reseed) and LOGS + closes; Lex DECIDES/FIRES (stop, wait, inject restart, trail-confirm) and is in control. One author of truth.
- **Grounding:** never a raw /clear inject. Current smart-compact already does autonomous /clear + Lex-authored resume via /lex/smart-compact/fire; this upgrades the resume to the investigator engine. Rename smart-compact -> smart-clear is already queued.

## 3. Build plan / todos (ordered; each ships with its acceptance test)

1. **Distiller -> staleness-driven (first sliver).** Select by `latest_chunk_ms > ref_summary_ms`; bump both timestamps; rolling-checkpoint trigger. ENGINE swap to headless Opus channel. Acceptance: inaugural test (stale 28 -> 0 on the live anchor).
2. **Unify investigator as the one engine** (cold-start + distill + handoff + crash + grounding), ephemeral, trigger-fired by the cheap watcher.
3. **Cold-start report persistence** (per-anchor folder, timestamped, file==seed, validate-prior, archive).
4. **Crash recovery** (jsonl-after-last-report = crash signal -> read gap -> update docs).
5. **Voice tier (haiku)**: single mouth, two channels, whitelist gate, renderer guard, persona, heartbeat.
6. **One-voice-many-projects** foreground/background drivers.
7. **Test harness** (neutral daemon, two tiers, probe-per-check, evidence log).
8. **Lifecycle dashboard** (Projects page rework, gated state machine, stage-aware greeting) — ADDS to existing.
9. Parked: multi-worker dependency coordination; migration snapshot/rollback in the drive loop; ollama lint-vs-wiki scope; Notes mode placement.

## 4. REGRESSION GUARD — do NOT break (verify after every change)

Guard ONLY the VERIFIED-working set (section 1). Verify the smoke BEFORE and AFTER any change touching these. Never assume.

- **Terminal / PTY binding (19de12c):** externally-launched VS Code sessions still flip live via drive-letter canonicalization. Smoke: launch a worker in VS Code; confirm bridge=ok and it flips live.
- **Bridge presence / worker discovery:** both launch paths still hook via presence files + reconcile loop.
- **Cross-session inject DELIVERY:** Lex injects a no-op to the live worker; confirm it lands in the worker jsonl tail. (Do NOT widen the open voice-PTY-paste regression.)
- **Worker back-and-forth / pushback:** inject a deliberately questionable step; confirm the worker pushes back and Lex handles it.
- **Test suite:** stays green (~1161+ daemon, 138 dashboard). Run before AND after each change; a drop is a regression.

NOT a regression guard (these are FIX/REPLACE targets, not things to preserve — re-verify live as part of THIS work, never assume they pass):
- **Single-TTS / double-talk** -> currently BROKEN, replaced by the haiku tier.
- **Hooks landing live, cold-start chain, coalesce** -> shipped-unverified; the investigator rebuild supersedes much of this. Re-verify live, don't inherit the "it works" assumption.
- **Tier-5 voice bugs** (TTS truncation, mic sliders, wake-phrase mic-kill) and the **voice-PTY-paste-no-commit** regression -> separate open fixes.

Rule: any change touching a Regression-Guard surface is high-risk -> verify the corresponding smoke BEFORE and AFTER, never assume. And never record a shipped-unverified item as "working."

## 5. Acceptance / smoke tests (result-level probes)

- **Inaugural:** stale ref count on the live anchor == 0 after a checkpoint; `ref_summary_ms >= latest_chunk_ms` for all refs. (Direct DB query, daemon-run, not worker narration.)
- **Cold start currency:** newest cold-start report timestamp >= newest jsonl chunk for the anchor; greeting states current state.
- **No double-talk:** stacked utterances -> exactly one reply, one TTS stream.
- **Danger gate:** a simulated destructive op pauses (permission denial routes to Lex), does not execute.
- Plus the section-4 regression smokes.

(Soft/feel checks — greeting sounds current, voice not robotic — use an explicit LLM-judge or user spot-check, flagged as judgment-based, never a deterministic green.)
