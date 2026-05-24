# FUNCTIONAL-SPEC Adversarial Review 001

> **Target:** `docs/spec/FUNCTIONAL-SPEC.md` revision dated 2026-05-09
> **Review run:** 2026-05-23
> **Gate:** P2-0. Must pass user triage before any Phase Two implementation.
> **Severity legend:** **BLOCK** — spec is wrong, contradicts itself, or hides a real defect; fix before building on it. **FLAG** — assumption, risk, or omission worth deciding on. **NIT** — clarity or polish.
> **Scope:** problems only. No fixes proposed.

---

## Resolution pass — 2026-05-23

After review, the user authorized "fix all if it makes sense". The following actions landed in the same session:

**Code change (one):**
- §7.1 correction regex tightened in `07-daemon/src/reinforcement/index.ts`. Bare-word patterns retired; new set requires sentence-initial position or explicit corrective phrase shapes. 761 tests pass.

**Spec rewrites (truth-aligned to current code):**
- §1: "every component HTTP/WS" softened — hook path is disk-write + best-effort signal.
- §3.1: SIGUSR1 documented as best-effort, no-op on Windows, periodic ingest is the workhorse there.
- §3.3: fragmentation backstops called out as a known limitation with proposed next step.
- §4.1: third vector collection (`reference_chunks`) added.
- §5.4: cross-project verifier order made explicit (flag in-memory, then write).
- §5.6: `wiki/canonical/` → `wiki/pages/` (matches code).
- §7.1: correction regex description rewritten to match new tightened set.
- §10.3: direct-llm and detached runtime modes added to the voice loop section.
- §12.1: PIN auth claim removed; host-binding declared as sole trust boundary.
- §15.1 + §15.2: auth model rewritten; LAN exposure caveat added; OneDrive encryption claim qualified; Tailscale node-sharing risk called out.
- §16: `DEVNEURAL_BIND` documented.

**Deferred (require user decision, not in-scope for spec/code sweep):**
- §3.1 IPC swap to portable transport (HTTP `/signal` endpoint or named pipe) — architectural change, needs user sign-off.
- §12.1 bind-default flip to `127.0.0.1` — behavior change, current default is intentional for Tailscale.
- §15.2 add auth layer at HTTP boundary — design decision (PIN comeback vs passkey vs reverse-proxy basic auth).
- All FLAGs and NITs not listed above — left as inventory for the user to pick from.

The eight BLOCKs are now either resolved in code/spec or explicitly deferred above. Phase Two implementation is unblocked subject to user acceptance of the deferred items.

---

## Section 0 — Identity

- **FLAG.** "Zero cost in default config. Data never leaves the machine except through the user's own off-site backup target." Section 14 recommends OneDrive as the backup target. OneDrive is Microsoft cloud with Microsoft-held keys. Framing minimizes that the recommended default already routes captured transcripts (including any scrubber misses) to a third party.

## Section 1 — Architecture overview

- **BLOCK.** "Every component talks to the daemon over HTTP/WS on `:3747`." Hooks do not. `hook-runner.js` writes `observations.jsonl` directly to disk and then emits a signal. The "every" is false and the disk-write path is a real coupling the spec hides.
- **NIT.** Diagram omits the silent-shim layer between Claude Code hooks and `hook-runner.js`, even though section 3.1 calls it critical.
- **NIT.** 09-bridge box exists in the diagram but the spec never identifies it as a VS Code extension until section 18; first-time readers cannot tell what runs where.

## Section 2 — Two-layer principle

- **NIT.** No statement of what happens when the layers disagree (semantic match retrieves a page that the editorial rules would reject, or vice versa). Conflict-resolution policy is unspecified.

## Section 3 — Capture pipeline

- **BLOCK.** "Emits a `SIGUSR1` to the running daemon." Windows does not have `SIGUSR1`. Node on Windows fakes a subset of POSIX signals and `SIGUSR1` is one of the unsupported ones. Spec is platform-incorrect for the only supported platform.
- **FLAG.** 3.2 step 2: regex-only secret scrubbing against "API key shapes, env var prefixes, JWT structures" silently misses novel formats, rotated key prefixes (e.g. Anthropic key prefix changes), and any vendor whose token does not match the encoded patterns. Risk is open-ended; spec presents it as defense-in-depth without bounding the gap.
- **FLAG.** 3.3 backstop: 8000-char mid-turn flush creates two adjacent vectors with no foreign-key link between them. The "rare, acceptable" across-batch split has the same shape. Both fragmentations directly contradict the section's whole motivation (one turn = one vector).
- **FLAG.** 3.4 claims the capture-side scrubber catches "voice transcripts of read-aloud secrets". Voice transcripts enter via Whisper output in `voice/lex-voice-ws.ts`, not via the transcript-watcher boundary. Whether `secret-scrub.ts` is applied on that path is not stated. If it isn't, the scope claim is wrong.

## Section 4 — Storage layer

- **BLOCK.** Directory naming contradiction. 4.3 lists `wiki/pages/` as canonical pages. 5.6 step 1 writes to `wiki/canonical/`. 5.4 references "existing trigger+insight+pattern" with no path. The spec uses both `pages/` and `canonical/` to mean the same thing.
- **BLOCK.** 4.1 names two vector collections: `raw_chunks` and `wiki_pages`. Section 8.2 introduces a `reference` source class served from `reference_chunks_meta` (SQLite), and section 17.5 mentions a reference corpus. No vector collection for it is described. Either references are not embedded (then how does retrieval work?) or there is a third collection the storage section omits.
- **FLAG.** 4.1 in-process linear cosine scan. No N at which this becomes a perf wall, no telemetry on scan latency, no fallback. At 250k+ chunks this is going to hurt.
- **FLAG.** 4.1 "Filtering happens in-memory after the cosine scan." For a query scoped to one project across a multi-project corpus this scans and discards 90%+ of vectors. Inverted by simply pre-filtering metadata, but the spec normalizes the worse order.
- **NIT.** `brainstorm_sessions` columns `topic_tags_json` and `artifacts_json` are introduced without saying who maintains them or when they get written.

## Section 5 — Wiki ingest operation

- **BLOCK.** 5.4 cross-project verifier: order of operations is ambiguous. Pass 2 writes `page_updates` (section 5.2). Verifier "fails closed" by setting `flag_for_review: true`. If the verifier runs AFTER Pass 2 commits, the unrelated-pattern fusion is already on disk and the flag is cosmetic. If it runs BEFORE, Pass 2's write should be gated on the verifier verdict. Neither order is stated.
- **FLAG.** 5.1 "SIGUSR1 every N captured events" — N is unspecified. Coalescing window not given either. Real-time path tunability is invisible.
- **FLAG.** 5.2 "Up to 5 affected pages." Silent cap. If the true count is 7, two pages drift while the spec calls the pass complete.
- **FLAG.** 5.2 Pass-1 8K input on `qwen3:8b` local. No timeout, no behavior on slow generation, no retry semantics distinct from validator retries.
- **FLAG.** 5.3 validator only checks Pass 2 output. Pass 1's JSON is unchecked. A malformed `affected_pages` array goes straight into Pass 2 selection.
- **FLAG.** 5.3 Anthropic Haiku fallback: Haiku is a different model with different JSON-shape tendencies. Substituting it for qwen at the validator-exhaustion boundary risks silent quality regression on a path the user has opted into specifically for "quality".
- **FLAG.** 5.5 brainstorm-source weight bump from 0.30 to 0.40 is a magic number. No criterion stated for choosing 0.40 over 0.35 or 0.50, no measurement that this improves promotion accuracy.
- **FLAG.** 5.7 "no em dashes, no AI co-author tags". These are enforced via the system prompt only. LLMs leak these constantly. No post-output regex check is mentioned; the rules are aspirational.

## Section 6 — Lint operation

- **FLAG.** "50 random canonical pages" per cycle. A page with weight 0.5 may never be revisited. Coverage is probabilistic and unbounded in the worst case.
- **FLAG.** Merge proposal "held for explicit `--apply`". No mention of where these held proposals surface for the user to review. They appear to accumulate invisibly.
- **FLAG.** "Lint NEVER auto-applies destructive changes to `human_edited: true` pages." "Destructive" is undefined. Is a summary rewrite destructive? A cross-ref removal? The guarantee is unenforceable without that line.

## Section 7 — Reinforcement and decay

- **BLOCK.** 7.1 correction regex includes `\bno\b` and `\bactually\b`. False-positive rate is catastrophic on natural English ("no problem", "actually, that's a great point"). Every false positive blacklists the page for the session and decays its weight. Compounds with curator section 9 step 5. This single regex can poison the entire reinforcement signal.
- **FLAG.** 7.1 Hit cosine >= 0.65 between injected summary and assistant reply. If Claude paraphrases heavily, false negative; the right injection looks unused. Threshold is set without measurement.
- **FLAG.** 7.1 "Pages with corrections >= 3 AND weight < 0.15 move to archive." A single noisy session under the false-positive regex above can bury a useful page in three turns.
- **FLAG.** 7.2 decay 0.995/day → half-life ~138 days, universal. No exemption for pages still actively cited by an active project; project relevance is not a signal.

## Section 8 — Retrieval and source-class taxonomy

- **FLAG.** 8.2 multipliers are fixed (`1.0 / 0.85 / 0.7 / 0.6 / 0.5`). No tuning per query type (e.g. "I want a reference manual lookup" → reference should outrank wiki). The taxonomy is one-size-fits-all.
- **FLAG.** 8.2 "If the row was archived, the chunk falls back to `raw` tier." This is silent. A user-archived brainstorm session degrades retrieval quality of every chunk under it without notice.
- **NIT.** 8.3 `group_by_session` is an opt-in flag for `/lex/recall` only. The dashboard `/search/all` does not group, so brainstorm chunks litter dashboard search but are clean for Lex. Asymmetry is intentional but unjustified.

## Section 9 — Curator (real-time injection)

- **FLAG.** Step 5 session blacklist depends on the correction signal from 7.1, which is built on the false-positive-heavy regex. A page wrongly flagged as corrected is gone for the rest of the session.
- **FLAG.** Step 7 "if best-hit score < threshold: silence". Threshold unspecified in the spec. Without it, "better nothing than noise" is a slogan, not a contract.
- **NIT.** Step 6 "one injection per N seconds per session" — N unspecified.
- **NIT.** Step 8 inject ~150-token summary every UserPromptSubmit. Across a long session this is non-trivial context bloat. No accounting policy.

## Section 10 — Lex

- **BLOCK.** Spec drift: recent commits added a "voice WS direct-llm path" (commit `85b3025`) and a session-end + pty-host gating commit (`08c827c`). The voice loop in 10.3 still describes a PTY-only path. The direct-LLM branch is invisible in the spec but live in code.
- **FLAG.** 10.4 `END_SESSION_RE` matches "goodbye Lex" and "bye Lex". A user dictating notes who quotes someone saying "bye Lex" within content fires the session-end pipeline mid-dictation. Notes mode is exactly where this misfire is most damaging.
- **FLAG.** 10.5 artifact-parser executes side effects (`reminders_to_create[]` creates real reminders) from LLM-controlled fenced output. Standard prompt-injection surface: a transcript snippet containing a fenced `artifact:notes-summary` block, captured later and re-surfaced to Lex, can manufacture reminders. No allow-list, no confirm step described.
- **FLAG.** 10.2 notes mode "Silent reply (no TTS)" — Lex still consumes turns. On the Anthropic provider this is paid silence. Cost profile of dictation mode is invisible.

## Section 11 — Brainstorm sessions and session-end pipeline

- **FLAG.** 11.2 step 1 bypasses the 600-byte minimum and relies on "the LLM's own filter" to reject junk. Small inputs are exactly where filter LLMs hallucinate and produce decorative pages. The bypass removes the deterministic gate without replacing it.
- **FLAG.** 11.3 idempotency uses a `sessionEndFired` flag on connection state. A daemon crash mid-end loses the flag. On restart `reapAllActive()` (11.1) force-ends any stuck row, which can re-run the pipeline against the same chunks → duplicate brainstorm-summary vectors.

## Section 12 — Dashboard and orb

- **BLOCK.** 12.1 PIN auth on first launch. No password complexity, no rate-limiting or lockout mentioned. A four-digit PIN on a port reachable across the entire Tailnet (and any Tailscale-shared external user) is 10,000 attempts to brute force. Section 15 leans on Tailscale ACLs as compensation, but ACLs are user-administered and the spec does not require them.
- **FLAG.** 12.2 "best-effort: a failure returns `null` for that section so a single broken data source does not black out the whole strip." This masks broken pipelines as empty tiles. A wiki page count of `null` looks like a UI bug, not a backend outage.

## Section 13 — Hooks system

- **FLAG.** 13.2 "`silence-all-hooks.ps1` ... Idempotent. `repair-double-wrapped-hooks.ps1` peels stacked layers from older runs." The existence of the repair script proves the idempotency claim has been violated in practice. The spec asserts idempotency without acknowledging the breakage mode.

## Section 14 — Backup pipeline

- **FLAG.** "Default schedule: daily 03:00." Windows Task Scheduler's missed-task behavior is config-dependent. If the machine sleeps through 03:00 and the task has no "run missed task" flag, backup silently skips. Spec does not commit to a missed-run policy.
- **FLAG.** Wiki off-site git push "skipped silently when no remote configured". Silent skip on a critical durability path is invisible failure. User who never set a remote will discover this only on disaster.

## Section 15 — Security model

- **BLOCK.** 15.2 dashboard auth = PIN only, paired with 12.1's lack of rate-limiting. This is the single most exposed surface (HTTP listener on Tailnet) and the weakest gate.
- **FLAG.** 15.1 "Threats NOT in scope ... malicious-actor models on the local network — assumed not present on a personal Tailnet." Tailscale supports node-sharing with external users. One share invalidates this assumption silently. Spec offers no warning at the share boundary.
- **FLAG.** 15.2 "OneDrive at-rest encryption" listed as a defense layer. OneDrive personal is Microsoft-held-key encryption, not zero-knowledge. Listing it next to PIN auth and WireGuard implies a comparable guarantee it does not provide.

## Section 16 — Environment variables

- **BLOCK.** `DEVNEURAL_PORT` default `3747`. Bind address is unspecified. If the daemon binds `0.0.0.0` by default, Tailscale ACLs are not the only gate — any process on the LAN can hit it. If it binds Tailscale interface only, that needs to be stated and tested. The omission is the kind of thing that ships as `0.0.0.0` by accident.

## Section 17 — Phase two roadmap

- **FLAG.** 17.1 L1 broadcaster tick every 5–15s. Each tick consumes Lex context-window tokens forever; over a one-hour conversation this is hundreds to thousands of tokens of repeated awareness frames, most identical to the last. No diff-only delta policy specified.
- **FLAG.** 17.1 acceptance "Snapshot stays under ~2K tokens" budgeted alongside L0 + L1 + L2 + voice turn + reply. Leaves no room for tool results from `/lex/recall` if Lex actually uses its retrieval tool during the same turn.
- **FLAG.** 17.3 thumbs up/down for Lex quality requires manual interaction. A voice user cannot tap. The feedback channel is closed in the mode that most needs it.
- **NIT.** 17.2 user-tunable personality dials — UI surface unspecified, mapping from dial to prompt-block-edit unspecified, version-bump semantics on dial change unspecified.

## Section 18 — Component file map

- (No findings.)

## Section 19 — What governs what

- **NIT.** "Source-class multipliers ... `search-all.ts:40-46`" — line citations will rot at the first refactor. Same risk on every line-numbered reference in this table.

---

## Summary count

| Severity | Count |
|---|---|
| BLOCK | 8 |
| FLAG | 31 |
| NIT | 8 |

Eight BLOCKs are the gating set. Phase Two implementation should not start until each BLOCK is either resolved or explicitly accepted by the user as a known shortfall.
