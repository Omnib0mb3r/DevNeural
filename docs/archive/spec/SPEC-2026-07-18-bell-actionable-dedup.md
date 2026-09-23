# Spec: bell actionable-only, part two (dedup + expiry + idle routing)

Fix FOUR, queued behind the three in `SPEC-2026-07-18-voice-binding-fixes.md`. Tests-first, commit separately, FIXES row + `Rebuild:` line. Do NOT restart the daemon.

## Grounding (measured live 2026-07-18, do not re-derive from scratch)
- The bell filter already works on the daemon: `passesSurfaceFilter` (07-daemon/src/dashboard/notifications.ts) drops `notify_class:'conversation'` when `surface='bell'`; `BELL_NOTIFY_CLASSES = {followup, signal}`. The activity emitters ("Lex injected raw", "Lex finished a turn", "transcript chunk reinforced") are correctly tagged `conversation` and are correctly dropped by surface=bell.
- TopBar bell dropdown already requests surface=bell (`08-dashboard/components/TopBar.tsx:62`, `notificationsClient(20,"bell")`). Badge count = `health.unread_notifications` (was 1 at measure time).
- BUT the user's live bell still showed conversation rows → their PWA is serving a STALE bundle from before the surface=bell wiring. AND `GET /notifications?surface=bell` returns 50+ `followup` rows dominated by repeated **"Claude waiting on you (idle_prompt)"** plus **"Worker never received an inject"**. These pass the filter honestly but never dedupe or expire, so the bell is noise even when filtered.

## The fixes
1. **Dedupe followup notifications.** Collapse identical followups (same type + same target, e.g. repeated `idle_prompt` for the same worker) into one live row instead of stacking N. Newest-wins or a count badge on the single row.
2. **Auto-expire / auto-clear.** A followup must clear when its condition resolves, not linger: `idle_prompt` clears when that worker goes active again; "Worker never received an inject" clears on a confirmed landing. Add a TTL backstop for any followup with no explicit resolve signal.
3. **Do not route worker-idle to the user when supervision owns it.** A worker going idle must NOT emit a user-facing bell followup when its anchor has an ACTIVE supervising Lex (Lex keeps workers busy; per the two-item allowlist a system-handled idle is not a needs-you). Gate `idle_prompt` on: no active supervising Lex for that anchor, or supervision already escalated/exhausted. Genuine user-blocked items (a worker question, supervision can't resolve) still surface.
4. **Verify the filter is in the SERVED bundle.** The "coded but not deployed" gap is the user's core complaint. Confirm the surface=bell TopBar wiring is present in the built/exported dashboard artifact; if the static export is stale, rebuild so a client refresh actually picks up the filter. Note in the commit whether a dashboard rebuild is required.

## Acceptance
- `GET /notifications?surface=bell` returns only genuine needs-you items (fired reminders + real user-blocked actions); the idle_prompt/inject-failure pileup is gone or collapsed to single live rows that clear on resolve.
- A worker going idle under active supervision produces NO user bell notification.
- Reference existing spec: `brainstorm/BELL-ACTIONABLE-ONLY.md` (two-item allowlist).
