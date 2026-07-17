# DevNeural Rolling Handover

Single living resume pointer. Replaces the dated `HANDOVER-*` files and
the per-cycle `SESSION-HANDOVER` / `SMOKE-HANDOVER` / `OVERNIGHT-*` notes.
Update this file IN PLACE every time the cursor moves; never add a new
dated file. Ground every claim against git before asserting; this doc
reflects what was true at the last update.

## Cursor (2026-07-17 ~01:50Z)

- **HEAD:** d238332 on master, tree clean.
- **PROD:** daemon pid 122044 (restarted 01:49Z) runs the FULL stack:
  the 2026-07-16 dashboard audit wave (GS-1..GS-12, migrations 051 +
  052 applied at the 01:33Z boot), the four 2026-07-17 voice fixes
  (SM-14..SM-17), and the SM-18 ws-close hotfix. Dashboard serves via
  next dev from source; production build validated clean.
- **Operator smoke test PENDING:** walk
  `C:/dev/data/skill-connections/brainstorm/RESTART-TEST-CHECKLIST.md`
  items 1-26. Items 22-26 are the voice fixes; item 23 needs a spoken
  turn, item 22 needs 5 idle minutes.

## Tonight's work (newest first)

- **SM-18 (d238332):** ws-close is never terminal - a socket drop runs
  the distillation flush only; the brainstorm stays alive for the
  reconnect. Terminal pipeline reserved for spoken end-session, UI
  end, compaction-restart. (The old code ended live brainstorm
  4bbafb48 twice tonight; row reopened both times, last at ~01:49Z -
  it is live now.)
- **Voice fourth wave (73508bd, 65a8dc0, 7d4222a, 1cc3701 =
  SM-15/17/14/16):** delivery verifier treats the utterance
  fingerprint as THE delivery signal (no repaste/FAILED on delivered
  words; loud TRUNCATED DELIVERY line); signal-based liveness
  everywhere (jsonl growth OR pty output within 15s = alive; timeouts
  bound silence, not reply time); 15s client keepalive ping + loud
  ws-close code/reason logging; silent TTS deaths scream (no-live-sink
  guard, TTS SYNTH FAILED / TTS STREAM ERROR in daemon.log).
- **Dashboard audit wave 2026-07-16 (6ce60f2..cc26d96, GS-1..GS-12):**
  supervision default=event everywhere (migration 051 backfilled 31
  seeded-polling anchors); selector on every anchor + small-screen
  wrap; settings cards in plain English (Worker auto-clear rename,
  history headers, effective-mode line); wiki match history with
  headers/verdicts/injected previews; periodic vector flush (dirty ->
  "saving soon"); bell counts only actionable + clear-all; home tiles
  show status not controls; brief refresh regenerates + 24h self-heal;
  deck nests workers under brainstorms; curator feed clear-all +
  destination hints; terminal mirror labeled; sessions page one merged
  table; KPI artifacts/lineage wired from wiki_drafts (migration 052
  collapsed 6,972 duplicate lint findings); drafts + meetings
  empty-states explain themselves (dead /sessions/new link fixed).
- **2026-07-16 earlier voice waves (SM-1..SM-13):** see FIXES.md; verified
  live except where the checklist says otherwise.

## Known baseline noise (NOT tonight's work)

- tests/grooming-routes.test.ts: one pre-existing failure (documented
  in FIXES.md SM-7).
- tests/sessions-anchor-liveness.test.ts: environmental flake, comes
  and goes with the operator's VS Code bridge heartbeat.
- 08-dashboard: 2 Playwright e2e spec files mis-collected by vitest
  (collection error only; 233 unit tests green).
- CuratorHealthCard "canary: not wired": honest label, probe does not
  exist yet.

## Next steps

1. Operator walks RESTART-TEST-CHECKLIST items 1-26 (dashboard wave +
   voice wave) on the live daemon.
2. Any failure: evidence is pre-wired - ws closes log code/reason,
   TTS deaths log loudly, delivery truncation logs TRUNCATED DELIVERY.
   Grep daemon.log first.
3. Phase Two remains queued behind the P2-0 adversarial review of
   FUNCTIONAL-SPEC (standing project rule).
4. Meeting flow still untested end to end (checklist item 20).

## Standing rules (unchanged)

- Daemon restart is OPERATOR-ONLY unless explicitly authorized in the
  moment. Builds are fine.
- Additive-only fixes; tests green before/after; commit bodies end
  with a Rebuild: yes/no line; FIXES.md row per fix.
- Regression-guard surfaces: terminal/PTY, bridge, cross-session
  inject.
