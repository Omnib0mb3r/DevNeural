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
 *   - never throws: null on disabled, unavailable, warming, inject
 *     failure, or timeout, so the caller's fail-safe (FORWARD
 *     everything to Lex, an utterance is never eaten) always fires
 *   - warmup gate (2026-07-16): a fresh spawn accepts NO asks until a
 *     boot-time probe has seen a real assistant reply. Pre-fix the
 *     tight ask timeouts could never cover claude's 4-20s interactive
 *     boot, so the first two asks after any lazy spawn timed out, the
 *     liveness rule killed the booting session (the 0xC000013A
 *     pty-host exits in the 2026-07-16 smoke-test log), and the
 *     cooldown then nulled every ask for its whole window - the
 *     session never answered a single ask all night
 *   - two consecutive timed-out asks on a WARM session, or a PTY
 *     found dead externally, kill the session; respawn attempts are
 *     bounded to one per
 *     DEVNEURAL_VOICE_BRAIN_SESSION_RESPAWN_COOLDOWN_MS (default 60s)
 *     so a broken environment cannot hot-loop spawns
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

/* Bounds time-to-first-SIGNAL, not total reply time (2026-07-17
 * signal-based liveness): once the session shows any life (jsonl
 * growth / pty output) the effective deadline extends by the quiet
 * window up to the wall, so a 6-7s slow-but-generating ask no longer
 * returns chars=0 and produces a silent turn. */
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
    /* 2026-07-16 smoke-test fix 2/3: default was 5 minutes, which
     * turned any session kill into 5 minutes of total voice silence
     * (every ask nulls instantly during cooldown). With the warmup
     * gate below, a genuinely broken environment costs one bounded
     * warmup attempt per window instead of a hot-loop, so the window
     * can be short. Env override unchanged. */
    respawnCooldownMs: Number(
      process.env.DEVNEURAL_VOICE_BRAIN_SESSION_RESPAWN_COOLDOWN_MS ?? 60_000,
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
  /* Warmup gate (2026-07-16 smoke-test fix 2/3). An interactive
   * claude takes 4-20s to boot; the tight per-ask timeouts (3-6s) can
   * never cover that, so pre-fix the first two asks after a lazy
   * spawn ALWAYS timed out, the two-strike liveness rule killed the
   * booting session (the 0xC000013A pty-host exits in the smoke-test
   * log ARE those kills), and the respawn cooldown then nulled every
   * ask for its whole window. Net effect observed live: the session
   * never answered a single ask all night; speech=null on every turn,
   * zero heartbeats, delivery always on raw fallback. `warm` flips
   * true only once the warmup probe has seen a real assistant reply;
   * asks made before that return null immediately WITHOUT injecting
   * (nothing lands in a booting composer, nothing counts as a
   * timeout). */
  warm: boolean;
  warmupRunning: boolean;
  spawnedAt: number;
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
    warm: false,
    warmupRunning: false,
    spawnedAt: 0,
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
  state.warm = false;
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
    state.warm = false;
    state.spawnedAt = deps.now();
    deps.log(
      `[voice-brain] spawned ptyId=${spawned.ptyId} pid=${spawned.pid} ccSessionId=${ccSessionId.slice(0, 8)} cwd=${deps.cwd}; warmup starting`,
    );
    warmupPromise = runWarmup(spawned.ptyId).catch((err) => {
      deps.log(
        `[voice-brain] WARMUP FAILED: warmup threw: ${(err as Error).message}`,
      );
      killCurrent('warmup-threw');
    });
    return true;
  } catch (err) {
    deps.log(`[voice-brain] spawn FAILED: ${(err as Error).message}`);
    return false;
  }
}

/* Warmup probe timings. The boot delay covers claude's TUI coming up
 * before anything is pasted (text pasted into a booting TUI sits in
 * the composer while boot overlays eat the committing CR - observed
 * live 2026-07-16: the first ask's text committed 25 SECONDS late,
 * when a later ask's CR finally pushed it through). The two early
 * bare CRs mirror seedFirstTurn's banner pre-dismiss. The re-nudge
 * interval keeps firing idempotent bare CRs so a probe whose commit
 * CR was eaten by a late overlay still submits. */
const WARMUP_BOOT_DELAY_MS = 3_000;
const WARMUP_RENUDGE_MS = 5_000;
/* 2026-07-17 incident (13:25Z, first spawn after a daemon restart
 * storm): a probe injected 3s after spawn landed in the pre-paint
 * cooked->raw ConPTY window and was swallowed WHOLESALE - it never
 * reached the composer at all (terminal ring showed the composer
 * rendering empty), so the bare-CR re-nudges no-opped for 4.5 minutes
 * and the warmup died with no jsonl ever written. Bare CRs cannot
 * resurrect text that never buffered, so while the jsonl has never
 * grown (a committed probe writes its user record immediately) the
 * FULL probe is re-sent on this cadence. If the first probe DID
 * survive in the composer, the re-sent text appends to it and the
 * commit CR submits one garbled turn - harmless, since any assistant
 * reply warms the session. */
const WARMUP_REPROBE_MS = 15_000;
const WARMUP_PROBE_TEXT = 'Warmup check. Reply with exactly: OK';
/* 90s, not 45s (2026-07-16 failure 1): a healthy boot on this box
 * measured 27s (04:29:38Z spawn -> 04:30:05Z first reply) and the
 * respawn under load blew straight through 45s and got killed. The
 * probe reply is the ONLY thing this timer bounds, so generous is
 * cheap; a genuinely dead spawn still dies, just 45s later. */
const DEFAULT_WARMUP_TIMEOUT_MS = 90_000;

/* In-flight warmup, exposed to tests so the background boot can be
 * driven to completion deterministically on the virtual clock. */
let warmupPromise: Promise<void> | null = null;

function warmupTimeoutMs(): number {
  const raw = Number(process.env.DEVNEURAL_VOICE_BRAIN_WARMUP_TIMEOUT_MS ?? '');
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_WARMUP_TIMEOUT_MS;
}

/* Boot-gate warmup (2026-07-16 smoke-test fix 2/3). Runs once per
 * spawn, outside the ask queue: dismiss boot banners, inject a tiny
 * self-contained probe, and wait (generously - this is boot, not a
 * voice turn) for the FIRST assistant record to land in the session
 * jsonl. Only then does the session accept real asks. Every outcome
 * is logged loudly; a failed warmup kills the session so the cooldown
 * gate meters retry attempts. */
async function runWarmup(ptyId: string): Promise<void> {
  if (state.warmupRunning) return;
  state.warmupRunning = true;
  const startedAt = deps.now();
  try {
    /* Banner pre-dismiss, same shape as pty-host's seedFirstTurn. */
    await deps.sleep(1_500);
    if (state.ptyId !== ptyId) return;
    try { deps.ptyInject(ptyId, '\r', false); } catch { /* best-effort */ }
    await deps.sleep(600);
    if (state.ptyId !== ptyId) return;
    try { deps.ptyInject(ptyId, '\r', false); } catch { /* best-effort */ }
    await deps.sleep(Math.max(0, WARMUP_BOOT_DELAY_MS - 2_100));
    if (state.ptyId !== ptyId) return;

    const jsonlPath = state.jsonlPath;
    if (!jsonlPath) return;
    let sinceOffset = 0;
    try {
      sinceOffset = deps.statSync(jsonlPath).size;
    } catch {
      sinceOffset = 0;
    }
    const probe = deps.ptyInject(ptyId, WARMUP_PROBE_TEXT, true);
    if (!probe.ok) {
      deps.log(`[voice-brain] WARMUP FAILED: probe inject error: ${probe.error}`);
      killCurrent('warmup-inject-failed');
      return;
    }
    /* Signal-based warmup (2026-07-17): the base timeout bounds
     * time-to-first-signal; jsonl growth / pty output during boot
     * extend the effective deadline, bounded by a 3x wall so a truly
     * wedged boot still dies. */
    const warmupWall = deps.now() + warmupTimeoutMs() * 3;
    let effectiveDeadline = deps.now() + warmupTimeoutMs();
    let lastNudgeAt = deps.now();
    let lastProbeAt = deps.now();
    let jsonlEverGrew = false;
    for (;;) {
      if (state.ptyId !== ptyId) return; /* killed/replaced mid-warmup */
      const handle = deps.getPty(ptyId);
      if (!handle || handle.exited) {
        deps.log('[voice-brain] WARMUP FAILED: pty died during boot');
        killCurrent('warmup-pty-died');
        return;
      }
      const ptyAt = ptyOutputAtMs(ptyId);
      if (ptyAt !== null && deps.now() - ptyAt < signalQuietMs()) {
        effectiveDeadline = extendOnSignal(effectiveDeadline, warmupWall, ptyAt);
      }
      let stat: { size: number } | null;
      try {
        stat = deps.statSync(jsonlPath);
      } catch {
        stat = null;
      }
      if (stat && stat.size > sinceOffset) {
        jsonlEverGrew = true;
        effectiveDeadline = extendOnSignal(
          effectiveDeadline,
          warmupWall,
          deps.now(),
        );
      }
      if (stat && stat.size > sinceOffset) {
        const chunk = deps.readRange(jsonlPath, sinceOffset, stat.size - sinceOffset);
        sinceOffset = stat.size;
        for (const line of chunk.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let rec: Record<string, unknown>;
          try {
            rec = JSON.parse(trimmed);
          } catch {
            continue;
          }
          if (extractAssistantText(rec)) {
            state.warm = true;
            state.consecutiveTimeouts = 0;
            deps.log(
              `[voice-brain] warm: first reply after ${deps.now() - startedAt}ms; session ready for asks`,
            );
            return;
          }
        }
      }
      const now = deps.now();
      if (now >= effectiveDeadline) {
        deps.log(
          `[voice-brain] WARMUP FAILED: no assistant reply and all liveness signals quiet for ${signalQuietMs()}ms (base ${warmupTimeoutMs()}ms); killing session (respawn gated by cooldown)`,
        );
        killCurrent('warmup-timeout');
        return;
      }
      if (!jsonlEverGrew && now - lastProbeAt >= WARMUP_REPROBE_MS) {
        lastProbeAt = now;
        lastNudgeAt = now;
        /* Swallowed-probe recovery (see WARMUP_REPROBE_MS): no jsonl
         * growth means the probe never committed as a turn; re-send
         * the full text, not just a CR. */
        try { deps.ptyInject(ptyId, WARMUP_PROBE_TEXT, true); } catch { /* best-effort */ }
      } else if (now - lastNudgeAt >= WARMUP_RENUDGE_MS) {
        lastNudgeAt = now;
        /* Idempotent bare CR: commits a probe whose original CR a boot
         * overlay swallowed; a no-op on an empty ready composer. */
        try { deps.ptyInject(ptyId, '\r', false); } catch { /* best-effort */ }
      }
      await deps.sleep(deps.pollIntervalMs);
    }
  } finally {
    state.warmupRunning = false;
  }
}

/* Fire-and-forget prewarm so the FIRST operator utterance of a voice
 * session already has a warm brain instead of paying the boot cost
 * (and pre-fix, the boot death spiral) on the first real turn. Called
 * by the voice WS on bind. Safe to call repeatedly. */
export function prewarmVoiceBrainSession(): void {
  if (!isVoiceBrainSessionEnabled()) return;
  if (state.ptyId && state.warm) return;
  ensureSpawned();
}

/* True when a live, boot-probed session is accepting asks. The
 * redelivery path (a spoken delivery cut by a session death waits for
 * the respawn, then re-delivers) polls this instead of poking the ask
 * queue with probe asks. */
export function isVoiceBrainSessionWarm(): boolean {
  if (!isVoiceBrainSessionEnabled()) return false;
  if (!state.ptyId || !state.warm) return false;
  const handle = deps.getPty(state.ptyId);
  return Boolean(handle && !handle.exited);
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

/* Streaming progress extension (2026-07-16 failure 1, second wave).
 * The 04:30Z incident: a spoken delivery was actively streaming
 * records when its ABSOLUTE deadline lapsed; the ask "timed out",
 * scored a liveness strike, and the two-strike watchdog killed the
 * session mid-speech - the operator heard the reply clipped
 * mid-sentence. An absolute deadline is the wrong shape for a
 * streaming ask: once records are flowing the session is provably
 * alive, and what we need to bound is SILENCE, not total duration.
 * So: the caller's timeout governs time-to-FIRST-record only; after
 * that, each new record extends the effective deadline by the idle
 * grace, capped by an absolute wall so a runaway generation still
 * ends. */
const DEFAULT_STREAM_IDLE_MS = 15_000;
const DEFAULT_STREAM_MAX_MS = 120_000;

/* Signal-based liveness (2026-07-17 operator directive: "time based
 * is likely bad, it is too short"). A session is ALIVE while ANY
 * signal fired within the last quiet window: transcript-jsonl growth
 * (bytes appended, assistant record or not) or pty byte output
 * (pty-host handle lastActivity). Every phase (ask, warmup,
 * streaming) treats its configured timeout as the bound on
 * time-to-first-SIGNAL and on silence between signals - never on
 * total reply time. Kill only fires when all signals are quiet; the
 * absolute wall still bounds runaways. */
const DEFAULT_SIGNAL_QUIET_MS = 15_000;

function signalQuietMs(): number {
  const raw = Number(process.env.DEVNEURAL_VOICE_BRAIN_SIGNAL_QUIET_MS ?? '');
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_SIGNAL_QUIET_MS;
}

/* Extend an effective deadline off a fresh liveness signal, never
 * shrinking it and never past the wall. */
function extendOnSignal(
  effectiveDeadline: number,
  wall: number,
  signalAtMs: number,
): number {
  return Math.min(
    wall,
    Math.max(effectiveDeadline, signalAtMs + signalQuietMs()),
  );
}

/* Latest pty output timestamp for the session's pty, or null when the
 * handle is gone / the dep does not expose it. */
function ptyOutputAtMs(ptyId: string | null): number | null {
  if (!ptyId) return null;
  const h = deps.getPty(ptyId) as
    | { exited: boolean; lastActivity?: number }
    | undefined;
  return h && !h.exited && typeof h.lastActivity === 'number'
    ? h.lastActivity
    : null;
}

function streamIdleMs(): number {
  const raw = Number(process.env.DEVNEURAL_VOICE_BRAIN_STREAM_IDLE_MS ?? '');
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_STREAM_IDLE_MS;
}

function streamMaxMs(): number {
  const raw = Number(process.env.DEVNEURAL_VOICE_BRAIN_STREAM_MAX_MS ?? '');
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_STREAM_MAX_MS;
}

/* Tail the session jsonl from startOffset until an answer or the
 * deadline. Two modes:
 *
 *   - onPartial absent: resolve on the FIRST text-bearing assistant
 *     record, exactly like judge-session's waitForAssistantReply.
 *   - onPartial present: deliver each record's text to onPartial as it
 *     lands, accumulate, and resolve with the concatenation when a
 *     record carries stop_reason 'end_turn'. The caller deadline
 *     bounds the wait for the FIRST record; after that the idle grace
 *     governs (see streamIdleMs above), bounded by the absolute wall.
 *
 * On timeout, recordsSeen + sawBytes tell the caller whether the
 * session was mid-generation (records flowed, then stalled), alive
 * but slow (the jsonl grew - claude accepted the inject and is
 * working, it just has not produced an assistant record yet; this is
 * what a slow HEARTBEAT ask looks like), or silent - the liveness
 * watchdog treats those very differently. */
async function waitForVoiceReply(
  jsonlPath: string,
  startOffset: number,
  deadline: number,
  onPartial: ((text: string) => void) | undefined,
  ptyId: string | null = null,
): Promise<
  | { timedOut: true; recordsSeen: number; sawBytes: boolean }
  | { timedOut: false; text: string }
> {
  let offset = startOffset;
  const parts: string[] = [];
  let recordsSeen = 0;
  let sawBytes = false;
  const wall = deps.now() + streamMaxMs();
  let effectiveDeadline = deadline;
  for (;;) {
    let stat: { size: number } | null;
    try {
      stat = deps.statSync(jsonlPath);
    } catch {
      stat = null;
    }
    /* Pty output is a liveness signal too (claude echoes/renders while
     * generating, before the jsonl record lands). */
    const ptyAt = ptyOutputAtMs(ptyId);
    if (ptyAt !== null && deps.now() - ptyAt < signalQuietMs()) {
      effectiveDeadline = extendOnSignal(effectiveDeadline, wall, ptyAt);
    }
    if (stat && stat.size > offset) {
      sawBytes = true;
      /* ANY jsonl growth is a liveness signal - assistant record or
       * not, streaming or not. The caller timeout bounds
       * time-to-first-signal; from here silence is what kills. */
      effectiveDeadline = extendOnSignal(effectiveDeadline, wall, deps.now());
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
          recordsSeen += 1;
          parts.push(text);
          try {
            onPartial(text);
          } catch (err) {
            deps.log(
              `[voice-brain] onPartial threw (ignored): ${(err as Error).message}`,
            );
          }
          /* Progress extends the deadline: bound silence, not total
           * duration. Never shrinks the caller deadline; never
           * exceeds the wall. */
          effectiveDeadline = Math.min(
            wall,
            Math.max(effectiveDeadline, deps.now() + streamIdleMs()),
          );
        }
        if (assistantStopReason(rec) === 'end_turn') {
          return { timedOut: false, text: parts.join('\n') };
        }
      }
    }
    const remaining = effectiveDeadline - deps.now();
    if (remaining <= 0) return { timedOut: true, recordsSeen, sawBytes };
    await deps.sleep(Math.min(deps.pollIntervalMs, remaining));
  }
}

/* Liveness strike policy, isolated on purpose (2026-07-16 addendum).
 * A candidate redesign is under operator review: drop fixed deadlines
 * entirely and treat transcript-jsonl growth OR pty byte output within
 * the last N seconds as the liveness signal at EVERY phase, killing
 * only when all signals are quiet. Until that lands, this function is
 * the single place the interim policy lives: a timed-out ask counts
 * as a strike ONLY when the session showed zero life for the whole
 * wait - no assistant records (streaming) and no jsonl growth at all
 * (covers non-streaming HEARTBEAT asks on a slow-but-alive session;
 * the 04:46Z incident killed the brain mid-heartbeat exactly because
 * record-less progress was invisible to the old policy). */
export function _shouldCountLivenessStrikeImpl(result: {
  recordsSeen: number;
  sawBytes: boolean;
}): boolean {
  return result.recordsSeen === 0 && !result.sawBytes;
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
  /* Warmup gate: never inject into a booting session. The ask nulls
   * fast (caller fail-safe fires: forward-to-Lex, skipped pulse), the
   * composer stays clean for the warmup probe, and nothing here can
   * count as a liveness timeout against a session that is still
   * booting. */
  if (!state.warm) {
    deps.log(
      `[voice-brain] ask skipped: session warming (${deps.now() - state.spawnedAt}ms since spawn)`,
    );
    return null;
  }
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

  const askStartedAt = deps.now();
  const result = await waitForVoiceReply(
    jsonlPath,
    sinceOffset,
    deadline,
    input.onPartial,
    ptyId,
  );
  if (result.timedOut) {
    if (!_shouldCountLivenessStrikeImpl(result)) {
      /* The session showed life during the wait (assistant records
       * streamed, or the jsonl grew at all - claude accepted the
       * inject and is working): this is a slow/stalled TURN, not a
       * dead session. No liveness strike. The 04:30Z (delivery) and
       * 04:46Z (heartbeat) incidents were exactly this shape scoring
       * strike 2 and getting killed mid-speech / mid-pulse. */
      deps.log(
        `[voice-brain] ask timed out but session showed life (records=${result.recordsSeen} bytes_grew=${result.sawBytes}); no liveness strike (streak stays ${state.consecutiveTimeouts})`,
      );
      return null;
    }
    handleTimeout();
    return null;
  }
  /* A reply landed: the session is alive and responsive. Reset the
   * failure streak. */
  deps.log(
    `[voice-brain] ask replied in ${deps.now() - askStartedAt}ms chars=${result.text.length}`,
  );
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
  warmupPromise = null;
}

/** Await the in-flight warmup (resolved immediately when none). Tests
 * only: production callers never wait on boot. */
export function _voiceBrainWarmupForTests(): Promise<void> {
  return warmupPromise ?? Promise.resolve();
}

export function _voiceBrainSessionSnapshotForTests(): Readonly<VoiceBrainSessionState> {
  return { ...state };
}
