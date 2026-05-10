# Codex review 002 of Phase Two implementation spec

> Captured 2026-05-10 during the Phase Two planning session. This review covered additions made after `docs/spec/CODEX-REVIEW-001.md`, with emphasis on meeting fold-in, kind classification and backfill, meeting-mode awareness silence, and Appendix R's Lex three-level context model.
>
> This review did not re-cover issues already flagged and adopted from review 001.

## A. Critical issues

No findings.

## B. Important issues

1. **Meeting-mode silence is not enforceable end-to-end.** BF-19 and Appendix R say meeting mode is fully silent, including L3 disablement, but the hard enforcement only exists for broadcaster pushes. `POST /lex/recall` remains generally available in section 4.2, and Wave 2 day 5 exposes `recent_context()` to Lex without a matching session-kind refusal contract at the API or tool boundary. The current plan relies on prompting and refusal text for part of the guarantee. That is not enough for "fully silent." Must-fix before BF-18 and BF-19 ship: pass `session_id` or `session_kind` through `recent_context()` and `/lex/recall`, and reject both in `kind='meeting'` sessions at the daemon boundary.

2. **Synthetic audit-document ingest conflicts with the new `kind` model.** Wave 2 day 3 says audit documents become synthetic `brainstorm_sessions` rows with `mode='notes'`, but BF-14 says `notes` defaults to `kind='meeting'`. The spec does not explicitly pin those synthetic sessions back to `kind='brainstorm'`, nor does it define a third non-meeting notes-like class. That changes retrieval rank, lineage behavior, and privacy semantics for audit material, and it contradicts the rationale that audit documents should be ingested as brainstorm artifacts. Must-fix before Wave 2 day 3: explicitly set synthetic audit sessions to a defined kind and document why.

3. **The meeting artifact contract is incomplete.** BF-15 introduces `meeting-summary` artifacts plus action-item reminders, but the artifact enum in the brainstorm detail response and the random artifact sampling section still only know `notes-summary`, `research-note`, `wiki-draft`, and `project-intent`. There is no canonical schema or enum for `meeting-summary`, no declared artifact table shape for action items, and no statement of whether meeting summaries participate in the generic artifact feed. That leaves dashboard surfacing and retention behavior under-specified. Must-fix before the meeting routes land.

4. **`wiki_drafts` still encodes a brainstorm-only parent even though meetings can now create drafts.** Section 3.4 keeps `wiki_drafts.brainstorm_id TEXT NOT NULL`, yet `POST /meetings/:id/promote-to-wiki` says a meeting creates a `wiki_drafts` row. SQLite will accept a meeting session id in that column because both live in `brainstorm_sessions`, but the contract is now semantically misleading and easy to implement wrong in validators, UI copy, and test fixtures. Either rename the column to `session_id` or state explicitly that it is a voice-session FK whose historical name is retained for compatibility.

5. **Meeting consent and retention rules are not fully executable.** Section 3.3 says a meeting cannot start in a state that retains audio without `consent_acked=1`, and the env table says per-session override happens via `keep_audio`, but no session-create API, schema field, or capture-path branch defines how this actually works. The spec never says whether meeting capture is blocked until consent is acknowledged, whether transient on-disk audio may exist before ack, or where `keep_audio` is stored. This is a privacy-boundary gap, not just a UX detail. Must-fix before BF-17 ships.

6. **Appendix E still describes the pre-meeting behavior and now contradicts the authoritative sections.** The worked example starts a `notes`-mode "brainstorm", auto-distills to wiki drafts, and promotes with `source_brainstorms`. That conflicts with BF-14 through BF-16, section 3.3, the `/meetings` endpoints, and the backfill rules. Because Appendix E is explicitly framed as implementation guidance for tests and unattended sessions, this contradiction is operationally dangerous. Must-fix before execution by replacing the example with either a real brainstorm example or a real meeting example that follows the updated rules.

7. **The awareness backpressure rule is too brittle as written.** Appendix R uses `awareness tokens / user-turn tokens` over a rolling 10-turn window with a 40 percent threshold. In voice workflows, short acknowledgements ("yes", "ok", "go on") will make the denominator collapse and force repeated downshifts even when absolute awareness cost is modest. There is also no hysteresis or recovery rule beyond "suspend L2 for 5 minutes," so the system is likely to flap. Must-fix before P2-2: add a minimum denominator floor, define hysteresis, and specify the recovery condition.

8. **The diff-only L1 mechanism lacks a revision protocol, so race conditions remain.** Appendix R says L1 is diff-only after baseline, but it never defines monotonic revision ids, PTY delivery guarantees, what happens if a tick is dropped or delayed, or when the daemon must force a full snapshot beyond the 30-minute refresh. Without this, Lex can apply a delta against the wrong baseline and drift silently. Must-fix before P2-2: version every L1 snapshot, drop stale diffs, and force a full-state resend after any missed or failed delivery.

9. **"User-actionable event" is not defined tightly enough for L2 push-on-change.** Appendix R gives examples, but not a closed enum or decision rule. That leaves the unattended implementer guessing whether flagged pages, artifact samples, outbound-cap hits, heartbeat failures, or cross-project skips should push. Since L2 push is the main inundation risk, this ambiguity matters. Must-fix before P2-2: define a closed event set and require any new push event to update the spec.

## C. Nice-to-haves

1. **Rename the `brainstorm_*` persistence layer to a voice-session-neutral term over time.** The new meeting fold-in works, but names like `brainstorm_sessions`, `brainstorm_chunks`, and `wiki_drafts.brainstorm_id` now carry avoidable cognitive debt.

2. **Add meeting-specific KPIs.** Brainstorm KPIs are well-covered, but once meetings are first-class there is likely value in tracking meeting count, action-item extraction rate, consent-acked rate, and audio-purge compliance.

3. **Persist explicit consent audit metadata.** `consent_acked` is only a boolean. A timestamp and actor field would make later privacy audits materially stronger.

## D. Things the plan got right

- The privacy model improved materially by moving from brainstorm-only blocking to provenance-based blocking for all voice-session-derived content, including meetings.
- Meeting sessions are correctly kept out of the automatic wiki-distillation path by default. That is the right bias for third-party speech.
- Backfill classification includes a user override before lineage runs. That is a good safeguard against hardening bad historical labels.
- Appendix R at least states the right control surfaces for inundation: budgets, idle suppression, per-mode verbosity, and a hard silence mode for meetings.
- Gating the awareness broadcaster behind real curator-health evidence is the right dependency ordering.

## E. Under-addressed risks

1. **Speaker attribution errors in meeting transcripts can create false action items.** The spec mentions speaker mapping in the meeting detail view, but it does not treat diarization or speaker-resolution quality as a risk to reminder accuracy.

2. **Backfill reclassification cleanup is unspecified.** If the user flips a legacy session from `meeting` to `brainstorm` or vice versa in `/brainstorms/backfill-review`, the spec does not define how previously generated summaries, reminders, edges, or lineage links are rolled back and rebuilt.

3. **The `notes`-mode override to `kind='brainstorm'` needs stronger guardrails.** Without an explicit warning or confirmation, a real third-party meeting can be mislabeled as a brainstorm and then inherit forever-retention and brainstorm-first retrieval treatment.

4. **The L1 summarisation path can recursively add load exactly when the system is already busy.** Appendix R says over-budget awareness is summarised by a local LLM call, but it does not budget the extra queue pressure or specify whether awareness summarisation can be skipped instead of model-called under contention.

## F. Holes for an unattended Claude Code session

1. **Session creation contract is missing.** The spec needs one canonical request shape for creating a voice session, including `mode`, `kind`, `attendees`, `meeting_topic`, `consent_acked`, and any retention override field.

2. **Meeting-summary persistence is missing.** The implementer needs a declared storage location and type for `meeting-summary` plus action items, not just endpoint prose.

3. **Awareness tool gating is missing.** The implementer needs explicit daemon-side rejection behavior for `recent_context()` and `/lex/recall` in meeting sessions.

4. **Audit-document synthetic-session semantics are missing.** The implementer needs a one-line rule stating the exact `kind`, source class, and lineage behavior for these non-audio sessions.

5. **Diff delivery semantics are missing.** The implementer needs a protocol for L1 revisions, resend behavior, and PTY write failure handling.

## G. Codex verdict (verbatim)

> "Execute with edits. The post-001 additions are directionally right, but the meeting fold-in and Appendix R still leave too much behavior to inference. The blocking problems are not in the idea. They are in enforceability and contract precision: meeting-mode silence is not daemon-enforced end-to-end, synthetic audit sessions collide with the new notes-to-meeting default, the meeting artifact and retention contracts are incomplete, and the diff-only awareness design still lacks a revision protocol. Fix those before the meeting and awareness waves land."

---

End of Codex review 002. Next planned external review per the spec: P2-0 against `FUNCTIONAL-SPEC.md`, scheduled for Wave 3 day 5.
