# Evening plan: 2026-05-12

Written by Lex (brainstorm session 3cd0ad4a) for the worker session and the user.

Three layers: coding queue for the worker, manual verification checklist for the user, automated Playwright plan for execution after daemon reset.

---

## A. Worker coding queue (tonight)

Order: smallest first, so each ships in its own commit.

### A1. LLM provider wiring for distillation backfill scheduler

The backfill module in `07-daemon/src/dashboard/sibling-distillation-backfill.ts` (or equivalent path; verify) was shipped overnight with an injected `generator` dep + clock. The daemon scheduler that calls it does not yet bind a real LLM client to that generator. Module is pure; binder is missing.

Tasks:
- Locate the scheduler entry that wires backfill into the daemon loop (likely `07-daemon/src/daemon.ts` or a scheduled-tasks module).
- Bind the existing brainstorm-distillation summarizer (the one that runs on natural session end) as the `generator` dep on the backfill call site.
- Confirm the cap (N=5 per run) flows through.
- Add an integration test: backfill scheduler with 7 sessions missing distillations, runs once, only 5 get distilled, ledger flag `hit_cap=true`.
- One commit.

### A2. Project tile supervision_mode UI

HTTP route (`patchProjectAnchor`) and dashboard client wrapper already shipped. UI surface not yet present.

Tasks:
- Add a small dropdown or three-state toggle on each Project tile in `08-dashboard/components/ProjectsGrid.tsx` (or wherever the tile renders): polling / event / off.
- On change, call the existing `patchProjectAnchor` client with the new mode.
- Optimistic UI update with rollback on HTTP failure.
- Visual treatment: off state visually dim (kill switch active), event state with a subtle indicator that it's the newer pipeline.
- Render test in `08-dashboard/tests/` for the three modes and the toggle behavior.
- One commit.

### A3. Pre-flight audit before manual smoke tests

Before user runs the manual checklist below, worker should:
- Confirm dashboard builds clean (`pnpm --filter dashboard build` or equivalent).
- Confirm daemon builds clean (`pnpm --filter daemon build`).
- Confirm both test suites pass (`pnpm --filter daemon test`, `pnpm --filter dashboard test`).
- If any of those fail, fix before touching A1/A2.

---

## B. User manual verification checklist

Five-minute hands-on items the user runs himself. Each should be a clear pass/fail.

### B1. VS Code window reload — bridge presence runtime

1. Open any project workspace in VS Code that has a DevNeural worker session.
2. Reload the window (Cmd+R / Ctrl+R on a focused VS Code window, or via the Command Palette).
3. Watch the dashboard's project tile for that anchor.
4. Within ~30 seconds, the project tile should show the bound state (transcript ref populated, anchor live).
5. **Pass**: tile binding persists/restores cleanly. **Fail**: tile shows "no transcript", or stuck "binding", or anchor goes dormant and doesn't recover.

### B2. iOS PWA push end-to-end smoke test

1. Open the dashboard on your iPhone via Safari, install as PWA (Add to Home Screen) if not already.
2. Open the installed PWA from the home screen.
3. On the dashboard, find the "Enable push" button (added overnight; should be on a settings or notifications page).
4. Accept the permission prompt iOS shows.
5. From the dashboard or Lex voice, create a reminder due in 1 minute.
6. Lock the phone or background the PWA.
7. **Pass**: phone buzzes with the reminder notification within ~60-90 sec of due time. **Fail**: no buzz, or buzz arrives only when PWA is reopened.

### B3. Sibling index on fresh brainstorm cold-start

1. Open a brand new brainstorm session.
2. Label it "DevNeural Testing" (or the same label as existing siblings).
3. In the first turn, ask Lex: "What siblings do you know about?"
4. **Pass**: Lex correctly enumerates the 10+ prior DevNeural Testing sessions with their started timestamps. **Fail**: Lex says no siblings, or wrong count, or hallucinates.

### B4. Phase 2 preload on fresh brainstorm cold-start

1. Same fresh brainstorm from B3 (or another).
2. Ask: "What was the last thing we talked about in the most recent prior session?"
3. **Pass**: Lex references actual content from the last sibling (distillation OR recent turns visible). **Fail**: Lex says it doesn't know, or invents content.

### B5. LLM-wired distillation backfill (after A1 ships)

1. Confirm there's at least one brainstorm_session with `status=ended` and `distillation IS NULL` in the database (any old session without one).
2. Restart the daemon.
3. Wait ~6 hours OR find a manual trigger if worker added one.
4. Check that session's `distillation` field is now populated.
5. **Pass**: row populated, content reads as a sensible summary. **Fail**: row still null, or contains an error string.

### B6. Supervision_mode UI (after A2 ships)

1. Open the dashboard, navigate to Projects grid.
2. On any project tile, find the new supervision_mode toggle.
3. Cycle through polling, event, off.
4. **Pass**: tile reflects the change immediately, polling refresh confirms the value persists. **Fail**: toggle doesn't render, HTTP error in console, or value doesn't persist on reload.

---

## C. Playwright execution plan

Two run modes:
- **Mode 1 — MCP Playwright (preferred for tonight)**: I drive Chrome via the `mcp__playwright__*` tools directly. No install needed, runs in this session after user resets daemons. Captures screenshots into `C:/dev/Projects/DevNeural/playwright-runs/2026-05-12-evening/`.
- **Mode 2 — Permanent suite (future)**: A real `playwright.config.ts` lives under `08-dashboard/e2e/` with these scenarios as `.spec.ts` files, runnable via `pnpm e2e`. Out of scope tonight unless time permits at end of queue.

### C1. Daemon-reset entry condition

Before any scenario runs, user confirms:
- Daemon process killed and restarted.
- Dashboard dev server running.
- At least one DevNeural worker session was opened post-restart so an anchor exists.
- Lex brainstorm under "DevNeural Testing" label has at least 2 prior siblings with distillations populated (otherwise C5 below skips with note).

### C2. Scenario: dashboard boots, top-bar renders

1. `browser_navigate` to dashboard root (likely http://localhost:3000 or the dashboard port — verify in `08-dashboard/package.json`).
2. `browser_wait_for` selector "TopBar" or `[data-testid="top-bar"]`.
3. `browser_take_screenshot` -> `01-boot.png`.
4. Pass: panic button visible top-right of nav, voice mute control visible, search visible.

### C3. Scenario: panic button keybind

1. `browser_press_key` Ctrl+Alt+. with focus NOT in an input.
2. `browser_wait_for` toast or audit-panel update confirming panic fired.
3. `browser_take_screenshot` -> `02-panic-fired.png`.
4. Then `browser_navigate` to /system, scroll to PanicAuditPanel, screenshot `03-panic-audit.png`.
5. Pass: audit row with caller="dashboard-keybind" and result="accepted" or "no_target" depending on session state.

### C4. Scenario: Past Sessions compact + collapse

1. `browser_navigate` to the page where LexSessionList renders.
2. `browser_take_screenshot` -> `04-past-sessions-default.png`.
3. Verify only 3-4 rows visible (count with `browser_evaluate`).
4. Click the collapse toggle (top-right of the list).
5. `browser_wait_for` collapsed state.
6. `browser_take_screenshot` -> `05-past-sessions-collapsed.png`.
7. Click toggle again, screenshot `06-past-sessions-expanded.png`.
8. Reload page, screenshot `07-past-sessions-after-reload.png`.
9. Pass: collapse state persists across reload (localStorage working).

### C5. Scenario: TerminalMirror collapse

Same shape as C4 but on TerminalMirror component. Screenshots `08-mirror-default.png`, `09-mirror-collapsed.png`, `10-mirror-after-reload.png`.

### C6. Scenario: brainstorm transcript history

1. Open a brainstorm session (or current one).
2. Send (via voice or text) at least 3 questions to populate history.
3. `browser_take_screenshot` -> `11-transcript-history.png`.
4. Pass: last 3 turns all visible scrollable, newest at bottom.
5. Send another question, before response arrives screenshot `12-transcript-thinking.png`.
6. Pass: "Lex thinking..." placeholder visible on Lex line, no stale prior answer next to new question.

### C7. Scenario: supervision_mode toggle (after A2 ships)

1. `browser_navigate` to projects grid.
2. Find first project tile, screenshot `13-tile-default.png`.
3. Click supervision_mode toggle, select "off".
4. `browser_take_screenshot` -> `14-tile-off.png`. Pass: visual dim treatment.
5. `browser_evaluate` to fetch `/projects/:id` or whatever endpoint and confirm mode=off persisted.
6. Toggle to "event", screenshot `15-tile-event.png`. Pass: subtle event-mode indicator visible.

### C8. Scenario: panic Past-Sessions count vs label

1. Confirm Stream Deck tile for "DevNeural Testing" shows correct count (matches `SELECT count(*) FROM brainstorm_sessions WHERE user_label='DevNeural Testing'`).
2. Screenshot `16-streamdeck-count.png`.
3. Pass: count matches DB.

### C9. Reporting

After all scenarios:
- Write `playwright-runs/2026-05-12-evening/REPORT.md` with pass/fail per scenario, screenshot links, and any console errors captured via `browser_console_messages`.
- I (Lex) summarize the report in voice when complete.

---

## D. Order of operations tonight

1. User resets daemons + confirms entry conditions (C1).
2. Worker runs pre-flight audit (A3).
3. Worker ships A1 (LLM wiring).
4. Worker ships A2 (supervision_mode UI).
5. User runs B1-B4 in any order while worker codes.
6. After A1 ships: user runs B5.
7. After A2 ships: user runs B6.
8. Lex (me) runs Playwright plan C2-C8 against the now-fully-shipped state.
9. Lex writes C9 report.
10. Morning handover doc auto-generated at queue completion.

## E. Stop conditions tonight

- All A items shipped + all C scenarios pass: queue complete, notify user.
- Two consecutive test failures on same step in A1 or A2: pause and notify.
- Daemon health probe fails twice: pause and notify.
- User says "stop" or "pause": pause and notify.
