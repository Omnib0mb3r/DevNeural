# Voice Layers (L1 rebuild + L2 control) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild Layer 1 (the Haiku voice terminal that holds Lex's personality, does all the talking, drops background noise, sees Layer 2 and controls it) on a proven root cause, and give it mechanical control over Layer 2's plan approval and worker dispatch.

**Architecture:** L1 is a per-brainstorm headless `claude` PTY (Haiku, no tools, `--setting-sources project,local`, spawned first when a brainstorm is opened). Every operator utterance becomes one L1 turn whose spoken text streams sentence by sentence and whose trailing `FORWARD:` / `CONTROL:` / `IGNORE:` lines drive the daemon. L2 (Opus/Fable, always spawned scoped with the brainstorm) plans and supervises workers; the daemon parks L2's worker dispatches and plan-approval prompts and lets L1 ask the operator by voice.

**Tech Stack:** TypeScript (Node 22, ESM), Fastify daemon (`07-daemon`), vitest, better-sqlite3 migrations (`07-daemon/scripts/migrations/NNN-*.sql`), Next.js static dashboard (`08-dashboard`), Claude Code CLI as the session runtime.

**Spec:** `docs/spec/LAYER-1-CONTROL.md` (canonical). Context-lifecycle companion: `C:\dev\data\skill-connections\brainstorm\AUTO-CLEAR.md` (T1-T10) and `docs/spec/SMART-COMPACT.md` (rewritten in Task 12).

## Global Constraints

- No em dashes or en dashes anywhere (code comments, docs, commit messages, UI strings). Hyphens, colons, periods.
- No AI attribution in commits. Commit bodies end with a `Rebuild: yes|no` line (project convention).
- Additive-first: existing dashboard control surface stays byte-identical (no new buttons/sliders on the voice panel).
- Daemon restart is operator-only. Build `dist/` and `08-dashboard/out/` but never restart the daemon.
- Every Bash call: one destructive op per call, never chained (project CLAUDE.md).
- Tests: `cd C:/dev/Projects/DevNeural/07-daemon && npx vitest run tests/<file>.test.ts`. Full suite: `npm test` (2 known reds are pre-existing: `grooming-routes.test.ts`, occasional `smart-compact-injector.test.ts` flake).
- Effort levels whitelist: `low|medium|high|xhigh|max`. Model whitelist: `opus|fable|sonnet|haiku` or `/^claude-[a-z0-9.-]+$/`.
- L1 spawn argv MUST contain `--tools ""`, `--strict-mcp-config`, `--setting-sources project,local`. L2 spawn MUST NOT get `--setting-sources` (its capture hooks live in user settings).
- `IGNORE` is a model decision, never a fallback: any L1 failure forwards the utterance verbatim to L2.
- Emergency stop stays deterministic (`matchPanicCommand` regex before anything else).
- Single mouth (spec "Single mouth" section): L1 is the only speaker; every spoken line is an L1 ask on the anchor's serialized queue; `topOwnsAck` is set when L1 spoke a handoff; a cut delivery is never re-delivered from the top; never-twice ring applies to L1 lines.
- Never touch ports, Tailscale serve config, or the Salem road trip project (a different tool the operator is running live). DevNeural stays on 3747/3000. No command may bind a port or restart the daemon.

---

## File Structure

| File | Responsibility |
|---|---|
| `07-daemon/src/lex/voice-brain-session.ts` (modify) | L1 PTY lifecycle per anchor: spawn, warm, ask, jsonl tail, blue/green rotate, kill. Owns the two-record end_turn fix. |
| `07-daemon/src/lex/persona.ts` (create) | Shared Lex identity/persona text blocks for L1 and L2. |
| `07-daemon/src/lex/system-prompt.ts` (modify) | L2 prompt composer consumes persona.ts; loses the TTS bullet; gains the `held_for_confirm` API note. |
| `07-daemon/src/lex/layer-model.ts` (modify) | Runtime knobs: `top_model`, `top_effort`, `mid_effort`, `worker_effort`, `dispatch_confirm_gate`; `effortArgs`. |
| `07-daemon/src/voice/voice-top-layer.ts` (modify) | L1 spawn prompt, live block, turn message, directive parser, `topLayerTurn`, `voiceLexReply`. |
| `07-daemon/src/voice/lex-voice-ws.ts` (modify) | Wiring: `forwardToL2` extraction, `midState`, warm queue, L1 turn integration, control handlers, `ignored` frame, `notifyTopLayerEvent`. |
| `07-daemon/src/lex/spawn-lex-session.ts` (modify) | `onPrepared` hook so L1 spawns before L2. |
| `07-daemon/src/dashboard/routes.ts` (modify) | Spawn-on-Open, effort args, dispatch gate in `/lex/inject-cross-session`, plan-approval detection in `/sessions/:id/pending-prompt`, L1 kill on anchor end. |
| `07-daemon/src/lex/dispatch-gate.ts` (create) | Pure pending-dispatch registry (park / release / reject / expire). |
| `07-daemon/src/lex/plan-approval.ts` (create) | Pure plan-prompt detector, plan extractor, approve/reject PTY actions, registry. |
| `07-daemon/scripts/migrations/054-lex-session-voice-binding.sql` (create) | Persist the L1 binding on `lex_session`. |
| `07-daemon/src/store/index-db.ts` (modify) | `LexSessionRow` voice fields + `setLexSessionVoiceBinding`, `getLexSessionByCcSessionId`. |
| `08-dashboard/components/VoiceClient.tsx`, `08-dashboard/lib/transcript-grouping.ts` (modify) | `ignored` frame rendered as a greyed operator row. |
| `docs/spec/SMART-COMPACT.md` (rewrite), `BUGS.md`, `FIXES.md`, `docs/HANDOVER.md` (modify) | Docs and trackers. |

---

### Task 0: Carry the prior session's uncommitted work into its own commit

The tree has uncommitted BUG-017/020/021 work from 2026-08-26 (`start-daemon.ps1`, `daemon.ts`, `routes.ts`, `sessions.ts`, `identity/project-id.ts`, `lex-voice-speak-controller.ts`, `lex-voice-ws.ts`, three tests, `BUGS.md`). This wave edits the same files; commit that work first so history stays honest and nothing is lost.

**Files:** all currently dirty files (see `git status`).

- [ ] **Step 1: Run the tests those changes touch**

Run: `cd C:/dev/Projects/DevNeural/07-daemon && npx vitest run tests/project-id.test.ts tests/scan-and-register.test.ts tests/derive-phase-from-tail.test.ts tests/lex-voice-ws-speak-queue.test.ts`
Expected: PASS (if a file fails, stop and report; do not commit red work).

- [ ] **Step 2: Type-check**

Run: `cd C:/dev/Projects/DevNeural/07-daemon && npm run build:check`
Expected: exit 0.

- [ ] **Step 3: Commit by explicit paths**

```bash
cd C:/dev/Projects/DevNeural
git add 07-daemon/scripts/start-daemon.ps1 07-daemon/src/daemon.ts 07-daemon/src/dashboard/routes.ts 07-daemon/src/dashboard/sessions.ts 07-daemon/src/identity/project-id.ts 07-daemon/src/voice/lex-voice-speak-controller.ts 07-daemon/src/voice/lex-voice-ws.ts 07-daemon/tests/project-id.test.ts 07-daemon/tests/scan-and-register.test.ts 07-daemon/tests/derive-phase-from-tail.test.ts BUGS.md
git commit -m "fix: carry 2026-08-26 session fixes (heap caps, non-git registration, phase derive)

Uncommitted work found in the tree at the start of the voice-layers wave:
BUG-017 heap caps in the voice WS and speak controller, BUG-021 non-git
folder registration, BUG-019 derive-phase age gate, stderr log rotation.
Committed as found so the voice wave builds on a clean base.

Rebuild: yes"
```

Then commit the spec + plan docs:

```bash
cd C:/dev/Projects/DevNeural
git add docs/spec/LAYER-1-CONTROL.md docs/INDEX.md docs/superpowers/plans/2026-09-21-voice-layers.md
git commit -m "docs(voice): LAYER-1-CONTROL v2 canonical spec + implementation plan

Rebuild: no"
```

---

### Task 1: Fix the two-record end_turn read (root cause of chars=0)

**Files:**
- Modify: `07-daemon/src/lex/voice-brain-session.ts:672-767` (`waitForVoiceReply`)
- Test: `07-daemon/tests/voice-brain-session-two-record-turn.test.ts` (create)

**Interfaces:**
- Consumes: `waitForVoiceReply(jsonlPath, startOffset, deadline, onPartial, ptyId)` (private), `extractAssistantText`, `assistantStopReason`.
- Produces: unchanged signature; new env `DEVNEURAL_VOICE_BRAIN_EMPTY_END_TURN_GRACE_MS` (default 2500).

- [ ] **Step 1: Write the failing test**

Create `07-daemon/tests/voice-brain-session-two-record-turn.test.ts`. Copy the fixture helpers `makeVirtualIo`, `makeFakePtyLayer`, `baseDeps`, and the `warmSession` helper VERBATIM from `07-daemon/tests/voice-brain-session.test.ts` (lines 41-260; `warmSession` is the helper that calls `prewarmVoiceBrainSession()`, schedules the probe reply with `io.scheduleAssistantRecord(jsonlPath, N, 'OK', 'end_turn')`, and awaits `_voiceBrainWarmupForTests()`), then add:

```ts
describe('BUG-022: a thinking-only end_turn record must not close the ask', () => {
  it('streams the text from the sibling record and resolves with it', async () => {
    const io = makeVirtualIo();
    const pty = makeFakePtyLayer();
    _setVoiceBrainSessionDepsForTests(baseDeps(io, pty));
    const jsonlPath = await warmSession(io, pty);
    const partials: string[] = [];
    /* Claude Code shape observed 2026-09-21: record 1 = thinking block
     * with stop_reason end_turn and NO text; record 2 = the text block,
     * same message id, also end_turn. */
    io.scheduleAssistantRecord(jsonlPath, 50, null, 'end_turn');
    io.scheduleAssistantRecord(jsonlPath, 400, 'Checked. Nine AM tomorrow.', 'end_turn');
    const reply = await askVoice({
      prompt: 'Deliver this.',
      timeoutMs: 6000,
      onPartial: (t) => partials.push(t),
    });
    expect(reply).toBe('Checked. Nine AM tomorrow.');
    expect(partials).toEqual(['Checked. Nine AM tomorrow.']);
  });

  it('a genuinely empty turn still resolves (null) after the grace window', async () => {
    const io = makeVirtualIo();
    const pty = makeFakePtyLayer();
    _setVoiceBrainSessionDepsForTests(baseDeps(io, pty));
    const jsonlPath = await warmSession(io, pty);
    io.scheduleAssistantRecord(jsonlPath, 50, null, 'end_turn');
    const reply = await askVoice({ prompt: 'x', timeoutMs: 6000, onPartial: () => undefined });
    expect(reply).toBeNull();
  });

  it('text record first then a bare end_turn closes with the text', async () => {
    const io = makeVirtualIo();
    const pty = makeFakePtyLayer();
    _setVoiceBrainSessionDepsForTests(baseDeps(io, pty));
    const jsonlPath = await warmSession(io, pty);
    io.scheduleAssistantRecord(jsonlPath, 50, 'First sentence.');
    io.scheduleAssistantRecord(jsonlPath, 200, null, 'end_turn');
    const reply = await askVoice({ prompt: 'x', timeoutMs: 6000, onPartial: () => undefined });
    expect(reply).toBe('First sentence.');
  });
});
```

- [ ] **Step 2: Run it, confirm it fails**

Run: `cd C:/dev/Projects/DevNeural/07-daemon && npx vitest run tests/voice-brain-session-two-record-turn.test.ts`
Expected: first test FAILS with `expected null to be 'Checked. Nine AM tomorrow.'`.

- [ ] **Step 3: Implement the grace window**

In `voice-brain-session.ts`, above `waitForVoiceReply`, add:

```ts
/* BUG-022 (2026-09-21; the root cause behind the old BUG-008 chars=0).
 * Claude Code writes one assistant turn as TWO jsonl records sharing a
 * message id: a thinking-block record ALREADY stamped stop_reason
 * 'end_turn' and no text, then the text record. Returning on the first
 * end_turn handed back the empty thinking record on every ask. An
 * end_turn that carries no text now opens a short grace window for the
 * sibling text record; a genuinely empty turn still resolves (empty)
 * once the window lapses. */
const DEFAULT_EMPTY_END_TURN_GRACE_MS = 2_500;

function emptyEndTurnGraceMs(): number {
  const raw = Number(process.env.DEVNEURAL_VOICE_BRAIN_EMPTY_END_TURN_GRACE_MS ?? '');
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_EMPTY_END_TURN_GRACE_MS;
}
```

Replace the record loop inside `waitForVoiceReply` (the `for (const line of chunk.split(/\r?\n/))` body and the post-loop deadline check) with:

```ts
      for (const line of chunk.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let rec: Record<string, unknown>;
        try {
          rec = JSON.parse(trimmed);
        } catch {
          continue;
        }
        const text = extractAssistantText(rec);
        if (!onPartial) {
          if (text) return { timedOut: false, text };
          continue;
        }
        const endTurn = assistantStopReason(rec) === 'end_turn';
        if (text) {
          recordsSeen += 1;
          parts.push(text);
          try {
            onPartial(text);
          } catch (err) {
            deps.log(
              `[voice-brain] onPartial threw (ignored): ${(err as Error).message}`,
            );
          }
          effectiveDeadline = Math.min(
            wall,
            Math.max(effectiveDeadline, deps.now() + streamIdleMs()),
          );
          /* The text record closes the ask when it carries end_turn
           * itself OR when its thinking-only sibling already did. */
          if (endTurn || emptyEndTurnAt !== null) {
            return { timedOut: false, text: parts.join('\n') };
          }
          continue;
        }
        if (endTurn) {
          if (parts.length > 0) {
            return { timedOut: false, text: parts.join('\n') };
          }
          /* Thinking-only end_turn: wait for the sibling text record. */
          if (emptyEndTurnAt === null) {
            emptyEndTurnAt = deps.now();
            effectiveDeadline = Math.min(
              wall,
              Math.max(effectiveDeadline, emptyEndTurnAt + emptyEndTurnGraceMs()),
            );
          }
        }
      }
    }
    if (
      emptyEndTurnAt !== null &&
      deps.now() - emptyEndTurnAt >= emptyEndTurnGraceMs()
    ) {
      deps.log(
        `[voice-brain] end_turn carried no text and no sibling text record arrived within ${emptyEndTurnGraceMs()}ms; resolving empty`,
      );
      return { timedOut: false, text: parts.join('\n') };
    }
    const remaining = effectiveDeadline - deps.now();
    if (remaining <= 0) return { timedOut: true, recordsSeen, sawBytes };
    await deps.sleep(Math.min(deps.pollIntervalMs, remaining));
```

Declare `let emptyEndTurnAt: number | null = null;` next to `let effectiveDeadline = deadline;` at the top of the function.

- [ ] **Step 4: Run the new test and the existing session suite**

Run: `cd C:/dev/Projects/DevNeural/07-daemon && npx vitest run tests/voice-brain-session-two-record-turn.test.ts tests/voice-brain-session.test.ts tests/voice-brain-ready-watch.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd C:/dev/Projects/DevNeural
git add 07-daemon/src/lex/voice-brain-session.ts 07-daemon/tests/voice-brain-session-two-record-turn.test.ts
git commit -m "fix(voice): read the text record behind a thinking-only end_turn (chars=0 root cause)

Claude Code writes an assistant turn as two jsonl records sharing one
message id: a thinking block already stamped end_turn, then the text.
waitForVoiceReply returned on the first end_turn, so every L1 ask logged
chars=0 while the reply sat unread one record later. An end_turn with no
text now opens a 2.5s grace window for the sibling text record.

Rebuild: yes"
```

---

### Task 2: Shared persona module

**Files:**
- Create: `07-daemon/src/lex/persona.ts`
- Modify: `07-daemon/src/lex/system-prompt.ts:29-113` (IDENTITY head)
- Test: `07-daemon/tests/persona.test.ts` (create)

**Interfaces:**
- Produces: `LEX_IDENTITY`, `LEX_PERSONA`, `LEX_TEXT_STYLE`, `LEX_SPOKEN_RULES` (strings), `composeBrainIdentity(): string`, `composeVoiceIdentity(): string`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import {
  LEX_IDENTITY,
  LEX_PERSONA,
  LEX_SPOKEN_RULES,
  LEX_TEXT_STYLE,
  composeBrainIdentity,
  composeVoiceIdentity,
} from '../src/lex/persona.js';
import { buildLexSystemPromptStable } from '../src/lex/system-prompt.js';

describe('persona: one Lex, two mouths', () => {
  it('both compositions share the identity and persona verbatim', () => {
    const brain = composeBrainIdentity();
    const voice = composeVoiceIdentity();
    for (const block of [LEX_IDENTITY, LEX_PERSONA]) {
      expect(brain).toContain(block);
      expect(voice).toContain(block);
    }
    expect(LEX_PERSONA).toContain('Dry British wit');
  });
  it('the brain keeps the written style and never the spoken rules', () => {
    const brain = composeBrainIdentity();
    expect(brain).toContain(LEX_TEXT_STYLE);
    expect(brain).not.toContain('Voice mode (TTS)');
    expect(brain).not.toContain(LEX_SPOKEN_RULES);
  });
  it('the voice gets the spoken rules', () => {
    const voice = composeVoiceIdentity();
    expect(voice).toContain(LEX_SPOKEN_RULES);
    expect(LEX_SPOKEN_RULES).toMatch(/no markdown/i);
    expect(LEX_SPOKEN_RULES).toMatch(/UUID|long numbers/i);
  });
  it('the L2 system prompt is built from the shared blocks', () => {
    const prompt = buildLexSystemPromptStable('conversation');
    expect(prompt).toContain(LEX_IDENTITY);
    expect(prompt).toContain(LEX_PERSONA);
    expect(prompt).not.toContain('Voice mode (TTS)');
  });
});
```

- [ ] **Step 2: Run it, confirm it fails** (module missing).

- [ ] **Step 3: Create `persona.ts`**

Move the text verbatim out of `system-prompt.ts` IDENTITY: `LEX_IDENTITY` = the `# You are Lex.` heading through the paragraph ending `whisper config).` (lines 29-45); `LEX_PERSONA` = `## Persona` through `never "Hi there!".` (47-70); `LEX_TEXT_STYLE` = `## Voice (one voice across every mode)` through the Bad examples list (72-113) with the three-line `Voice mode (TTS)` bullet (93-95) REMOVED. Then:

```ts
/* Spoken rules: L1 is the only mouth. L2 never speaks, so these live
 * only in the voice composition (LAYER-1-CONTROL.md, Personality). */
export const LEX_SPOKEN_RULES = `## Spoken voice (you are the mouth)

Everything you write is converted to speech and played aloud.

- Short spoken sentences. One breath each. No lists, no headers, no
  markdown, no code fences, no asterisks, no backticks.
- Never read long numbers, UUIDs, commit hashes, or file paths aloud.
  Say "the commit", "that session", "the daemon sessions module".
- Plain English. No JSON, no code syntax. Summarise a location, never
  spell it.
- Preserve every number, decision, negation, blocker and name from the
  deeper brain exactly. You deliver; you do not summarise facts away.
- Answer first, then one question at most. Never close with an empty
  offer.
- No em dashes, no en dashes.`;

export function composeBrainIdentity(): string {
  return [LEX_IDENTITY, LEX_PERSONA, LEX_TEXT_STYLE].join('\n\n');
}

export function composeVoiceIdentity(): string {
  return [LEX_IDENTITY, LEX_PERSONA, LEX_SPOKEN_RULES].join('\n\n');
}
```

In `system-prompt.ts`: `import { composeBrainIdentity } from './persona.js';`, rename the existing template to `const IDENTITY_REST = \`## First-turn seed protocol ...\`` (everything from line 115 to the end of the old literal, unchanged), and define `const IDENTITY = [composeBrainIdentity(), IDENTITY_REST].join('\n\n');`.

- [ ] **Step 4: Run** `npx vitest run tests/persona.test.ts tests/system-prompt-scope.test.ts` → PASS. Run `npm run build:check` → exit 0.

- [ ] **Step 5: Commit** `git add 07-daemon/src/lex/persona.ts 07-daemon/src/lex/system-prompt.ts 07-daemon/tests/persona.test.ts` with message `refactor(lex): shared persona module for the voice and brain layers` (`Rebuild: yes`).

---

### Task 3: Runtime knobs and spawn flags

**Files:**
- Modify: `07-daemon/src/lex/layer-model.ts`
- Modify: `07-daemon/src/lex/voice-brain-session.ts:113-126` (model resolver), `:164-188` (deps), `:345-363` (argv)
- Modify: `07-daemon/src/dashboard/routes.ts:1808-1813`, `:1959-1964`, `:3996`
- Test: `07-daemon/tests/layer-model.test.ts` (extend), `07-daemon/tests/voice-brain-session.test.ts` (extend)

**Interfaces:**
- Produces in `layer-model.ts`: `TOP_MODEL_KEY`, `TOP_EFFORT_KEY`, `MID_EFFORT_KEY`, `WORKER_EFFORT_KEY`, `DISPATCH_CONFIRM_GATE_KEY`; `resolveEffort(raw): string | null`; `topModel(cfg)`, `topEffort(cfg)`, `midEffort(cfg)`, `workerEffort(cfg)`; `effortArgs(level): string[]`; `effortFlag(level): string`; `dispatchConfirmGateOn(cfg): boolean`.
- Produces in `voice-brain-session.ts`: new dep `runtimeConfig: () => RuntimeConfigReader`.

- [ ] **Step 1: Failing tests** (append to `layer-model.test.ts`):

```ts
import {
  dispatchConfirmGateOn, effortArgs, effortFlag, midEffort, resolveEffort,
  topEffort, topModel, workerEffort,
} from '../src/lex/layer-model.js';

function cfg(map: Record<string, string>) {
  return { getRuntimeConfig: (k: string) => map[k] ?? null };
}

describe('effort + top-model knobs', () => {
  it('whitelists effort levels and rejects junk', () => {
    expect(resolveEffort('low')).toBe('low');
    expect(resolveEffort(' XHIGH ')).toBe('xhigh');
    expect(resolveEffort('turbo; rm -rf /')).toBeNull();
    expect(resolveEffort('')).toBeNull();
  });
  it('effortArgs is empty when unset, a flag pair when set', () => {
    expect(effortArgs(null)).toEqual([]);
    expect(effortArgs('low')).toEqual(['--effort', 'low']);
    expect(effortFlag(null)).toBe('');
    expect(effortFlag('max')).toBe(' --effort max');
  });
  it('top model reads runtime_config, then env, then haiku', () => {
    delete process.env.DEVNEURAL_VOICE_BRAIN_MODEL;
    expect(topModel(cfg({}))).toBe('haiku');
    expect(topModel(cfg({ top_model: 'sonnet' }))).toBe('sonnet');
    process.env.DEVNEURAL_VOICE_BRAIN_MODEL = 'claude-sonnet-5';
    expect(topModel(cfg({}))).toBe('claude-sonnet-5');
    delete process.env.DEVNEURAL_VOICE_BRAIN_MODEL;
  });
  it('per-layer effort knobs', () => {
    expect(topEffort(cfg({ top_effort: 'low' }))).toBe('low');
    expect(midEffort(cfg({ mid_effort: 'xhigh' }))).toBe('xhigh');
    expect(workerEffort(cfg({}))).toBeNull();
  });
  it('dispatch gate is off unless on', () => {
    expect(dispatchConfirmGateOn(cfg({}))).toBe(false);
    expect(dispatchConfirmGateOn(cfg({ dispatch_confirm_gate: 'on' }))).toBe(true);
    expect(dispatchConfirmGateOn(cfg({ dispatch_confirm_gate: 'ON ' }))).toBe(true);
  });
});
```

And in `voice-brain-session.test.ts` add a pin (inside the existing spawn/warm describe, after a `warmSession`):

```ts
  it('spawns L1 with the fast-boot and no-tools flags, effort only when set', async () => {
    const io = makeVirtualIo();
    const pty = makeFakePtyLayer();
    _setVoiceBrainSessionDepsForTests(
      baseDeps(io, pty, { runtimeConfig: () => ({ getRuntimeConfig: () => null }) }),
    );
    await warmSession(io, pty);
    const args = pty.spawnCalls[0]!.args ?? [];
    expect(args).toContain('--strict-mcp-config');
    expect(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2)).toEqual(['--tools', '']);
    expect(args.slice(args.indexOf('--setting-sources'), args.indexOf('--setting-sources') + 2)).toEqual(['--setting-sources', 'project,local']);
    expect(args).not.toContain('--effort');
    expect(args[args.indexOf('--model') + 1]).toBe('haiku');
  });
  it('honors top_model and top_effort from runtime config', async () => {
    const io = makeVirtualIo();
    const pty = makeFakePtyLayer();
    const map: Record<string, string> = { top_model: 'sonnet', top_effort: 'low' };
    _setVoiceBrainSessionDepsForTests(
      baseDeps(io, pty, { runtimeConfig: () => ({ getRuntimeConfig: (k) => map[k] ?? null }) }),
    );
    await warmSession(io, pty);
    const args = pty.spawnCalls[0]!.args ?? [];
    expect(args[args.indexOf('--model') + 1]).toBe('sonnet');
    expect(args.slice(args.indexOf('--effort'), args.indexOf('--effort') + 2)).toEqual(['--effort', 'low']);
  });
```

`baseDeps` in that file must add `runtimeConfig: () => ({ getRuntimeConfig: () => null })` to its defaults.

- [ ] **Step 2: Run, confirm failures** (`topModel is not exported`, spawn args missing).

- [ ] **Step 3: Implement `layer-model.ts` additions**

```ts
export const TOP_MODEL_KEY = 'top_model';
export const TOP_EFFORT_KEY = 'top_effort';
export const MID_EFFORT_KEY = 'mid_effort';
export const WORKER_EFFORT_KEY = 'worker_effort';
export const DISPATCH_CONFIRM_GATE_KEY = 'dispatch_confirm_gate';

/* `claude --effort <level>` levels (from `claude --help`). Haiku 4.5 has
 * no effort parameter: the CLI accepts the flag on haiku and nothing
 * changes, so the knob only bites on Sonnet/Opus/Fable. */
const KNOWN_EFFORT_LEVELS: ReadonlySet<string> = new Set([
  'low', 'medium', 'high', 'xhigh', 'max',
]);

export function resolveEffort(raw: string | null | undefined): string | null {
  const lower = (raw ?? '').trim().toLowerCase();
  return KNOWN_EFFORT_LEVELS.has(lower) ? lower : null;
}

export function effortArgs(level: string | null): string[] {
  return level ? ['--effort', level] : [];
}

/* For the bridge-typed worker command string (routes.ts
 * queueProjectBootstrap). resolveEffort's whitelist is the injection
 * guard; never interpolate an unresolved value. */
export function effortFlag(level: string | null): string {
  return level ? ` --effort ${level}` : '';
}

/** L1 model: runtime_config.top_model -> DEVNEURAL_VOICE_BRAIN_MODEL -> 'haiku'. */
export function topModel(cfg: RuntimeConfigReader): string {
  return resolveLayerModel(
    cfg.getRuntimeConfig(TOP_MODEL_KEY) ?? process.env.DEVNEURAL_VOICE_BRAIN_MODEL,
    'haiku',
  );
}
export function topEffort(cfg: RuntimeConfigReader): string | null {
  return resolveEffort(cfg.getRuntimeConfig(TOP_EFFORT_KEY) ?? process.env.DEVNEURAL_TOP_EFFORT);
}
export function midEffort(cfg: RuntimeConfigReader): string | null {
  return resolveEffort(cfg.getRuntimeConfig(MID_EFFORT_KEY) ?? process.env.DEVNEURAL_MID_EFFORT);
}
export function workerEffort(cfg: RuntimeConfigReader): string | null {
  return resolveEffort(cfg.getRuntimeConfig(WORKER_EFFORT_KEY) ?? process.env.DEVNEURAL_WORKER_EFFORT);
}
/** Phase B mechanical dispatch gate. 'on' enables; anything else is off. */
export function dispatchConfirmGateOn(cfg: RuntimeConfigReader): boolean {
  const raw = cfg.getRuntimeConfig(DISPATCH_CONFIRM_GATE_KEY) ?? process.env.DEVNEURAL_DISPATCH_CONFIRM_GATE ?? '';
  return raw.trim().toLowerCase() === 'on';
}
```

Update the header comment's topology lines to mention the knobs.

- [ ] **Step 4: Wire the L1 spawn**

In `voice-brain-session.ts`: add to `VoiceBrainSessionDeps` the field `runtimeConfig: () => RuntimeConfigReader;` (import type from `./layer-model.js`). In `defaultDeps()` set `runtimeConfig: () => getStore().db` (import `getStore` from the same module `lex-voice-ws.ts` imports it from; grep `import { getStore }` in `src/voice/lex-voice-ws.ts` and copy that path). Delete the local `voiceBrainModel()` and `DEFAULT_VOICE_BRAIN_MODEL`; build the argv:

```ts
    const cfg = deps.runtimeConfig();
    const spawned = deps.spawnLex({
      cwd: deps.cwd,
      systemPrompt: buildVoiceBrainSystemPrompt(),
      args: [
        '--session-id',
        ccSessionId,
        '--dangerously-skip-permissions',
        '--model',
        topModel(cfg),
        ...effortArgs(topEffort(cfg)),
        '--tools',
        '',
        '--strict-mcp-config',
        /* 2026-09-21: a headless haiku spawn with the operator's user
         * settings loaded took 30-57s (SessionStart hooks + plugin
         * sync); with only project/local sources it took 4s. L1 needs
         * no hooks, plugins or CLAUDE.md. L2 keeps the user source
         * (the daemon's capture hooks live there). */
        '--setting-sources',
        'project,local',
      ],
      sessionId: ccSessionId,
    });
```

`buildVoiceBrainSystemPrompt` is introduced in Task 5; until then keep `systemPrompt: VOICE_BRAIN_SESSION_SYSTEM_PROMPT`.

In `routes.ts` both L2 spawn sites: `extraArgs: ['--model', midModel(store.db), '--permission-mode', midPermissionMode(store.db), ...effortArgs(midEffort(store.db))]`. At `:3996`: ``const command = `claude --model ${workerModel(store.db)}${effortFlag(workerEffort(store.db))} --dangerously-skip-permissions`;``. Extend the `layer-model.js` import at `routes.ts:81`.

- [ ] **Step 5: Run** `npx vitest run tests/layer-model.test.ts tests/voice-brain-session.test.ts` → PASS; `npm run build:check` → 0.

- [ ] **Step 6: Commit** `feat(voice): per-layer model/effort knobs; L1 spawns with project,local settings only` (`Rebuild: yes`).

---

### Task 4: One L1 per brainstorm, spawned on Open, persisted, killed on end

**Files:**
- Modify: `07-daemon/src/lex/voice-brain-session.ts` (singleton state -> registry keyed by anchor id)
- Create: `07-daemon/scripts/migrations/054-lex-session-voice-binding.sql`
- Modify: `07-daemon/src/store/index-db.ts:355-380` (`LexSessionRow`), near `:2069` (new setters/getters)
- Modify: `07-daemon/src/lex/spawn-lex-session.ts:274-301` (`onPrepared` hook)
- Modify: `07-daemon/src/dashboard/routes.ts:1797` (new anchor), `:1890-1992` (open), `:2046` (end)
- Modify: `07-daemon/src/voice/lex-voice-ws.ts:1893`, `:5339` (anchor-keyed prewarm / warm)
- Test: `07-daemon/tests/voice-brain-registry.test.ts` (create), `07-daemon/tests/lex-session-voice-binding.test.ts` (create), `07-daemon/tests/spawn-lex-session.test.ts` (extend)

**Interfaces:**
- Produces: `askVoice(input & { anchorId?: string | null })`, `prewarmVoiceBrainSession(anchorId?: string | null)`, `isVoiceBrainSessionWarm(anchorId?)`, `killVoiceBrainSession(anchorId: string, reason: string): void`, `listVoiceBrainSessions(): Array<{ anchorId, ptyId, ccSessionId, warm }>`; dep `persistBinding: (anchorId, b: { voice_session_id; voice_pty_id; voice_spawned_ms }) => void`.
- DB: `setLexSessionVoiceBinding(id, b)`, `getLexSessionByCcSessionId(cc): LexSessionRow | null` (via `lex_transcript_ref`).
- `SpawnLexSessionOptions.onPrepared?: (prep: PrepareLexSpawnResult) => void`.

- [ ] **Step 1: Failing tests**

`tests/voice-brain-registry.test.ts` (fixture copied from `voice-brain-session.test.ts:41-260`; `warmSession` gains an `anchorId` argument that it passes to `prewarmVoiceBrainSession(anchorId)` and `_voiceBrainWarmupForTests(anchorId)`):

```ts
describe('one L1 per brainstorm anchor', () => {
  it('two anchors get two sessions and asks route to their own pty', async () => {
    const io = makeVirtualIo();
    const pty = makeFakePtyLayer();
    const bindings: Array<[string, { voice_pty_id: string }]> = [];
    _setVoiceBrainSessionDepsForTests(
      baseDeps(io, pty, { persistBinding: (a, b) => bindings.push([a, b]) }),
    );
    const pathA = await warmSession(io, pty, 'anchor-a');
    const pathB = await warmSession(io, pty, 'anchor-b');
    expect(pty.spawnCalls).toHaveLength(2);
    expect(bindings.map(([a]) => a)).toEqual(['anchor-a', 'anchor-b']);
    io.scheduleAssistantRecord(pathA, 50, 'from a', 'end_turn');
    io.scheduleAssistantRecord(pathB, 50, 'from b', 'end_turn');
    expect(await askVoice({ anchorId: 'anchor-a', prompt: 'x', timeoutMs: 5000 })).toBe('from a');
    expect(await askVoice({ anchorId: 'anchor-b', prompt: 'x', timeoutMs: 5000 })).toBe('from b');
    expect(pty.injectCalls.filter((c) => c.text === 'x').map((c) => c.ptyId)).toEqual(['pty-1', 'pty-2']);
  });
  it('killVoiceBrainSession kills only that anchor', async () => {
    const io = makeVirtualIo();
    const pty = makeFakePtyLayer();
    _setVoiceBrainSessionDepsForTests(baseDeps(io, pty));
    await warmSession(io, pty, 'anchor-a');
    await warmSession(io, pty, 'anchor-b');
    killVoiceBrainSession('anchor-a', 'anchor-end');
    expect(pty.killCalls).toEqual(['pty-1']);
    expect(isVoiceBrainSessionWarm('anchor-a')).toBe(false);
    expect(isVoiceBrainSessionWarm('anchor-b')).toBe(true);
  });
  it('a null anchor uses the shared default session', async () => {
    const io = makeVirtualIo();
    const pty = makeFakePtyLayer();
    _setVoiceBrainSessionDepsForTests(baseDeps(io, pty));
    await warmSession(io, pty, null);
    expect(isVoiceBrainSessionWarm(null)).toBe(true);
    expect(listVoiceBrainSessions().map((s) => s.anchorId)).toEqual(['default']);
  });
});
```

`tests/lex-session-voice-binding.test.ts` (fixture: `IndexDb` + `runMigrations` exactly as `tests/projects-routes-loose-ends.test.ts:29-71`):

```ts
it('persists and reads back the L1 binding; resolves an anchor by cc session id', () => {
  db.insertLexSession({ id: ANCHOR, created_ms: 1, title: null, derived_title: null, status: 'live', current_pty_id: null, cwd: 'C:/dev/x' });
  db.setLexSessionVoiceBinding(ANCHOR, { voice_session_id: 'vs-1', voice_pty_id: 'vp-1', voice_spawned_ms: 123 });
  const row = db.getLexSession(ANCHOR)!;
  expect(row.voice_session_id).toBe('vs-1');
  expect(row.voice_pty_id).toBe('vp-1');
  expect(row.voice_spawned_ms).toBe(123);
  db.appendTranscriptRef({ lexSessionId: ANCHOR, ccSessionId: CC, transcriptPath: 'C:/t.jsonl', startedMs: 5 });
  expect(db.getLexSessionByCcSessionId(CC)?.id).toBe(ANCHOR);
  expect(db.getLexSessionByCcSessionId('nope')).toBeNull();
});
```

(If `appendTranscriptRef` is a module function in `lex-session-store.ts` rather than an `IndexDb` method, call it the way `spawn-lex-session.test.ts` does.)

`tests/spawn-lex-session.test.ts` extend: `onPrepared` is called with the prepared anchor BEFORE `spawnLex`:

```ts
it('calls onPrepared before spawnLex so L1 can start first', () => {
  const order: string[] = [];
  const r = spawnLexSession({
    cwd: CWD, title: 't',
    onPrepared: (prep) => { order.push(`prepared:${prep.lexSession.id.length > 0}`); },
    /* copy the existing fake-spawn wiring this file uses; it records 'spawn' into order */
  });
  expect(order[0]).toBe('prepared:true');
  expect(order[1]).toBe('spawn');
});
```

- [ ] **Step 2: Run, confirm failures.**

- [ ] **Step 3: Registry refactor in `voice-brain-session.ts`**

Replace `let state = initialState()` with:

```ts
const DEFAULT_ANCHOR = 'default';
const sessions = new Map<string, VoiceBrainSessionState>();
const queues = new Map<string, Promise<void>>();

function keyFor(anchorId: string | null | undefined): string {
  return anchorId && anchorId.trim() ? anchorId : DEFAULT_ANCHOR;
}
function stateFor(anchorId: string | null | undefined): VoiceBrainSessionState {
  const key = keyFor(anchorId);
  let s = sessions.get(key);
  if (!s) {
    s = initialState();
    sessions.set(key, s);
  }
  return s;
}
```

Every function that read the module `state` takes `anchorId` and calls `stateFor(anchorId)`: `killCurrent(anchorId, reason)`, `ensureSpawned(anchorId)`, `runWarmup(anchorId, ptyId)`, `askVoiceInner(input)` (reads `input.anchorId`), `prewarmVoiceBrainSession(anchorId)`, `isVoiceBrainSessionWarm(anchorId)`, `handleTimeout(anchorId)`, `_voiceBrainWarmupForTests(anchorId)`, `_voiceBrainSessionSnapshotForTests(anchorId)`. The queue becomes per anchor:

```ts
function enqueue<T>(anchorId: string | null | undefined, fn: () => Promise<T>): Promise<T> {
  const key = keyFor(anchorId);
  const tail = queues.get(key) ?? Promise.resolve();
  const run = (): Promise<T> => fn();
  const result = tail.then(run, run);
  queues.set(key, result.then(() => undefined, () => undefined));
  return result;
}
export function askVoice(input: AskVoiceInput): Promise<string | null> {
  return enqueue(input.anchorId, () => askVoiceInner(input)).catch((err) => { ... return null; });
}
```

Add `anchorId?: string | null` to `AskVoiceInput`. After a successful spawn in `ensureSpawned`, call `deps.persistBinding(keyFor(anchorId), { voice_session_id: ccSessionId, voice_pty_id: spawned.ptyId, voice_spawned_ms: deps.now() })` inside try/catch (log on throw). Default dep: `persistBinding: (anchorId, b) => { if (anchorId === DEFAULT_ANCHOR) return; getStore().db.setLexSessionVoiceBinding(anchorId, b); }`. Add:

```ts
export function killVoiceBrainSession(anchorId: string, reason: string): void {
  const key = keyFor(anchorId);
  if (!sessions.has(key)) return;
  killCurrent(anchorId, reason);
  sessions.delete(key);
  queues.delete(key);
}
export function listVoiceBrainSessions(): Array<{ anchorId: string; ptyId: string | null; ccSessionId: string | null; warm: boolean }> {
  return [...sessions.entries()].map(([anchorId, s]) => ({ anchorId, ptyId: s.ptyId, ccSessionId: s.ccSessionId, warm: s.warm }));
}
```

`_resetVoiceBrainSessionStateForTests` clears both maps. Log lines gain `anchor=${key.slice(0, 8)}`.

- [ ] **Step 4: Migration + DB methods**

`054-lex-session-voice-binding.sql`:

```sql
-- 2026-09-21 voice layers: persist the Layer 1 (voice brain) binding on
-- the brainstorm anchor so restarts, the dashboard and the Stream Deck
-- can find the L1 session the same way project_session carries the
-- worker binding.
ALTER TABLE lex_session ADD COLUMN voice_session_id TEXT;
ALTER TABLE lex_session ADD COLUMN voice_pty_id TEXT;
ALTER TABLE lex_session ADD COLUMN voice_spawned_ms INTEGER;
```

`index-db.ts`: add to `LexSessionRow` `voice_session_id?: string | null; voice_pty_id?: string | null; voice_spawned_ms?: number | null;` and methods next to `setLexSessionSupervises`:

```ts
  setLexSessionVoiceBinding(
    lexAnchorId: string,
    b: { voice_session_id: string | null; voice_pty_id: string | null; voice_spawned_ms: number | null },
  ): LexSessionRow | null {
    this.db
      .prepare(`UPDATE lex_session SET voice_session_id = ?, voice_pty_id = ?, voice_spawned_ms = ? WHERE id = ?`)
      .run(b.voice_session_id, b.voice_pty_id, b.voice_spawned_ms, lexAnchorId);
    return this.getLexSession(lexAnchorId);
  }

  getLexSessionByCcSessionId(ccSessionId: string): LexSessionRow | null {
    const row = this.db
      .prepare(`SELECT lex_session_id FROM lex_transcript_ref WHERE cc_session_id = ? ORDER BY ordering DESC LIMIT 1`)
      .get(ccSessionId) as { lex_session_id: string } | undefined;
    return row ? this.getLexSession(row.lex_session_id) : null;
  }
```

(Confirm the `lex_transcript_ref` column names by grepping `CREATE TABLE IF NOT EXISTS lex_transcript_ref` in `index-db.ts` and the `019`/`02x` migrations; use the real names.) Make sure `getLexSession` selects the new columns (if it uses `SELECT *` nothing changes).

- [ ] **Step 5: Spawn L1 first**

`spawn-lex-session.ts`: add `onPrepared?: (prep: PrepareLexSpawnResult) => void;` to `SpawnLexSessionOptions`; in `spawnLexSession` after `const prep = prepareLexSpawn(opts);` insert:

```ts
  /* Voice layers (2026-09-21): let the caller start Layer 1 for this
   * anchor BEFORE the L2 PTY spawns, so the voice is warm while L2 is
   * still booting. Best-effort; a throw here must not block L2. */
  if (opts.onPrepared) {
    try {
      opts.onPrepared(prep);
    } catch (err) {
      /* observability only */
      console.error(`[spawn-lex-session] onPrepared threw: ${(err as Error).message}`);
    }
  }
```

`routes.ts` new-anchor route: add `onPrepared: (prep) => prewarmVoiceBrainSession(prep.lexSession.id),` to the `spawnLexSession({...})` call. Open route: call `prewarmVoiceBrainSession(id);` (a) inside the `bind` early-return branch before returning, and (b) at the top of the `inflight` async body before `buildLexSpawnPrompt`. Import `prewarmVoiceBrainSession, killVoiceBrainSession` from `../lex/voice-brain-session.js`. End route (`/lex/anchors/:id/end`, `:2046`): after the pipeline queue call add `killVoiceBrainSession(id, 'anchor-end');`. In `lex-voice-ws.ts` `dispatchVoiceCommand` `end_session` branch, after the ptyKill add `if (anchor) killVoiceBrainSession(anchor, 'voice-end-session');` using `currentAnchorId()` (defined in Task 6 Step 3; for this task add the helper now, it is pure resolution code).

`lex-voice-ws.ts:1893`: `prewarmVoiceBrainSession(currentAnchorId());` and `:5339`: `isWarm: () => isVoiceBrainSessionWarm(currentAnchorId()),`. `voice-top-layer.ts` `defaultAsk` passes `anchorId` through (the ask args gain `anchorId?`).

- [ ] **Step 6: Run** the three test files + `tests/voice-brain-session.test.ts` + `tests/spawn-lex-session.test.ts` + `npm run build:check` → all green.

- [ ] **Step 7: Commit** `feat(voice): one L1 voice session per brainstorm, spawned on Open before L2, persisted on lex_session` (`Rebuild: yes`).

---

### Task 5: Layer 1 prompt, live block, parser, turn

**Files:**
- Modify: `07-daemon/src/voice/voice-top-layer.ts` (rebuild the top half; keep `voiceLexReply`)
- Modify: `07-daemon/src/lex/voice-brain-session.ts:128-135` (`VOICE_BRAIN_SESSION_SYSTEM_PROMPT` -> `buildVoiceBrainSystemPrompt()`)
- Test: `07-daemon/tests/voice-top-layer.test.ts` (rewrite), `07-daemon/tests/voice-top-layer-live-block.test.ts` (create)

**Interfaces (produced):**

```ts
export type TopLayerControl =
  | 'mute' | 'unmute' | 'standby' | 'listen' | 'disable' | 'end_session'
  | 'stop_speaking' | 'interrupt_work' | 'cancel_redirect' | 'repeat'
  | 'approve_plan' | 'reject_plan' | 'confirm_dispatch' | 'reject_dispatch';
export type MidState = 'down' | 'warming' | 'idle' | 'thinking' | 'tool' | 'replying';
export interface LiveBlock {
  mid: MidState; midSinceMs: number | null; midTool: string | null;
  worker: string | null;            // "idle" | "running 3m (dropship-01)" | null = no worker
  lastSaid: string | null;
  digest: LexDigest | null;
  pendingPlan: string | null;       // plan text awaiting approval (Phase B)
  pendingDispatch: { id: string; summary: string } | null;
  nowMs: number;
}
export interface TopLayerResult {
  speech: string | null; forward: string | null;
  control: TopLayerControl | null; controlArg: string | null;
  ignore: string | null;
}
export function buildTopLayerSystemPrompt(): string;
export function renderLiveBlock(live: LiveBlock): string;
export function buildTopLayerTurnMessage(utterance: string, live: LiveBlock, opts: { duringTts: boolean; words: number }): string;
export function buildTopLayerEventMessage(event: { kind: 'plan-ready' | 'dispatch-pending' | 'dispatch-result' | 'plan-result'; text: string; id?: string }, live: LiveBlock): string;
export function parseTopLayerReply(raw: string | null | undefined): TopLayerResult;
export function speechOnly(text: string): string;  // directive lines removed
export async function topLayerTurn(utterance: string, ctx: TopLayerCtx): Promise<TopLayerResult>;
export async function topLayerEventTurn(event, ctx): Promise<TopLayerResult>;  // same as turn but never fail-safe-forwards
export interface TopLayerCtx { live: LiveBlock; duringTts: boolean; anchorId: string | null; deps?: TopLayerDeps }
```

- [ ] **Step 1: Failing tests** (`tests/voice-top-layer.test.ts`, replace file):

```ts
import { describe, expect, it } from 'vitest';
import {
  buildTopLayerSystemPrompt, buildTopLayerTurnMessage, parseTopLayerReply,
  renderLiveBlock, speechOnly, topLayerTurn, type AskFn, type LiveBlock,
} from '../src/voice/voice-top-layer.js';
import { LEX_PERSONA, LEX_SPOKEN_RULES } from '../src/lex/persona.js';

const LIVE: LiveBlock = { mid: 'idle', midSinceMs: null, midTool: null, worker: null, lastSaid: null, digest: null, pendingPlan: null, pendingDispatch: null, nowMs: 0 };

describe('parseTopLayerReply', () => {
  it('plain text is speech', () => {
    expect(parseTopLayerReply('Morning. Coffee first.')).toEqual({ speech: 'Morning. Coffee first.', forward: null, control: null, controlArg: null, ignore: null });
  });
  it('FORWARD block, CONTROL verb with argument, IGNORE reason', () => {
    const r = parseTopLayerReply('On it.\nFORWARD: check the boot logs\nand the restart time\nCONTROL: reject_plan too risky tonight');
    expect(r.speech).toBe('On it.');
    expect(r.forward).toBe('check the boot logs\nand the restart time');
    expect(r.control).toBe('reject_plan');
    expect(r.controlArg).toBe('too risky tonight');
    expect(parseTopLayerReply('IGNORE: background tv')).toEqual({ speech: null, forward: null, control: null, controlArg: null, ignore: 'background tv' });
  });
  it('unknown CONTROL token stays speech; null parses to all-null', () => {
    expect(parseTopLayerReply('CONTROL: dance').speech).toBe('CONTROL: dance');
    expect(parseTopLayerReply(null).forward).toBeNull();
  });
  it('speechOnly strips every directive line', () => {
    expect(speechOnly('Right.\nFORWARD: x\nIGNORE: y')).toBe('Right.');
  });
});

describe('topLayerTurn', () => {
  const ctx = (ask: AskFn, onSpeech?: (l: string) => void) => ({ live: LIVE, duringTts: false, anchorId: 'a', deps: { ask, onSpeech, timeoutMs: 100 } });
  it('fail-safe: a null ask forwards the utterance verbatim and never ignores', async () => {
    const r = await topLayerTurn('deploy the thing', ctx(async () => null));
    expect(r).toEqual({ speech: null, forward: 'deploy the thing', control: null, controlArg: null, ignore: null });
  });
  it('a thrown ask also fail-safes', async () => {
    const r = await topLayerTurn('hello', ctx(async () => { throw new Error('boom'); }));
    expect(r.forward).toBe('hello');
  });
  it('streams speech per record with directives stripped, then reports no remainder', async () => {
    const spoken: string[] = [];
    const ask: AskFn = async (a) => { a.onPartial?.('Sure thing.\nFORWARD: run the tests'); return 'Sure thing.\nFORWARD: run the tests'; };
    const r = await topLayerTurn('run the tests', ctx(ask, (l) => spoken.push(l)));
    expect(spoken).toEqual(['Sure thing.']);
    expect(r.speech).toBeNull();
    expect(r.forward).toBe('run the tests');
  });
  it('IGNORE with no speech is the silent drop', async () => {
    const r = await topLayerTurn('turn the lights off honey', ctx(async () => 'IGNORE: not addressed to me'));
    expect(r.ignore).toBe('not addressed to me');
    expect(r.forward).toBeNull();
    expect(r.speech).toBeNull();
  });
  it('the turn message carries the live block and the utterance', () => {
    const msg = buildTopLayerTurnMessage('what is she doing', { ...LIVE, mid: 'tool', midTool: 'Read', midSinceMs: 5_000, nowMs: 45_000 }, { duringTts: true, words: 4 });
    expect(msg).toMatch(/brain: tool Read 40s/);
    expect(msg).toMatch(/\[heard\] "what is she doing"/);
    expect(msg).toMatch(/during_tts: yes/);
  });
});

describe('buildTopLayerSystemPrompt', () => {
  it('carries the persona, the spoken rules and the contract verbs', () => {
    const p = buildTopLayerSystemPrompt();
    expect(p).toContain(LEX_PERSONA);
    expect(p).toContain(LEX_SPOKEN_RULES);
    for (const v of ['FORWARD:', 'CONTROL:', 'IGNORE:', 'cancel_redirect', 'approve_plan', 'confirm_dispatch']) expect(p).toContain(v);
    expect(p).toMatch(/warming/);
    expect(p).not.toContain('never reference earlier messages');
  });
});
```

`tests/voice-top-layer-live-block.test.ts`:

```ts
it('renders every mid state and the optional lines', () => {
  const base: LiveBlock = { mid: 'warming', midSinceMs: 1_000, midTool: null, worker: 'idle', lastSaid: 'Right then.', digest: { currentTask: 'dropship research', lastDecision: '', openQuestion: '', workerStatus: '', nextSteps: 'phase 2' }, pendingPlan: null, pendingDispatch: { id: 'd1', summary: 'run the tests' }, nowMs: 13_000 };
  const s = renderLiveBlock(base);
  expect(s).toMatch(/^\[live\] brain: warming 12s/m);
  expect(s).toMatch(/worker: idle/);
  expect(s).toMatch(/last said: "Right then\."/);
  expect(s).toMatch(/Current task: dropship research/);
  expect(s).toMatch(/dispatch pending \(d1\): run the tests/);
  expect(renderLiveBlock({ ...base, mid: 'idle', midSinceMs: null, digest: null, pendingDispatch: null })).toMatch(/brain: idle\n/);
});
```

- [ ] **Step 2: Run, confirm failures.**

- [ ] **Step 3: Implement**

`voice-brain-session.ts`: replace the `VOICE_BRAIN_SESSION_SYSTEM_PROMPT` const with a lazy import-free builder to avoid a cycle: keep the const name exported for tests but its value becomes `buildVoiceBrainSystemPrompt()` from `../voice/voice-top-layer.js` (voice-top-layer already lazy-imports voice-brain-session inside `defaultAsk`, so a static import from voice-brain-session to voice-top-layer is acyclic at module-eval time). Delete the "never reference earlier messages" sentence: L1 is a conversation now.

`voice-top-layer.ts` top half:

```ts
import { composeVoiceIdentity } from '../lex/persona.js';
import type { LexDigest } from './voice-digest.js';

export const CONTROLS: ReadonlySet<string> = new Set([
  'mute', 'unmute', 'standby', 'listen', 'disable', 'end_session',
  'stop_speaking', 'interrupt_work', 'cancel_redirect', 'repeat',
  'drop_reply', 'combine',
  'approve_plan', 'reject_plan', 'confirm_dispatch', 'reject_dispatch',
]);
const FORWARD_LINE = /^\s*forward:(.*)$/i;
const CONTROL_LINE = /^\s*control:\s*([a-z_]+)\s*(.*)$/i;
const IGNORE_LINE = /^\s*ignore:(.*)$/i;
const MAX_SPEECH_CHARS = 600;

const CONTRACT = `## Your job on this call

You are the voice of Lex on a live call with Michael. A deeper part of
you (the brain) reasons, writes plans and runs the worker; it never
speaks. You speak for both of you, in the first person. Never say
"Lex" in the third person; the only "he" is the worker.

You are his sparring partner: witty, smart, concise. Challenge a soft
premise, push back once, help him get to the point. Sharpen what he
said into the actual ask, then hand the brain ONLY the distilled
result, never a transcript of the exchange. While the brain works,
keep him posted when it matters, briefly. When the brain replies, say
so in your own words, then deliver its facts exactly.

If he speaks while a brain reply is being delivered (during_tts: yes),
the audio has already stopped. Decide: a correction or a new direction
means the reply is moot, add CONTROL: drop_reply and FORWARD the new
direction; an addition just forwards as a follow-up; a clarification of
the same ask adds CONTROL: combine so the brain gets one turn. An
[event] brain-progress line means the brain is still working; say a
word only if it helps, silence is fine.

Every message you receive has a [live] block (what the brain and the
worker are doing right now, your last spoken line, the current digest)
and a [heard] line (what Michael just said). Sometimes an [event] line
instead (the brain finished a plan, or wants to send the worker
something). Decide, every time:

1. Answer yourself when you can: small talk, "what's she doing",
   status from the [live] block, a repeat, a quick clarification.
2. Hand substance to the brain: real work, project facts, decisions,
   anything needing tools or the worker. Say a short natural handoff
   out loud and add a trailing line FORWARD: <the ask, in Michael's
   intent>.
3. Issue a control when the words clearly mean one. Trailing line
   CONTROL: <verb> [argument]. Verbs: mute, unmute, standby, listen,
   disable, end_session, stop_speaking, interrupt_work,
   cancel_redirect (drop what the brain is doing and FORWARD the new
   direction), repeat (say the last thing again), approve_plan,
   reject_plan <reason>, confirm_dispatch, reject_dispatch <reason>.
4. Ignore background: the TV, other people, a fragment with no
   address to you, your own words echoing back. Trailing line
   IGNORE: <two-word reason>, and say nothing. When unsure whether it
   was meant for you, ask in five words or fewer instead.

Rules: reply text is spoken exactly as written. Directive lines go
LAST, one per line, never inside speech. If the [live] block says the
brain is warming, say so once ("the deeper part of me is still waking
up, go on"), keep talking, and still FORWARD; the daemon queues it.
If the brain is thinking or in a tool, you still answer; never wait
for it. When a plan is pending, read its gist in two or three
sentences and ask for a go; Michael's yes becomes
CONTROL: approve_plan, his no becomes CONTROL: reject_plan <why>.
When a dispatch is pending, say what the brain wants to send and to
whom, ask for a go; yes is CONTROL: confirm_dispatch, no is
CONTROL: reject_dispatch <why>. Never invent facts that are not in the
[live] block or in what the brain said.`;

export function buildTopLayerSystemPrompt(): string {
  return [composeVoiceIdentity(), CONTRACT].join('\n\n');
}

export function renderLiveBlock(live: LiveBlock): string {
  const since = (ms: number | null): string => ms === null ? '' : ` ${Math.max(0, Math.round((live.nowMs - ms) / 1000))}s`;
  const brain =
    live.mid === 'tool' ? `tool ${live.midTool ?? 'unknown'}${since(live.midSinceMs)}`
    : live.mid === 'thinking' || live.mid === 'warming' ? `${live.mid}${since(live.midSinceMs)}`
    : live.mid;
  const lines = [`[live] brain: ${brain}`];
  if (live.worker !== null) lines.push(`       worker: ${live.worker}`);
  if (live.lastSaid) lines.push(`       last said: ${JSON.stringify(live.lastSaid)}`);
  if (live.digest) {
    const f = (v: string) => (v.trim() ? v.trim() : '(none)');
    lines.push(`       Current task: ${f(live.digest.currentTask)}`, `       Last decision: ${f(live.digest.lastDecision)}`, `       Open question: ${f(live.digest.openQuestion)}`, `       Next steps: ${f(live.digest.nextSteps)}`);
  }
  if (live.pendingPlan) lines.push(`       plan pending: ${live.pendingPlan.replace(/\s+/g, ' ').slice(0, 600)}`);
  if (live.pendingDispatch) lines.push(`       dispatch pending (${live.pendingDispatch.id}): ${live.pendingDispatch.summary.slice(0, 200)}`);
  return lines.join('\n');
}

export function buildTopLayerTurnMessage(utterance: string, live: LiveBlock, opts: { duringTts: boolean; words: number }): string {
  return `${renderLiveBlock(live)}\n[heard] ${JSON.stringify(utterance)}  (during_tts: ${opts.duringTts ? 'yes' : 'no'}, words: ${opts.words})`;
}

export function buildTopLayerEventMessage(event: { kind: string; text: string; id?: string }, live: LiveBlock): string {
  const tag = event.id ? `${event.kind} ${event.id}` : event.kind;
  return `${renderLiveBlock(live)}\n[event] ${tag}: ${event.text}`;
}

export function speechOnly(text: string): string {
  return text.split(/\r?\n/).filter((l) => !FORWARD_LINE.test(l) && !CONTROL_LINE.test(l) && !IGNORE_LINE.test(l)).join('\n').trim();
}

export function parseTopLayerReply(raw: string | null | undefined): TopLayerResult {
  const empty: TopLayerResult = { speech: null, forward: null, control: null, controlArg: null, ignore: null };
  if (!raw || !raw.trim()) return empty;
  const speechLines: string[] = []; const forwardLines: string[] = [];
  let control: TopLayerControl | null = null; let controlArg: string | null = null;
  let ignore: string | null = null; let sawForward = false; let collecting = false;
  for (const line of raw.split(/\r?\n/)) {
    const fwd = line.match(FORWARD_LINE);
    if (fwd) { if (!sawForward) { sawForward = true; collecting = true; const rest = fwd[1]!.trim(); if (rest) forwardLines.push(rest); } else collecting = false; continue; }
    const ctl = line.match(CONTROL_LINE);
    if (ctl && CONTROLS.has(ctl[1]!.toLowerCase())) { if (control === null) { control = ctl[1]!.toLowerCase() as TopLayerControl; controlArg = ctl[2]?.trim() || null; } collecting = false; continue; }
    const ign = line.match(IGNORE_LINE);
    if (ign) { if (ignore === null) ignore = ign[1]!.trim() || 'unspecified'; collecting = false; continue; }
    if (collecting) forwardLines.push(line); else speechLines.push(line);
  }
  const speechJoined = speechLines.join('\n').trim();
  return {
    speech: speechJoined ? speechJoined.slice(0, MAX_SPEECH_CHARS) : null,
    forward: forwardLines.join('\n').trim() || null,
    control, controlArg, ignore,
  };
}
```

`topLayerTurn`: ask with `system: undefined` (the system prompt now lives at spawn), `prompt: buildTopLayerTurnMessage(...)`, `anchorId: ctx.anchorId`, `timeoutMs: turnTimeoutMs(ctx.deps?.timeoutMs)` (default 8000, env `DEVNEURAL_VOICE_VERDICT_TIMEOUT_MS`), `noLivenessStrike: true`, and `onPartial` when `deps.onSpeech` exists:

```ts
  const consumed: string[] = [];
  const onPartial = onSpeech ? (recordText: string): void => {
    const sp = speechOnly(recordText);
    if (!sp) return;
    consumed.push(sp);
    try { onSpeech(sp); } catch { /* caller's bug */ }
  } : undefined;
  let raw: string | null = null;
  try { raw = await ask({ prompt, timeoutMs, noLivenessStrike: true, anchorId: ctx.anchorId, ...(onPartial ? { onPartial } : {}) }); } catch { raw = null; }
  const result = parseTopLayerReply(raw);
  const allNull = result.speech === null && result.forward === null && result.control === null && result.ignore === null;
  if (allNull) return { speech: null, forward: utterance, control: null, controlArg: null, ignore: null };
  if (consumed.length > 0) result.speech = null;   /* already spoken as it streamed */
  return result;
```

`AskFn` args: `system?: string` (optional now). `voiceLexReply` keeps passing `system: lexReplySystem()` and `prompt`; `askVoiceInner` keeps `buildVoiceQuestion(system, prompt)`. `topLayerEventTurn` is identical except `allNull` returns `empty` (never forwards an event) and uses `buildTopLayerEventMessage`.

- [ ] **Step 4: Run** `npx vitest run tests/voice-top-layer.test.ts tests/voice-top-layer-live-block.test.ts tests/voice-brain-session.test.ts` → PASS; `build:check` → 0.

- [ ] **Step 5: Commit** `feat(voice): Layer 1 prompt, live block and directive contract (speak / forward / control / ignore)` (`Rebuild: yes`).

---

### Task 6: Wire Layer 1 into the voice turn pipeline

**Files:**
- Modify: `07-daemon/src/voice/lex-voice-ws.ts`: `ConnState` (`:215-405`), `handleJsonlLine` (`:2487`), `runTopLayerVoiceTurnOnce` (`:4517-4832`), `dispatchVoiceCommand` (`:3718`), module exports.
- Test: `07-daemon/tests/lex-voice-ws-top-layer-wire.test.ts` (create)

**Interfaces:**
- Consumes: Task 5 API; `mergeOperatorUtterances(parts)` (`:1826`), `speak(text, {continuation})` (`:2987`), `splitForSpeech` (`lex-voice-speak-controller.ts:336`), `getDigest()`, `isAwaitingSystemPrompt`, `getPty/getPtyBySession`, `lastSpokenText` (module `let`), `dispatchVoiceCommand`.
- Produces (pure, exported for tests): `_midStateImpl(input): { mid: MidState; sinceMs: number | null; tool: string | null }`, `_planTopLayerActionsImpl(result: TopLayerResult, midWarming: boolean): TopLayerAction[]`, `setTopLayerControlHandlers(h: TopLayerControlHandlers)`, `notifyTopLayerEvent(anchorId: string, event): Promise<boolean>`.
- New frame: `{ t: 'ignored', text, reason }`.

- [ ] **Step 1: Failing tests** (pure seams):

```ts
import { describe, expect, it } from 'vitest';
import { _midStateImpl, _planTopLayerActionsImpl } from '../src/voice/lex-voice-ws.js';

describe('_midStateImpl', () => {
  const base = { hasBind: true, ptyAlive: true, awaitingSystemPrompt: false, seenAssistant: true, ttsActive: false, awaitingResponseSince: 0, lastToolName: null as string | null, directLlm: false, directLlmInFlight: false };
  it('down / warming / idle / thinking / tool / replying', () => {
    expect(_midStateImpl({ ...base, hasBind: false }).mid).toBe('down');
    expect(_midStateImpl({ ...base, ptyAlive: false }).mid).toBe('down');
    expect(_midStateImpl({ ...base, awaitingSystemPrompt: true }).mid).toBe('warming');
    expect(_midStateImpl({ ...base, seenAssistant: false }).mid).toBe('warming');
    expect(_midStateImpl(base).mid).toBe('idle');
    expect(_midStateImpl({ ...base, awaitingResponseSince: 10 })).toEqual({ mid: 'thinking', sinceMs: 10, tool: null });
    expect(_midStateImpl({ ...base, awaitingResponseSince: 10, lastToolName: 'Read' })).toEqual({ mid: 'tool', sinceMs: 10, tool: 'Read' });
    expect(_midStateImpl({ ...base, ttsActive: true }).mid).toBe('replying');
    expect(_midStateImpl({ ...base, directLlm: true, directLlmInFlight: true }).mid).toBe('thinking');
  });
});

describe('_planTopLayerActionsImpl', () => {
  const r = (o: Partial<Parameters<typeof _planTopLayerActionsImpl>[0]>) => ({ speech: null, forward: null, control: null, controlArg: null, ignore: null, ...o });
  it('ignore alone drops; forward routes; warming queues; control dispatches', () => {
    expect(_planTopLayerActionsImpl(r({ ignore: 'tv' }), false)).toEqual([{ kind: 'ignore', reason: 'tv' }]);
    expect(_planTopLayerActionsImpl(r({ forward: 'x' }), false)).toEqual([{ kind: 'forward', text: 'x' }]);
    expect(_planTopLayerActionsImpl(r({ forward: 'x' }), true)).toEqual([{ kind: 'queue-until-warm', text: 'x' }]);
    expect(_planTopLayerActionsImpl(r({ speech: 'ok', control: 'mute' }), false)).toEqual([{ kind: 'speak', text: 'ok' }, { kind: 'control', control: 'mute', arg: null }]);
    expect(_planTopLayerActionsImpl(r({ control: 'cancel_redirect', forward: 'new plan' }), false)).toEqual([{ kind: 'control', control: 'cancel_redirect', arg: null }, { kind: 'forward', text: 'new plan' }]);
  });
});
```

- [ ] **Step 2: Run, confirm failures.**

- [ ] **Step 3: Implement**

(a) `ConnState` additions: `pendingForwardsUntilWarm: string[]; warmQueueTimer: ReturnType<typeof setInterval> | null; midSeenAssistant: boolean; midLastToolName: string | null;` with initial values `[]`, `null`, `false`, `null` in the state initializer.

(b) `handleJsonlLine` (`:2487`): before `const readOnly = ...` add `state.midSeenAssistant = true;`. After `const isPreToolAck = decision.is_pre_tool_ack;` add: `state.midLastToolName = isPreToolAck ? firstToolUseName(rec) : null;` where

```ts
function firstToolUseName(rec: Record<string, unknown>): string | null {
  const content = (rec.message as { content?: Array<{ type?: string; name?: string }> } | undefined)?.content;
  const t = Array.isArray(content) ? content.find((c) => c?.type === 'tool_use') : undefined;
  return typeof t?.name === 'string' ? t.name : null;
}
```

(c) Pure seams (module level, exported):

```ts
export interface MidStateInput { hasBind: boolean; ptyAlive: boolean; awaitingSystemPrompt: boolean; seenAssistant: boolean; ttsActive: boolean; awaitingResponseSince: number; lastToolName: string | null; directLlm: boolean; directLlmInFlight: boolean }
export function _midStateImpl(i: MidStateInput): { mid: MidState; sinceMs: number | null; tool: string | null } {
  if (i.directLlm) return { mid: i.directLlmInFlight ? 'thinking' : 'idle', sinceMs: null, tool: null };
  if (!i.hasBind || !i.ptyAlive) return { mid: 'down', sinceMs: null, tool: null };
  if (i.awaitingSystemPrompt || !i.seenAssistant) return { mid: 'warming', sinceMs: null, tool: null };
  if (i.ttsActive) return { mid: 'replying', sinceMs: null, tool: null };
  if (i.awaitingResponseSince > 0) return i.lastToolName ? { mid: 'tool', sinceMs: i.awaitingResponseSince, tool: i.lastToolName } : { mid: 'thinking', sinceMs: i.awaitingResponseSince, tool: null };
  return { mid: 'idle', sinceMs: null, tool: null };
}
export type TopLayerAction = { kind: 'ignore'; reason: string } | { kind: 'speak'; text: string } | { kind: 'control'; control: TopLayerControl; arg: string | null } | { kind: 'forward'; text: string } | { kind: 'queue-until-warm'; text: string };
export function _planTopLayerActionsImpl(r: TopLayerResult, midWarming: boolean): TopLayerAction[] {
  const out: TopLayerAction[] = [];
  if (r.speech) out.push({ kind: 'speak', text: r.speech });
  if (r.control) out.push({ kind: 'control', control: r.control, arg: r.controlArg });
  if (r.forward) out.push(midWarming ? { kind: 'queue-until-warm', text: r.forward } : { kind: 'forward', text: r.forward });
  if (out.length === 0 && r.ignore !== null) out.push({ kind: 'ignore', reason: r.ignore });
  return out;
}
```

(d) Inside `attachLexVoiceWs`: `currentAnchorId()` (resolution copied from `:4649-4656`, returning `bs?.id ?? state.brainstormId ?? null`), `midState()` (feeds `_midStateImpl` from `state`, `getPty`, `isAwaitingSystemPrompt`; also mark `state.midSeenAssistant = true` when `jsonlHasAssistantRecord(state.jsonlPath)` finds `"type":"assistant"` in the last 64KB of the file, checked once while false), `workerLine()` (from `resolveLexScope(anchorId)` + `getProjectSession`: `null` when unbound, `idle` / `running Nm (<slug>)` from the anchor tile phase via `derivePhaseFromTail` if cheap, else `'bound (<slug>)'`), `buildLive(): LiveBlock`.

(e) Extract `forwardToL2(text: string, sttMs: number): Promise<void>` = the current body of `runTopLayerVoiceTurnOnce` from `confirmRealBarge(false);` (`:4545`) to the end (`:4831`), with `trimmed` -> `text` and `result` -> `{ text, ms: sttMs }`, and the `layer-hop` line changed to `to Lex (brain): ${text}`.

(f) New `runTopLayerVoiceTurnOnce`:

```ts
  async function runTopLayerVoiceTurnOnce(trimmed: string, sttMs: number): Promise<string | void> {
    const duringTts = state.utteranceStartedDuringTts;
    state.utteranceStartedDuringTts = false;
    if (state.pendingTopUtterances.length > 0) {
      const extras = state.pendingTopUtterances.splice(0);
      logFn(`[voice-ws] coalesce: combining ${extras.length} newer utterance(s) into one turn`);
      return mergeOperatorUtterances([trimmed, ...extras]);
    }
    confirmRealBarge(false);
    state.topOwnsAck = false;
    const anchorId = currentAnchorId();
    let streamed = false;
    const speakLine = (line: string): void => {
      send({ t: 'layer-hop', layer: 'top', text: line });
      for (const s of splitForSpeech(line)) speak(s, { continuation: streamed });
      streamed = true;
    };
    const turn = await topLayerTurn(trimmed, {
      live: buildLive(), duringTts, anchorId,
      deps: { onSpeech: speakLine },
    });
    const warming = midState().mid === 'warming';
    for (const action of _planTopLayerActionsImpl(turn, warming)) {
      switch (action.kind) {
        case 'speak': speakLine(action.text); break;
        case 'ignore':
          logFn(`[voice-ws] L1 ignored (${action.reason}): ${JSON.stringify(trimmed.slice(0, 80))}`);
          send({ t: 'ignored', text: trimmed, reason: action.reason });
          break;
        case 'control': applyTopLayerControl(action.control, action.arg, trimmed); break;
        case 'queue-until-warm':
          state.pendingForwardsUntilWarm.push(action.text);
          logFn(`[voice-ws] L2 warming; queued forward depth=${state.pendingForwardsUntilWarm.length}`);
          send({ t: 'queued-mid-turn', text: action.text, queue_depth: state.pendingForwardsUntilWarm.length });
          armWarmQueueFlush();
          break;
        case 'forward': await forwardToL2(action.text, sttMs); break;
      }
    }
  }
```

(g) `armWarmQueueFlush()`: if `state.warmQueueTimer` is null, `setInterval` 1000ms (unref): when `state.closed` clear; when `midState().mid !== 'warming'` or the oldest item is older than 5 min (fail-open: the CC composer buffers a paste): `const merged = mergeOperatorUtterances(state.pendingForwardsUntilWarm.splice(0)); clearInterval; state.warmQueueTimer = null; void forwardToL2(merged, 0);`. Clear the timer in `teardown()`.

(h) `applyTopLayerControl(control, arg, utterance)`:

```ts
  function applyTopLayerControl(control: TopLayerControl, arg: string | null, utterance: string): void {
    switch (control) {
      case 'mute': case 'unmute': case 'standby': case 'listen': case 'disable': case 'end_session':
        dispatchVoiceCommand(control, 'transcript'); return;
      case 'stop_speaking': { const c = speakCtrl.killActive(); if (c) send({ t: 'tts-cancel', reason: 'quiet' }); return; }
      case 'interrupt_work': dispatchVoiceCommand('hold_up', 'transcript'); return;
      case 'cancel_redirect': {
        /* Double-ESC to the L2 PTY: drop its in-flight work; the new
         * direction follows as the FORWARD action. Never touches L3. */
        const h = state.bindKey ? getPty(state.bindKey) || getPtyBySession(state.bindKey) : null;
        if (h && !h.exited) { try { h.pty.write('\x1b\x1b'); } catch { /* best-effort */ } }
        state.awaitingResponseSince = 0; state.pendingUserUtterances = [];
        logFn('[voice-ws] L1 cancel_redirect: double-ESC sent to L2');
        return;
      }
      case 'repeat': { if (lastSpokenText) { for (const s of splitForSpeech(lastSpokenText)) speak(s, { continuation: true }); } return; }
      case 'approve_plan': case 'reject_plan': case 'confirm_dispatch': case 'reject_dispatch': {
        const anchorId = currentAnchorId();
        const h = topLayerControlHandlers;
        const fn = control === 'approve_plan' ? h.approvePlan : control === 'reject_plan' ? h.rejectPlan : control === 'confirm_dispatch' ? h.confirmDispatch : h.rejectDispatch;
        if (!anchorId || !fn) { speakLineNow('That control is not wired on this brainstorm.'); return; }
        void fn(anchorId, arg).then((msg) => { if (msg) speakLineNow(msg); }).catch((err) => logFn(`[voice-ws] L1 control ${control} failed: ${(err as Error).message}`));
        return;
      }
    }
  }
```

`speakLineNow(text)` = `for (const s of splitForSpeech(text)) speak(s, { continuation: true })` plus a `layer-hop` frame. Module-level:

```ts
export interface TopLayerControlHandlers {
  approvePlan?: (anchorId: string, arg: string | null) => Promise<string | null>;
  rejectPlan?: (anchorId: string, arg: string | null) => Promise<string | null>;
  confirmDispatch?: (anchorId: string, arg: string | null) => Promise<string | null>;
  rejectDispatch?: (anchorId: string, arg: string | null) => Promise<string | null>;
  pendingPlan?: (anchorId: string) => string | null;
  pendingDispatch?: (anchorId: string) => { id: string; summary: string } | null;
}
let topLayerControlHandlers: TopLayerControlHandlers = {};
export function setTopLayerControlHandlers(h: TopLayerControlHandlers): void { topLayerControlHandlers = h; }
```

`buildLive()` fills `pendingPlan` / `pendingDispatch` from these handlers.

(i) Event delivery into a live voice connection. Keep a module-level `const eventSinks = new Map<ConnState, (event) => Promise<void>>()`; each connection registers `runTopLayerEventTurn(event)` (uses `topLayerEventTurn`, speaks via `speakLine`, applies controls) in `attachLexVoiceWs` and deletes itself in `teardown()`. Export:

```ts
export async function notifyTopLayerEvent(anchorId: string, event: { kind: 'plan-ready' | 'dispatch-pending' | 'dispatch-result' | 'plan-result'; text: string; id?: string }): Promise<boolean> {
  let delivered = false;
  for (const [st, sink] of eventSinks) {
    if (st.closed) continue;
    if (resolveAnchorIdForState(st) !== anchorId) continue;
    try { await sink(event); delivered = true; } catch (err) { logFn(`[voice-ws] top-layer event sink threw: ${(err as Error).message}`); }
  }
  return delivered;
}
```

(`resolveAnchorIdForState` is `currentAnchorId` lifted to take a state.)

(j) End of session: in `dispatchVoiceCommand` `end_session`, add `const a = currentAnchorId(); if (a) killVoiceBrainSession(a, 'voice-end-session');` after the ptyKill.

(k) Single-mouth guards (spec "Single mouth"):
  - In `runTopLayerVoiceTurnOnce`, after the turn resolves set `state.topOwnsAck = streamed || turn.speech !== null;` BEFORE forwarding, so `_shouldSpeakDeepAckImpl` suppresses L2's pre-tool ack when L1 already spoke the handoff (grep the consult site of `_shouldSpeakDeepAckImpl` in `handleJsonlLine` and confirm it reads `state.topOwnsAck`).
  - `speakLine` applies the never-twice ring: `if (wasLastSpoken(line)) return; rememberSpokenLine(line);` (import from `./voice-haiku-glue.js`).
  - In `speakViaBrain` (`:3040-3126`) the `'cut'` branch no longer calls `redeliverAfterRespawn()`; it records `cut`, logs `[voice-ws] LEX REPLY DELIVERY CUT: not re-delivered (would re-speak the heard prefix); full text in transcript`, and returns. Delete `redeliverAfterRespawn` and the `REDELIVERY_*` constants if nothing else uses them. Pin it in `tests/lex-voice-ws-top-layer-wire.test.ts` through the existing `_recordReplyDelivery` seam if reachable, otherwise document in the commit.
  - New verbs: `drop_reply` -> `speakCtrl.killActive()` + `send({t:'tts-cancel', reason:'drop-reply'})` + `deliverySeq += 1` (module counter; a later `then` for the dropped delivery sees the mismatch and records `miss` without speaking raw) and `state.suppressDeliveryUntilNextTurn = true` consumed by `speakViaBrain` (skip raw fallback once). `combine` -> if `state.pendingTopUtterances.length > 0` merge via `mergeOperatorUtterances([...state.pendingTopUtterances.splice(0), turn.forward ?? utterance])` and forward that; else treat as a plain forward.

(l) Brain-progress events: while `state.awaitingResponseSince > 0` and the operator has been quiet for 45s (`Date.now() - state.lastUserSpeechEndMs > 45_000`) and no progress event fired in the last 45s, the jsonl watch tick (`startJsonlWatch` interval) calls the connection's event sink with `{ kind: 'brain-progress', text: renderLiveBlock(buildLive()) }`. L1 may answer with silence (an all-null event turn speaks nothing).

- [ ] **Step 4: Run** `npx vitest run tests/lex-voice-ws-top-layer-wire.test.ts tests/lex-voice-ws-flush-cr.test.ts tests/lex-voice-ws-speak-queue.test.ts tests/voice-top-coalesce.test.ts tests/voice-mid-turn-live-route.test.ts tests/voice-barge-kill.test.ts` → PASS; `build:check` → 0. Then the full voice glob: `npx vitest run tests/voice-*.test.ts tests/lex-voice-*.test.ts`.

- [ ] **Step 5: Commit** `feat(voice): Layer 1 owns every utterance: speak, forward, control, ignore; queues forwards until L2 is warm` (`Rebuild: yes`).

---

### Task 7: Blue/green respawn of a disposable L1

**Files:**
- Modify: `07-daemon/src/lex/voice-brain-session.ts`
- Test: `07-daemon/tests/voice-brain-rotate.test.ts` (create)

**Interfaces:**
- Produces: env `DEVNEURAL_VOICE_BRAIN_MAX_JSONL_BYTES` (default 400000); `_rotateForTests(anchorId)`; state fields `standby: VoiceBrainSessionState | null`, `rotating: boolean`.

- [ ] **Step 1: Failing test**

```ts
it('rotates to a fresh session between turns once the jsonl passes the cap, old serves until new is warm', async () => {
  process.env.DEVNEURAL_VOICE_BRAIN_MAX_JSONL_BYTES = '200';
  const io = makeVirtualIo(); const pty = makeFakePtyLayer();
  _setVoiceBrainSessionDepsForTests(baseDeps(io, pty));
  const pathA = await warmSession(io, pty, 'a');
  /* pad the jsonl over the cap with a big reply */
  io.scheduleAssistantRecord(pathA, 20, 'x'.repeat(300), 'end_turn');
  expect(await askVoice({ anchorId: 'a', prompt: 'p1', timeoutMs: 5000 })).toHaveLength(300);
  /* rotation started: a second spawn exists, the first pty is still the ask target */
  expect(pty.spawnCalls).toHaveLength(2);
  const pathB = transcriptPathFor({ cwd: CWD, ccSessionId: 'cc-session-2', homeDir: HOME_DIR });
  io.scheduleAssistantRecord(pathA, 20, 'still old', 'end_turn');
  expect(await askVoice({ anchorId: 'a', prompt: 'p2', timeoutMs: 5000 })).toBe('still old');
  /* warm the standby (probe reply) and let the swap job run */
  io.scheduleAssistantRecord(pathB, 5, 'OK', 'end_turn');
  await _voiceBrainWarmupForTests('a', { standby: true });
  await _rotateForTests('a');
  expect(pty.killCalls).toEqual(['pty-1']);
  io.scheduleAssistantRecord(pathB, 20, 'from new', 'end_turn');
  expect(await askVoice({ anchorId: 'a', prompt: 'p3', timeoutMs: 5000 })).toBe('from new');
  delete process.env.DEVNEURAL_VOICE_BRAIN_MAX_JSONL_BYTES;
});
```

- [ ] **Step 2: Run, confirm failure.**

- [ ] **Step 3: Implement**

After a successful ask in `askVoiceInner` (just before `return text || null`): `maybeStartRotation(anchorId)`:

```ts
function maxJsonlBytes(): number { const raw = Number(process.env.DEVNEURAL_VOICE_BRAIN_MAX_JSONL_BYTES ?? ''); return Number.isFinite(raw) && raw > 0 ? raw : 400_000; }

function maybeStartRotation(anchorId: string | null | undefined): void {
  const s = stateFor(anchorId);
  if (s.rotating || !s.jsonlPath) return;
  let size = 0; try { size = deps.statSync(s.jsonlPath).size; } catch { return; }
  if (size < maxJsonlBytes()) return;
  s.rotating = true;
  const standby = initialState();
  s.standby = standby;
  deps.log(`[voice-brain] anchor=${keyFor(anchorId).slice(0, 8)} jsonl ${size}B over cap; warming a fresh session in the background`);
  spawnInto(anchorId, standby);   /* ensureSpawned's body parameterised on the target state; warmup runs on the standby */
  standby.onWarm = () => { void enqueue(anchorId, async () => swapToStandby(anchorId)); };
}
async function swapToStandby(anchorId: string | null | undefined): Promise<void> {
  const s = stateFor(anchorId); const nb = s.standby;
  if (!nb || !nb.warm) { s.rotating = false; s.standby = null; return; }
  const oldPty = s.ptyId;
  Object.assign(s, { ptyId: nb.ptyId, ccSessionId: nb.ccSessionId, jsonlPath: nb.jsonlPath, warm: true, consecutiveTimeouts: 0, spawnedAt: nb.spawnedAt, standby: null, rotating: false });
  if (oldPty) { try { deps.ptyKill(oldPty); } catch { /* best-effort */ } }
  try { deps.persistBinding(keyFor(anchorId), { voice_session_id: s.ccSessionId, voice_pty_id: s.ptyId, voice_spawned_ms: s.spawnedAt }); } catch { /* observability */ }
  deps.log(`[voice-brain] anchor=${keyFor(anchorId).slice(0, 8)} rotated: old pty ${oldPty} killed, new pty ${s.ptyId} live`);
}
```

Refactor `ensureSpawned(anchorId)` into `spawnInto(anchorId, target: VoiceBrainSessionState)` + a thin `ensureSpawned` that passes `stateFor(anchorId)`. `runWarmup(anchorId, ptyId, target)` sets `target.warm = true` and calls `target.onWarm?.()`. Swaps only ever run inside the anchor's ask queue, so no ask is in flight during the swap. `_rotateForTests(anchorId)` = `enqueue(anchorId, () => swapToStandby(anchorId))`. `_voiceBrainWarmupForTests(anchorId, { standby })` awaits the standby's warmup promise.

- [ ] **Step 4: Run** the rotate test + all voice-brain tests → PASS.

- [ ] **Step 5: Commit** `feat(voice): blue/green L1 respawn past a jsonl size cap, never mid-turn` (`Rebuild: yes`).

---

### Task 8: Mechanical confirm gate on worker dispatch (Phase B)

**Files:**
- Create: `07-daemon/src/lex/dispatch-gate.ts`
- Modify: `07-daemon/src/dashboard/routes.ts:5813` (`POST /lex/inject-cross-session` handler), daemon boot wiring where `attachLexVoiceWs` deps are set (grep `setTopLayerControlHandlers` insertion point next to `registerSmartClearRoutes` in `routes.ts:469`)
- Modify: `07-daemon/src/lex/system-prompt.ts` (API surface note)
- Test: `07-daemon/tests/dispatch-gate.test.ts` (create)

**Interfaces:**

```ts
export interface PendingDispatch { id: string; anchorId: string; body: Record<string, unknown>; callerLabel: string | null; summary: string; parkedAtMs: number }
export function isContextManagementCaller(label: string | null | undefined): boolean;
export class DispatchGate {
  constructor(deps: { now: () => number; id?: () => string; ttlMs?: number });
  park(anchorId: string, body: Record<string, unknown>): PendingDispatch;
  pendingFor(anchorId: string): PendingDispatch | null;   // newest
  release(id: string): PendingDispatch | null;
  reject(id: string, reason: string): PendingDispatch | null;
  expire(nowMs: number): PendingDispatch[];
}
```

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from 'vitest';
import { DispatchGate, isContextManagementCaller } from '../src/lex/dispatch-gate.js';

describe('dispatch gate', () => {
  it('context-management callers bypass the gate', () => {
    for (const l of ['smart-compact:window-open', 'smart-clear', 'event-supervisor', 'auto-supervisor']) expect(isContextManagementCaller(l)).toBe(true);
    for (const l of ['lex-voice', 'lex-text', 'dashboard:tile', null, undefined]) expect(isContextManagementCaller(l)).toBe(false);
  });
  it('parks, summarises, releases once, rejects once, expires', () => {
    let t = 1000;
    const g = new DispatchGate({ now: () => t, id: () => 'd1', ttlMs: 600_000 });
    const p = g.park('anchor', { target_session: 'cc', text: 'run the vitest suite and report', caller_label: 'lex-voice' });
    expect(p.summary).toBe('run the vitest suite and report');
    expect(g.pendingFor('anchor')?.id).toBe('d1');
    expect(g.release('d1')?.body.text).toBe('run the vitest suite and report');
    expect(g.release('d1')).toBeNull();
    const q = g.park('anchor', { text: 'x'.repeat(300) });
    expect(q.summary).toHaveLength(200);
    t += 600_001;
    expect(g.expire(t).map((e) => e.id)).toEqual([q.id]);
    expect(g.pendingFor('anchor')).toBeNull();
  });
});
```

- [ ] **Step 2: Run, confirm failure.**

- [ ] **Step 3: Implement `dispatch-gate.ts`**

```ts
import { randomUUID } from 'node:crypto';

const CONTEXT_MANAGEMENT_PREFIXES = ['smart-compact:', 'smart-clear', 'event-supervisor', 'auto-supervisor'];

/* AUTO-CLEAR T10.2: the confirm gate exempts ONLY context-management
 * system actions. New work from Lex still needs the spoken yes. */
export function isContextManagementCaller(label: string | null | undefined): boolean {
  const l = (label ?? '').trim();
  return CONTEXT_MANAGEMENT_PREFIXES.some((p) => l === p || l.startsWith(p));
}

export class DispatchGate {
  private readonly pending = new Map<string, PendingDispatch>();
  private readonly now: () => number;
  private readonly id: () => string;
  private readonly ttlMs: number;
  constructor(deps: { now: () => number; id?: () => string; ttlMs?: number }) {
    this.now = deps.now; this.id = deps.id ?? (() => randomUUID().slice(0, 8)); this.ttlMs = deps.ttlMs ?? 10 * 60_000;
  }
  park(anchorId: string, body: Record<string, unknown>): PendingDispatch {
    const text = typeof body.text === 'string' ? body.text : '';
    const p: PendingDispatch = { id: this.id(), anchorId, body, callerLabel: typeof body.caller_label === 'string' ? body.caller_label : null, summary: text.replace(/\s+/g, ' ').trim().slice(0, 200), parkedAtMs: this.now() };
    this.pending.set(p.id, p);
    return p;
  }
  pendingFor(anchorId: string): PendingDispatch | null {
    let best: PendingDispatch | null = null;
    for (const p of this.pending.values()) if (p.anchorId === anchorId && (!best || p.parkedAtMs > best.parkedAtMs)) best = p;
    return best;
  }
  release(id: string): PendingDispatch | null { const p = this.pending.get(id) ?? null; if (p) this.pending.delete(id); return p; }
  reject(id: string, _reason: string): PendingDispatch | null { return this.release(id); }
  expire(nowMs: number): PendingDispatch[] {
    const out: PendingDispatch[] = [];
    for (const p of [...this.pending.values()]) if (nowMs - p.parkedAtMs >= this.ttlMs) { this.pending.delete(p.id); out.push(p); }
    return out;
  }
}
```

- [ ] **Step 4: Wire the route**

Read `routes.ts:5813` first. At the top of the handler, after the body is parsed and BEFORE `crossSessionInject(...)` is called, insert:

```ts
    /* Phase B mechanical confirm gate (LAYER-1-CONTROL.md). Lex's own
     * worker dispatch is parked and the operator is asked by voice
     * through Layer 1. Context-management callers are exempt. */
    if (
      dispatchConfirmGateOn(store.db) &&
      typeof body.from_lex_anchor_id === 'string' && body.from_lex_anchor_id &&
      !isContextManagementCaller(body.caller_label)
    ) {
      const parked = dispatchGate.park(body.from_lex_anchor_id, body as Record<string, unknown>);
      log(`[dispatch-gate] parked ${parked.id} from anchor ${body.from_lex_anchor_id.slice(0, 8)}: ${JSON.stringify(parked.summary.slice(0, 80))}`);
      const delivered = await notifyTopLayerEvent(body.from_lex_anchor_id, { kind: 'dispatch-pending', id: parked.id, text: `the brain wants to send the worker: ${parked.summary}` });
      if (!delivered) {
        emitNotification({ severity: 'warn', source: 'dispatch-gate', notify_class: 'followup', title: 'Lex wants to prompt the worker', body: parked.summary, dedup_key: `dispatch:${parked.id}` });
      }
      reply.code(202);
      return { ok: false, decision: 'held_for_confirm', pending_id: parked.id, message: 'The operator is being asked by voice. Do not re-send; you will be told the outcome.' };
    }
```

Module-level in `routes.ts` (or a small `dispatch-gate-wire.ts`): `const dispatchGate = new DispatchGate({ now: () => Date.now() });` plus an unref'd 60s `setInterval` that runs `dispatchGate.expire(Date.now())` and, for each expired item, injects `[dispatch-rejected ${id}] No answer from the operator within ten minutes. Hold that work; ask again when he is back.` into the anchor's L2 PTY (`getLexSession(anchorId).current_pty_id` via `ptyInject(..., true)`). Register the L1 handlers at the same place the voice WS is attached:

```ts
  setTopLayerControlHandlers({
    pendingDispatch: (anchorId) => { const p = dispatchGate.pendingFor(anchorId); return p ? { id: p.id, summary: p.summary } : null; },
    confirmDispatch: async (anchorId) => {
      const p = dispatchGate.pendingFor(anchorId); if (!p) return 'Nothing is waiting to go to the worker.';
      dispatchGate.release(p.id);
      const r = await crossSessionInject(p.body as InjectRequest, store.db, injectDeps);   /* the same call + deps the route uses below */
      log(`[dispatch-gate] released ${p.id}: ${r.decision}`);
      return r.ok ? 'Sent to the worker.' : `The worker did not take it: ${r.decision}.`;
    },
    rejectDispatch: async (anchorId, reason) => {
      const p = dispatchGate.pendingFor(anchorId); if (!p) return 'Nothing is waiting to go to the worker.';
      dispatchGate.reject(p.id, reason ?? '');
      const row = getLexSession(anchorId);
      if (row?.current_pty_id) ptyInject(row.current_pty_id, `[dispatch-rejected ${p.id}] The operator said no${reason ? `: ${reason}` : ''}. Revise the plan and confirm again before dispatching.`, true);
      return 'Told the brain to revise.';
    },
    /* plan handlers are added in Task 9 */
  });
```

`system-prompt.ts` API_SURFACE, next to the `POST /lex/inject-cross-session` line, add: `A 202 with decision "held_for_confirm" means the operator is being asked by voice through the voice layer. Do NOT re-send. Wait for a [dispatch-rejected] message (revise) or for the worker to start (the dispatch was released).`

- [ ] **Step 5: Run** `npx vitest run tests/dispatch-gate.test.ts tests/cross-session-inject-scope.test.ts tests/cross-session-inject-verify.test.ts` → PASS; `build:check` → 0.

- [ ] **Step 6: Commit** `feat(lex): mechanical confirm gate on worker dispatch, answered by voice through Layer 1` (`Rebuild: yes`).

---

### Task 9: Plan approval by voice (Phase B)

**Files:**
- Create: `07-daemon/src/lex/plan-approval.ts`
- Modify: `07-daemon/src/dashboard/routes.ts:1402-1467` (pending-prompt handler), the handler registration from Task 8
- Test: `07-daemon/tests/plan-approval.test.ts` (create)

**Interfaces:**

```ts
export function isPlanApprovalPrompt(kind: string, message: string): boolean;
export function extractPendingPlan(jsonlTail: string): string | null;
export interface PendingPlan { anchorId: string; ccSessionId: string; ptyId: string | null; plan: string; atMs: number }
export class PlanApprovalRegistry { set(p: PendingPlan): void; get(anchorId: string): PendingPlan | null; clear(anchorId: string): void }
export function approvePlan(inject: (ptyId: string, text: string, commit: boolean) => { ok: boolean }, ptyId: string): boolean;
export function rejectPlan(writeRaw: (ptyId: string, bytes: string) => void, inject: (...) => { ok: boolean }, ptyId: string, reason: string, delay: (fn: () => void, ms: number) => void): void;
```

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from 'vitest';
import { approvePlan, extractPendingPlan, isPlanApprovalPrompt, rejectPlan } from '../src/lex/plan-approval.js';

const line = (o: unknown) => JSON.stringify(o) + '\n';

describe('plan approval', () => {
  it('detects the ExitPlanMode permission prompt only', () => {
    expect(isPlanApprovalPrompt('permission_prompt', 'Claude needs your permission to use ExitPlanMode')).toBe(true);
    expect(isPlanApprovalPrompt('permission', 'ExitPlanMode')).toBe(true);
    expect(isPlanApprovalPrompt('idle_prompt', 'ExitPlanMode')).toBe(false);
    expect(isPlanApprovalPrompt('permission_prompt', 'Claude needs your permission to use Bash')).toBe(false);
  });
  it('extracts the plan from the last unanswered ExitPlanMode tool_use', () => {
    const tail =
      line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'ExitPlanMode', input: { plan: '# Plan\n1. do x' } }] } }) ;
    expect(extractPendingPlan(tail)).toBe('# Plan\n1. do x');
    const answered = tail + line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] } });
    expect(extractPendingPlan(answered)).toBeNull();
    expect(extractPendingPlan(line({ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }))).toBeNull();
  });
  it('approve sends Enter; reject sends ESC then the reason as a prompt', () => {
    const calls: string[] = [];
    expect(approvePlan((p, t, c) => { calls.push(`${p}:${JSON.stringify(t)}:${c}`); return { ok: true }; }, 'pty9')).toBe(true);
    expect(calls).toEqual(['pty9:"\\r":false']);
    const raw: string[] = []; const inj: string[] = []; const timers: Array<() => void> = [];
    rejectPlan((p, b) => raw.push(`${p}:${JSON.stringify(b)}`), (p, t) => { inj.push(`${p}:${t}`); return { ok: true }; }, 'pty9', 'too risky', (fn) => timers.push(fn));
    expect(raw).toEqual(['pty9:"\\u001b"']);
    timers.forEach((f) => f());
    expect(inj[0]).toMatch(/^pty9:\[plan-rejected\] The operator said no: too risky/);
  });
});
```

- [ ] **Step 2: Run, confirm failure.**

- [ ] **Step 3: Implement `plan-approval.ts`**

```ts
export function isPlanApprovalPrompt(kind: string, message: string): boolean {
  return /permission/i.test(kind) && /ExitPlanMode/i.test(message);
}

export function extractPendingPlan(jsonlTail: string): string | null {
  let plan: string | null = null; let pendingId: string | null = null;
  for (const raw of jsonlTail.split(/\r?\n/)) {
    const t = raw.trim(); if (!t) continue;
    let rec: { type?: string; message?: { content?: Array<Record<string, unknown>> } };
    try { rec = JSON.parse(t); } catch { continue; }
    const content = Array.isArray(rec.message?.content) ? rec.message!.content! : [];
    if (rec.type === 'assistant') {
      for (const c of content) if (c.type === 'tool_use' && c.name === 'ExitPlanMode') {
        const input = c.input as { plan?: unknown } | undefined;
        plan = typeof input?.plan === 'string' ? input.plan : ''; pendingId = typeof c.id === 'string' ? c.id : null;
      }
    } else if (rec.type === 'user') {
      for (const c of content) if (c.type === 'tool_result' && pendingId && c.tool_use_id === pendingId) { plan = null; pendingId = null; }
    }
  }
  return plan;
}

export class PlanApprovalRegistry {
  private readonly byAnchor = new Map<string, PendingPlan>();
  set(p: PendingPlan): void { this.byAnchor.set(p.anchorId, p); }
  get(anchorId: string): PendingPlan | null { return this.byAnchor.get(anchorId) ?? null; }
  clear(anchorId: string): void { this.byAnchor.delete(anchorId); }
}

/* The Claude Code plan dialog ("Would you like to proceed?") accepts the
 * highlighted option on Enter and cancels on Escape. Approve = bare CR
 * (no text, no second CR). Reject = ESC, then the reason typed as the
 * next prompt so the brain keeps planning with the operator's words. */
export function approvePlan(inject: (ptyId: string, text: string, commit: boolean) => { ok: boolean }, ptyId: string): boolean {
  return inject(ptyId, '\r', false).ok;
}
export function rejectPlan(writeRaw: (ptyId: string, bytes: string) => void, inject: (ptyId: string, text: string, commit: boolean) => { ok: boolean }, ptyId: string, reason: string, delay: (fn: () => void, ms: number) => void): void {
  writeRaw(ptyId, '\x1b');
  delay(() => { inject(ptyId, `[plan-rejected] The operator said no${reason ? `: ${reason}` : ''}. Keep planning and present a revised plan.`, true); }, 600);
}
```

- [ ] **Step 4: Wire detection + handlers**

In the pending-prompt route (`routes.ts:1402`), after `setPending(id, body.message, promptKind);`:

```ts
    if (isPlanApprovalPrompt(promptKind, body.message)) {
      const anchor = store.db.getLexSessionByCcSessionId(id);
      if (anchor) {
        const handle = getPtyBySession(id);
        const ref = listTranscriptRefs(anchor.id).find((r) => r.cc_session_id === id);
        let plan: string | null = null;
        try { plan = ref ? extractPendingPlan(readTail(ref.transcript_path, 256 * 1024)) : null; } catch { plan = null; }
        planApprovals.set({ anchorId: anchor.id, ccSessionId: id, ptyId: handle?.ptyId ?? anchor.current_pty_id ?? null, plan: plan ?? '(plan text unavailable; ask the brain to summarise)', atMs: Date.now() });
        log(`[plan-approval] pending on anchor ${anchor.id.slice(0, 8)} (${plan ? plan.length : 0} chars)`);
        void notifyTopLayerEvent(anchor.id, { kind: 'plan-ready', text: plan ? plan.slice(0, 1500) : 'the brain has a plan ready but the text is unavailable' });
      }
    }
```

(`readTail(path, bytes)` reads the last N bytes with `fs.openSync/readSync`; add it next to the handler or reuse `readWorkerTail` from `smart-clear.ts` if its signature fits.) Extend the Task 8 handler registration:

```ts
    pendingPlan: (anchorId) => planApprovals.get(anchorId)?.plan ?? null,
    approvePlan: async (anchorId) => {
      const p = planApprovals.get(anchorId); if (!p?.ptyId) return 'No plan is waiting.';
      const ok = approvePlan(ptyInject, p.ptyId); planApprovals.clear(anchorId); clearPending(p.ccSessionId);
      return ok ? 'Approved. The brain is going ahead.' : 'I could not reach the brain to approve it.';
    },
    rejectPlan: async (anchorId, reason) => {
      const p = planApprovals.get(anchorId); if (!p?.ptyId) return 'No plan is waiting.';
      const h = getPty(p.ptyId); if (!h || h.exited) return 'The brain is not reachable.';
      rejectPlan((_, b) => { h.pty.write(b); }, ptyInject, p.ptyId, reason ?? '', (fn, ms) => setTimeout(fn, ms));
      planApprovals.clear(anchorId); clearPending(p.ccSessionId);
      return 'Sent it back for another pass.';
    },
```

`midPermissionMode` default stays `bypassPermissions`; the restart-verify flips `mid_permission_mode` to `plan` live and keeps it if item 6 passes. Update the `layer-model.ts` comment to say the routing now exists.

- [ ] **Step 5: Run** `npx vitest run tests/plan-approval.test.ts tests/pending-prompt-notify.test.ts` → PASS; `build:check` → 0.

- [ ] **Step 6: Commit** `feat(lex): route the L2 plan-approval prompt through Layer 1 by voice` (`Rebuild: yes`).

---

### Task 10: Dashboard: greyed "ignored" rows, build out/

**Files:**
- Modify: `08-dashboard/lib/transcript-grouping.ts:22` (turn type gains `ignored?: boolean`)
- Modify: `08-dashboard/components/VoiceClient.tsx:2348` (`case "transcript"` sibling: new `case "ignored"`), the transcript row renderer (grep `layer === "operator"` under `components/` to find the row component)
- Test: `08-dashboard/lib/__tests__/transcript-grouping.test.ts` or the existing grouping test file (extend)

- [ ] **Step 1: Failing test:** an `ignored: true` operator turn survives `groupTranscriptTurns` with the flag intact.
- [ ] **Step 2: Run, confirm failure.**
- [ ] **Step 3: Implement:** `case "ignored": { const text = String(msg.text ?? "").trim(); if (text) setTurns((prev) => cap([...prev, { id: \`i-${Date.now()}\`, role: "user" as const, text, layer: "operator" as const, ignored: true }])); break; }` (reuse the `TURNS_BUFFER_CAP` slice used by `case "transcript"`). In the row renderer: when `turn.ignored`, add `style={{ opacity: 0.45 }}` and a trailing `<span>(not for Lex)</span>`. No new controls.
- [ ] **Step 4: Run** `cd C:/dev/Projects/DevNeural/08-dashboard && npx vitest run` (233 unit tests + 2 known playwright collection errors) then `npm run build` (writes `out/`).
- [ ] **Step 5: Commit** `feat(dashboard): grey out utterances Layer 1 dropped as background` (`Rebuild: no` for the daemon; note `out/` rebuilt).

---

### Task 11: Trackers, full suites, daemon build

**Files:** `BUGS.md`, `FIXES.md`, `docs/HANDOVER.md`, `docs/spec/LAYER-1-CONTROL.md` (code map touch-ups)

- [ ] **Step 1: BUGS.md:** add `BUG-022 | SMOKE-TESTING | L1 voice-brain chars=0: waitForVoiceReply closed the ask on the thinking-only end_turn record; the sibling text record was never read (root cause of BUG-008). Fixed in Task 1; awaiting restart + live verify.` Index row + detail block (Found 2026-09-21, Fixed 2026-09-21). Update the BUG-008 detail with `Root-caused as BUG-022.` Announce `🐞 BUG LOGGED - BUG-022 [SMOKE-TESTING] ...` in the reply.
- [ ] **Step 2: FIXES.md:** one row per commit (VL-1 .. VL-10), each with the commit sha, file, and the restart-verify item it maps to.
- [ ] **Step 3: HANDOVER.md:** new cursor `2026-09-22 voice layers wave (daemon NOT restarted)`: what shipped (shas), deploy state (dist built, out/ built), the restart-verify list from `LAYER-1-CONTROL.md` "Testing / Live" plus: flip `POST /runtime-config/mid_permission_mode {"value":"plan"}` only after items 1-5 pass; `POST /runtime-config/dispatch_confirm_gate {"value":"on"}` to arm the gate; expected log lines (`[voice-brain] ask replied ... chars=<n>`, `[voice-ws] L1 ignored`, `[dispatch-gate] parked`, `[plan-approval] pending`).
- [ ] **Step 4: Full suites:** `cd 07-daemon && npm test` (expect only the 2 known reds) and `npm run build` (dist). `cd 08-dashboard && npm run build` already done in Task 10; re-run if any client file changed since.
- [ ] **Step 5: Commit** `docs: voice layers wave trackers + handover` (`Rebuild: no`).

---

### Task 12: Context lifecycle doc made coherent (docs only, this wave)

**Files:** rewrite `docs/spec/SMART-COMPACT.md` (keep the filename; `docs/INDEX.md` already lists it).

- [ ] **Step 1:** Rewrite the doc as "Context lifecycle: worker auto-clear, handover, and how the layers drive it". Sections, in this order, each written from the current code and AUTO-CLEAR T1-T10 (no new design):
  1. What exists today (worker auto-clear = smart-clear trigger on Layer A transport; routes `/lex/smart-clear/state|plan|confirm`, `/lex/smart-compact/clear-and-paste|wrap-paste`; two mode keys; SessionStart `/worker/clear-handoff` reseed; `smart_compact_log` audit). Cite file:line from AUTO-CLEAR §4.
  2. Who drives it: L2 (always spawned scoped since this wave, carrying `renderSupervisionDrive()`); L1 only narrates ("she's clearing the worker's context, about a minute") from the live block; the dispatch gate exempts `smart-compact:*` / `smart-clear` callers.
  3. Target state (T3, in the operator's words): Lex sees context filling, tells the worker to reach a stopping point and write its handover, reviews it against the plan and the overall status, edits it, clears the worker, injects the reviewed concise handover; SessionStart reseed dedup.
  4. What Phase C builds (next wave): worker-authored handover frame (T5 slots), Lex review + append step (a `POST /lex/smart-clear/review` that takes the worker's handover + Lex's edits and returns the vetted reseed), single mode key, reseed dedup, L2 self-clear per T4 with the `clear`-branch hook.
  5. Restart-verify for the restored driver loop: with a worker at ctx >= 40% and `smart_clear_mode=live`, a `[supervisor-event]` makes L2 poll state -> plan -> drive-to-stop -> clear-and-paste -> confirm; an audit row `caller:'smart-clear'` appears.
- [ ] **Step 2:** Commit `docs(spec): SMART-COMPACT rewritten as the context-lifecycle doc aligned with the voice layers` (`Rebuild: no`).

---

## Phase C (next wave, not started tonight): worker-authored handover + Lex review

Recipe only; plan it as its own file when A+B are live-verified.

1. `POST /lex/smart-clear/handover-request` : daemon injects a WRAP prompt that asks the worker to write its handover into the T5 frame (Verified state, What I was doing, Decisions, Stopping point) and reply `ready`.
2. `POST /lex/smart-clear/review` : Lex posts the worker's handover + its own Next steps + edits; daemon runs `vetReseed`, stores the approved handover under `<DATA_ROOT>/brainstorms/<anchor>/HANDOVER-<iso>.md` (reuse `handover-writer.ts`), returns the reseed text.
3. `clear-and-paste` takes `handover_id` and pastes the approved handover; `/worker/clear-handoff` returns the same approved handover instead of recomputing (dedup).
4. Merge `smart_clear_mode` + `smart_compact_mode` into one `auto_clear_mode`.
5. L2 self-clear (T4): `writeHandover` on the stop pipeline, `POST /lex/clear-handoff`, `postLexClearHandoff` in the `clear`/`compact` hook branch, staggered against the worker.

---

## Self-review

- Spec coverage: layers/scope (Task 4), boot order + warm queue (Tasks 4, 6), L1 runtime flags + knobs (Task 3), system prompt + turn contract + IGNORE (Task 5), barge new-input policy (Task 6 `cancel_redirect`, coalesce kept), reply delivery + BUG-008 (Task 1), context hygiene (Task 7), personality (Task 2), knobs table (Task 3), Phase B plan approval (Task 9) + dispatch gate (Task 8), transcript `ignored` (Tasks 6, 10), AUTO-CLEAR alignment (Tasks 8, 12), testing lists (each task), trackers (Task 11).
- Placeholders: none. Where an identifier must be confirmed against the file at execution time, the exact grep is given.
- Type consistency: `TopLayerResult` fields (`speech, forward, control, controlArg, ignore`) match across Tasks 5, 6; `LiveBlock` matches Tasks 5, 6; `TopLayerControlHandlers` (Task 6) is what Tasks 8, 9 register; `askVoice` input gains `anchorId` in Task 4 and is used in Task 5's `defaultAsk`.
