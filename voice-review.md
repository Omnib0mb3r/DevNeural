# Voice review

> Hole-poking pass on the DevNeural design. Captured 2026-05-10 from a voice-mode Lex conversation, then refactored after comparing the design against Karpathy's "LLM Wiki" pattern (https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f), then refactored again after the user clarified that brainstorms are the substrate, not derivative.
>
> **Framing:** DevNeural is **agentic personal infrastructure**, not a product. The bar is "is it solid for me," not "is it pitchable."
>
> **Identity correction:** the user is a brainstormer-first. Voice brainstorm conversations are the *core* artifact. They are equal-or-higher priority than project transcripts. Polished wiki content is downstream of brainstorming, not the centre of the system. Design and retrieval must reflect that.

---

## 1. Where DevNeural sits relative to Karpathy

The Karpathy LLM Wiki pattern is three layers: raw sources (immutable), an LLM-maintained markdown wiki with cross-references, and a schema config file that defines the wiki's conventions. Operations are ingest, query, and lint. Karpathy's claim is *delegating maintenance to the LLM* so the wiki actually stays alive.

DevNeural's core layer matches Karpathy almost cell-for-cell:

| Karpathy | DevNeural |
|---|---|
| Raw sources (immutable) | jsonl transcripts + reference corpus + **brainstorm transcripts** |
| LLM-maintained wiki (markdown + cross-refs) | `wiki/` with `[trigger] -> [insight]` schema |
| Schema config (CLAUDE.md-style) | `docs/spec/DEVNEURAL.md` |
| Ingest | Pass 1 + Pass 2 |
| Query | curator + `/lex/recall` + dashboard search |
| Lint | lint module (Phase 1) |

DevNeural extends Karpathy with five additions:

1. **Real-time injection** at `UserPromptSubmit` (push, not pull).
2. **Vector RAG layer** alongside the wiki (semantics + logic, two-layer model).
3. **Reinforcement decay loop** for wiki pages.
4. **Cross-project promotion** with a verifier.
5. **Voice surface (Lex)** as a parallel innovation track.

These are additive on top of a validated core. If they fail, the system collapses to Karpathy and still works. That is the right risk shape.

**What Karpathy's pattern does not address and DevNeural must own:** brainstorm capture, brainstorm-as-first-class-source, voice ingestion, and the bidirectional flow between unstructured ideation and structured wiki. The brainstorm-first reframe in Section 2 below is DevNeural's most important divergence from Karpathy's published pattern.

---

## 2. Brainstorm-first reframe (the priority axis)

This section overrides any earlier assumption that brainstorms are downstream of, or lower priority than, project transcripts and wiki pages. Decisions below are committed, not proposals.

### 2.1 Decisions

1. **Brainstorms outrank wiki and project transcripts in retrieval.** Source-classed retrieval order is changing. New default order: **brainstorms (full transcript + summary) > canonical wiki > pending drafts > project jsonl transcripts > generic raw > reference**. Intent detection on the recall query may re-weight further (e.g. "what was I thinking about X" forces brainstorms-only).

2. **Brainstorms never decay.** Reinforcement decay applies to wiki pages only. Brainstorm transcripts and summaries are permanent. Old brainstorms are *more* valuable than new ones because they capture the moment a direction crystallised.

3. **Full transcript is searchable forever, not just the summary.** Current state ingests only the rolling summary into `raw_chunks`. New: a `brainstorm_chunks` table (or `kind:'brainstorm-transcript'` tag plus a no-decay flag) holds turn-bounded chunks of the full transcript. The summary stays as a fast retrieval target; the full transcript is the system of record.

4. **Brainstorms are the most sensitive privacy class.** Pass 2 Haiku fallback is **forbidden** for brainstorm content even with the opt-in flag set. Cross-project verifier is forbidden for brainstorm pages. Outbound document (`outbound.md`) lists this rule as non-negotiable.

5. **First-class `/brainstorms` route on the dashboard.** Not nested under `/sessions`. Top-level navigation. Filterable by project (or "general"/"scratch" for project-less), mode (conversation/notes/PTT), date range, topic vector match. Each row shows: title, summary, derived artifacts (research-note, wiki-draft, project-intent, notes-summary), link to full transcript, audio playback if available, lineage links to wiki pages spawned.

6. **Project-less brainstorms are valid first-class.** Add a `general` namespace for brainstorms not tied to a CC project. The current `brainstorm` workspace exemplifies this. Schema: brainstorm_sessions.project_slug nullable, with a separate `general` bucket in the dashboard.

7. **Bidirectional brainstorm <-> wiki linkage is mandatory, and wiki distillation at session end is automatic, not user-triggered.**
   - **Session-end is the distillation moment.** When a brainstorm session ends (Stop button, spoken "end session", browser close, PTY exit), the daemon automatically runs Pass 2 against the full transcript, produces wiki-draft artifacts, and writes them to disk as pending drafts. The user reviews drafts in the dashboard but never has to *trigger* the distillation. The "extract insights" button is removed as the primary path; it survives only as an admin "force re-distill" action for already-ended sessions.
   - **Drafts surface for review, not for action.** Pending drafts appear in `/brainstorms/<id>` and on a `/drafts` queue with one-click promote-to-wiki, edit, or discard. Default behaviour after N days of no action: auto-promote drafts above a confidence threshold; drop drafts below.
   - **Every wiki page** has a back-pointer to every brainstorm session that contributed evidence. Stored in frontmatter (`source_brainstorms: [<id>, <id>]`) and surfaced inline in the page detail modal.

8. **Cross-brainstorm linking AND unified orb.** Same topic explored across multiple sessions over time auto-links: vector similarity between session summaries above threshold = create an edge. Visualisation is a **single unified orb**, not a toggle. Brainstorm sessions are first-class nodes in the existing orb alongside wiki pages (and project transcripts where they have enough density). Edges span all node types: brainstorm-to-brainstorm (topic recurrence), brainstorm-to-wiki (lineage / `source_brainstorms`), wiki-to-wiki (existing cross-refs), brainstorm-to-project (which project a brainstorm fed into). Node visual style differentiates type (color / shape / size). User sees the entire mental landscape in one view: "I have been circling this idea for three months across five sessions, two of them spawned wiki pages, one of them seeded a project."

9. **"What was I thinking" is a first-class query mode.** Lex command (`recall: brainstorm-only` or natural-language equivalent) and a dashboard search mode that searches brainstorms first, derived artifacts second, wiki third. Different from the default polished-knowledge recall.

10. **Audio is retained and replayable.** Voice brainstorm audio is captured (it must be; whisper.cpp processes it). Retain the source WAV/OGG bundle in `data/brainstorms/<id>/audio/` after transcription. Dashboard exposes a playback control on every brainstorm session detail. Even a short tone-of-thought clip is valuable. If retention cost grows, add a configurable max-age or compress to opus.

11. **Brainstorm KPIs added to the strip.** New tiles: total brainstorms (count), brainstorm hours captured (cumulative), avg derived artifacts per brainstorm, wiki pages tracing back to a brainstorm (lineage coverage), project-less vs project-tied ratio. Activity row also shows the existing "active brainstorms with mode breakdown" but the new tiles are persistent counts not activity.

12. **Backfill past brainstorms.** Sessions captured before the session-end pipeline shipped (pre-2026-05-09) may have only summaries on disk. One-shot script `npm run backfill-brainstorms`: walk `data/brainstorms/`, re-ingest any raw transcript present into the new `brainstorm_chunks` shape, regenerate summaries through Pass 2, populate lineage back-pointers in the wiki frontmatter where matches are confidently identified.

### 2.2 Implications for earlier parts of the design

- **Hole #13 (brainstorm-to-wiki path unclear):** resolved by decision 7. Bidirectional linkage with explicit one-click promotion.
- **Hole #1 (privacy is implicit):** tightened by decision 4. Brainstorms are explicitly off-limits for outbound regardless of opt-in flags.
- **Reinforcement decay loop:** scope clarified to wiki-pages-only by decision 2.
- **Source-classed retrieval order in `/lex/recall`:** changed by decision 1.
- **Stopping criteria (Section 7):** add brainstorm-derived metrics: lineage coverage rate above 80% (every wiki page traceable to its brainstorm origins where applicable), brainstorm search latency P50 under 300ms, audio replay functional.

---

## 3. Holes (deduplicated, sharpest first)

1. **Wiki compounding is unproven.** The whole pitch rests on "useful injections strengthen, ignored ones decay." Validation item #1 in `TODO.md` is still open. Decay scheduler shipped 2026-05-09, never observed running across weeks. With n=1 user, you cannot tell tuning from noise. Karpathy does not claim compounding either; he claims maintenance offload.

2. **Curator silent-failure mode.** "Below threshold = silence" looks identical to "curator is broken." No telemetry distinguishes them.

3. **LLM-compiled schema is the brittlest bet.** qwen3:8b producing valid `[trigger] -> [insight]` Pass 2 schema reliably is the keystone risk. Haiku fallback is a band-aid. No regression suite catches schema drift or model regression.

4. **Reinforcement ground truth is weak.** Hit and correction detection from follow-up-turn regex is noisy. Could compound errors instead of correcting them.

5. **No dogfooding metric.** KPI strip tracks system internals but not user behaviour toward the system. If user engagement is zero, the brain is a write-only log.

6. **No "DevNeural is solid" criteria.** Open-ended Phase Two = indefinite scope. Until there is a stopping condition, this never lands, just accretes.

7. **Test coverage is thin.** 53 unit tests across 9 layers. No integration tests. End-to-end "ingest -> Pass 2 -> query -> curator injects" path is never asserted automatically.

8. **`SYSTEM_PROMPT_VERSION` is bookkeeping without comparison.** P2-1 versions the prompt but no A/B-replay. Versioning without comparison is filename theatre.

9. **Embedder lock-in.** Swap models = vector space incoherent. No `model_id` column, no `npm run reindex`.

10. **Cross-project promotion threshold of 2 is too low.** Two projects sharing vocab can trip false-positive promotion.

11. **GPU contention.** whisper.cpp cuBLAS + ollama qwen3 both want the GPU. Concurrent voice + ingest can thrash or OOM.

12. **Single reviewer = compounding blind spots.** Only the user reviews wiki quality.

13. **Brainstorm-to-wiki path was unclear.** Resolved by Section 2 decision 7.

14. **No external observability.** Self-monitoring loop. Watchdog is a 5-min `/health` probe. Closed circle.

15. **Reminder/push chain too long.** No native OS toast fallback when push fails.

16. **Raw chunks retention.** No cull rule. Vector index cost compounds over years. (Note: brainstorm_chunks are exempt from any cull rule per Section 2 decision 2 and 3.)

17. **Identity sprawl.** Resolved by accepting "agentic personal infrastructure" framing and brainstormer-first identity.

### 3.1 Higher-order gaps

1. **Privacy boundary is implicit, not explicit.** Pass 2 Haiku fallback ships local content to Anthropic. README claims "your data never leaves your machine" while two opt-in flags violate that. Add explicit `outbound.md` listing every off-host code path, dashboard tile showing total outbound calls per day, hard cap. Brainstorms specifically forbidden from outbound (Section 2 decision 4).

2. **Wiki page-as-truth assumption.** Wrong-but-high-weight page gets injected confidently. No uncertainty surface. Add visible confidence score on inline injection + "this looks wrong" button that drops weight and flags for self-audit.

3. **The audit is not in the loop.** This `voice-review.md` is itself a project audit. Is it ingested? Will future Lex sessions know we ran this review? Resolved by Section 2 decision 12 (backfill) plus a permanent rule: every brainstorm summary plus every voice-mode audit document gets ingested as a brainstorm artifact.

4. **Wiki edit ownership undefined.** Decision: **LLM-write-only with user-veto via `frozen: true` frontmatter flag.** A frozen page is read-only by ingest until unfrozen. User edits in a frozen page survive ingest. User edits in an unfrozen page are merged at next ingest with a warning if overwritten.

5. **No Lex artifact quality telemetry.** Add random-sample artifact surfacing in dashboard for quick correct/incorrect labelling. Drives P2-1 dial tuning.

6. **Time-bound knowledge.** Add `last-verified` timestamp per wiki insight; lint flags pages where it is older than 90 days for recheck.

7. **Schema evolution.** Add `schema_version` field per page; migration scripts in `07-daemon/scripts/migrations/`.

8. **Untested restore drill.** Quarterly drill: spin up a parallel daemon on backup data, sanity-check, document time-to-restore.

9. **Cold-start for new projects.** Test deliberately: register a brand-new empty project and watch what gets injected on the first prompt. Document the cold-start contract.

10. **Bus factor and pause mode.** Add a pause mode that freezes wiki decay during inactive periods. Brainstorms already exempt.

11. **Search ranking unspecified.** Document the actual hybrid retrieval strategy: BM25 + vector + recency + source-class weight (per Section 2 decision 1).

12. **Karpathy is published, not battle-tested.** Track during the 30-day observation window which Karpathy claims hold up.

---

## 4. Steals from the Karpathy pattern

1. **Schema-as-living-config.** Load `docs/spec/DEVNEURAL.md` into Pass 2 system-prompt context on every ingest call. Schema changes propagate automatically.
2. **Lint-as-first-class periodic job.** Promote lint to a scheduled nightly task. Surface findings in dashboard.
3. **LLM self-audit.** Recurring fresh-CC-context task: "are these 10 random pages still accurate, useful, well-scoped?" Mitigates single-reviewer blind spots.

---

## 5. Plug-the-holes plan

| Source | Action | Effort |
|---|---|---|
| Holes #1, #2, #5 | Curator instrumentation. Log every injection. Curator Health KPI card: injections/day, hit rate, correction rate, silence rate, click-through rate. | half day |
| Hole #2 | Synthetic canary. Nightly known-prompt -> known-page. Alert via reminder if curator silences. | hour |
| Hole #3 | Schema regression suite. 50 pinned jsonl turns + expected Pass 2 outputs. Nightly. | half day |
| Hole #4 | Promote P2-3 thumbs UI ahead of P2-2. Drop regex-only correction detection. Weight explicit signals 10:1. | tracked under P2-3 |
| Hole #6 | Define stopping criteria explicitly (Section 7). | 1 hour to draft |
| Hole #7 | One golden-path integration test per layer. Include brainstorm capture path. | day |
| Hole #8 | A/B replay harness for `SYSTEM_PROMPT_VERSION`. Lands inside P2-1. | half day |
| Hole #9 | `model_id` column on chunk tables + `npm run reindex`. | half day |
| Hole #10 | Raise cross-project threshold to N=3 OR domain-distance check. | hour |
| Hole #11 | GPU job queue. Or VRAM monitor + ingest backoff while voice active. | half day |
| Hole #12 | Periodic LLM self-audit (covers Karpathy steal #3 too). | half day |
| Hole #13 | Resolved by Section 2 decision 7 (bidirectional linkage). | covered below |
| Hole #14 | Daemon POSTs heartbeat to separate process or phone shortcut. Phone alerts on no-beat in 10 min. | 2 hours |
| Hole #15 | Native OS toast fallback when web push fails. | 2 hours |
| Hole #16 | Cull rule for stale raw_chunks. Brainstorm_chunks exempt. | half day |
| Hole #17 | Resolved by reframing. README edit. | 30 minutes |
| Higher #1 | `outbound.md` + dashboard outbound tile + hard cap. Brainstorms forbidden from outbound. | half day |
| Higher #2 | Confidence score on injection + "this looks wrong" button. | half day |
| Higher #3 | Auto-ingest voice-review and audit documents as brainstorm artifacts. Backfill (Section 2 decision 12) covers historical. | half day |
| Higher #4 | `frozen: true` frontmatter flag for LLM-write-only pages with user-veto. | half day |
| Higher #5 | Random artifact sampling in dashboard for correct/incorrect labelling. | half day |
| Higher #6 | `last-verified` field per insight + lint flag at >90 days. | half day |
| Higher #7 | `schema_version` field + migrations directory. | half day |
| Higher #8 | Quarterly restore drill + documented runbook. | 2 hours setup, 1 hour per drill |
| Higher #9 | Cold-start test runbook + automated case in integration suite. | 2 hours |
| Higher #10 | Pause mode (freeze wiki decay during configurable inactive periods). | 2 hours |
| Higher #11 | Document hybrid retrieval strategy. Confirm BM25+vector+recency+source-class fusion is the actual strategy. | 1 hour to document, half day if implementation differs |
| Higher #12 | Tag KPIs to Karpathy claims; monitor over observation window. | 1 hour |
| Karpathy steal 1 | Load `DEVNEURAL.md` into Pass 2 system prompt. | hour |
| Karpathy steal 2 | Lint as scheduled nightly task. Dashboard findings panel. | half day |
| Karpathy steal 3 | LLM self-audit periodic task. | half day |

### 5.1 Brainstorm-first work (Section 2 decisions, fully scoped)

| Decision | Action | Effort |
|---|---|---|
| 2.1 | Source-class weights configurable + intent-aware re-weight in `/lex/recall`. New default: brainstorms > wiki > drafts > project transcripts > raw > reference. | day |
| 2.2 | Exempt brainstorm_chunks from decay scheduler. Audit code path. | hour |
| 2.3 | `brainstorm_chunks` table (or tag) for turn-bounded full-transcript chunks with no-decay flag. Session-end pipeline writes both summary and full chunks. | day |
| 2.4 | Outbound rule: brainstorm content forbidden in Pass 2 fallback and cross-project verifier. Enforced in code, tested. | half day |
| 2.5 | First-class `/brainstorms` route on the dashboard. Top-level nav. Filters: project, mode, date, vector match. Detail page: summary, artifacts, transcript, audio, lineage. | 2 days |
| 2.6 | `general` namespace for project-less brainstorms. Schema migration (project_slug nullable, default `general`). | half day |
| 2.7 | **Automatic session-end wiki distillation** (no manual button). Hook into existing session-end pipeline: run Pass 2 against full transcript, write pending wiki drafts. `/drafts` queue with promote/edit/discard. Auto-promote-above-threshold / auto-drop-below after N days of no action. `source_brainstorms` frontmatter on every wiki page. Surfaced in page detail modal. Admin "force re-distill" action retained. | 1.5 days |
| 2.8 | Cross-brainstorm auto-link: vector-similarity edges between session summaries. **Unified orb** (no toggle). Brainstorms, wiki pages, and projects are all nodes in the same graph. Edges span all node types: brainstorm<->brainstorm, brainstorm<->wiki, wiki<->wiki, brainstorm<->project. Node style differentiates type. Filter chips replace toggles for "show only brainstorms" etc. | 3 days |
| 2.9 | "What was I thinking" first-class query mode. Lex command + dashboard search filter. | half day |
| 2.10 | Audio retention. Keep source bundle in `data/brainstorms/<id>/audio/`. Dashboard playback control. Configurable max-age + opus compression. | day |
| 2.11 | Brainstorm KPI tiles: total count, hours, avg artifacts/brainstorm, wiki lineage coverage, project-less ratio. | half day |
| 2.12 | `npm run backfill-brainstorms` one-shot. Re-ingest pre-2026-05-09 sessions into the new shape. | day |

---

## 6. Lex carve-out

P2-1 (Lex personality customization, dials, per-mode few-shot, refusal contract, `SYSTEM_PROMPT_VERSION` versioning) stays on the critical path *in parallel* with the wiki-proof and brainstorm-first work. Lex is the primary CC-side innovation surface and must be functional, communicative, and well-guardrailed independent of however the RAG, wiki, and brainstorm layers evolve.

P2-2 (live awareness broadcaster) is gated. Broadcaster consumes wiki + KPI + active-session state. Ships only after curator instrumentation lands.

P2-3 (thumbs feedback) is double-purpose: feeds Lex feedback loop *and* reinforcement ground truth. Promote ahead of P2-2.

---

## 7. Stopping criteria

DevNeural is "solid" when all are true:

- **Curator Health card** shows useful injection rate >=60% on complex prompts (>=5 turn sessions) over 30 days.
- **Explicit thumb-up rate** on injections >=70%.
- **Nightly schema-regression canary** green for 14 consecutive days.
- **Nightly LLM self-audit** zero high-severity findings for 7 consecutive days.
- **Lint** zero high-severity findings for 7 consecutive days.
- **Integration tests** one golden-path per layer, passing on every commit.
- **External heartbeat** alerted at least once and recovered cleanly.
- **Brainstorm lineage coverage** >=80% (every wiki page that derived from a brainstorm has a back-pointer).
- **Brainstorm search latency P50** <300ms.
- **Audio replay** functional on at least one historic and one recent brainstorm.
- **Restore drill** completed at least once with documented time-to-restore.
- **Outbound dashboard tile** shows zero brainstorm content has ever been sent off-host.
- **Cold-start test** documented and integrated; new project gets sensible cross-project injection from prompt 1.

---

## 8. Sequenced execution

### Wave 1 (this week, ~3 days work)

Foundations and irreversible reframes. No optional polish.

1. **Brainstorm-first reframe (Section 2.1, 2.2, 2.3, 2.4, 2.6, 2.11):** retrieval order flip, decay exemption, `brainstorm_chunks` table, outbound rule, `general` namespace, KPI tiles. Plus README edit to drop "product" framing and elevate brainstormer-first identity.
2. **Curator instrumentation + Curator Health KPI card** (holes #1, #2, #5).
3. **Synthetic canary + schema regression suite** (holes #2, #3).
4. **Schema-as-living-config** (Karpathy steal 1).
5. **Embedder `model_id` + `npm run reindex`** (hole #9).
6. **Cross-project threshold raise / domain-distance** (hole #10).
7. **`outbound.md` + dashboard outbound tile + hard cap** (higher #1, ties to Section 2.4).
8. **`frozen: true` flag for LLM-write-only with user-veto** (higher #4).
9. **`schema_version` + migrations directory** (higher #7).

### Wave 2 (parallel tracks, ~1 week)

Track A (brainstorm-first build-out + wiki proof):

- Section 2.5 (`/brainstorms` route).
- Section 2.7 (bidirectional linkage + extract-insights button).
- Section 2.10 (audio retention + replay).
- Section 2.12 (`backfill-brainstorms` one-shot).
- Higher #3 (auto-ingest audit documents).
- Karpathy steal 2 (lint as nightly).
- Karpathy steal 3 (LLM self-audit).
- Higher #2 (confidence score + "this looks wrong" button).
- Higher #6 (`last-verified` field + 90-day lint flag).
- Higher #10 (pause mode).
- Hole #11 (GPU job queue / VRAM backoff).
- Hole #14 (external heartbeat).
- Hole #15 (native OS toast fallback).
- Hole #16 (raw_chunks cull rule, brainstorms exempt).

Track B (Lex critical path):

- P2-1 personality customization with A/B replay harness baked in (hole #8).
- P2-3 thumbs UI (double duty: Lex feedback + reinforcement ground truth).
- Higher #5 (random artifact sampling in dashboard).

### Wave 3 (gated on Wave 2 signals, ~1 week)

- Section 2.8 (cross-brainstorm auto-link + brainstorm-orb layer).
- Section 2.9 ("what was I thinking" first-class query mode).
- P2-2 awareness broadcaster (only after curator instrumentation shows trustworthy signals).
- Higher #8 (restore drill + runbook).
- Higher #9 (cold-start test + automated case).
- Higher #11 (document hybrid retrieval strategy).
- P2-0 adversarial spec review with real numbers in hand instead of speculation.
- P2-4, P2-5 (UI polish, docs refresh).
- Stopping-criteria check. If green, declare solid.

---

## 9. Verdict

DevNeural's core wiki layer sits on validated ground (Karpathy's pattern). The riskiest extensions (reinforcement, real-time injection, cross-project, voice) are additive; the system collapses gracefully to Karpathy if they fail.

The most important correction in this review is **brainstorm-first**: voice brainstorm conversations are the substrate, not derivatives. Retrieval, decay, privacy, dashboard, and lineage are all reordered around that fact.

Lex stays on the critical path independent of wiki proof and brainstorm-first build-out. Stopping criteria are decidable. With Waves 1 through 3 done, this is solid agentic personal infrastructure for one user, organised around how that user actually thinks: out loud, in conversation, before code.

---

# 2026-07-17 voice pipeline findings (investigation only, feeds the barge-in spec)

Audit of the live pipeline against four target behaviors plus the bell
inventory. Every claim below carries file:line evidence from the
working tree at ecc22e4 or from live state (daemon.log,
voice-preferences.json, notifications.jsonl). No code was changed.

## F1. Self-echo: how Lex's own TTS becomes a user utterance

**Capture path.** The mic opens ONCE with browser echo cancellation ON:
getUserMedia({audio: {echoCancellation: true, noiseSuppression: true,
autoGainControl: true}}) (08-dashboard/components/VoiceClient.tsx:2442-2448).
That raw stream feeds a GainNode (live mic_gain currently 1.1) whose
output is injected into silero VAD via the getStream/pauseStream/
resumeStream override triad (VoiceClient.tsx:2586-2626). So AEC is on,
but its residual is multiplied by mic gain before VAD triggering, and
laptop-speaker/Bluetooth leakage routinely survives browser AEC.

**Playback path defeats the echo canceller.** TTS PCM plays through a
bare AudioContext: every binary chunk is wrapped in an
AudioBufferSourceNode and scheduled onto a playhead
(schedulePcmChunk, VoiceClient.tsx:1226-1242, fed from the ws binary
handler at 2115). Chromium's AEC historically does not reference Web
Audio API output (Chromium bug 40504498; the fix landed 2023-10-31 and
coverage of AudioWorklet/setSinkId paths remains unverified), so the
echoCancellation:true constraint on capture has nothing to subtract:
the canceller never sees what the speakers are playing. This is the
spec's named suspect path, confirmed present.

**The during-TTS guard is advisory now, not a drop.**
state.utteranceStartedDuringTts is set only when an utterance-start
frame arrives (07-daemon/src/voice/lex-voice-ws.ts:4182-4193) and is
consumed as a context HINT to the voice-brain top layer
(lex-voice-ws.ts:3766-3784, voice-top-layer.ts:88-98). The only hard
suppression left is the fail-safe branch: forward suppressed when the
top layer returned nothing AND the turn started during TTS
(lex-voice-ws.ts:3837-3851). Top layer v2 (aa330c4, 2026-07-15) removed
the old deterministic non-wake during-TTS drop; a model judgment call
now decides echo vs real, and it demonstrably misjudges (the live
"Cancelled call" echo delivered as a queued user utterance).

**Two holes make the flag itself wrong:**

1. **Drain tail.** The daemon clears state.ttsActive and sends
   tts-end when the piper PCM stream ends
   (lex-voice-speak-controller.ts:219-235), which is seconds before the
   client's AudioContext drains its scheduled buffers (the client
   documents exactly this at VoiceClient.tsx:2322-2328). The client
   knows true drain in finalizePlaybackEnd (VoiceClient.tsx:1030-1049)
   but sends NO frame to the daemon there. Any utterance starting in
   the tail gets utteranceStartedDuringTts=false.
2. **Swallowed-start staleness.** The client barge cooldown early-return
   exits onSpeechStart BEFORE utterance-start is sent
   (VoiceClient.tsx:2657-2667 returns; the send is at 2676). VAD's
   onSpeechEnd still ships the audio plus utterance-end
   (VoiceClient.tsx:2735-2743 into finalizeUtterance 2562-2581). The
   daemon then transcribes a turn whose during-TTS flag is whatever the
   PREVIOUS turn left (cleared to false at lex-voice-ws.ts:3784), and
   whose mic buffer was never reset: binary frames append
   unconditionally (lex-voice-ws.ts:4119-4120) and only an
   utterance-start clears the buffer (4191-4192).

**Live confirmation:** every "transcript received" line tonight
03:02-03:14Z logs duringTts=false (daemon.log), during a session with
active TTS.

## F2. Barge-in regression: why speech during TTS stops nothing

**The only entry point** is silero onSpeechStart
(VoiceClient.tsx:2633). Flow: muted return (2634); if
speakingRef || ttsActiveRef (2657) then IF
Date.now() - lastTtsStartAtRef < bargeCooldownRef return with NO
frames sent (2664-2667); otherwise send barge-in, locally
resetTtsPlayback() (2672-2673), then utterance-start (2676), which
is the daemon floor that kills piper unconditionally
(lex-voice-ws.ts:4190, killActiveTts 2937-2975).

**The cooldown clock restarts on every segment.**
lastTtsStartAtRef.current = Date.now() runs on EVERY tts-start
frame, continuation segments included (VoiceClient.tsx:2285-2305), and
the daemon emits tts-start PER SEGMENT
(lex-voice-speak-controller.ts:200-204). Since top layer v2 phase 2
(7319847, 2026-07-15), a reply streams as MANY short segments: each
directive-free voice-brain record speaks immediately as its own
segment (lex-voice-ws.ts:3777-3781), and the raw fallback splits per
sentence via splitForSpeech (lex-voice-ws.ts:2496). Result: the
cooldown window re-arms every few seconds for the whole reply.

**The live cooldown is 1500ms** (voice-preferences.json,
barge_cooldown_ms: 1500; file last written 2026-07-16 22:49 local).
Default is 250ms (piper.ts:60-64); the slider max is 2000
(VoiceClient.tsx:218). With 1500ms re-armed at every segment start,
most user speech during playback falls inside a swallow window: the
handler returns before ANY frame is sent, so the daemon floor never
fires either. Playback continues; the operator cannot interrupt.

**Commit hunt result:** none of 73508bd / 7d4222a / 1cc3701 / d238332 /
ecc22e4 touched the kill path (their diffs cover inject-verify,
keepalive, failure logging, session-end triggers, replay). 1e1d48e
migrates only mic_gain and vad_redemption (lib/mic-gain-migration.ts)
and does not touch barge_cooldown_ms. The regression is an
interaction, not one commit: (a) 2026-07-15 top layer v2
(aa330c4 + 7319847) turned one-or-two tts-starts per reply into a
per-sentence/per-record stream of them, multiplying cooldown restamps;
(b) the persisted cooldown sits at 1500ms, 6x default (the tunable knob
itself dates to 6c50b7e). Either alone is survivable; together the
swallow windows tile the reply.

**Drain-tail corollary:** in the tail the daemon has no ctx to cancel
(speakCtrl.killActive() returns false, killActiveTts 2947-2948 exits
before tts-cancel), so ONLY the client-local resetTtsPlayback() can
stop tail audio, and only when the cooldown gate lets the handler run
(client flags stay true until finalizePlaybackEnd, so the block is
reachable there).

## F3. Endpointing: vad_redemption_ms application

- **Init:** MicVAD.new spreads
  buildVadOptionSet(vadSensitivityRef.current, vadRedemptionRef.current)
  (VoiceClient.tsx:2826-2829); vad-web 0.0.30 honors only the ms-based
  keys (lib/voice-vad-options.ts header comment).
- **Live update machinery EXISTS and works:** applyLiveVadOptions calls
  vad.setOptions(buildVadOptionSet(...)) (VoiceClient.tsx:1577-1588);
  vad-web recomputes redemption frames on the next audio frame
  (node_modules/@ricky0123/vad-web/dist/real-time-vad.js:316-317,
  frame-processor.js:67-73).
- **But nothing server-side can trigger it.** The only triggers are:
  (a) the settings bus, a same-window CustomEvent
  (lib/voice-settings-bus.ts:36-53), and (b) the reconnect re-sync that
  re-fetches /voice/piper-status and re-emits all keys including
  vad_redemption_ms (VoiceClient.tsx:1974-2047).
- **FINDING:** no UI control emits vad_redemption_ms at all.
  VoiceSettingsPanel emits mic_gain (41, 254), audio_output_device
  (217), vad_sensitivity (226), and barge_cooldown_ms (285); it
  contains zero matches for "redemption". Therefore tonight's
  server-side push 450 -> 2500 at ~22:53 (via POST
  /voice/set-vad-redemption, 07-daemon/src/dashboard/routes.ts:2279)
  did NOT reach the running VAD instance and cannot until a ws
  reconnect fires the re-sync block or voice is toggled off/on. A
  running VAD keeps endpointing at its init-time value indefinitely
  under a server-side change.
- Current persisted value: vad_redemption_ms 2500
  (voice-preferences.json).

## F4. Mid-turn interrupts: stop-class routing today

- A stop-class utterance must round-trip the voice-brain LLM. Only a
  parsed CONTROL: line fires effects (lex-voice-ws.ts:3797-3804 ->
  applyTopLayerControl 3123-3154). interrupt_work maps to
  dispatchVoiceCommand('hold_up') which DOES hard-abort: TTS kill +
  a real \x03 down the Lex PTY + recap (runHoldUp wiring,
  lex-voice-ws.ts:3261-3315). stop_speaking kills TTS only
  (3128-3134), Lex keeps working by contract.
- When classification misses, times out, or the brain is down, the
  utterance becomes a FORWARD and, mid-turn with no TTS, lands in
  pendingUserUtterances (lex-voice-ws.ts:4004-4033), which flushes
  only at the next end_turn boundary (2050-2054;
  _flushPendingUtterancesImpl 873-930). That is tonight's observed
  "stop queued until the tool boundary". The ONLY deterministic phrase
  today is the panic kill (matchPanicCommand, 3675-3681).
- **Hard-interrupt attach point:** the PTY interrupt write pattern
  already exists at three sites sharing one shape
  (handle.pty.write of \x03): confirmRealBarge
  (lex-voice-ws.ts:2920-2935), killActiveTts explicit-barge branch
  (2965-2974), and runHoldUp's ctrlCLexPty (3281-3293). An
  ESC-equivalent stop-class hook rides the same
  getPty(bindKey)/handle.pty.write path; Fix 29's post-abort state
  resets (awaitingResponseSince=0, pendingUserUtterances=[],
  3311-3313) document exactly which state must clear after an abort or
  the next utterance wedges in the mid-turn queue.

## F5. Duplicate mid-turn delivery (observed 3x tonight)

Live trace 03:09:25-03:09:41Z (daemon.log): forward committed ->
"INJECT PARTIAL DELIVERY: landed user record is missing payload
head/tail; repasting the full payload" -> CR retry 2/3 -> 3/3 ->
"INJECT DELIVERY FAILED" for the SAME fingerprint. Mechanisms, all in
code:

1. **Repaste on partial landing** re-sends the FULL payload after a
   truncated copy already submitted (verifyInjectDelivery,
   lex-voice-ws.ts:1102-1112): copy 1 (truncated, live_state fragments
   from the snapshot the direct path prepends at 3934+) plus copy 2
   (full).
2. **CR retries commit whatever sits in the composer**
   (lex-voice-ws.ts:1114-1119). A stuck paste from utterance A can be
   committed by utterance B's CR retry, B's 850ms flush follow-up CR
   (881-919), or the always-fire bare CR after inject: three
   independent CR sources share one composer.
3. **Flush requeue on failure** (lex-voice-ws.ts:894-901) re-queues the
   text for the NEXT end_turn while the original paste may still be
   sitting uncommitted: a third copy when it finally commits.
4. The queued path itself has no fingerprint dedupe against copies
   already delivered by (1)/(2).

**Heard-you today:** a queued mid-turn utterance only gets a
queued-mid-turn UI frame (lex-voice-ws.ts:4030-4033). No audio ack
exists, so queued-until-boundary reads as ignored. (Output-side dedupe
wasLastSpoken/rememberSpokenLine exists in voice-top-layer.ts:460-521
but covers spoken lines, not inject delivery.)

## F6. Bell notification emitter inventory

Bell filter: BELL_NOTIFY_CLASSES = report/followup/signal;
'conversation' is excluded from the bell but still lands in the feed
(07-daemon/src/dashboard/notifications.ts:46-51).

| Emitter | file:line | class | fires on | routine? |
|---|---|---|---|---|
| Curator inject | reinforcement/index.ts:164 | signal | EVERY curator context inject | yes: 3 bell rows in 2 min tonight (03:12:43, 03:13:46, 03:14:21) |
| Wiki promote | reinforcement/index.ts:175 | signal | every pending-page promotion | yes |
| Wiki hit | reinforcement/index.ts:185 | signal | every retrieval hit | yes |
| Raw-chunk hit | reinforcement/index.ts:195 | signal | every raw transcript hit | yes |
| Correction demote | reinforcement/index.ts:205 | signal (warn) | user-correction demotion | borderline |
| Claude waiting (idle_prompt) | dashboard/routes.ts:1379 | followup (warn, pushes) | every CC Notification hook idle prompt | yes while voice-chatting: 03:12:32, 03:13:51, 03:15:58, 03:16:09 |
| Lex finished a turn | dashboard/routes.ts:1450 | conversation | every Lex turn | bell-filtered, floods activity feed (5 rows 03:12-03:15) |
| Generic POST /notifications | dashboard/routes.ts:3535 | caller-set, default signal | any internal poster | open door |
| Session ended report | lex/session-end-pipeline.ts:203 | report | every terminal session end | semi |
| Stale distillation | lex/stale-watcher.ts:183 | signal | stale anchors per tick | yes when distill pipeline is broken |
| Grooming gaps | daemon.ts:646 wrapper | signal | grooming classes, 30-min/anchor debounce | semi |
| Missing ffmpeg/binary | reference/process.ts:286 | signal (warn) | reference ingest needs binary | legit |

The bell fillers during tonight's session were the curator inject
signals and the idle_prompt followups (which also web-push at warn).

## Verdict against the four target behaviors

1. Speech cuts Lex audio under 300ms: FAILS during cooldown windows
   (1500ms x per-segment restamp tiles the reply) and has no server
   kill in the drain tail.
2. Long TTS reply, zero phantom utterances: FAILS via three compounding
   holes: advisory-only echo judgment, drain-tail flag=false, and
   swallowed-start stale flag plus un-cleared mic buffer.
3. Stop lands under 1s mid-turn: FAILS unless the LLM classifies
   CONTROL in time; the deterministic path exists only for the panic
   phrase. The PTY interrupt primitive already exists (three call
   sites).
4. One utterance = one delivery: FAILS under partial-landing repaste
   plus multi-source CR commits plus failure requeue, with no
   delivery-side fingerprint dedupe.
