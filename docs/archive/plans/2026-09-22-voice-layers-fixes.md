# Voice Layers Fix Wave Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the brain (Layer 2) reachable by voice, make spoken controls deterministic, and give Layer 1 the truth it needs so it stops guessing; closes BUG-026, BUG-027, BUG-028, BUG-029, BUG-030 found in the 2026-09-22 first voice test.

**Architecture:** Every fix is additive on the existing seams: `_midStateImpl` gains a PTY-derived "composer up" signal so L2 stops reading as warming; a word gate in `lex-voice-commands.ts` runs before Layer 1 for the fixed control verbs; `workerLine()` carries the worker's phase; the L1 spawn moves to a memory-free cwd; the contract gains worked examples; the attach-time default prewarm goes. Pure functions carry the logic and the tests; the WS wiring only calls them.

**Tech Stack:** TypeScript (ESM, Node 24), vitest, Fastify daemon in `07-daemon`. Tests run with `npx vitest run tests/<file>.test.ts` from `C:\dev\Projects\DevNeural\07-daemon`. Build with `npm run build` there.

**Spec:** `docs/spec/LAYER-1-CONTROL.md` (v2). Bug entries with root causes: `BUGS.md` BUG-026 to BUG-030.

## Global Constraints

- Additive-only. No existing test pin changes meaning; a pin may gain a field with its old default.
- Commit bodies end with `Rebuild: yes` or `Rebuild: no`. No AI attribution lines in commits (operator rule).
- No em dashes or en dashes anywhere, including spoken text and comments.
- Every spoken line is an L1 line; the daemon never emits a hardcoded spoken line (BUG-013 rule). The word gate applies effects; it does not speak.
- "lex emergency stop" stays checked first, before the word gate.
- Windows: the daemon spawns Claude Code with `cmd.exe` quoting; do not add args with spaces.

---

### Task 1: BUG-026, L2 warm from the PTY

**Files:**
- Modify: `07-daemon/src/voice/lex-voice-ws.ts` (`_midStateImpl` at ~1908-1944, `ConnState` init at ~2089-2129, `midState()` at ~3210-3228, constants near 2063-2069)
- Test: `07-daemon/tests/lex-voice-ws-top-layer-wire.test.ts`

**Interfaces:**
- Consumes: `PtyHandle` fields `startedAt`, `lastActivity`, `exited` (`src/dashboard/pty-host.ts:74-76`), `isAwaitingSystemPrompt(key)`.
- Produces: `export function _l2ComposerUpImpl(i: { exited: boolean; awaitingSystemPrompt: boolean; startedAt: number; lastActivity: number; nowMs: number }): boolean`; `MidStateInput.composerUp: boolean`; exported constants `L2_WARM_MIN_UPTIME_MS = 15_000`, `L2_WARM_QUIET_MS = 3_000`.

- [ ] **Step 1: Write the failing tests**

Add to `tests/lex-voice-ws-top-layer-wire.test.ts`, inside the existing `describe('_midStateImpl'...)` block add `composerUp: false` to `base`, then append:

```ts
  it('composer up counts as warm even before the first assistant record (BUG-026)', () => {
    expect(_midStateImpl({ ...base, seenAssistant: false, composerUp: true }).mid).toBe('idle');
    expect(
      _midStateImpl({ ...base, seenAssistant: false, composerUp: true, awaitingResponseSince: 10 }).mid,
    ).toBe('thinking');
    expect(
      _midStateImpl({ ...base, seenAssistant: false, composerUp: true, awaitingSystemPrompt: true }).mid,
    ).toBe('warming');
  });
```

New describe block (import `_l2ComposerUpImpl`, `L2_WARM_MIN_UPTIME_MS`, `L2_WARM_QUIET_MS` from `../src/voice/lex-voice-ws.js`):

```ts
describe('_l2ComposerUpImpl', () => {
  const up = { exited: false, awaitingSystemPrompt: false, startedAt: 0, lastActivity: 20_000, nowMs: 40_000 };
  it('is up once the PTY is old enough and its output has been quiet', () => {
    expect(_l2ComposerUpImpl(up)).toBe(true);
  });
  it('is not up during boot, while output is still flowing, on a native prompt, or after exit', () => {
    expect(_l2ComposerUpImpl({ ...up, nowMs: L2_WARM_MIN_UPTIME_MS - 1, lastActivity: 0 })).toBe(false);
    expect(_l2ComposerUpImpl({ ...up, lastActivity: up.nowMs - L2_WARM_QUIET_MS + 1 })).toBe(false);
    expect(_l2ComposerUpImpl({ ...up, awaitingSystemPrompt: true })).toBe(false);
    expect(_l2ComposerUpImpl({ ...up, exited: true })).toBe(false);
  });
});
```

- [ ] **Step 2: Run the file to verify it fails**

Run: `npx vitest run tests/lex-voice-ws-top-layer-wire.test.ts`
Expected: FAIL, `_l2ComposerUpImpl is not a function` and the composerUp expectation `'warming'` vs `'idle'`.

- [ ] **Step 3: Implement**

In `lex-voice-ws.ts` next to `WARM_QUEUE_CAP_MS` (line ~2069):

```ts
/* L2 "composer up" (BUG-026): a freshly opened L2 writes no jsonl until
 * its first turn, and that turn cannot arrive while the daemon calls it
 * warming. The PTY tells us the same thing the operator's eyes do: the
 * banner has scrolled and output has gone quiet. Latched once seen. */
export const L2_WARM_MIN_UPTIME_MS = 15_000;
export const L2_WARM_QUIET_MS = 3_000;

export function _l2ComposerUpImpl(i: {
  exited: boolean;
  awaitingSystemPrompt: boolean;
  startedAt: number;
  lastActivity: number;
  nowMs: number;
}): boolean {
  if (i.exited || i.awaitingSystemPrompt) return false;
  if (i.nowMs - i.startedAt < L2_WARM_MIN_UPTIME_MS) return false;
  return i.nowMs - i.lastActivity >= L2_WARM_QUIET_MS;
}
```

`MidStateInput` gains `composerUp: boolean;`. In `_midStateImpl` replace the warming test:

```ts
  if (i.awaitingSystemPrompt || !(i.seenAssistant || i.composerUp)) {
    return { mid: 'warming', sinceMs: null, tool: null };
  }
```

`ConnState` gains `midComposerSeen: boolean;` (init `false` next to `midSeenAssistant: false`). In `midState()` before the `return _midStateImpl(...)`:

```ts
    if (!state.midComposerSeen && handle && state.bindKey) {
      const nowMs = Date.now();
      if (
        _l2ComposerUpImpl({
          exited: handle.exited,
          awaitingSystemPrompt: isAwaitingSystemPrompt(state.bindKey),
          startedAt: handle.startedAt,
          lastActivity: handle.lastActivity,
          nowMs,
        })
      ) {
        state.midComposerSeen = true;
        logFn(
          `[voice-ws] L2 composer up after ${Math.round((nowMs - handle.startedAt) / 1000)}s; brain idle`,
        );
      }
    }
```

and pass `composerUp: state.midComposerSeen,` into the input object.

- [ ] **Step 4: Run the file to verify it passes**

Run: `npx vitest run tests/lex-voice-ws-top-layer-wire.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Commit**

```bash
git add 07-daemon/src/voice/lex-voice-ws.ts 07-daemon/tests/lex-voice-ws-top-layer-wire.test.ts
git commit -m "fix(voice): L2 counts as warm once its composer is up, not only after its first reply (BUG-026)"
```
Body: root cause one paragraph, `Rebuild: yes`.

---

### Task 2: BUG-030, deterministic word gate and parser guards

**Files:**
- Modify: `07-daemon/src/voice/lex-voice-commands.ts` (append)
- Modify: `07-daemon/src/voice/voice-top-layer.ts` (`TopLayerResult` ~97-107, `speechOnly` ~344, `parseTopLayerReply` ~381-439)
- Modify: `07-daemon/src/voice/lex-voice-ws.ts` (after the panic block at ~4699-4705; log line at ~5010)
- Test: `07-daemon/tests/lex-voice-commands.test.ts`, `07-daemon/tests/voice-top-layer.test.ts`

**Interfaces:**
- Produces: `export type SpokenControl = 'mute' | 'unmute' | 'standby' | 'listen' | 'end_session' | 'stop_speaking'`; `export function matchSpokenControl(text: string): SpokenControl | null`; `TopLayerResult.inferredControl?: boolean`; `export const STAGE_DIRECTION_LINE = /^\s*\(.*\)\s*$/`.

- [ ] **Step 1: Write the failing tests**

`tests/lex-voice-commands.test.ts`, append:

```ts
import { matchSpokenControl } from '../src/voice/lex-voice-commands.js';

describe('matchSpokenControl (BUG-030 word gate)', () => {
  it('matches the fixed verb set only with the lex prefix', () => {
    expect(matchSpokenControl('Lex mute.')).toBe('mute');
    expect(matchSpokenControl('lex, unmute')).toBe('unmute');
    expect(matchSpokenControl('Lex stand by')).toBe('standby');
    expect(matchSpokenControl('lex standby')).toBe('standby');
    expect(matchSpokenControl('Lex listen')).toBe('listen');
    expect(matchSpokenControl('lex end session')).toBe('end_session');
    expect(matchSpokenControl('Lex end the session')).toBe('end_session');
    expect(matchSpokenControl('lex stop talking')).toBe('stop_speaking');
    expect(matchSpokenControl('Lex be quiet')).toBe('stop_speaking');
  });
  it('ignores the verbs without the prefix and never eats substance', () => {
    expect(matchSpokenControl('mute the tv')).toBeNull();
    expect(matchSpokenControl('lex, can you mute the worker notifications')).toBeNull();
    expect(matchSpokenControl('lex emergency stop')).toBeNull();
    expect(matchSpokenControl('')).toBeNull();
  });
});
```

`tests/voice-top-layer.test.ts`, append (import `parseTopLayerReply`, `speechOnly` if not already):

```ts
describe('parser guards (BUG-030)', () => {
  it('a narrated verb with no directive becomes the control, flagged inferred', () => {
    const r = parseTopLayerReply('Muted.');
    expect(r.control).toBe('mute');
    expect(r.inferredControl).toBe(true);
    expect(parseTopLayerReply('Unmuted, go on.').control).toBe('unmute');
    expect(parseTopLayerReply('Standing by.').control).toBe('standby');
    expect(parseTopLayerReply('Listening.').control).toBe('listen');
    expect(parseTopLayerReply('Stopping. Over.').control).toBe('stop_speaking');
  });
  it('a real directive is never overridden and long speech is never inferred', () => {
    const r = parseTopLayerReply('Muted.\nCONTROL: standby');
    expect(r.control).toBe('standby');
    expect(r.inferredControl).toBeUndefined();
    expect(parseTopLayerReply('Muted the notifications for the worker as you asked, and the rest stays live.').control).toBeNull();
  });
  it('parenthetical stage directions are never spoken', () => {
    expect(parseTopLayerReply('(Listening, not speaking.)').speech).toBeNull();
    expect(speechOnly('(pauses)\nRight, got it.')).toBe('Right, got it.');
    expect(parseTopLayerReply('Right (I think) so.').speech).toBe('Right (I think) so.');
  });
});
```

- [ ] **Step 2: Run both files to verify they fail**

Run: `npx vitest run tests/lex-voice-commands.test.ts tests/voice-top-layer.test.ts`
Expected: FAIL, `matchSpokenControl` not exported; `control` null where `'mute'` expected; speech `'(Listening, not speaking.)'` where null expected.

- [ ] **Step 3: Implement**

`lex-voice-commands.ts`, append:

```ts
/* BUG-030 (2026-09-22): the fixed operator controls were riding Layer 1's
 * directive discipline and it narrated them instead ("Muted." with no
 * CONTROL line; the mic stayed live). These few verbs are matched
 * mechanically, prefix required, BEFORE Layer 1, same shape as the panic
 * phrase. Layer 1 still speaks the ack; the effect no longer depends on it. */
export type SpokenControl =
  | 'mute'
  | 'unmute'
  | 'standby'
  | 'listen'
  | 'end_session'
  | 'stop_speaking';

const SPOKEN_CONTROL_RES: ReadonlyArray<[RegExp, SpokenControl]> = [
  [new RegExp(LEX_PREFIX + String.raw`unmute\b`), 'unmute'],
  [new RegExp(LEX_PREFIX + String.raw`mute\s*$`), 'mute'],
  [new RegExp(LEX_PREFIX + String.raw`stand\s*by\s*$`), 'standby'],
  [new RegExp(LEX_PREFIX + String.raw`listen\s*$`), 'listen'],
  [new RegExp(LEX_PREFIX + String.raw`end\s+(the\s+)?session\s*$`), 'end_session'],
  [new RegExp(LEX_PREFIX + String.raw`(stop\s+(talking|speaking)|be\s+quiet|quiet)\s*$`), 'stop_speaking'],
];

/** The fixed spoken controls, prefix required, whole utterance. Anything
 * with more words after the verb is substance for Layer 1 and returns null. */
export function matchSpokenControl(text: string): SpokenControl | null {
  if (!text) return null;
  const norm = normalize(text);
  if (!norm) return null;
  for (const [re, kind] of SPOKEN_CONTROL_RES) {
    if (re.test(norm)) return kind;
  }
  return null;
}
```

`voice-top-layer.ts`: `TopLayerResult` gains `/** Set when the control came from a narrated verb, not a CONTROL line. */ inferredControl?: boolean;`. Next to the line regexes:

```ts
/* A whole line in parentheses is a stage direction, never speech. */
export const STAGE_DIRECTION_LINE = /^\s*\(.*\)\s*$/;

/* Narrated verbs (BUG-030): short speech that IS the control. */
const NARRATED_CONTROL: ReadonlyArray<[RegExp, TopLayerControl]> = [
  [/^unmuted\b/i, 'unmute'],
  [/^muted\b/i, 'mute'],
  [/^standing by\b/i, 'standby'],
  [/^listening\b/i, 'listen'],
  [/^(stopping|stopped)\b/i, 'stop_speaking'],
];
const NARRATED_CONTROL_MAX_CHARS = 40;
```

`speechOnly`: add `&& !STAGE_DIRECTION_LINE.test(line)` to the filter. In `parseTopLayerReply`, the final `else speechLines.push(line)` becomes `else if (!STAGE_DIRECTION_LINE.test(line)) speechLines.push(line);`. After `const speechJoined = ...`:

```ts
  let inferredControl: boolean | undefined;
  if (control === null && speechJoined && speechJoined.length <= NARRATED_CONTROL_MAX_CHARS) {
    for (const [re, verb] of NARRATED_CONTROL) {
      if (re.test(speechJoined)) {
        control = verb;
        inferredControl = true;
        break;
      }
    }
  }
```

and include `...(inferredControl ? { inferredControl } : {})` in the returned object.

`lex-voice-ws.ts`: import `matchSpokenControl` from `./lex-voice-commands.js`. Right after the panic block (after line ~4705):

```ts
    /* BUG-030: the fixed controls are mechanical, prefix required, before
     * Layer 1. Layer 1 still hears the utterance and speaks the ack; its
     * own CONTROL line, if any, hits the voice-command dedupe. */
    const spokenControl = matchSpokenControl(result.text);
    if (spokenControl) {
      logFn(`[voice-ws] control by word gate: ${spokenControl} text=${JSON.stringify(result.text.slice(0, 60))}`);
      await applyTopLayerControl(
        spokenControl,
        null,
        { speech: null, forward: null, control: null, controlArg: null, ignore: null },
        result.text,
      );
    }
```

(`handleUtteranceEnd` is already async; `applyTopLayerControl` is declared later in the same closure, which is fine for a function declaration.) The `L1 turn:` log line gains ` inferred=${turn.inferredControl ? 'yes' : 'no'}`.

- [ ] **Step 4: Run both files to verify they pass**

Run: `npx vitest run tests/lex-voice-commands.test.ts tests/voice-top-layer.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add 07-daemon/src/voice/lex-voice-commands.ts 07-daemon/src/voice/voice-top-layer.ts 07-daemon/src/voice/lex-voice-ws.ts 07-daemon/tests/lex-voice-commands.test.ts 07-daemon/tests/voice-top-layer.test.ts
git commit -m "fix(voice): mechanical word gate for mute/unmute/standby/listen/end session/quiet; narrated verbs and stage directions handled (BUG-030)"
```
Body ends `Rebuild: yes`.

---

### Task 3: BUG-029, the worker's phase in the live block

**Files:**
- Modify: `07-daemon/src/dashboard/sessions.ts` (export `readLastAssistantText`, ~365)
- Modify: `07-daemon/src/voice/lex-voice-ws.ts` (`workerLine` ~3233-3246, new exported `_workerLineImpl`)
- Test: create `07-daemon/tests/voice-live-block-worker-line.test.ts`

**Interfaces:**
- Consumes: `getPhase(sessionId)` from `src/dashboard/session-phase.ts`; `derivePhaseFromTail(file)` and `readLastAssistantText(file)` from `src/dashboard/sessions.ts`; `transcriptPathFor({cwd, ccSessionId})` from `src/lex/spawn-lex-session.ts`.
- Produces: `export function _workerLineImpl(i: { status: string; slug: string; phase: 'thinking' | 'tool' | 'permission' | 'idle' | 'unknown'; lastActivityMs: number | null; nowMs: number; lastText: string | null }): string`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { _workerLineImpl } from '../src/voice/lex-voice-ws.js';

describe('_workerLineImpl (BUG-029)', () => {
  const base = { status: 'live', slug: 'DevNeural', phase: 'idle' as const, lastActivityMs: null, nowMs: 100_000, lastText: null };
  it('names the phase and the slug', () => {
    expect(_workerLineImpl({ ...base, phase: 'thinking', lastActivityMs: 88_000 })).toBe(
      'live, thinking (DevNeural), last activity 12s ago',
    );
    expect(_workerLineImpl({ ...base, phase: 'tool', lastActivityMs: 99_000 })).toBe(
      'live, running a tool (DevNeural), last activity 1s ago',
    );
    expect(_workerLineImpl({ ...base, phase: 'permission' })).toBe(
      'live, waiting on a permission prompt (DevNeural)',
    );
    expect(_workerLineImpl({ ...base, phase: 'unknown' })).toBe('live (DevNeural)');
  });
  it('idle carries the last thing the worker said, trimmed', () => {
    expect(
      _workerLineImpl({ ...base, lastActivityMs: 100_000 - 3 * 60_000, lastText: 'Done. Tests green.\nNext?' }),
    ).toBe('live, idle (DevNeural), quiet for 3m, last said: "Done. Tests green. Next?"');
  });
  it('offline keeps the old wording', () => {
    expect(_workerLineImpl({ ...base, status: 'dormant' })).toBe('bound, offline (DevNeural)');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/voice-live-block-worker-line.test.ts`
Expected: FAIL, `_workerLineImpl` not exported.

- [ ] **Step 3: Implement**

`sessions.ts`: change `function readLastAssistantText` to `export function readLastAssistantText`.

`lex-voice-ws.ts`: imports `getPhase` from `../dashboard/session-phase.js`, `derivePhaseFromTail, readLastAssistantText` from `../dashboard/sessions.js`, `transcriptPathFor` from `../lex/spawn-lex-session.js` (check none of these already import `lex-voice-ws.js`; if `sessions.ts` does, import lazily inside `workerLine` with `await import` is not possible in a sync function, so instead move the two helpers' call behind a small module-level `let phaseDeps` set from `daemon.ts`; expected: no cycle, `sessions.ts` does not import the voice WS). Add above `attachLexVoiceWs`:

```ts
function agoLabel(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.round(m / 60)}h`;
}

/* BUG-029: what the [live] block says about the supervised worker. The
 * phase is the same merge the deck tiles use (hook phase, overridden by
 * the transcript tail). Pure so the wording is pinned. */
export function _workerLineImpl(i: {
  status: string;
  slug: string;
  phase: 'thinking' | 'tool' | 'permission' | 'idle' | 'unknown';
  lastActivityMs: number | null;
  nowMs: number;
  lastText: string | null;
}): string {
  if (i.status !== 'live') return `bound, offline (${i.slug})`;
  const phaseWord: Record<typeof i.phase, string | null> = {
    thinking: 'thinking',
    tool: 'running a tool',
    permission: 'waiting on a permission prompt',
    idle: 'idle',
    unknown: null,
  };
  const word = phaseWord[i.phase];
  let line = word ? `live, ${word} (${i.slug})` : `live (${i.slug})`;
  if (i.lastActivityMs !== null && i.phase !== 'permission' && i.phase !== 'unknown') {
    const ago = agoLabel(i.nowMs - i.lastActivityMs);
    line += i.phase === 'idle' ? `, quiet for ${ago}` : `, last activity ${ago} ago`;
  }
  if (i.phase === 'idle' && i.lastText) {
    line += `, last said: ${JSON.stringify(i.lastText.replace(/\s+/g, ' ').trim().slice(0, 120))}`;
  }
  return line;
}
```

`workerLine(anchorId)` body after `if (!proj) return null;`:

```ts
      const sid = proj.current_session_id;
      let phase: 'thinking' | 'tool' | 'permission' | 'idle' | 'unknown' = 'unknown';
      let lastActivityMs: number | null = null;
      let lastText: string | null = null;
      if (proj.status === 'live' && sid) {
        phase = getPhase(sid);
        const file = transcriptPathFor({ cwd: proj.cwd, ccSessionId: sid });
        const tail = derivePhaseFromTail(file);
        if (tail !== 'unknown') phase = tail;
        try {
          lastActivityMs = fs.statSync(file).mtimeMs;
        } catch {
          lastActivityMs = null;
        }
        if (phase === 'idle') lastText = readLastAssistantText(file);
      }
      return _workerLineImpl({
        status: proj.status,
        slug: proj.project_slug,
        phase,
        lastActivityMs,
        nowMs: Date.now(),
        lastText,
      });
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/voice-live-block-worker-line.test.ts tests/voice-top-layer-live-block.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add 07-daemon/src/dashboard/sessions.ts 07-daemon/src/voice/lex-voice-ws.ts 07-daemon/tests/voice-live-block-worker-line.test.ts
git commit -m "fix(voice): the live block carries the worker's phase, activity age and last words (BUG-029)"
```
Body ends `Rebuild: yes`.

---

### Task 4: BUG-028, memory-free Layer 1 and the "you do not know it" rule

**Files:**
- Modify: `07-daemon/src/lex/voice-brain-session.ts` (`defaultDeps` ~255-268, `ensureSpawned` spawn at ~465, `VoiceBrainSessionDeps` type ~190-230)
- Modify: `07-daemon/src/voice/voice-top-layer.ts` (`CONTRACT`, the Rules paragraph ~213-219)
- Test: `07-daemon/tests/voice-brain-session.test.ts`, `07-daemon/tests/voice-top-layer.test.ts`

**Interfaces:**
- Produces: `export function defaultVoiceBrainCwd(): string` (env `DEVNEURAL_VOICE_BRAIN_SESSION_CWD` or `<DATA_ROOT>/voice-l1`); optional dep `ensureDir?: (dir: string) => void`.

- [ ] **Step 1: Write the failing tests**

`tests/voice-brain-session.test.ts`, append at top level (import `defaultVoiceBrainCwd`):

```ts
describe('defaultVoiceBrainCwd (BUG-028)', () => {
  it('lives under the data root, outside every repo, unless overridden', () => {
    const prev = process.env.DEVNEURAL_VOICE_BRAIN_SESSION_CWD;
    delete process.env.DEVNEURAL_VOICE_BRAIN_SESSION_CWD;
    try {
      expect(defaultVoiceBrainCwd()).toMatch(/\/voice-l1$/);
      expect(defaultVoiceBrainCwd()).not.toMatch(/Projects\/DevNeural/);
      process.env.DEVNEURAL_VOICE_BRAIN_SESSION_CWD = 'C:/elsewhere';
      expect(defaultVoiceBrainCwd()).toBe('C:/elsewhere');
    } finally {
      if (prev === undefined) delete process.env.DEVNEURAL_VOICE_BRAIN_SESSION_CWD;
      else process.env.DEVNEURAL_VOICE_BRAIN_SESSION_CWD = prev;
    }
  });
});
```

`tests/voice-top-layer.test.ts`, in the system-prompt describe:

```ts
  it('tells the voice it holds no project facts (BUG-028)', () => {
    const p = buildTopLayerSystemPrompt();
    expect(p).toMatch(/you do not know it/);
    expect(p).toMatch(/hold no project facts/);
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/voice-brain-session.test.ts tests/voice-top-layer.test.ts`
Expected: FAIL, `defaultVoiceBrainCwd` not exported; prompt regex miss.

- [ ] **Step 3: Implement**

`voice-brain-session.ts`: `import { DATA_ROOT } from '../paths.js';` and

```ts
/* BUG-028: Claude Code loads the git root's auto-memory for any cwd inside
 * a repo; the L1 that ran from 07-daemon recited the operator's MEMORY.md
 * as Lex's state. The voice runs from a bare directory under the data
 * root, outside every repo, so it owns no memory and has nothing to
 * recite. */
export function defaultVoiceBrainCwd(): string {
  return process.env.DEVNEURAL_VOICE_BRAIN_SESSION_CWD ?? `${DATA_ROOT}/voice-l1`;
}
```

`defaultDeps().cwd = defaultVoiceBrainCwd()`, and add `ensureDir: (dir) => fs.mkdirSync(dir, { recursive: true }),` with the type field `ensureDir?: (dir: string) => void;`. In `ensureSpawned` just before `deps.spawnLex({`: `try { deps.ensureDir?.(deps.cwd); } catch { /* spawn will report */ }`.

`voice-top-layer.ts` CONTRACT, append to the Rules paragraph after "Never invent facts that are not in the [live] block or in what the brain said.":

```
You hold no project facts of your own. Anything about the project, its
branches, plans, history, goals or what the worker did is substance:
FORWARD it. If the [live] block does not say it, you do not know it:
say so in one short line and FORWARD the question.
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/voice-brain-session.test.ts tests/voice-top-layer.test.ts tests/persona.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add 07-daemon/src/lex/voice-brain-session.ts 07-daemon/src/voice/voice-top-layer.ts 07-daemon/tests/voice-brain-session.test.ts 07-daemon/tests/voice-top-layer.test.ts
git commit -m "fix(voice): Layer 1 runs from a memory-free cwd and is told it holds no project facts (BUG-028)"
```
Body ends `Rebuild: yes`.

---

### Task 5: Contract worked examples; "warming" and "waking" banned out loud

**Files:**
- Modify: `07-daemon/src/voice/voice-top-layer.ts` (`CONTRACT`: the warming sentence ~214-216 and a new Examples block before the during_tts paragraph)
- Modify: `07-daemon/src/lex/persona.ts` (`LEX_SPOKEN_RULES` line ~125-126)
- Test: `07-daemon/tests/voice-top-layer.test.ts`, `07-daemon/tests/persona.test.ts`

- [ ] **Step 1: Write the failing tests**

`tests/persona.test.ts`, in the spoken-rules describe:

```ts
  it('bans the boot words out loud (2026-09-22)', () => {
    expect(LEX_SPOKEN_RULES).toMatch(/warming/);
    expect(LEX_SPOKEN_RULES).toMatch(/waking/);
  });
```

`tests/voice-top-layer.test.ts`:

```ts
  it('carries worked examples for every directive shape', () => {
    const p = buildTopLayerSystemPrompt();
    expect(p).toMatch(/Examples \(heard/);
    expect(p).toMatch(/CONTROL: drop_reply/);
    expect(p).toMatch(/CONTROL: combine/);
    expect(p).toMatch(/CONTROL: repeat/);
    expect(p).toMatch(/CONTROL: mute/);
    expect(p).toMatch(/IGNORE: background/);
    expect(p).not.toMatch(/still waking up/);
  });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run tests/persona.test.ts tests/voice-top-layer.test.ts`
Expected: FAIL on the new expectations only.

- [ ] **Step 3: Implement**

`persona.ts` rule: `- Out loud there is only one of you. Never say brain, layer, top, mid, session, model, deeper reasoning, warming or waking up; say "I". If you are not ready yet: "give me a second".`

`voice-top-layer.ts` CONTRACT: replace `say so once in the first person ("still waking up, go on"), keep talking, and still FORWARD; the daemon queues it.` with `say "give me a second, go on" once, keep talking, and still FORWARD; the daemon queues it.` Insert before the `If Michael speaks while a brain reply` paragraph:

```
Examples (heard -> your whole reply, directives on their own lines):
- "Lex, you there?" -> Here.
- "What's the worker doing?" with worker: live, thinking (dropship-01), last activity 12s ago -> Working. Thinking, last moved about twelve seconds ago.
- "What's the worker doing?" with worker: live (dropship-01) and nothing more -> I can't see that from here, checking.
  FORWARD: what is the worker doing right now
- "What's our goal on this project?" -> One moment, checking.
  FORWARD: what is the current goal of the project
- "No, forget that, do the migration first." (during_tts: yes) -> Right, migration first.
  CONTROL: drop_reply
  FORWARD: do the migration first, before the previous task
- "And make it idempotent." (same ask still queued) -> Idempotent, noted.
  CONTROL: combine
  FORWARD: make it idempotent
- "Say that again." -> CONTROL: repeat
- "Lex mute." -> Muted.
  CONTROL: mute
- The TV in the background, "...tonight at eleven..." -> IGNORE: background tv
```

- [ ] **Step 4: Run to verify they pass**

Run: `npx vitest run tests/persona.test.ts tests/voice-top-layer.test.ts tests/voice-top-layer-live-block.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add 07-daemon/src/voice/voice-top-layer.ts 07-daemon/src/lex/persona.ts 07-daemon/tests/persona.test.ts 07-daemon/tests/voice-top-layer.test.ts
git commit -m "feat(voice): worked examples in the Layer 1 contract; warming and waking banned out loud"
```
Body ends `Rebuild: yes`.

---

### Task 6: BUG-027, no default Layer 1 on attach

**Files:**
- Modify: `07-daemon/src/voice/lex-voice-ws.ts` (~2073-2088)
- Test: `07-daemon/tests/voice-haiku-wiring.test.ts` (append a source pin)

- [ ] **Step 1: Write the failing test**

```ts
import { readFileSync } from 'node:fs';
describe('attach does not spawn a default Layer 1 (BUG-027)', () => {
  it('the null prewarm is gone; the Open routes and the ask path own spawning', () => {
    const src = readFileSync(new URL('../src/voice/lex-voice-ws.ts', import.meta.url), 'utf-8');
    expect(src).not.toMatch(/prewarmVoiceBrainSession\(null\)/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/voice-haiku-wiring.test.ts`
Expected: FAIL on the new pin.

- [ ] **Step 3: Implement**

Replace the try/catch block at ~2079-2088 with:

```ts
  /* BUG-027 (2026-09-22): no prewarm here. The anchor Open routes spawn
   * the per-anchor Layer 1 first (routes.ts onPrepared), and askVoice
   * spawns on demand for a bind whose L1 died. The old null prewarm
   * warmed a shared "default" session that no ask ever used. */
```

Remove the `prewarmVoiceBrainSession` import if it becomes unused (check with `npx tsc --noEmit -p .`).

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/voice-haiku-wiring.test.ts && npx tsc --noEmit -p .`
Expected: PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add 07-daemon/src/voice/lex-voice-ws.ts 07-daemon/tests/voice-haiku-wiring.test.ts
git commit -m "fix(voice): no default Layer 1 on voice attach (BUG-027)"
```
Body ends `Rebuild: yes`.

---

### Task 7: Suite, trackers, spec, build

**Files:**
- Modify: `BUGS.md` (BUG-026 to BUG-030 -> SMOKE-TESTING, index and detail), `FIXES.md` (rows VL-10 to VL-15 under "2026-09-21/22 voice layers wave"), `docs/HANDOVER.md` (cursor), `docs/spec/LAYER-1-CONTROL.md` ("Boot order and warm" item 3: the warm definition; "The per-utterance turn": the word gate next to the emergency stop bullet; the live block example's worker line)

- [ ] **Step 1: Full daemon suite**

Run: `cd C:\dev\Projects\DevNeural\07-daemon && npx vitest run 2>&1 | tail -30`
Expected: only the two pre-existing reds (`grooming-routes` BUG-014, `sessions-anchor-liveness` environmental). Anything else red is this wave's and gets fixed before moving on.

- [ ] **Step 2: Build**

Run: `npm run build` in `07-daemon`. Expected: tsc clean, `dist/` mtimes fresh. The dashboard is untouched; no `out/` rebuild.

- [ ] **Step 3: Trackers and spec**

Flip the five bugs to SMOKE-TESTING in both blocks with `Fixed: 2026-09-22 (<sha>)`. FIXES.md rows in the wave table's format: `| VL-10 | L2 warm from the PTY | ✅ built | <sha> | ... **Rebuild:** yes |` and so on through VL-15. Spec edits as listed. HANDOVER cursor: "fix wave built, restart pending".

- [ ] **Step 4: Commit**

```bash
git add BUGS.md FIXES.md docs/HANDOVER.md docs/spec/LAYER-1-CONTROL.md
git commit -m "docs: voice fix wave trackers, spec warm definition and word gate"
```
Body ends `Rebuild: no`.

---

### Task 8: Restart and mechanical verify (operator authorised "complete all")

- [ ] **Step 1: Restart** `curl -s -X POST http://127.0.0.1:3747/admin/daemon/restart`, poll `/health` for a new pid.
- [ ] **Step 2: Open** `POST /lex/anchors/4bbafb48-bbfd-47e6-b076-e1a58a334303/open` and watch `daemon.log` for, in order: `[voice-brain] anchor=4bbafb48 spawned` with `cwd=C:/dev/data/skill-connections/voice-l1`, `[lex-anchor] reopen`, `warm: first reply`, then within ~40s `[voice-ws] L2 composer up after <N>s; brain idle` once a voice client attaches (the line comes from `midState()`, which runs per turn and per flush tick; without a client the latch fires on the first turn). No `anchor=default` line.
- [ ] **Step 3: Hand over** items 2 to 9 to the operator with the new log lines to expect: `control by word gate: mute` on "Lex mute", `L1 turn: ... forward=true ... warming=false` on a substantive ask, `forward to L2:`, then the delivery ask `ask replied ... chars=<n>`.
