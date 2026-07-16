/**
 * Dedicated persistent voice-brain session.
 *
 * Sibling of judge-session.ts (spec:
 * docs/superpowers/specs/2026-07-15-voice-top-layer-design.md, layer 1
 * "TOP"). The voice top layer needs fast turnaround on every spoken
 * exchange, and judge-session serializes ALL of its callers onto one
 * shared in-flight-ask queue: routing voice turns through it would
 * park an operator utterance behind however many classification asks
 * the supervisors have queued. So the voice brain gets its OWN
 * kept-open headless `claude` PTY session with its own session id,
 * its own ask queue, and its own liveness state, built on the same
 * machinery judge-session uses:
 *
 *   - lazy spawn on first ask via pty-host's spawnLex with a
 *     daemon-minted --session-id, so the transcript jsonl path is
 *     predictable up front (spawn-lex-session's transcriptPathFor,
 *     the 2026-07-08 deterministic-binding approach)
 *   - asks pasted through ptyInject with commit=true: body plus CR,
 *     and pty-host's own 1s bare-CR nudge (PTY_INJECT_COMMIT_NUDGE_MS)
 *     fires after every inject, so no extra nudge is needed here
 *   - replies read by tailing the session's
 *     ~/.claude/projects/<slug>/<sessionId>.jsonl from a stored byte
 *     offset, 200ms poll interval
 *   - never throws: null on disabled, unavailable, inject failure, or
 *     timeout, so the caller's fail-safe (FORWARD everything to Lex,
 *     an utterance is never eaten) always fires
 *   - two consecutive timed-out asks, or a PTY found dead externally,
 *     kill the session; respawn attempts are bounded to one per
 *     DEVNEURAL_VOICE_BRAIN_SESSION_RESPAWN_COOLDOWN_MS (default
 *     5 minutes) so a broken environment cannot hot-loop spawns
 *   - never idle-reaped: same Max-plan flat-rate rationale as
 *     judge-session, the session stays open indefinitely by design
 *
 * Phase 2 streaming: askVoice accepts an optional onPartial hook.
 * When provided, each assistant jsonl record's text is delivered to
 * onPartial as it lands (so the caller can start speaking before the
 * turn finishes), and the promise resolves with the full concatenated
 * text once a record carries message.stop_reason === 'end_turn'.
 * Without onPartial, the first text-bearing assistant record resolves
 * the ask, mirroring judge-session's single-record behavior.
 *
 * The speech-first contract, FORWARD/CONTROL trailing-line parsing,
 * persona and digest grounding all live in voice-top-layer.ts. This
 * module owns only the session lifecycle and the ask primitive; the
 * per-ask `system` field is a plain framing line the caller prepends
 * (same shape judge-session's askText takes).
 */
import { randomUUID as nodeRandomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import {
  spawnLex as ptySpawnLex,
  ptyInject as ptyHostInject,
  ptyKill as ptyHostKill,
  getPty as ptyHostGetPty,
} from '../dashboard/pty-host.js';
import { transcriptPathFor } from './spawn-lex-session.js';

export interface AskVoiceInput {
  /** Optional framing line prepended before the prompt (the top
   * layer's speech-first contract). Plain text; askVoice never parses
   * the reply. */
  system?: string;
  prompt: string;
  /** Per-ask hard timeout. Default: DEVNEURAL_VOICE_BRAIN_TIMEOUT_MS
   * (6000ms) when omitted. Voice asks are latency-sensitive, which is
   * why the default is deliberately tighter than judge-session's 10s:
   * past a few seconds the top layer's fail-safe (forward to Lex)
   * beats a stale spoken answer. */
  timeoutMs?: number;
  /** Phase 2 streaming hook. Called once per assistant jsonl record
   * with that record's text as it lands. When provided, the promise
   * resolves with the full concatenated text on stop_reason
   * 'end_turn'; when omitted, the first text-bearing record resolves
   * the ask. A throwing onPartial is logged and ignored. */
  onPartial?: (text: string) => void;
}

const DEFAULT_ASK_TIMEOUT_MS = 6_000;

/* Read per ask, not cached at module load, so a daemon that mutates
 * process.env (runtime_config reload) takes effect without a restart. */
function defaultAskTimeoutMs(): number {
  const raw = Number(process.env.DEVNEURAL_VOICE_BRAIN_TIMEOUT_MS ?? '');
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_ASK_TIMEOUT_MS;
}

/* Session-level contract, injected once at spawn via
 * --append-system-prompt. Deliberately thin: the top layer restates
 * its full speech-first contract (persona, digest grounding,
 * FORWARD/CONTROL trailing lines) inside every ask it sends, so the
 * session prompt only needs the ground rules that make a headless
 * utility session safe: no tools, no clarifying questions, every
 * message self-contained. */
export const VOICE_BRAIN_SESSION_SYSTEM_PROMPT = `You are a persistent, headless voice session for an autonomous coding daemon. Your reply text is converted directly to speech and played aloud, so answer in short, natural spoken prose with no markdown, no code fences, and no headings. There is no human at the keyboard: never use a tool, never ask a clarifying question, never refuse to answer, and never reference earlier messages in this session. Every incoming message is a fully self-contained, independent request that carries its own instructions; follow the instructions inside the message you just received.`;

function buildVoiceQuestion(system: string | undefined, prompt: string): string {
  return system ? `${system}\n\n${prompt}` : prompt;
}

/* Set true only by _setVoiceBrainSessionDepsForTests(overrides) with a
 * non-null argument. Same safety backstop as judge-session: under
 * Vitest (process.env.VITEST is set for every worker) the session
 * stays disabled unless a test explicitly wired fake deps, so no test
 * file that merely calls into a voice call site can ever launch a real
 * `claude --dangerously-skip-permissions` subprocess. */
let depsOverridden = false;

export function isVoiceBrainSessionEnabled(): boolean {
  if (process.env.DEVNEURAL_VOICE_BRAIN_SESSION === '0') return false;
  if (process.env.VITEST && !depsOverridden) return false;
  return true;
}

/* ---------------------------------------------------------------- *
 * Dependency injection surface. Production wires the real pty-host /
 * fs / crypto primitives via defaultDeps(); tests replace every seam
 * via _setVoiceBrainSessionDepsForTests so no real `claude` process is
 * ever spawned in the suite. Shape-identical to JudgeSessionDeps but
 * declared independently: the two sessions must never share state or
 * grow a compile-time coupling that tempts them to.
 * ---------------------------------------------------------------- */

export interface VoiceBrainSessionDeps {
  spawnLex: (opts: {
    cwd: string;
    systemPrompt?: string;
    args?: string[];
    sessionId?: string;
  }) => { ptyId: string; pid: number };
  ptyInject: (
    ptyId: string,
    text: string,
    commit?: boolean,
  ) => { ok: true } | { ok: false; error: string };
  ptyKill: (ptyId: string) => boolean;
  getPty: (ptyId: string) => { exited: boolean } | undefined;
  statSync: (path: string) => { size: number };
  readRange: (path: string, start: number, length: number) => string;
  now: () => number;
  randomUUID: () => string;
  sleep: (ms: number) => Promise<void>;
  log: (msg: string) => void;
  cwd: string;
  homeDir: string;
  pollIntervalMs: number;
  respawnCooldownMs: number;
}

function defaultReadRange(path: string, start: number, length: number): string {
  const fd = fs.openSync(path, 'r');
  try {
    const buf = Buffer.alloc(length);
    fs.readSync(fd, buf, 0, length, start);
    return buf.toString('utf-8');
  } finally {
    fs.closeSync(fd);
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof (t as { unref?: () => void }).unref === 'function') {
      (t as { unref: () => void }).unref();
    }
  });
}

function defaultDeps(): VoiceBrainSessionDeps {
  return {
    spawnLex: ptySpawnLex,
    ptyInject: ptyHostInject,
    ptyKill: ptyHostKill,
    getPty: ptyHostGetPty,
    statSync: (p) => fs.statSync(p),
    readRange: defaultReadRange,
    now: () => Date.now(),
    randomUUID: () => nodeRandomUUID(),
    sleep: defaultSleep,
    log: () => undefined,
    cwd: process.env.DEVNEURAL_VOICE_BRAIN_SESSION_CWD ?? process.cwd(),
    homeDir: os.homedir(),
    pollIntervalMs: 200,
    respawnCooldownMs: Number(
      process.env.DEVNEURAL_VOICE_BRAIN_SESSION_RESPAWN_COOLDOWN_MS ?? 5 * 60 * 1000,
    ),
  };
}

let deps: VoiceBrainSessionDeps = defaultDeps();

/* Mirrors setJudgeSessionLogger. Defaults to a no-op so standalone
 * imports never crash; daemon.ts routes lifecycle events into
 * daemon.log by calling this at startup. */
export function setVoiceBrainSessionLogger(log: (msg: string) => void): void {
  deps.log = log;
}

/* ---------------------------------------------------------------- *
 * Session state.
 * ---------------------------------------------------------------- */

interface VoiceBrainSessionState {
  ptyId: string | null;
  ccSessionId: string | null;
  jsonlPath: string | null;
  consecutiveTimeouts: number;
  lastSpawnAttemptAt: number;
}

function initialState(): VoiceBrainSessionState {
  return {
    ptyId: null,
    ccSessionId: null,
    jsonlPath: null,
    consecutiveTimeouts: 0,
    /* -Infinity, not 0: a clock value of exactly 0 is a legitimate
     * first-attempt timestamp (virtual clocks in tests start there),
     * so 0 cannot double as the "never attempted" sentinel. -Infinity
     * makes the cooldown delta resolve to Infinity for a session that
     * has never attempted a spawn, clearing the gate with no separate
     * boolean flag. */
    lastSpawnAttemptAt: -Infinity,
  };
}

let state: VoiceBrainSessionState = initialState();

/* Kill the current PTY (best-effort) and clear all session identity so
 * the next ask attempts a fresh spawn, subject to the respawn cooldown
 * gate in ensureSpawned. Used both for the "PTY died externally" path
 * and the "two consecutive timeouts" liveness trigger. */
function killCurrent(reason: string): void {
  if (state.ptyId) {
    deps.log(`[voice-brain] killing session ptyId=${state.ptyId} reason=${reason}`);
    try {
      deps.ptyKill(state.ptyId);
    } catch (err) {
      deps.log(`[voice-brain] ptyKill threw (ignored): ${(err as Error).message}`);
    }
  }
  state.ptyId = null;
  state.ccSessionId = null;
  state.jsonlPath = null;
  state.consecutiveTimeouts = 0;
}

/* Ensure a live voice-brain session exists, spawning (or respawning)
 * one if needed. Returns false when no session is available right now;
 * the caller resolves its ask to null in that case. */
function ensureSpawned(): boolean {
  if (state.ptyId) {
    const handle = deps.getPty(state.ptyId);
    if (handle && !handle.exited) return true;
    deps.log(`[voice-brain] pty died externally ptyId=${state.ptyId}`);
    killCurrent('exited');
  }

  const now = deps.now();
  if (now - state.lastSpawnAttemptAt < deps.respawnCooldownMs) {
    deps.log(
      `[voice-brain] spawn suppressed: cooldown active (${deps.respawnCooldownMs}ms window, last attempt ${now - state.lastSpawnAttemptAt}ms ago)`,
    );
    return false;
  }
  state.lastSpawnAttemptAt = now;

  const ccSessionId = deps.randomUUID();
  const jsonlPath = transcriptPathFor({
    cwd: deps.cwd,
    ccSessionId,
    homeDir: deps.homeDir,
  });
  try {
    const spawned = deps.spawnLex({
      cwd: deps.cwd,
      systemPrompt: VOICE_BRAIN_SESSION_SYSTEM_PROMPT,
      args: ['--session-id', ccSessionId, '--dangerously-skip-permissions'],
      sessionId: ccSessionId,
    });
    state.ptyId = spawned.ptyId;
    state.ccSessionId = ccSessionId;
    state.jsonlPath = jsonlPath;
    state.consecutiveTimeouts = 0;
    deps.log(
      `[voice-brain] spawned ptyId=${spawned.ptyId} pid=${spawned.pid} ccSessionId=${ccSessionId.slice(0, 8)} cwd=${deps.cwd}`,
    );
    return true;
  } catch (err) {
    deps.log(`[voice-brain] spawn failed: ${(err as Error).message}`);
    return false;
  }
}

function handleTimeout(): void {
  state.consecutiveTimeouts += 1;
  deps.log(
    `[voice-brain] ask timed out; session marked suspect (consecutive_timeouts=${state.consecutiveTimeouts})`,
  );
  if (state.consecutiveTimeouts >= 2) {
    deps.log('[voice-brain] two consecutive timeouts; killing session for respawn');
    killCurrent('two-consecutive-timeouts');
  }
}

function extractAssistantText(rec: Record<string, unknown>): string | null {
  if (rec.type !== 'assistant') return null;
  const message = rec.message as
    | { content?: Array<{ type?: string; text?: string }> }
    | undefined;
  if (!message?.content) return null;
  const text = message.content
    .filter((c) => c?.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text as string)
    .join('\n')
    .trim();
  return text || null;
}

/* stop_reason lives on the nested message object, same place
 * replay-pty.ts and select-tts-content.ts read it. Checked separately
 * from text extraction because an end_turn record may carry no text
 * blocks at all and must still close the streaming ask. */
function assistantStopReason(rec: Record<string, unknown>): string | null {
  if (rec.type !== 'assistant') return null;
  const message = rec.message as { stop_reason?: unknown } | undefined;
  return typeof message?.stop_reason === 'string' ? message.stop_reason : null;
}

/* Tail the session jsonl from startOffset until an answer or the
 * deadline. Two modes:
 *
 *   - onPartial absent: resolve on the FIRST text-bearing assistant
 *     record, exactly like judge-session's waitForAssistantReply.
 *   - onPartial present: deliver each record's text to onPartial as it
 *     lands, accumulate, and resolve with the concatenation when a
 *     record carries stop_reason 'end_turn'.
 */
async function waitForVoiceReply(
  jsonlPath: string,
  startOffset: number,
  deadline: number,
  onPartial: ((text: string) => void) | undefined,
): Promise<{ timedOut: true } | { timedOut: false; text: string }> {
  let offset = startOffset;
  const parts: string[] = [];
  for (;;) {
    let stat: { size: number } | null;
    try {
      stat = deps.statSync(jsonlPath);
    } catch {
      stat = null;
    }
    if (stat && stat.size > offset) {
      const chunk = deps.readRange(jsonlPath, offset, stat.size - offset);
      offset = stat.size;
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
        if (text) {
          parts.push(text);
          try {
            onPartial(text);
          } catch (err) {
            deps.log(
              `[voice-brain] onPartial threw (ignored): ${(err as Error).message}`,
            );
          }
        }
        if (assistantStopReason(rec) === 'end_turn') {
          return { timedOut: false, text: parts.join('\n') };
        }
      }
    }
    const remaining = deadline - deps.now();
    if (remaining <= 0) return { timedOut: true };
    await deps.sleep(Math.min(deps.pollIntervalMs, remaining));
  }
}

/* The ask primitive: enable-flag check, lazy spawn, inject,
 * tail-and-wait, liveness bookkeeping. Returns the trimmed reply text
 * or null on any failure. Callers reach it through the queue in
 * askVoice, never directly. */
async function askVoiceInner(input: AskVoiceInput): Promise<string | null> {
  if (!isVoiceBrainSessionEnabled()) return null;
  const timeoutMs = input.timeoutMs ?? defaultAskTimeoutMs();
  const question = buildVoiceQuestion(input.system, input.prompt);
  const deadline = deps.now() + timeoutMs;

  if (!ensureSpawned()) return null;
  const ptyId = state.ptyId!;
  const jsonlPath = state.jsonlPath!;

  let sinceOffset = 0;
  try {
    sinceOffset = deps.statSync(jsonlPath).size;
  } catch {
    sinceOffset = 0;
  }

  const inject = deps.ptyInject(ptyId, question, true);
  if (!inject.ok) {
    deps.log(`[voice-brain] inject failed ptyId=${ptyId}: ${inject.error}`);
    killCurrent('inject-failed');
    return null;
  }

  const result = await waitForVoiceReply(jsonlPath, sinceOffset, deadline, input.onPartial);
  if (result.timedOut) {
    handleTimeout();
    return null;
  }
  /* A reply landed: the session is alive and responsive. Reset the
   * failure streak. */
  state.consecutiveTimeouts = 0;
  /* A degenerate end_turn with zero text blocks concatenates to the
   * empty string; the top layer treats that the same as no answer, so
   * normalize it to null here (the null path is what triggers the
   * fail-safe forward). */
  const text = result.text.trim();
  return text || null;
}

/* ---------------------------------------------------------------- *
 * Serialization: one in-flight voice ask at a time, since all asks
 * share the one PTY's stdin/stdout. This queue is PRIVATE to the
 * voice-brain session; judge-session asks run on their own queue and
 * their own PTY, so a backed-up judge never delays a voice turn.
 * ---------------------------------------------------------------- */

let queueTail: Promise<void> = Promise.resolve();

function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const run = (): Promise<T> => fn();
  const resultPromise = queueTail.then(run, run);
  queueTail = resultPromise.then(
    () => undefined,
    () => undefined,
  );
  return resultPromise;
}

/**
 * Single-turn ask against the dedicated voice-brain session. Returns
 * the trimmed assistant reply text, or null on disabled, unavailable,
 * or timeout. Never throws; on null the caller's fail-safe (forward
 * the utterance to Lex) fires unchanged.
 */
export function askVoice(input: AskVoiceInput): Promise<string | null> {
  return enqueue(() => askVoiceInner(input)).catch((err) => {
    deps.log(
      `[voice-brain] askVoice threw (treated as unavailable): ${(err as Error).message}`,
    );
    return null;
  });
}

/* ---------------------------------------------------------------- *
 * Test seams. Production code should never call these.
 * ---------------------------------------------------------------- */

export function _setVoiceBrainSessionDepsForTests(
  overrides: Partial<VoiceBrainSessionDeps> | null,
): void {
  deps = overrides ? { ...defaultDeps(), ...overrides } : defaultDeps();
  depsOverridden = overrides !== null;
}

export function _resetVoiceBrainSessionStateForTests(): void {
  state = initialState();
  queueTail = Promise.resolve();
}

export function _voiceBrainSessionSnapshotForTests(): Readonly<VoiceBrainSessionState> {
  return { ...state };
}
