# Supervisor wire routes to worker terminal, not Lex (Fix 34d aftermath)

**Reported:** 2026-05-26 02:30 EDT by operator
**Severity:** high (cross-session inject pipeline misrouted; audit trail lied)
**Status:** fixed (Fix 34d.1, this commit)
**Related:** FIXES.md row 34d (regressed), row 34d.1 (this fix); `docs/SMOKE-PROGRESS.md` step 3.7 REGRESSED.

## Symptom

Event-driven supervisor wire (`07-daemon/src/dashboard/worker-event-listener.ts`)
fired correctly end-to-end: chokidar saw worker jsonl changes, the detector
matched `idle`, `resolveLexTargetSession` returned the correct Lex CC session
id (`2a708d6d-44db-4668-97f5-bce3e94d19b0`), and `cross_session_injection_log`
recorded a row with `caller_label='event-supervisor'`,
`decision='accepted'`, `reject_reason='delivery_mode=lex-queue'`. Looked
green on every audit surface.

Live behavior contradicted the audit: the `[supervisor-event] worker=DevNeural
event=idle…Decide: re-inject worker…` payload landed in the WORKER's CC jsonl
(`94e85826…`) as queue-operation enqueue rows, NOT in Lex's CC jsonl
(`2a708d6d…`). Worker got the prompt asking Lex how to handle worker idleness.
The worker started reasoning about itself instead of Lex deciding.

## Why the audit lied

`07-daemon/src/dashboard/worker-event-listener.ts` Fix 34d's
`deliverSupervisorPromptToLex` ran:

```ts
const ref = db.getLexTranscriptRefByCc(lexCcSessionId);
const r = injectQueue(ref.lex_session_id, text);   // BUG
```

`injectQueue` defaulted to `queueSessionPrompt` in
`07-daemon/src/dashboard/sessions.ts`, which calls
`writeBridgePrompt(sessionId, text, true)`. That writer creates a marker
file `<DATA_ROOT>/bridge-prompts/<sessionId>.in` for the
[09-bridge VSIX](`09-bridge/`) to read and paste into the matching VS Code
terminal.

The `<sessionId>.in` shape REQUIRES a Claude Code session id (that's the
identifier the bridge keys terminals by). `ref.lex_session_id` is a
`lex_session.id` row UUID (a brainstorm anchor), NOT a CC session id.

Concrete row from the operator's DB:

```
lex_transcript_ref id=188
  lex_session_id = 4bbafb48-bbfd-47e6-b076-e1a58a334303   (brainstorm anchor)
  cc_session_id  = 2a708d6d-44db-4668-97f5-bce3e94d19b0   (Lex CC)
```

So `writeBridgePrompt('4bbafb48-…', text, true)` dropped a marker that no
VSIX terminal claimed. The 09-bridge VSIX with no matching terminal fell
through to whichever terminal was in scope (the worker), pasted the
supervisor payload there. Audit row recorded `accepted` because the file
write succeeded — the writer never knew about delivery.

## Architectural rule re-affirmed (operator, 2026-05-26 02:35 EDT)

> Daemon NEVER injects directly to worker. Daemon notifies Lex; Lex decides.
> Only Lex's outputs reach worker.

The Fix 34d branch violated this in two ways:

1. The "lex-queue" branch silently routed to the worker via bridge-fallback.
2. The else-branch (`isLexTarget === false`) called `crossSessionInject` with
   the supervisor payload, which could legitimately reach a worker via bridge
   or daemon-owned PTY. Per the rule, supervisor injects MUST target Lex; a
   non-Lex target is an error condition, not a fallback case.

## Fix (Fix 34d.1)

`07-daemon/src/dashboard/worker-event-listener.ts`:

1. `deliverSupervisorPromptToLex` now calls
   `ptyInject(lexCcSessionId, text, true)` (from
   `07-daemon/src/dashboard/pty-host.ts`). `ptyInject` resolves by `ptyId`
   first then by `sessionId`; Lex CC runs under a daemon-managed pty so
   `cc_session_id` matches `handle.sessionId` and the write lands at Lex's
   terminal directly. Trailing CR commit and 1 s bare-CR follow-up nudge are
   baked into `ptyInject` already.
2. Mode label flips: `'lex-queue'` -> `'lex-pty'`. Audit `reject_reason` tag
   becomes `delivery_mode=lex-pty`.
3. Signature: third param renamed `injectQueue` -> `injectPty`, typed
   `(ccSessionId, text, commit) => { ok: true } | { ok: false; error }` —
   same shape as `ptyInject`.
4. `buildInject` non-Lex-target branch drops the `crossSessionInject` fallback
   entirely. Now: audit-log with `mode='rejected-not-lex'`,
   `reject_reason='target_not_lex_cc'`, return `{ ok: false, reason:
   'target_not_lex_cc' }`. Supervisor wire is Lex-only by construction.
5. Imports dropped: `crossSessionInject`, `issueToken`, `queueSessionPrompt`.
   Import added: `ptyInject`.

## Tests

`07-daemon/tests/worker-event-listener.test.ts` four pins, all under
`describe('deliverSupervisorPromptToLex (Fix 34d.1: pty routing)')`:

1. `no_lex_transcript_ref` when target cc is not bound to a Lex session.
2. **Inversion of the pre-fix bug:** routes via `injectPty` keyed on the CC
   id (NOT `lex_session.id`). Pins `ccSessionId === 'cc-lex-target'` and
   `commit === true`.
3. `injectPty` error surface (returns `mode='lex-pty'`, `reason` propagated).
4. **Contract pin via `vi.spyOn(sessionsModule, 'queueSessionPrompt')`**
   asserting the bridge writer is NEVER called under any branch. A future
   regression that wires the bridge fallback back in will fail loudly here.

## Live verification (post-rebuild + restart)

1. Restart daemon.
2. Force a worker idle (or wait for the next idle event).
3. Confirm new row in `cross_session_injection_log` with
   `caller_label='event-supervisor'` AND
   `reject_reason='delivery_mode=lex-pty'`.
4. Tail Lex CC jsonl
   `C:/Users/michael/.claude/projects/C--dev-data-skill-connections-brainstorm/2a708d6d-44db-4668-97f5-bce3e94d19b0.jsonl`:
   the `[supervisor-event]` text MUST appear here.
5. Worker jsonl (`94e85826-…` and successors) MUST NOT receive any new
   queue-operation rows containing `[supervisor-event]`.

If `ptyInject` returns `'pty not found'` (Lex CC running outside daemon
spawn), the row will land with `mode='lex-pty'` `reason='pty not found'`.
That is a different failure (Lex bootstrap path) and is out of scope here;
the routing fix is correct regardless.

## Addendum: snippet picker (bundled in Fix 34d.1)

While reviewing the misrouted payloads, the operator surfaced a second
defect on the same wire: the `Snippet:` block carried raw jsonl bytes
(usually the last ~2 KB), which on SessionStart was CC's skill-catalog
attachment (`"skillCount":99,"isInitial":true`), on hook ticks was the
`hook_additional_context` payload, and during work was whatever
queue-operation envelope the worker had just written. Pure noise. Lex
had no actionable signal from any supervisor fire.

**Required payload per event type (operator-stated):**

- **idle** — stall duration in seconds since the last assistant turn,
  last user message text, last assistant text (skip pre-tool acks where
  `stop_reason='tool_use'`), last tool call attempted + result.
- **permission_denied** — denied tool name, denied tool input args, hook
  reason if present.
- **commit** — commit subject line, files touched count, branch.
- **expectation_drift** — the drift description from the expectation
  supervisor (passed via override, since the jsonl tail does not carry
  the LLM-judged summary).

**General rules:** strip CC meta records (system, attachment,
`hook_additional_context`, queue-operation, skill catalogs, session-init
blobs). Use only `assistant.text` and `user.message.content[].text`
fields. Cap at ~600 chars total; truncate middle if needed. Empty case
returns `(no recent activity)` — never silently swallow.

**Implementation:**

- New pure module `07-daemon/src/dashboard/worker-event-snippet.ts`.
- Exports `parseMeaningfulLines(jsonlTail)` (filter logic mirrors
  `brainstorm-jsonl-ingestor`'s meaningful-line predicate: skip
  `isMeta`, `isCompactSummary`, top-level `attachment` records; keep
  only `user` and `assistant` records; pull text + tool_use +
  tool_result parts).
- Exports `extractEventSnippet(eventType, rawTail, opts)` with a small
  switch on `eventType` for the four formatters above plus a fallback
  for `test_failure` / `pending_prompt` / `bridge_disconnect`.
- `worker-event-detect.ts` `pushIfFireable` now stamps
  `snippet: extractEventSnippet(type, parsed.snippet, { now })`
  instead of raw bytes.

**Tests:** new `07-daemon/tests/worker-event-snippet.test.ts` with 12
pins covering filter behavior, per-event-type formatter outputs, the
600-char cap, and the explicit pre-tool ack skip on `last_assistant`.
Existing `worker-event-detect.test.ts` permission_denied pin updated
from `/Permission to use Bash/` to `/denied_tool:\s*Bash/`.

**Combined test totals (routing + snippet picker):** 889/889 daemon
tests pass; tsc clean.

Live verification step (3) is added in the verification list above:
the `Snippet:` block must contain structured `stall_seconds=…`,
`last_user: …`, `last_assistant: …` lines, NOT raw jsonl bytes or
skill catalog text.
