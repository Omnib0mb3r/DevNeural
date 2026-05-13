# Overnight Supervision Handover

Date: 2026-05-12, completed 06:44 local.
Operator: Lex (brainstorm session 3cd0ad4a).
Worker: DevNeural session dbd1adad-de99-48ec-bb00-56b5c94d1611 (rotated from fe96154c at ~04:04).

## Headline

Queue ran to completion autonomously. 20+ commits since session start, no stop conditions triggered, no destructive escalations. Final test state: 409 daemon, 19 dashboard render. Branch sits ahead of origin on master; pushes happened in batches across the night.

## Commits this run (newest first)

```
54c85cd chore(prune): survey post-PROJECT-ANCHORS prune sweep
8acb6bf docs(readme,install): link the new HOW-TO surfaces
a238ec9 docs(how-to): voice/TTS knobs + reminders web push end-to-end
41daa6b docs(how-to): dashboard UX surfaces (panic + transcript history + Past Sessions compact + collapse helper)
bb3eb2b docs(how-to): supervision pipelines deep dive (bridge / inject / smart-compact / EDS / threading)
32d711c feat(daemon): sibling distillation backfill job (N=5 per run cap)
0a32429 feat(daemon): sibling distillation preloader (top 2 most-recent at spawn)
42cd8e9 feat(daemon): chokidar listener for event-driven Lex supervision
f3f3cdc feat(daemon): jsonl-tail event detection for event-driven supervision
97d6819 feat(daemon): kill-switch persistence for event-driven supervision
cca1353 feat(daemon): sibling index for Lex spawn / reopen prompts
2ba5fa7 fix(dashboard): cap Past Sessions height and add collapse-to-strip toggle
22b8bfe feat(dashboard): Lex transcript history panel with collapse toggle and thinking placeholder
53377d9 feat(dashboard): patchProjectAnchor client (supervision_mode + title)
2ef345c feat(daemon): event-driven supervision foundations (router, debouncer, mode column)
cdb9685 feat(daemon): dispatch web push when a reminder fires
3d13ccc fix(dashboard): unify Lex naming (drop 'Lex Chat' / 'Brainstorm with Lex')
e8a807a feat(daemon): smart-compact orchestration surface
```

## Themes shipped

1. **Event-driven supervision** end-to-end. Foundations (router, debouncer, supervision_mode column polling/event/off), kill-switch persistence (>20 events / 10 min flips back to polling and warns), jsonl-tail event detector with 2KB snippet cap, chokidar listener wired through cross-session inject path with mode-gating and dedupe. Dashboard patchProjectAnchor client lets you flip mode per anchor from the UI.

2. **Brainstorm threading**. Phase 1 sibling index injected at Lex spawn/reopen; sibling source is the current anchor's `lex_transcript_refs` (prior CC bindings under the same anchor), ordered by `ordering` DESC, excluding the current ref. Label-grouped lookup across other `brainstorm_sessions` rows is retained as a fallback only when the anchor has zero prior refs. Phase 2 hybrid preload: top-2 most-recent transcript refs get distillation + last 5 user/assistant pairs prepended; missing-distillation fallback is first-3 + last-7 turns from the ref's jsonl. Backfill job re-runs the summarizer on refs with null distillation, capped at N=5 per run with hit_cap flag.

3. **Dashboard UX**. Lex transcript history panel (last 10 turns scrollable, "Lex thinking..." placeholder on thinking status so a stale answer never sits next to a new question). TerminalMirror collapse toggle with localStorage. Past Sessions list capped to 3-4 rows visible with the same collapse-to-strip pattern. Lex naming unified (dropped "Lex Chat" and "Brainstorm with Lex" in favor of plain "Lex").

4. **Reminders web push**. End-to-end wiring confirmed: reminder-push.ts module + daemon sweep call site + dedupe ledger + tests already in place from earlier work (we caught this and avoided a redundant re-implementation).

5. **Smart-compact orchestration surface** (e8a807a).

6. **Docs refresh**. Four new how-tos covering supervision pipelines, dashboard UX surfaces, voice/TTS knobs, reminders push. README + INSTALL.md linked to the new surfaces. Text-input mode TTS suppression documented as feature.

7. **Prune sweep**. Conservative; nothing deleted automatically. Worktree branch deletion left behind a manual gate. Migrations 009-022 surveyed, all referenced, no orphans. Historical handovers and postmortems retained with rationale.

## Open verification items (do these when you have 5 min each)

- **Reminders -> iOS push**: code is in but the real-device end-to-end test isn't done. Push the dashboard, accept the PWA notification prompt on the phone, set a reminder for one minute out, watch for the buzz.
- **Phase 1 sibling index**: confirm next brainstorm cold-start under "DevNeural Testing" actually shows the sibling index header in the system prompt. Source is the current anchor's prior `lex_transcript_refs`, not other brainstorm rows.
- **Phase 2 preload**: same cold-start should also include the last-2 prior transcript distillations + last 5 user/assistant pairs from each ref's jsonl, appended after the index.
- **Distillation backfill scheduler**: backfill module is bound to a daemon-side scheduler that ticks every 10 minutes (first fire after a 30s boot grace). Generator is `createLlmDistillationGenerator` which goes through `pickProvider()` and lands on the local ollama provider (BF-4 forbids Anthropic for brainstorm content). The provider's `distillation` role is wired on qwen3:8b alongside the existing ingest / lint / reconcile / selfQuery roles and is surfaced on `/system` under the LLM Provider panel. Prompt asks for 3-4 short lines under 80 words covering headline, last decision, open questions, and any blocker, so cold-start handoff is structured rather than a one-line tease.
- **Brainstorm-to-project binding**: each brainstorm anchor (`lex_sessions` row) carries a nullable `supervises_project_anchor_id` foreign key into `project_session` (ON DELETE SET NULL so a project removal blanks the pointer without taking the brainstorm with it). Set at create time via the new-brainstorm modal's project picker, editable later from the brainstorm tile. `voice-snapshot` surfaces the binding in `live_state` so Lex sees its supervised target without having to infer from `open_projects`. The cross-session inject path resolves a missing `target_session` against the bound project's `current_session_id`, so Lex inject calls can omit the target entirely when supervising a single project. When the bound project is dormant the resolver returns `{target_session: null, reason: 'bound-project-dormant'}` and the inject route 422s with a clear message instead of silently dropping. Explicit `target_session` in the call still wins. Clearing the column drops Lex back to the legacy judgment-based behavior of choosing from `open_projects`.

### Hierarchy at a glance

```
Brainstorm anchor (lex_sessions)              grandparent / boss
  user_label = "DevNeural Testing"            persistent across resets
  supervises_project_anchor_id ──────────┐
                                         │
                                         ▼
Project anchor (project_session)              parent / child of the brainstorm
  id = "DevNeural"                            persistent across worker restarts
  current_session_id ────────────────────┐
                                         │
                                         ▼
Worker CC session                             grandchild / rotates
  id = "0d25363c..."                          new id on every VS Code restart
```

The brainstorm anchor owns the relationship. The project anchor is its child and lives independently. The actual Claude Code worker process is the grandchild and is the only layer that rotates on every restart; the daemon walks brainstorm → project → live worker on every inject, so the binding never has to be re-pointed when only the worker session id changes.

## Open follow-ups worker captured

- LLM provider wiring into the distillation backfill scheduler is now live on local ollama / qwen3:8b under the `distillation` role.
- Per-tile mini-panic buttons deferred from panic-button spec; only add if global button targets wrong session often in practice.
- Manual "attach session to thread X" affordance is now the brainstorm-to-project binding picker on the new-brainstorm modal and the brainstorm tile edit affordance.

## Parked items still parked

- MediaSession TTS background audio-pinning (nice-to-have, unproven on iOS bug 198277).
- Native iOS shell for background mic.
- ntfy standalone notification channel (redundant with existing web push).
- FUTURE-DAEMON-SPLIT (way later).

## Supervision pipeline notes

- Cron ran on 2-minute cadence with dynamic worker UUID resolution (initial cron 0baa6dcf hardcoded UUID and went stale when worker rotated at 04:04; replaced with ac1a19ed using `ls -t ... | head -1` per tick).
- One stall observed mid-night between Phase 2 ship and docs refresh start. Worker idled after declaring "Continuing Lex supervision protocol" as last message. Imperative nudge inject restarted it cleanly.
- Daemon health remained 200 throughout. No widening of `.claude/settings.local.json` was needed; the existing allowlist covered everything.

## Suggested first-look in the morning

1. `git -C C:/dev/Projects/DevNeural log --oneline origin/master..HEAD` to see what's not pushed yet.
2. Verify the four how-to docs render correctly and link properly from README.
3. Run the reminder push smoke test on iPhone PWA.
4. Open a fresh "DevNeural Testing" brainstorm and see whether the sibling header + Phase 2 preload actually show up.
