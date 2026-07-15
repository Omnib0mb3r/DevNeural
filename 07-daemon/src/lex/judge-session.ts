/**
 * Persistent Max-plan judge session.
 *
 * Operator directive (2026-07-15, verbatim intent): "keep the child
 * sessions open as needed, I'm not paying every time, talking to Lex
 * already works this way, you don't close the session each time."
 * Today's async judges (classifySupersede in expectation-supervisor.ts,
 * judgeInjectionUse in reinforcement/inject-verdict.ts, the alignment
 * judge inside evaluateExpectation) route through callVoiceChat /
 * callValidated against ollama (or, off this codebase's BF-4 path, the
 * metered anthropic API). A Claude Max subscription already pays a
 * flat rate for however many Claude Code turns the operator's own
 * login can drive, so ONE kept-open, headless `claude` PTY session
 * dedicated to answering short questions costs nothing marginal beyond
 * the fixed subscription -- exactly like the persistent Lex brainstorm
 * PTY does. This module is a singleton coordinator for that session.
 *
 * Two entry points share the one session:
 *   - askJudge({kind, prompt, timeoutMs}): strict-JSON classification.
 *     The JSON schema for `kind` is embedded in the per-ask injected
 *     text (buildJudgeQuestion), NOT baked into the session's system
 *     prompt -- the system prompt only says "match your reply's format
 *     to the tag on the message." That keeps the session generic
 *     enough for askText to share it without contradicting a "you only
 *     ever produce JSON" instruction.
 *   - askText({system?, prompt, timeoutMs}): a plain natural-language
 *     single-turn reply, trimmed, no JSON parsing. Intended for the
 *     voice layer (a future wiring, out of this module's scope) to
 *     generate greetings/small-talk on the Max-plan session instead of
 *     a metered Haiku call.
 *
 * Both entry points:
 *   - lazy-spawn the session on first use (spawnJudgeSession via
 *     ensureSpawned)
 *   - serialize onto ONE shared in-flight-ask queue -- a second caller
 *     (whether askJudge or askText) queues behind whichever ask is
 *     already running, because both share the one PTY's stdin/stdout
 *   - respect DEVNEURAL_JUDGE_SESSION=0 as the escape hatch (default
 *     ON per the operator directive); when off, both resolve null
 *     immediately without touching the PTY layer at all
 *   - resolve null on timeout, spawn failure, or a dead session, so
 *     every call site's existing fallback (ollama / callValidated)
 *     fires unchanged
 *   - share the same liveness/respawn bookkeeping: the PTY dying, or
 *     two consecutive timed-out asks, triggers a kill + respawn,
 *     bounded to at most one respawn per
 *     DEVNEURAL_JUDGE_SESSION_RESPAWN_COOLDOWN_MS (default 5 min) so a
 *     broken environment (missing `claude` binary, expired auth, etc.)
 *     cannot hot-loop spawn attempts.
 *   - never idle-reap. The session stays open indefinitely by design;
 *     the operator's directive is explicit that closing it defeats the
 *     entire point.
 *
 * NOT for the curator vet gate (curation/curator.ts's vetCandidate).
 * That gate runs synchronously inside an 800ms in-hook budget --
 * nowhere near enough for a real Claude Code turn round-trip, even on
 * a warm persistent session. Do not route it through here.
 *
 * Reuses pty-host's spawnLex / ptyInject / ptyKill / getPty exports
 * (pty-host.ts is read-only for this module) and spawn-lex-session.ts's
 * pure transcriptPathFor helper to predict the jsonl path from a
 * daemon-minted `--session-id`, the same deterministic-binding
 * approach spawn-lex-session.ts uses for real Lex anchors (2026-07-08
 * cross-bind fix). Unlike a Lex anchor, the judge session never
 * touches lex_session_store or brainstorm_store: it is an internal
 * daemon utility session, never surfaced on a dashboard, so spawnLex is
 * called directly rather than routing through spawnLexSession's
 * DB-backed anchor machinery. spawnLex already spawns a non-Lex prompt
 * session as-is -- skipLegacyBrainstormRegister: true short-circuits
 * the isBrainstormCwd branch regardless of cwd, and spawnLex's own
 * sanitizeClaudeSpawnEnv already strips ANTHROPIC_API_KEY internally
 * on every spawn -- so no pty-host change was needed for this module.
 *
 * Replies are read the same way the voice pipeline (lex-voice-ws.ts's
 * pollJsonl) and the replay harness (lex/replay-pty.ts) do: tail the
 * session's jsonl from a stored byte offset, parse each new line as
 * JSON, and take the first assistant record's text content as the
 * answer.
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

export type JudgeKind = 'supersede' | 'inject_verdict' | 'alignment';

export interface AskJudgeInput {
  kind: JudgeKind;
  /** The question body. The strict-JSON schema for `kind` is prepended
   * automatically (see buildJudgeQuestion); callers supply only the
   * substance of the question. */
  prompt: string;
  /** Per-ask hard timeout. Default DEFAULT_ASK_TIMEOUT_MS (10s) when
   * omitted. Callers on a fire-and-forget path (all three today's
   * judges are) should pass a generous value -- there is no metered
   * cost to a slow answer on the Max-plan session, only latency. */
  timeoutMs?: number;
}

export interface AskTextInput {
  /** Optional framing line prepended before the prompt (e.g. "Reply in
   * one short sentence, Jarvis voice, no punctuation drama."). Plain
   * text, not a JSON schema -- askText never parses the reply. */
  system?: string;
  prompt: string;
  timeoutMs?: number;
}

const DEFAULT_ASK_TIMEOUT_MS = 10_000;

/* Session-level contract, injected once at spawn via
 * --append-system-prompt. Deliberately generic: it does NOT forbid
 * natural-language replies, because askText shares this same session.
 * Each individual ask states its own required format (buildJudgeQuestion
 * embeds the JSON schema; buildTextQuestion just carries the prompt) so
 * the session-level prompt only needs to teach the daemon's two message
 * tags and the ground rules that apply to both. */
export const JUDGE_SESSION_SYSTEM_PROMPT = `You are a persistent, headless utility session for an autonomous coding daemon. There is no human at the keyboard: never use a tool, never ask a clarifying question, never refuse to answer, and never reference earlier messages in this session -- every incoming message is a fully self-contained, independent request.

Two kinds of message arrive here, distinguished by the tag at the start of the message:

[judge:<kind>] -- a strict classification question. The message itself states the exact JSON shape required and the tie-break to use when uncertain. Reply with EXACTLY one JSON object and nothing else: no markdown code fences, no leading or trailing text, no explanation.

[text] -- a natural-language request (for example, drafting a short spoken reply). Answer directly and concisely in plain prose. Do not wrap the answer in JSON, quotes, or a preamble like "Sure, here is...".

Always match your reply's format to the tag on the message you just received, not to any earlier message.`;

function schemaForKind(kind: JudgeKind): string {
  switch (kind) {
    case 'supersede':
      return '{"verdict":"contradicts"} or {"verdict":"independent"} -- tie-break when uncertain: "independent".';
    case 'inject_verdict':
      return '{"verdict":"used","reason":"one short sentence"} or {"verdict":"ignored","reason":"one short sentence"} -- tie-break when uncertain: "ignored".';
    case 'alignment':
      return '{"aligned":true|false,"alignment_score":0.0-1.0,"drift_summary":"one short sentence, empty string when aligned","suggested_correction":"one short sentence, empty string when aligned"} -- tie-break when uncertain: aligned=true with a mid-range alignment_score.';
  }
}

function buildJudgeQuestion(kind: JudgeKind, prompt: string): string {
  return `[judge:${kind}] Respond with STRICT JSON ONLY: one line, no markdown code fences, no prose before or after, no tool calls. Required reply shape:\n${schemaForKind(kind)}\n\n${prompt}`;
}

function buildTextQuestion(system: string | undefined, prompt: string): string {
  const header = system ? `[text] ${system}` : '[text]';
  return `${header}\n\n${prompt}`;
}

/* Set true only by _setJudgeSessionDepsForTests(overrides) with a
 * non-null argument -- i.e. a test that explicitly wired fake pty/fs
 * deps and wants to exercise the real ask/spawn/liveness logic against
 * them (tests/judge-session.test.ts). Everything else under Vitest
 * gets isJudgeSessionEnabled()===false, see the guard below. */
let depsOverridden = false;

export function isJudgeSessionEnabled(): boolean {
  if (process.env.DEVNEURAL_JUDGE_SESSION === '0') return false;
  /* Safety backstop for the test suite. Vitest sets process.env.VITEST
   * for every worker it runs. Discovered the hard way: the moment
   * classifySupersede / judgeInjectionUse / evaluateExpectation were
   * wired through askJudge, three PRE-EXISTING test files that never
   * heard of this module (none mock it) started timing out -- they
   * were hitting ensureSpawned's real spawnLex and actually launching
   * `claude --dangerously-skip-permissions` subprocesses from inside
   * the test run. Requiring an explicit _setJudgeSessionDepsForTests
   * call to re-enable this path under Vitest means every OTHER test in
   * the suite (existing or future) that merely calls into one of the
   * three judge call sites gets a safe, instant null instead of a real
   * spawn, with no per-file mocking required. */
  if (process.env.VITEST && !depsOverridden) return false;
  return true;
}

/* ---------------------------------------------------------------- *
 * Dependency injection surface. Production wires the real pty-host /
 * fs / crypto primitives via defaultDeps(); tests replace every seam
 * via _setJudgeSessionDepsForTests so no real `claude` process is ever
 * spawned in the suite.
 * ---------------------------------------------------------------- */

export interface JudgeSessionDeps {
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

function defaultDeps(): JudgeSessionDeps {
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
    cwd: process.env.DEVNEURAL_JUDGE_SESSION_CWD ?? process.cwd(),
    homeDir: os.homedir(),
    pollIntervalMs: 200,
    respawnCooldownMs: Number(
      process.env.DEVNEURAL_JUDGE_SESSION_RESPAWN_COOLDOWN_MS ?? 5 * 60 * 1000,
    ),
  };
}

let deps: JudgeSessionDeps = defaultDeps();

/* Mirrors pty-host's setPtyHostLogger / voice-ws's setVoiceWsLogger
 * pattern. Defaults to a no-op so standalone imports (tests, scripts)
 * never crash; daemon.ts must call this at startup to route lifecycle
 * events into daemon.log (out of this module's ownership -- see the
 * return summary for the one-line wiring daemon.ts still needs). */
export function setJudgeSessionLogger(log: (msg: string) => void): void {
  deps.log = log;
}

/* ---------------------------------------------------------------- *
 * Session state.
 * ---------------------------------------------------------------- */

interface JudgeSessionState {
  ptyId: string | null;
  ccSessionId: string | null;
  jsonlPath: string | null;
  consecutiveTimeouts: number;
  lastSpawnAttemptAt: number;
}

function initialState(): JudgeSessionState {
  return {
    ptyId: null,
    ccSessionId: null,
    jsonlPath: null,
    consecutiveTimeouts: 0,
    /* -Infinity, not 0: a real (or virtual, in tests) clock value of
     * exactly 0 is a legitimate first-attempt timestamp, so 0 cannot
     * double as the "never attempted" sentinel without colliding with
     * it. -Infinity makes `now - lastSpawnAttemptAt` always resolve to
     * Infinity for a session that has never attempted a spawn, which
     * naturally clears the cooldown check below with no separate
     * boolean flag needed. */
    lastSpawnAttemptAt: -Infinity,
  };
}

let state: JudgeSessionState = initialState();

/* Kill the current PTY (best-effort) and clear all session identity so
 * the next ask attempts a fresh spawn, subject to the respawn cooldown
 * gate in ensureSpawned. Used both for the "PTY died externally" path
 * and the "two consecutive timeouts" liveness trigger. */
function killCurrent(reason: string): void {
  if (state.ptyId) {
    deps.log(`[judge-session] killing session ptyId=${state.ptyId} reason=${reason}`);
    try {
      deps.ptyKill(state.ptyId);
    } catch (err) {
      deps.log(`[judge-session] ptyKill threw (ignored): ${(err as Error).message}`);
    }
  }
  state.ptyId = null;
  state.ccSessionId = null;
  state.jsonlPath = null;
  state.consecutiveTimeouts = 0;
}

/* Ensure a live judge session exists, spawning (or respawning) one if
 * needed. Returns false when no session is available right now -- the
 * caller resolves its ask to null in that case. */
function ensureSpawned(): boolean {
  if (state.ptyId) {
    const handle = deps.getPty(state.ptyId);
    if (handle && !handle.exited) return true;
    deps.log(`[judge-session] pty died externally ptyId=${state.ptyId}`);
    killCurrent('exited');
  }

  const now = deps.now();
  if (now - state.lastSpawnAttemptAt < deps.respawnCooldownMs) {
    deps.log(
      `[judge-session] spawn suppressed: cooldown active (${deps.respawnCooldownMs}ms window, last attempt ${now - state.lastSpawnAttemptAt}ms ago)`,
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
      systemPrompt: JUDGE_SESSION_SYSTEM_PROMPT,
      args: ['--session-id', ccSessionId, '--dangerously-skip-permissions'],
      sessionId: ccSessionId,
    });
    state.ptyId = spawned.ptyId;
    state.ccSessionId = ccSessionId;
    state.jsonlPath = jsonlPath;
    state.consecutiveTimeouts = 0;
    deps.log(
      `[judge-session] spawned ptyId=${spawned.ptyId} pid=${spawned.pid} ccSessionId=${ccSessionId.slice(0, 8)} cwd=${deps.cwd}`,
    );
    return true;
  } catch (err) {
    deps.log(`[judge-session] spawn failed: ${(err as Error).message}`);
    return false;
  }
}

function handleTimeout(): void {
  state.consecutiveTimeouts += 1;
  deps.log(
    `[judge-session] ask timed out; session marked suspect (consecutive_timeouts=${state.consecutiveTimeouts})`,
  );
  if (state.consecutiveTimeouts >= 2) {
    deps.log('[judge-session] two consecutive timeouts; killing session for respawn');
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

async function waitForAssistantReply(
  jsonlPath: string,
  startOffset: number,
  deadline: number,
): Promise<{ timedOut: true } | { timedOut: false; text: string }> {
  let offset = startOffset;
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
        if (text) return { timedOut: false, text };
      }
    }
    const remaining = deadline - deps.now();
    if (remaining <= 0) return { timedOut: true };
    await deps.sleep(Math.min(deps.pollIntervalMs, remaining));
  }
}

/* Shared ask primitive behind both askJudge and askText: enable-flag
 * check, lazy spawn, inject, tail-and-wait, liveness bookkeeping.
 * Returns the raw assistant text (untrimmed beyond what
 * extractAssistantText already trims) or null on any failure. Never
 * throws. */
async function askRawInner(question: string, timeoutMs: number): Promise<string | null> {
  if (!isJudgeSessionEnabled()) return null;
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
    deps.log(`[judge-session] inject failed ptyId=${ptyId}: ${inject.error}`);
    killCurrent('inject-failed');
    return null;
  }

  const result = await waitForAssistantReply(jsonlPath, sinceOffset, deadline);
  if (result.timedOut) {
    handleTimeout();
    return null;
  }
  /* A reply landed: the session is alive and responsive, whatever its
   * content. Reset the failure streak. */
  state.consecutiveTimeouts = 0;
  return result.text;
}

async function askJudgeInner(input: AskJudgeInput): Promise<unknown | null> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_ASK_TIMEOUT_MS;
  const question = buildJudgeQuestion(input.kind, input.prompt);
  const text = await askRawInner(question, timeoutMs);
  if (text === null) return null;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    deps.log(`[judge-session] reply had no JSON object kind=${input.kind}: ${text.slice(0, 200)}`);
    return null;
  }
  try {
    return JSON.parse(match[0]);
  } catch (err) {
    deps.log(
      `[judge-session] JSON parse failed kind=${input.kind}: ${(err as Error).message}`,
    );
    return null;
  }
}

async function askTextInner(input: AskTextInput): Promise<string | null> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_ASK_TIMEOUT_MS;
  const question = buildTextQuestion(input.system, input.prompt);
  const text = await askRawInner(question, timeoutMs);
  return text === null ? null : text.trim();
}

/* ---------------------------------------------------------------- *
 * Serialization: one in-flight ask at a time across BOTH askJudge and
 * askText, since they share the one PTY's stdin/stdout. A second call
 * (of either kind) queues behind whichever ask is already running.
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
 * Strict-JSON classification ask. Prefer this from any judge call
 * site; on null (disabled, unavailable, timeout, or malformed reply)
 * fall back to the site's existing provider path unchanged.
 */
export function askJudge(input: AskJudgeInput): Promise<unknown | null> {
  return enqueue(() => askJudgeInner(input)).catch((err) => {
    deps.log(`[judge-session] askJudge threw (treated as unavailable): ${(err as Error).message}`);
    return null;
  });
}

/**
 * Natural-language single-turn ask. Returns the trimmed assistant
 * reply text, or null on any failure (same fallback contract as
 * askJudge).
 */
export function askText(input: AskTextInput): Promise<string | null> {
  return enqueue(() => askTextInner(input)).catch((err) => {
    deps.log(`[judge-session] askText threw (treated as unavailable): ${(err as Error).message}`);
    return null;
  });
}

/* ---------------------------------------------------------------- *
 * Test seams. Production code should never call these.
 * ---------------------------------------------------------------- */

export function _setJudgeSessionDepsForTests(
  overrides: Partial<JudgeSessionDeps> | null,
): void {
  deps = overrides ? { ...defaultDeps(), ...overrides } : defaultDeps();
  depsOverridden = overrides !== null;
}

export function _resetJudgeSessionStateForTests(): void {
  state = initialState();
  queueTail = Promise.resolve();
}

export function _judgeSessionSnapshotForTests(): Readonly<JudgeSessionState> {
  return { ...state };
}
