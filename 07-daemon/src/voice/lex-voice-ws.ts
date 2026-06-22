/**
 * Lex voice WebSocket pipeline.
 *
 * Single bidirectional WebSocket per browser tab. The browser opens
 * mic, runs silero VAD locally, ships utterance-bounded PCM frames to
 * the daemon. The daemon transcribes via whisper-server, injects the
 * text into the Lex daemon-PTY, watches the Lex jsonl for the matching
 * assistant turn to complete, runs Piper on the response text, and
 * streams TTS PCM frames back.
 *
 * Why one socket: latency. Open the WS once on tab load, prewarm
 * whisper, and every utterance is just frames + a transcript event.
 * Building separate HTTP requests per direction would round-trip the
 * tailscale relay multiple times per turn.
 *
 * Wire protocol (lightweight on purpose):
 *   client -> server (JSON):
 *     { t: "hello", session_id?: string }
 *     { t: "utterance-start" }
 *     { t: "utterance-end" }                 - triggers transcribe + inject
 *     { t: "barge-in" }                      - cancel in-flight TTS
 *     { t: "ping" }
 *   client -> server (binary):
 *     PCM frames between utterance-start and utterance-end:
 *     16 kHz mono, 16-bit signed little-endian. AudioWorklet on the
 *     browser side does the resampling.
 *   server -> client (JSON):
 *     { t: "hello-ack", session_id, voice_rate }
 *     { t: "transcript", text, ms }
 *     { t: "injected" }                       - text reached Lex stdin
 *     { t: "assistant-text", text }           - final response text Lex emitted
 *     { t: "tts-start", rate }
 *     { t: "tts-end" }
 *     { t: "session-end", reason }            - spoken end-session command;
 *                                               client should setEnabled(false)
 *     { t: "error", code, message }
 *     { t: "pong" }
 *   server -> client (binary):
 *     TTS PCM frames between tts-start and tts-end:
 *     22050 Hz mono 16-bit signed little-endian.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { WebSocket as FastifyWS } from '@fastify/websocket';
import { transcribeWav, pcm16ToWav } from './whisper.js';
import { synthesize, piperStatus } from './piper.js';
import {
  createSpeakController,
  type SpeakController,
} from './lex-voice-speak-controller.js';
import {
  ptyInject,
  getPty,
  getPtyBySession,
  listPtys,
  isAwaitingSystemPrompt,
  ptyKill,
} from '../dashboard/pty-host.js';
import { getLexSession, setLexSessionStatus } from '../lex/lex-session-store.js';
import {
  getBrainstormByClaudeSessionId,
  getBrainstormByPty,
  getStore as getBrainstormStore,
  getBrainstorm,
} from '../lex/brainstorm-store.js';
import { processAssistantTurn } from '../lex/artifact-parser.js';
import { fireForLexTurn as fireAttentionForLexTurn } from '../dashboard/lex-attention.js';
import {
  contextTokensFromUsage,
  maybeCompactOnTurnEnd,
  type CompactionSupervisorState,
  type UsageLike,
} from '../lex/compaction-supervisor.js';
import { spawnLexSession } from '../lex/spawn-lex-session.js';
import { buildLexSpawnPrompt } from '../lex/spawn-prompt.js';
import { buildLexSystemPromptVersioned } from '../lex/system-prompt.js';
import { buildVoiceSnapshot } from '../lex/snapshot-context.js';
import { callVoiceChat } from '../llm/voice-chat.js';
import { detectDeferral } from '../lex/deferral-detector.js';
import { randomUUID } from 'node:crypto';
import {
  matchVoiceCommand,
  ALL_VOICE_COMMAND_KINDS,
  type VoiceCommandKind,
} from './lex-voice-commands.js';
import { runHoldUp } from './lex-voice-hold-up.js';
import {
  detectContradiction,
  formatQueueDrain,
} from './lex-voice-coalesce.js';
import { firePanic } from '../dashboard/panic-routes.js';
import { getStore } from '../lex/brainstorm-store.js';
import { checkToolGate, notifyLargeFsRead, LARGE_FS_READ_LINE_THRESHOLD } from '../lex/tool-gate.js';
import {
  runSessionEndPipeline,
  runDistillationFlush,
} from '../lex/session-end-pipeline.js';
import { appendUtterance as appendSessionAudio } from './audio-bundle.js';
import { selectTtsContent, clampAck } from './select-tts-content.js';
import {
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TICK_MS,
} from './lex-voice-heartbeat.js';
import { shouldSpeakHeartbeatHaiku } from './voice-heartbeat-haiku.js';
import {
  renderForSpeech,
  heartbeatLine,
  haikuRoute,
  composeGlueReply,
} from './voice-haiku-wiring.js';
import { useVoiceHaiku } from './voice-haiku.js';

/* Voice modes drive whether the daemon synthesizes Lex's response
 * out loud. The browser still receives transcript + assistant-text
 * events in every mode so the on-screen panel updates regardless. */
type VoiceMode = 'conversation' | 'notes' | 'push-to-talk';

interface ConnState {
  ws: FastifyWS;
  /* The Lex session/PTY this socket is bound to. We accept either a
   * sessionId (jsonl-bound) or a ptyId (pre-binding). */
  bindKey: string | null;
  /* Claude Code session UUID whose jsonl we tail for assistant turns to
   * TTS. Decoupled from bindKey so we can speak responses from any
   * session — including standalone Claude Code instances that aren't
   * managed by pty-host (no PTY entry, but jsonl exists on disk). */
  watchSessionId: string | null;
  /* PCM frames buffered between utterance-start and utterance-end. */
  micBuf: Buffer[];
  micBufBytes: number;
  /* In-flight TTS handle so barge-in can cancel mid-stream.
   * `cancelled` is set by killActiveTts so the pcm 'end' handler can
   * suppress its own tts-end emit (the client already received an
   * earlier tts-cancel and a trailing tts-end would race against
   * the next reply's tts-start). */
  ttsActive: { cancel: () => void; cancelled: boolean } | null;
  /* Cursor into the bound session's jsonl for incremental tail reads. */
  jsonlOffset: number;
  jsonlPath: string | null;
  watchTimer: ReturnType<typeof setInterval> | null;
  /* Set after we inject so the next end_turn we observe in the jsonl
   * is recognised as the response. The jsonl pre-existing content
   * shouldn't trigger a synth. */
  awaitingResponseSince: number;
  /* Hard cap to keep memory bounded on a misbehaving client. */
  closed: boolean;
  /* Active voice mode set by the client on hello / mode-change. */
  mode: VoiceMode;
  /* Session-end pipeline guard. Set true on first fire from any path
   * (voice command, ws close, server eviction) so subsequent paths
   * no-op instead of running a duplicate force-ingest + summarize +
   * embed sequence. */
  sessionEndFired: boolean;
  /* Per-kind dedupe window for voice commands. The client now has
   * a Web Speech / hotkey "wake-word" path that fires while micGated
   * is true (TTS playback) AND the daemon's normal transcript path
   * still fires when the same utterance finishes through whisper.
   * Without this, "Lex shut up" mid-TTS would emit voice-mute twice
   * and panic / end-session would log two audit rows. 1500ms covers
   * the gap between the wake-word fire and the trailing transcript
   * landing through utterance-end. */
  lastVoiceCmdMs: Partial<Record<VoiceCommandKind, number>>;
  /* True when the current utterance began while ttsActive was
   * non-null (i.e. the user spoke during a Lex TTS reply). Stamped
   * on the utterance-start frame and read inside handleUtteranceEnd
   * after dispatch. When set, a transcript that does NOT match a
   * voice command is dropped instead of injected, so AEC residual
   * (Lex's own audio bleeding into the mic) cannot land as a
   * phantom user turn that derails the brainstorm. Wake commands
   * (matchVoiceCommand returns non-null) still fire via the
   * dispatch path before this gate. */
  utteranceStartedDuringTts: boolean;
  /* Half-duplex heartbeat gate (2026-06-18). userSpeaking is true
   * between utterance-start and utterance-end; lastUserSpeechEndMs is
   * the instant the user last stopped. The working-heartbeat must never
   * pulse while either says the user holds the floor — Lex speaking
   * mutes the mic, so a pulse over the user makes Lex deaf to them. */
  userSpeaking: boolean;
  lastUserSpeechEndMs: number;
  /* Talkback speak-suppression gate (2026-06-19). Set true when the
   * turn was triggered by TYPED input (text-input frame), false when
   * triggered by a real voice utterance. The talkback watcher and the
   * direct-llm reply both consult it: typed input gets a text-only
   * reply (panel frame + chunk still land) and is NEVER spoken. Last
   * input source wins, so the user's most recent channel decides
   * whether Lex talks back. Read at the two speak() sites only; the
   * visual + persistence paths are unaffected. */
  suppressSpeakForTurn: boolean;
  /* Mid-session compaction trigger state. Flips compactedAt the
   * moment shouldTriggerCompaction crosses 75% so a trailing
   * end_turn record in the same jsonl tail cannot re-fire the
   * restart while distillation is still running. */
  compaction: CompactionSupervisorState;
  /* N-deep barge integration (2026-05-22). Captures the markdown-
   * cleaned text passed to piper for the in-flight TTS so a
   * killActiveTts call can record what Lex was MEANT to say. Cleared
   * on natural tts-end so the next reply does not inherit a stale
   * intended-text. */
  currentTtsText: string | null;
  /* Wall-clock instant the current TTS handle started streaming.
   * Subtracted from the cancel timestamp so the partial-chain entry
   * carries an "interrupted Xms into delivery" hint the LLM uses to
   * weave the resumed reply. */
  currentTtsStartedAtMs: number;
  /* Unresolved interrupted-reply chain. Each entry is one assistant
   * turn that was synthesized but cancelled before piper finished
   * shipping it. Appended on killActiveTts when ttsActive was non-
   * null; cleared the next time handleUtteranceEnd successfully
   * injects a user transcript. The chain is in-memory only; a daemon
   * restart between cancel and the next inject loses the [voice-
   * context] block, which is acceptable given the narrow window and
   * the worker's own jsonl still carrying the assistant turn text.
   * Survives /compact and /clear in the worker because it lives on
   * the WS state, not in the worker's context. */
  partialChain: Array<{
    intended_text: string;
    started_at_ms: number;
    cancelled_at_ms: number;
  }>;
  /* Fix 20 (2026-05-23) mid-tool-use utterance queue.
   * When the user speaks while Lex is mid-turn (e.g. mid-tool-use)
   * with NO active TTS, the new utterance is deferred instead of
   * injected. handleUtteranceEnd pushes the cleaned transcript here;
   * handleJsonlLine flushes the queue as one combined inject the
   * instant awaitingResponseSince clears (i.e. Lex's end_turn lands).
   * That preserves Lex's in-flight tool sequence while still letting
   * the user "stack" follow-on context that gets delivered cleanly
   * at the next natural turn boundary. */
  pendingUserUtterances: string[];
  /* Brainstorm-as-durable-primary-entity (2026-05-22, Path B).
   * Set when a hello frame carries a brainstorm_id and the resolved
   * brainstorm has runtime_mode='direct-llm'. Drives the dispatch
   * branch in handleUtteranceEnd: direct-llm calls ollama through
   * callVoiceChat and persists chunks itself instead of injecting
   * into a PTY and watching the worker's jsonl. cc-pty (legacy) and
   * null (no brainstorm bind) both keep the original behaviour. */
  brainstormId: string | null;
  runtimeMode: 'cc-pty' | 'direct-llm' | null;
  /* Fix 35 Phase A (2026-05-26): coalesce single-output-stream
   * invariant for the direct-llm path. True while a callVoiceChat +
   * speak() round-trip is in flight; gates handleUtteranceEnd's
   * direct-llm branch so a second utterance arriving mid-reply is
   * queued onto pendingUserUtterances and drained on completion
   * instead of spawning a parallel ollama call. The cc-pty path
   * already has its own equivalent gate via awaitingResponseSince +
   * the mid-turn-no-tts queue. */
  inFlightDirectLlmReply: boolean;
  /* Fix 57 (2026-06-01) COALESCE Phase B: AbortController bound to
   * the in-flight callVoiceChat call. Contradiction handler aborts so
   * ollama stops generating immediately instead of letting the
   * cancelled instruction finish + land as one more assistant chunk
   * that nobody asked for. Null between turns; assigned in
   * handleDirectLlmUtterance before the await, cleared after. */
  directLlmAbort: AbortController | null;
  /* Fix 40 (2026-05-26): speak-queue serialisation. The controller
   * drains entries one at a time, awaiting each piper's natural end
   * before spawning the next. Multi-segment Lex replies (pre-tool
   * ack + end_turn body) therefore play back-to-back instead of
   * spawning concurrent piper children that mix into double-talk.
   * killActiveTts (and runHoldUp's cancelTts) clear the queue and
   * cancel the in-flight ctx as one atomic boundary; segments queued
   * AFTER a kill belong to a fresh logical turn and start a new run. */
  ttsQueue: Array<{ cleanText: string }>;
  ttsQueueRunning: boolean;
}

/* 2026-05-22: lifted from 4 MB to 64 MB. The old 4 MB ceiling was a
 * floor on how long the user could keep talking before STT refused
 * the buffer; combined with the dashboard's 30s utterance cap that
 * dropped audio, long-form utterances were not survivable. 64 MB =
 * roughly 33 min of 16k mono int16, comfortably above the new
 * dashboard MAX_UTTERANCE_MS of 30 min, with headroom for the
 * defensive sample ceiling on the client. fastifyWebsocket's default
 * frame limit (100 MB) still bounds individual WS frames so a single
 * pathological message cannot blow past this. */
const MIC_BUF_MAX = 64 * 1024 * 1024;

const SESSION_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* Spoken end-session command. Recognition moved into the unified Lex
 * voice-command dispatcher (lex-voice-commands.ts) on 2026-05-14;
 * end-session now requires the explicit "lex end session" phrase like
 * every other voice command so meeting chatter that mentions "end
 * session" mid-conversation cannot tear down the panel. */

/* Find a Claude Code session jsonl by sessionId, scanning every project
 * slug under ~/.claude/projects. Decouples the TTS watcher from pty-host
 * tracking: if a Claude Code instance is running outside the daemon's
 * PTY pool but its session jsonl exists on disk, we can still tail it. */
function findJsonlBySessionId(sessionId: string): string | null {
  if (!SESSION_UUID_RE.test(sessionId)) return null;
  const claudeRoot = path.posix.join(
    os.homedir().replace(/\\/g, '/'),
    '.claude',
    'projects',
  );
  if (!fs.existsSync(claudeRoot)) return null;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(claudeRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const candidate = path.posix.join(
      claudeRoot,
      e.name,
      `${sessionId}.jsonl`,
    );
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/* One voice WS per PTY. Without this, a user with multiple dashboard
 * tabs open sees every utterance injected once per tab, same audio,
 * same transcript, three injects, three Lex replies. We track the
 * active socket per bindKey and gracefully evict any previous one
 * whenever a fresh hello binds. */
const activeByBindKey = new Map<string, ConnState>();

/* Fix 53 (2026-06-18): one voice TALKBACK per watched session.
 * activeByBindKey only dedupes PTY-bound + direct-llm clients. A
 * read-only TTS watcher (watchSessionId set, no PTY -> no bindKey)
 * is invisible to that map, so two watchers tailing the same jsonl
 * each synthesize the same assistant segment -> audible double audio.
 * This map tracks the active watcher per watch-target (session id or
 * jsonl path); a fresh watcher evicts the prior one. Newest wins,
 * matching the activeByBindKey eviction contract above. */
const activeByWatchTarget = new Map<string, ConnState>();

/* Fix 53 hard guarantee: a given assistant jsonl record is synthesized
 * to audio AT MOST ONCE across ALL connections within this window,
 * even if two watchers briefly coexist during a reconnect race (one
 * 250ms poll tick) before eviction lands. Pure suppression keyed by
 * `${watch-target}::${record-uuid}::${ack|body}` — it can only stop a
 * duplicate stream, never block the single legitimate one. This is the
 * "never speak twice, no matter what" backstop behind the eviction. */
const globallySpokenRecords = new Map<string, number>();
const GLOBAL_SPOKEN_TTL_MS = 15_000;
function claimSpokenRecord(key: string): boolean {
  const now = Date.now();
  for (const [k, exp] of globallySpokenRecords) {
    if (exp <= now) globallySpokenRecords.delete(k);
  }
  const existing = globallySpokenRecords.get(key);
  if (existing && existing > now) return false;
  globallySpokenRecords.set(key, now + GLOBAL_SPOKEN_TTL_MS);
  return true;
}

/* Last tts-end emit timestamp (epoch ms). Stamped server-side every
 * time the daemon finishes streaming TTS PCM to a client. Surfaced in
 * /health.audio.last_tts_ack_ms so an external probe can see when the
 * audio path last completed a round trip. 0 until first TTS finishes
 * after process start. */
let lastTtsEndMs = 0;

export interface VoiceWsStats {
  bound_count: number;
  last_tts_ack_ms: number;
}

export function getVoiceWsStats(): VoiceWsStats {
  let bound = 0;
  for (const c of activeByBindKey.values()) {
    if (!c.closed && c.bindKey) bound += 1;
  }
  return { bound_count: bound, last_tts_ack_ms: lastTtsEndMs };
}

/* Lex dashboard voice controls. Mirrors the spoken voice-command path
 * (mute / unmute / disable) over HTTP so Lex can mute itself or stop
 * the voice session from a tool call. The browser handles each frame
 * the same way it does for a voice-triggered command:
 *   voice-mute    halt TTS, keep socket
 *   voice-unmute  resume TTS
 *   voice-disable stop voice session (panel flips off)
 * Stop maps to voice-disable rather than session-end so the underlying
 * brainstorm row stays live; teardown of the brainstorm is its own
 * end_session command. */
export type VoiceControlKind = 'mute' | 'unmute' | 'stop';

const VOICE_CONTROL_FRAMES: Record<VoiceControlKind, string> = {
  mute: 'voice-mute',
  unmute: 'voice-unmute',
  stop: 'voice-disable',
};

export interface VoiceControlOptions {
  /** Reason string surfaced to the client (audit trail / UI badge). */
  reason?: string;
  /** Target a single connection by bindKey (session_id or pty_id).
   * Omitted -> broadcast to every active voice client. */
  bindKey?: string | null;
}

export interface VoiceControlResult {
  ok: boolean;
  delivered: number;
  bind_keys: string[];
  reason: string;
}

/* Test seam: each test reconstructs the connection set without
 * standing up real sockets. Production paths leave this null and
 * fall back to the module-level activeByBindKey map. */
let testRegistryOverride:
  | Map<string, { ws: { send: (data: string) => void }; closed: boolean; bindKey: string | null }>
  | null = null;

export function _setVoiceControlRegistryForTests(
  registry:
    | Map<string, { ws: { send: (data: string) => void }; closed: boolean; bindKey: string | null }>
    | null,
): void {
  testRegistryOverride = registry;
}

export function broadcastVoiceControl(
  kind: VoiceControlKind,
  opts: VoiceControlOptions = {},
): VoiceControlResult {
  const reason = (opts.reason ?? 'http-request').slice(0, 256);
  const frame = VOICE_CONTROL_FRAMES[kind];
  const registry = testRegistryOverride ??
    (activeByBindKey as unknown as Map<
      string,
      { ws: { send: (data: string) => void }; closed: boolean; bindKey: string | null }
    >);
  const targets: Array<{
    ws: { send: (data: string) => void };
    closed: boolean;
    bindKey: string | null;
  }> = [];
  if (opts.bindKey) {
    const target = registry.get(opts.bindKey);
    if (target && !target.closed) targets.push(target);
  } else {
    for (const c of registry.values()) {
      if (!c.closed) targets.push(c);
    }
  }
  let delivered = 0;
  const reached: string[] = [];
  const payload = JSON.stringify({ t: frame, reason });
  for (const c of targets) {
    try {
      c.ws.send(payload);
      delivered += 1;
      if (c.bindKey) reached.push(c.bindKey);
    } catch {
      /* socket already gone; never block the broadcaster on a
       * single dead client. */
    }
  }
  return { ok: true, delivered, bind_keys: reached, reason };
}

/* Push a `recovery-exhausted` frame to the active voice client (if
 * any) for a given bind key. Called by the cancelled-tool-recovery
 * background service after two strikes inside the 30 s window so the
 * client can surface a dashboard banner. Best-effort: no client
 * connected = silent no-op, the audit row + log line are the durable
 * record. */
export function broadcastRecoveryExhausted(
  bindKey: string,
  reason: string,
): { delivered: number } {
  const registry = testRegistryOverride ??
    (activeByBindKey as unknown as Map<
      string,
      { ws: { send: (data: string) => void }; closed: boolean; bindKey: string | null }
    >);
  const target = registry.get(bindKey);
  if (!target || target.closed) return { delivered: 0 };
  try {
    target.ws.send(
      JSON.stringify({ t: 'recovery-exhausted', reason: reason.slice(0, 256) }),
    );
    return { delivered: 1 };
  } catch {
    return { delivered: 0 };
  }
}

/* Narrow state shape for the flush helper. Defined here (not as part
 * of ConnState) so the helper can be unit-tested with a hand-rolled
 * partial without satisfying the full ConnState surface. */
export interface _FlushPendingUtterancesState {
  pendingUserUtterances: string[];
  bindKey: string | null;
  mode: 'conversation' | 'notes' | string;
  awaitingResponseSince: number;
}

export interface _FlushPendingUtterancesDeps {
  state: _FlushPendingUtterancesState;
  ptyInject: (
    key: string,
    text: string,
    commit: boolean,
  ) => { ok: true } | { ok: false; error: string };
  send: (msg: Record<string, unknown>) => void;
  /* Test seam: when omitted, defaults to a normal setTimeout with
   * unref. Tests pass a synchronous capture so the bare-CR follow-up
   * can be fired without sleeping. */
  scheduleFollowupCr?: (fn: () => void, delayMs: number) => void;
  /* Override the 850 ms delay only for tests. Production uses the
   * default to match DEFAULT_COMMIT_DELAY_MS in cross-session-inject. */
  followupDelayMs?: number;
  /* Test seam: capture the log line instead of writing to stdout. */
  log?: (msg: string) => void;
}

function _defaultScheduleFollowupCr(fn: () => void, delayMs: number): void {
  const t = setTimeout(fn, delayMs);
  if (typeof (t as { unref?: () => void }).unref === 'function') {
    (t as { unref: () => void }).unref();
  }
}

/* Mid-turn queue flush. Exported as `_flushPendingUtterancesImpl` so
 * the regression test (lex-voice-ws.flush-cr.test.ts) can drive it
 * without standing up a full WS attach. The closure inside
 * attachLexVoiceWs delegates here; the body lives here so the test
 * exercises the same code path as production. */
export function _flushPendingUtterancesImpl(
  deps: _FlushPendingUtterancesDeps,
): void {
  const { state, ptyInject, send } = deps;
  if (state.pendingUserUtterances.length === 0) return;
  if (!state.bindKey) return;
  const queued = state.pendingUserUtterances.slice();
  state.pendingUserUtterances = [];
  const header =
    queued.length === 1
      ? '[voice-context: queued-mid-turn-utterance] The user spoke this while you were mid-turn; it was held until your turn boundary.\n\n'
      : `[voice-context: queued-mid-turn-utterances (${queued.length})] The user spoke these follow-on utterances while you were mid-turn. They were held until your turn boundary; treat as one combined message:\n\n${queued.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n\n`;
  const body = queued.length === 1 ? `${header}${queued[0]}` : header;
  const voiceTag =
    state.mode === 'notes'
      ? '[voice mode: notes, silent reply, capture as artifact] '
      : '[voice mode] ';
  const ir = ptyInject(state.bindKey, body + voiceTag, true);
  if (!ir.ok) {
    send({
      t: 'error',
      code: 'inject',
      message: `flush-mid-turn-queue: ${ir.error}`,
    });
    state.pendingUserUtterances = queued.concat(state.pendingUserUtterances);
    return;
  }
  /* Bare-CR follow-up. Mirrors cross-session-inject.ts:297-306: bridge-
   * attached workers sometimes receive the primary atomic write into
   * the input field but never submit, so the cursor sits after
   * '[voice mode] ' and the worker stays idle. Fire an explicit '\r'
   * through the same transport ~850 ms later (matches
   * DEFAULT_COMMIT_DELAY_MS) to settle it. commit=false on the nudge
   * so ptyInject does not append a second CR onto a bare CR. */
  const schedule = deps.scheduleFollowupCr ?? _defaultScheduleFollowupCr;
  const delayMs = deps.followupDelayMs ?? 850;
  schedule(() => {
    if (!state.bindKey) return;
    try {
      ptyInject(state.bindKey, '\r', false);
    } catch {
      /* nudge is fire-and-forget */
    }
  }, delayMs);
  (deps.log ?? console.log)(
    `[voice-ws] mid-turn-no-tts queue flush count=${queued.length}`,
  );
  send({
    t: 'injected',
    source: 'mid-turn-queue-flush',
    count: queued.length,
  });
  state.awaitingResponseSince = Date.now();
}

/* Single meaningful words that must reach Lex despite the wordCount<2
 * whisper-noise floor (2026-06-18). The user steers with terse commands
 * ("go", "stop", "proceed") and the 2-word floor was swallowing them.
 * Deliberately excludes whisper's common noise transcriptions ("okay",
 * "you", "thanks", "yeah") so the noise floor still holds. */
const SHORT_COMMAND_WORDS = new Set<string>([
  'go', 'stop', 'wait', 'yes', 'no', 'nope', 'proceed', 'continue',
  'done', 'cancel', 'kill', 'pause', 'abort', 'retry', 'next', 'send',
  'ship', 'build', 'hold', 'skip', 'undo', 'repeat',
]);

export function attachLexVoiceWs(socket: FastifyWS): void {
  console.log(`[voice-ws] client connected (attach)`);
  const state: ConnState = {
    ws: socket,
    bindKey: null,
    watchSessionId: null,
    micBuf: [],
    micBufBytes: 0,
    ttsActive: null,
    jsonlOffset: 0,
    jsonlPath: null,
    watchTimer: null,
    awaitingResponseSince: 0,
    closed: false,
    mode: 'conversation',
    sessionEndFired: false,
    lastVoiceCmdMs: {},
    utteranceStartedDuringTts: false,
    userSpeaking: false,
    lastUserSpeechEndMs: 0,
    suppressSpeakForTurn: false,
    compaction: { compactedAt: 0 },
    currentTtsText: null,
    currentTtsStartedAtMs: 0,
    partialChain: [],
    pendingUserUtterances: [],
    directLlmAbort: null,
    brainstormId: null,
    runtimeMode: null,
    inFlightDirectLlmReply: false,
    ttsQueue: [],
    ttsQueueRunning: false,
  };

  /* Working-heartbeat state. lastSpeechMs is the epoch ms of the most
   * recent TTS activity (start of a speak + every tts-end); the
   * heartbeat watcher uses it as the silence clock. heartbeatTimer is
   * the in-flight ticker, started with the jsonl watch and torn down
   * with it. */
  let lastSpeechMs = 0;
  /* Last line actually spoken; the haiku fast lane replays it on
   * "say that again" without an Opus round-trip. */
  let lastSpokenText: string | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  /* Fix 40 (2026-05-26): centralise piper synth lifecycle behind a
   * controller that serialises same-turn speak() calls and cancels
   * cleanly on barge. The legacy inline speak() reassigned
   * state.ttsActive without cancelling the prior ctx, which produced
   * audible double-talk whenever a pre-tool ack and the matching
   * end_turn body both landed text content. See
   * docs/bugs/2026-05-26-cc-pty-double-talk-investigation.md. */
  const speakCtrl: SpeakController = createSpeakController(state, {
    synthesize,
    send: (frame) => send(frame as Record<string, unknown>),
    sendBinary,
    onTtsEnd: () => {
      lastTtsEndMs = Date.now();
      lastSpeechMs = Date.now();
    },
  });

  function send(msg: Record<string, unknown>): void {
    if (state.closed) return;
    try {
      socket.send(JSON.stringify(msg));
    } catch {
      /* socket closed mid-send */
    }
  }

  function sendBinary(buf: Buffer): void {
    if (state.closed) return;
    try {
      socket.send(buf);
    } catch {
      /* socket closed mid-send */
    }
  }

  /* Fix 53 (2026-06-18): claim this connection as the sole talkback
   * for its watch-target (session id, else jsonl path). Evicts any
   * prior watcher of the same target so a read-only TTS watcher can
   * never coexist with another watcher and double-speak. Newest wins,
   * mirroring the activeByBindKey eviction in bind(). No-op when there
   * is nothing to watch yet. */
  /* Fix 57 (2026-06-19): canonical talkback identity = the physical
   * jsonl path being spoken, NOT the session UUID. Pre-fix the key was
   * `watchSessionId ?? jsonlPath`, so a client bound by session UUID and
   * a client bound via the global-Lex PTY fallback landed under DIFFERENT
   * keys for the SAME physical Lex, never evicted each other, and both
   * synthesised the same end_turn body -> audible Lex-over-Lex. Resolve
   * the UUID to its jsonl path so the two namespaces cannot diverge. */
  function watchTargetKey(): string | null {
    if (state.jsonlPath) return state.jsonlPath;
    if (state.watchSessionId) {
      const j = findJsonlBySessionId(state.watchSessionId);
      if (j) return j;
    }
    return null;
  }

  function claimWatchTarget(): void {
    const key = watchTargetKey();
    if (!key) return;
    /* Drop any stale self-claim under a pre-resolution key so a late
     * path-resolve (pollJsonl) cannot leave this conn occupying two
     * slots and shadowing a real eviction. */
    for (const [k, v] of activeByWatchTarget) {
      if (v === state && k !== key) activeByWatchTarget.delete(k);
    }
    const prior = activeByWatchTarget.get(key);
    if (prior && prior !== state) {
      prior.closed = true;
      try {
        prior.ws.send(
          JSON.stringify({
            t: 'evicted',
            reason:
              'another voice client started watching this session; only one talkback per session is allowed',
          }),
        );
      } catch {
        /* socket already gone */
      }
      try {
        prior.ws.close();
      } catch {
        /* ignore */
      }
    }
    activeByWatchTarget.set(key, state);
  }

  function bind(sessionOrPty: string | undefined): void {
    /* Resolve a jsonl to tail directly from the supplied session_id, so
     * we can speak responses from Claude Code instances that aren't
     * tracked by pty-host (standalone harness instances, IDE-spawned
     * sessions, etc.). The PTY resolution below is still used for
     * inject — TTS-watch and inject-target are intentionally decoupled. */
    if (sessionOrPty && SESSION_UUID_RE.test(sessionOrPty)) {
      const jsonl = findJsonlBySessionId(sessionOrPty);
      if (jsonl) {
        state.watchSessionId = sessionOrPty;
        state.jsonlPath = jsonl;
        try {
          state.jsonlOffset = fs.statSync(jsonl).size;
        } catch {
          state.jsonlOffset = 0;
        }
      }
    }

    /* Resolve to a PTY handle so we can pump inject. If no key supplied,
     * pick the brainstorm PTY (single global Lex convention). */
    let handle = sessionOrPty
      ? getPty(sessionOrPty) || getPtyBySession(sessionOrPty)
      : undefined;
    if (!handle) {
      const all = listPtys();
      const lex = all.find(
        (p) => !p.exited && /[\\/]brainstorm[\\/]?$/i.test(p.cwd),
      );
      if (lex) {
        handle = getPty(lex.ptyId);
      }
    }
    if (!handle) {
      /* No PTY available for inject. If we already resolved a jsonl from
       * the session_id, allow the WS to remain connected for TTS-only
       * (read-only voice talkback). Otherwise this is a hard error. */
      if (!state.jsonlPath) {
        send({
          t: 'error',
          code: 'no-pty',
          message:
            'No Lex PTY active. Start Lex from the Brainstorm tab first.',
        });
        return;
      }
      send({
        t: 'hello-ack',
        session_id: state.watchSessionId,
        pty_id: null,
        voice_rate: piperStatus().rate,
        jsonl_bound: true,
        inject_disabled: true,
      });
      claimWatchTarget();
      startJsonlWatch();
      return;
    }
    state.bindKey = handle.sessionId ?? handle.ptyId;
    /* Evict any earlier socket bound to the same PTY. Multiple tabs
     * with the voice panel open would otherwise each hear the user's
     * utterance, transcribe it, and inject it; Lex sees the same text
     * three times. We send a soft eviction message so the loser tab
     * can show "voice taken over by another tab" instead of dropping
     * silently. */
    const prior = activeByBindKey.get(state.bindKey);
    if (prior && prior !== state) {
      prior.closed = true;
      try {
        prior.ws.send(
          JSON.stringify({
            t: 'evicted',
            reason:
              'another tab opened the voice panel; only one voice client per PTY is allowed',
          }),
        );
      } catch {
        /* socket already gone */
      }
      try {
        prior.ws.close();
      } catch {
        /* ignore */
      }
    }
    activeByBindKey.set(state.bindKey, state);
    /* PTY-derived jsonl is the legacy path. Skip it when the caller
     * already supplied a watchSessionId — that takes precedence so the
     * watcher tails the session the client actually wants spoken. */
    if (!state.watchSessionId && handle.sessionId) {
      const slug = handle.cwd.replace(/[\\/:]/g, '-');
      const claudeRoot = path.posix.join(
        os.homedir().replace(/\\/g, '/'),
        '.claude',
        'projects',
      );
      const jsonl = path.posix.join(
        claudeRoot,
        slug,
        `${handle.sessionId}.jsonl`,
      );
      if (fs.existsSync(jsonl)) {
        state.jsonlPath = jsonl;
        try {
          state.jsonlOffset = fs.statSync(jsonl).size;
        } catch {
          state.jsonlOffset = 0;
        }
      }
    }
    send({
      t: 'hello-ack',
      session_id: state.watchSessionId ?? handle.sessionId,
      pty_id: handle.ptyId,
      voice_rate: piperStatus().rate,
      jsonl_bound: Boolean(state.jsonlPath),
    });
    claimWatchTarget();
    if (state.jsonlPath) startJsonlWatch();
    /* Fix 31 (2026-05-25): migrate awaitingResponseSince from the
     * brainstorm row when binding to an in-flight turn. The race:
     * a prior WS for the same brainstorm fired ptyInject and set
     * awaiting on its ConnState + flipped the brainstorm row's
     * lifecycle_state to 'speaking' (handleUtteranceEnd:1900-1910).
     * That socket then closed before the assistant turn landed
     * (client reconnect on sessionId resolve, smart-compact restart,
     * eviction, or daemon restart). The new ConnState bound here
     * has awaiting=0 by default, so handleJsonlLine's gate at line
     * 762 (!awaiting && !readOnly) drops the assistant turn when it
     * arrives in the jsonl. The brainstorm row is the source of
     * truth for "in-flight"; inherit it. lifecycle_state flips back
     * to idle/attached on the matching end_turn at line 822, so
     * this only stamps awaiting when a turn truly is in flight. */
    try {
      const bs =
        (handle.sessionId && getBrainstormByClaudeSessionId(handle.sessionId)) ||
        getBrainstormByPty(handle.ptyId) ||
        null;
      if (bs && bs.lifecycle_state === 'speaking') {
        state.awaitingResponseSince = Date.now();
        if (!state.watchTimer) startJsonlWatch();
      }
    } catch {
      /* best-effort migration; never block bind() */
    }
  }

  /* Brainstorm-as-durable-primary-entity (2026-05-22, Path B).
   *
   * Bind the socket to a brainstorm by id, then split based on
   * runtime_mode:
   *
   * - 'direct-llm': no PTY, no jsonl watcher. The socket carries
   *   brainstormId only; handleUtteranceEnd runs the direct-llm
   *   branch and persists chunks straight into brainstorm_chunks.
   * - 'cc-pty' or 'detached' or unknown: fall through to the
   *   legacy bind() path using the brainstorm's claude_session_id
   *   so the existing PTY + jsonl plumbing keeps working unchanged.
   *
   * Sends 'hello-ack' on success; 'error' code 'no-brainstorm' when
   * the id does not resolve, code 'brainstorm-ended' when the row
   * is already terminal. */
  function bindByBrainstorm(brainstormId: string): void {
    const row = getBrainstorm(brainstormId);
    if (!row) {
      send({
        t: 'error',
        code: 'no-brainstorm',
        message: `brainstorm "${brainstormId}" not found`,
      });
      return;
    }
    if (row.status === 'ended') {
      send({
        t: 'error',
        code: 'brainstorm-ended',
        message: 'brainstorm is ended; create a new one to continue',
      });
      return;
    }
    state.brainstormId = brainstormId;
    /* 'detached' is a transitional schema value; treat it as cc-pty
     * at the voice WS level so the legacy path picks it up. Voice WS
     * only diverges on the explicit 'direct-llm' value. */
    state.runtimeMode = row.runtime_mode === 'direct-llm' ? 'direct-llm' : 'cc-pty';
    if (state.runtimeMode === 'direct-llm') {
      /* Standalone brainstorm: no PTY, no jsonl. The voice WS is the
       * sole runtime for this brainstorm; chunks land directly into
       * the DB and TTS streams from the LLM reply. */
      state.bindKey = `brainstorm:${brainstormId}`;
      const prior = activeByBindKey.get(state.bindKey);
      if (prior && prior !== state) {
        prior.closed = true;
        try {
          prior.ws.send(
            JSON.stringify({
              t: 'evicted',
              reason:
                'another tab opened the voice panel for this brainstorm',
            }),
          );
        } catch {
          /* socket already gone */
        }
        try {
          prior.ws.close();
        } catch {
          /* ignore */
        }
      }
      activeByBindKey.set(state.bindKey, state);
      send({
        t: 'hello-ack',
        brainstorm_id: brainstormId,
        runtime_mode: 'direct-llm',
        voice_rate: piperStatus().rate,
      });
      return;
    }
    /* Legacy cc-pty: delegate to the existing session_id-keyed
     * resolver so all the PTY + jsonl bookkeeping stays in one
     * place. */
    bind(row.claude_session_id ?? row.pty_id ?? undefined);
  }

  function startJsonlWatch(): void {
    if (state.watchTimer) return;
    state.watchTimer = setInterval(() => pollJsonl(), 250);
    startHeartbeat();
  }

  function stopJsonlWatch(): void {
    if (state.watchTimer) {
      clearInterval(state.watchTimer);
      state.watchTimer = null;
    }
    stopHeartbeat();
  }

  /* Periodic "still working" pulse while a turn is in flight. The gate
   * (lex-voice-heartbeat.ts) only fires after a real gap of silence,
   * never while audio is playing, and never in notes mode. The pulse
   * routes through speak() so it serialises with real speech and resets
   * the silence clock; it carries no answer content. */
  function startHeartbeat(): void {
    if (heartbeatTimer) return;
    heartbeatTimer = setInterval(() => {
      if (state.closed) return;
      const now = Date.now();
      /* shouldSpeakHeartbeatHaiku === shouldHeartbeat when the flag is
       * off; with it on it adds the single-mouth guard. */
      const fire = shouldSpeakHeartbeatHaiku({
        awaitingSince: state.awaitingResponseSince,
        lastSpeechMs,
        ttsActive: Boolean(state.ttsActive),
        userSpeaking: state.userSpeaking,
        lastUserSpeechEndMs: state.lastUserSpeechEndMs,
        mode: state.mode,
        now,
        intervalMs: HEARTBEAT_INTERVAL_MS,
      });
      if (fire && state.awaitingResponseSince) {
        speak(heartbeatLine(now - state.awaitingResponseSince));
      }
    }, HEARTBEAT_TICK_MS);
    if (typeof (heartbeatTimer as { unref?: () => void }).unref === 'function') {
      (heartbeatTimer as { unref: () => void }).unref();
    }
  }

  function stopHeartbeat(): void {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  /* Track which assistant-text segments have already been TTS'd so the
   * watcher does not double-speak. Per-segment hashing (not per-uuid)
   * because a single Lex turn can split a text ack into several
   * pre-tool blocks before the eventual end_turn record, and the
   * end_turn record's content array can echo earlier text blocks.
   * Storing a hash per text block lets us dedupe across both stop_
   * reason paths (end_turn and tool_use) without re-speaking text
   * the client has already heard. */
  const spokenSegmentHashes: Set<string> = new Set();

  function pollJsonl(): void {
    if (!state.jsonlPath && state.watchSessionId) {
      /* Late jsonl creation: the file may not have existed at bind
       * time but was created on first user/assistant turn. Offset
       * stamps to 0 (not EOF) so any assistant text already on disk
       * when we late-resolve is still read. Safety: the
       * `awaitingResponseSince > 0` gate + the
       * `rec.type !== 'assistant'` filter + the spokenSegmentHashes
       * dedupe in handleJsonlLine filter out any pre-bind content;
       * reading from 0 only admits content that landed AFTER the
       * matching inject. Same shape as the 2026-05-14 compaction-
       * restart bind at line 1055. */
      const jsonl = findJsonlBySessionId(state.watchSessionId);
      if (jsonl) {
        state.jsonlPath = jsonl;
        state.jsonlOffset = 0;
        /* Fix 57: path now known -> claim the canonical talkback slot so
         * a late-resolved watcher cannot free-run alongside another. */
        claimWatchTarget();
      }
    }
    if (!state.jsonlPath) {
      /* Re-resolve the jsonl path if the PTY just bound a session_id.
       * Offset = 0 for the same reason as the watchSessionId branch
       * above: the handleJsonlLine gates filter what plays. */
      const handle = state.bindKey
        ? getPty(state.bindKey) || getPtyBySession(state.bindKey)
        : undefined;
      if (handle && handle.sessionId) {
        const slug = handle.cwd.replace(/[\\/:]/g, '-');
        const claudeRoot = path.posix.join(
          os.homedir().replace(/\\/g, '/'),
          '.claude',
          'projects',
        );
        const jsonl = path.posix.join(
          claudeRoot,
          slug,
          `${handle.sessionId}.jsonl`,
        );
        if (fs.existsSync(jsonl)) {
          state.jsonlPath = jsonl;
          state.jsonlOffset = 0;
          /* Fix 57: same canonical-slot claim on the PTY late-resolve
           * branch so a global-Lex-fallback watcher cannot double-speak. */
          claimWatchTarget();
        }
      }
    }
    if (!state.jsonlPath) return;
    let stat: fs.Stats;
    try {
      stat = fs.statSync(state.jsonlPath);
    } catch {
      return;
    }
    if (stat.size <= state.jsonlOffset) return;
    let chunk: Buffer;
    try {
      const fd = fs.openSync(state.jsonlPath, 'r');
      try {
        const len = stat.size - state.jsonlOffset;
        chunk = Buffer.alloc(len);
        fs.readSync(fd, chunk, 0, len, state.jsonlOffset);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return;
    }
    state.jsonlOffset = stat.size;
    const lines = chunk.toString('utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let rec: Record<string, unknown>;
      try {
        rec = JSON.parse(trimmed);
      } catch {
        continue;
      }
      handleJsonlLine(rec);
    }
  }

  function handleJsonlLine(rec: Record<string, unknown>): void {
    if (rec.type !== 'assistant') return;
    /* Read-only watch mode: when the client supplied a watchSessionId
     * but we have no PTY to inject into, the WS can't drive the request
     * side, so awaitingResponseSince never gets set. Speak every fresh
     * end_turn from the watched session instead. spokenSegmentHashes
     * dedupes against re-reads at segment granularity. */
    const readOnly = state.watchSessionId && !state.bindKey;
    if (!readOnly && !state.awaitingResponseSince) return;
    const message = rec.message as
      | {
          content?: Array<{ type?: string; text?: string }>;
          stop_reason?: string;
          usage?: UsageLike;
        }
      | undefined;
    if (!message) return;
    /* Fix 13: speak text content on BOTH stop_reason='end_turn' and
     * stop_reason='tool_use'. The tool_use path covers the pre-tool
     * ack ("Investigating...", "On it..."): Lex emits a text block
     * AND a tool_use block in the same turn, stop_reason on that
     * record is 'tool_use' (not 'end_turn'), and the legacy gate
     * dropped the entire turn before extraction. Per-segment dedupe
     * (spokenSegmentHashes) keeps the eventual end_turn record from
     * re-speaking text the user already heard.
     *
     * Filter + dedupe live in the pure selectTtsContent helper so
     * the rules can be unit-tested without standing up the WS. */
    const decision = selectTtsContent(rec as unknown as Parameters<typeof selectTtsContent>[0], spokenSegmentHashes);
    if (decision.drop) return;
    const isPreToolAck = decision.is_pre_tool_ack;
    const text = decision.new_text;
    const fullText = decision.full_text;
    const uuid = String(rec.uuid ?? '');
    /* Stamp the dedupe set BEFORE speak() so a re-read of the same
     * jsonl line cannot double-speak. */
    for (const h of decision.new_hashes) spokenSegmentHashes.add(h);
    if (!isPreToolAck) state.awaitingResponseSince = 0;
    /* Fix 20 (2026-05-23): flush any utterances queued during
     * Lex's mid-turn-no-tts window the instant the end_turn lands.
     * Pre-tool acks are intentionally NOT a flush point — they're
     * mid-tool-use markers, not turn boundaries. */
    if (!isPreToolAck && state.pendingUserUtterances.length > 0) {
      flushPendingUtterances();
    }
    /* Phase 3 of LEX-STANDALONE-SUPERVISION (2026-05-24): flip
     * lifecycle_state back to idle (or attached when a worker is
     * bound) on the matching end_turn record so the idle-watcher
     * starts counting silence again. Pre-tool acks stay in speaking
     * because Lex is still mid-turn. Best-effort lookup; the row may
     * have been archived by an unrelated path. */
    if (!isPreToolAck) {
      try {
        const handle = state.bindKey
          ? getPty(state.bindKey) || getPtyBySession(state.bindKey)
          : null;
        const bs =
          (handle?.sessionId && getBrainstormByClaudeSessionId(handle.sessionId)) ||
          (handle?.ptyId && getBrainstormByPty(handle.ptyId)) ||
          null;
        if (bs && bs.lifecycle_state === 'speaking') {
          const post = getStore().db.getBrainstorm(bs.id);
          const nextLifecycle = post?.attached_worker_session_id
            ? 'attached'
            : 'idle';
          getStore().db.updateBrainstorm(bs.id, {
            lifecycle_state: nextLifecycle,
          });
        }
      } catch {
        /* observational */
      }
    }
    /* Always tell the client the response text, regardless of mode.
     * The panel renders it on screen. Notes-only mode skips the TTS
     * synth so Lex stays silent (the user is dictating, doesn't want
     * audio talkback). Push-to-talk still uses voice talkback by
     * default; the user can flip mode mid-session if they want
     * silence. */
    /* Wave 2 carry-over #1: surface the per-turn id + the prompt
     * version archived at spawn time so the VoiceClient can render
     * inline LexThumbs. Both fields are optional in the protocol;
     * older clients ignore them. The brainstorm row lookup uses the
     * same handle resolution the artifact-extraction block below does;
     * order matters because that block also wants brainstormId. */
    let brainstormForFeedback: { id: string; prompt_version: string | null } | null = null;
    let brainstormModeForChunk: 'conversation' | 'notes' | 'push-to-talk' = 'conversation';
    /* Originating CC session id for the chunk-write below
     * (LEX-AUTONOMY-PAYLOAD-SPEC Stage 0). Prefer the bound PTY
     * handle's session id; fall back to the watcher's tracked
     * session id; NULL out when neither is available so the column
     * stays NULL rather than receiving a stale value. */
    let ccSessionIdForChunk: string | null = null;
    try {
      const handle = state.bindKey
        ? getPty(state.bindKey) || getPtyBySession(state.bindKey)
        : undefined;
      let bs = null as
        | null
        | { id: string; prompt_version?: string | null; mode?: string };
      if (handle?.sessionId) {
        bs = getBrainstormByClaudeSessionId(handle.sessionId);
      }
      if (!bs && handle) {
        bs = getBrainstormByPty(handle.ptyId);
      }
      if (bs) {
        brainstormForFeedback = {
          id: bs.id,
          prompt_version: bs.prompt_version ?? null,
        };
        const bsMode = bs.mode;
        brainstormModeForChunk =
          bsMode === 'notes' || bsMode === 'push-to-talk' ? bsMode : 'conversation';
      }
      ccSessionIdForChunk =
        handle?.sessionId ?? state.watchSessionId ?? null;
    } catch {
      /* observability only */
    }
    /* Speak the newly-extracted text. The assistant-text frame, the
     * brainstorm-chunk insert, and the speak() call all gate on
     * `text` being non-empty. When pre-tool segments have already
     * been spoken in an earlier tool_use record AND the end_turn
     * record echoes only those segments, `text` is empty and these
     * blocks are skipped; the post-end_turn pipeline (artifacts,
     * attention, compaction) still runs on `fullText`. */
    if (text) {
      send({
        t: 'assistant-text',
        text,
        ...(uuid ? { turn_id: uuid } : {}),
        ...(brainstormForFeedback?.id ? { brainstorm_id: brainstormForFeedback.id } : {}),
        ...(brainstormForFeedback?.prompt_version
          ? { prompt_version: brainstormForFeedback.prompt_version }
          : {}),
        ...(isPreToolAck ? { pre_tool_ack: true } : {}),
      });
      /* Land an assistant turn into brainstorm_chunks the moment it
       * arrives so brainstorm_sessions.turn_count + the /lex/recall
       * retrieval surface track live conversation, not just the
       * session-end backfill. Chunk id is the CC turn uuid so the
       * brainstorm-jsonl-ingestor's next tick re-insert is a no-op
       * via INSERT OR REPLACE. When the uuid is missing (rare race
       * where the jsonl entry has not flushed) we skip; the ingestor
       * will land the row on its tick. Wrapped so a chunk insert
       * failure cannot block the speak path. The pre-tool-ack write
       * lands the partial text; the eventual end_turn write replaces
       * it with the full message text under the same uuid. */
      if (brainstormForFeedback?.id && uuid) {
        try {
          getStore().db.insertBrainstormChunk({
            id: uuid,
            brainstorm_id: brainstormForFeedback.id,
            turn_index: getStore().db.nextTurnIndex(brainstormForFeedback.id),
            role: 'lex',
            mode: brainstormModeForChunk,
            text: isPreToolAck ? text : fullText,
            model_id: process.env.DEVNEURAL_LEX_MODEL_ID ?? 'claude',
            no_decay: 1,
            cc_session_id: ccSessionIdForChunk,
          });
        } catch {
          /* observational; never block speak() */
        }
      }
      if (state.mode === 'notes') {
        send({ t: 'tts-skipped', reason: 'notes-mode' });
      } else if (state.suppressSpeakForTurn) {
        /* Typed-input turn: text-only reply. The assistant-text frame
         * and brainstorm chunk above already landed, so the panel shows
         * the answer; we just never synthesize audio for it. */
        send({ t: 'tts-skipped', reason: 'text-input' });
      } else {
        /* Fix 53 (2026-06-18): never synthesize the same assistant
         * record twice. The eviction in claimWatchTarget already keeps
         * a single watcher per session; this is the backstop for the
         * one-poll-tick race where a reconnecting watcher overlaps the
         * outgoing one. Keyed per (watch-target, record, segment-role)
         * so a real pre-tool ack + end_turn body of the same turn both
         * still play, and a genuinely identical later reply (different
         * record uuid) is never suppressed. */
        const speakKey = `${state.watchSessionId ?? state.jsonlPath ?? state.bindKey ?? ''}::${uuid || decision.new_hashes[0] || text.slice(0, 64)}::${isPreToolAck ? 'ack' : 'body'}`;
        if (claimSpokenRecord(speakKey)) {
          /* Hard cap: a pre-tool ack speaks a short heard-you signal
           * only, never the answer. The answer is spoken once, at
           * end_turn. Structural enforcement so a fat ack can never be
           * heard as a second response. The visual frame + chunk above
           * still carry the full text. */
          speak(isPreToolAck ? clampAck(text) : text);
        } else {
          send({ t: 'tts-skipped', reason: 'already-spoken' });
        }
      }
    }
    /* Pre-tool ack stops here. The follow-on end_turn record from
     * the same Lex turn will run artifacts / attention / large-fs /
     * compaction on the full message text. */
    if (isPreToolAck) return;
    /* Slice C: scan the assistant turn for fenced artifact blocks
     * (research-note / wiki-draft / project-intent / notes-summary),
     * persist them, and link the artifact ids into the brainstorm
     * row. Notes-summary entries also fan out into the reminders
     * system. Wrapped in try so a malformed artifact never blocks
     * the turn from speaking. Note: text-mode chats that don't open
     * this voice WS currently miss extraction. A daemon-wide
     * brainstorm jsonl watcher is the follow-up. */
    try {
      const brainstormId = brainstormForFeedback?.id ?? null;
      const persisted = processAssistantTurn(fullText, {
        brainstormId,
        fallbackTitle: fullText.slice(0, 60),
        ...(uuid ? { dedupeKey: uuid } : {}),
      });
      if (persisted.length > 0) {
        send({
          t: 'artifacts',
          items: persisted.map((p) => ({
            id: p.id,
            kind: p.kind,
            category: p.category,
            title: p.title,
            ...(p.reminder_ids ? { reminder_ids: p.reminder_ids } : {}),
          })),
        });
      }
    } catch {
      /* artifact extraction is observational; never block speak() */
    }
    /* Real-time attention notification. When the assistant turn ends
     * with a decision-shaped question (yes/no, pick-one, short prompt
     * with '?') we fire a push so the user gets pulled back from
     * whatever else they were doing. The dispatcher handles quiet
     * hours internally - suppressed pushes still write to the in-app
     * notification log so the user can catch up after waking. Wrapped
     * so a notification failure cannot block the speak path. */
    try {
      fireAttentionForLexTurn({
        brainstorm_id: brainstormForFeedback?.id ?? null,
        turn_id: uuid || null,
        text: fullText,
      });
    } catch {
      /* attention dispatch is observational; never block speak() */
    }
    /* Wave 3 Lane B step 41 (LX-16). Heuristic large-fs-read detector.
     * When Lex returns a Bash tool result that looks like a grep/find
     * dump exceeding LARGE_FS_READ_LINE_THRESHOLD lines, emit an
     * awareness event so the dashboard trace shows the read. The
     * detection is line-count only; it does not parse tool_use blocks. */
    try {
      const lineCount = fullText.split('\n').length;
      if (lineCount >= LARGE_FS_READ_LINE_THRESHOLD) {
        /* Extract first word-like pattern as a proxy for the grep arg. */
        const patternMatch = fullText.match(/grep\s+(?:-[a-z]+\s+)*["']?([^\s"']+)["']?/i);
        const pattern = patternMatch?.[1] ?? '(large output)';
        let brainstormId: string | null = null;
        try {
          const handle = state.bindKey
            ? getPty(state.bindKey) || getPtyBySession(state.bindKey)
            : undefined;
          if (handle?.sessionId) {
            const bs = getBrainstormByClaudeSessionId(handle.sessionId);
            if (bs) brainstormId = bs.id;
          }
        } catch { /* best-effort */ }
        notifyLargeFsRead({ pattern, line_count: lineCount, brainstorm_id: brainstormId });
      }
    } catch {
      /* observational; never block turn */
    }
    /* The speak / tts-skipped frame fires earlier (inside the
     * `if (text)` block before the pre-tool-ack early return) so a
     * tool_use record's pre-ack text reaches the speaker. The end_
     * turn record may have already-spoken segments (newText empty);
     * in that case there is nothing left to speak here and the
     * pipeline below runs against fullText. */
    /* Mid-session compaction check. End-of-turn is the ONLY boundary
     * at which a restart is safe (the spec is strict: never cut
     * mid-sentence). When shouldTriggerCompaction crosses 75% of the
     * model's max context, run the synchronous session-end pipeline
     * (distill + summary + RAG embed) and then spawn-restart the
     * same anchor so the brainstorm UI keeps the same anchor id and
     * the cold-start preload force-distills the just-ended sibling
     * before the new session reads it. Compaction state lives on
     * ConnState so a trailing end_turn from the same jsonl tail
     * cannot re-fire while the first restart is still distilling. */
    const usage = message?.usage;
    const tokens = contextTokensFromUsage(usage);
    if (tokens > 0) {
      const brainstormAnchorId = brainstormForFeedback?.id ?? null;
      void maybeCompactOnTurnEnd(
        { contextTokens: tokens },
        {
          state: state.compaction,
          log: (msg) => console.log(msg),
          runSessionEnd: async () => {
            await fireSessionEndPipeline('compaction-restart');
          },
          spawnRestart: async () => {
            if (!brainstormAnchorId) {
              return { ok: false, error: 'no anchor handle' };
            }
            try {
              /* Lookup the brainstorm cwd so feedback memories rebake
               * into the compaction-restart prompt. The handle resolves
               * via the current bindKey; if it has been torn down (rare
               * during the restart window) the cwd falls back to
               * undefined and the hard-rules block is simply absent
               * for this restart. */
              const handle = state.bindKey
                ? getPty(state.bindKey) || getPtyBySession(state.bindKey)
                : undefined;
              const restartCwd = handle?.cwd;
              const built = buildLexSpawnPrompt({
                lexSessionId: brainstormAnchorId,
                transcriptPaths: [],
                ...(restartCwd ? { cwd: restartCwd } : {}),
              });
              if (built.feedback_memories.kept.length > 0) {
                console.log(
                  `[lex-compaction] hard-rules baked into restart prompt kept=${built.feedback_memories.kept.length} cwd=${restartCwd}`,
                );
              }
              const fresh = spawnLexSession({
                lexSessionId: brainstormAnchorId,
                extraArgs: ['--dangerously-skip-permissions'],
                systemPrompt: built.prompt,
              });
              /* Internal rebind BEFORE killing the old PTY. Without
               * this the WS keeps watching the old jsonl + injecting
               * into the dying PTY, so the first reply on the fresh
               * session lands in the new jsonl while the WS is still
               * pointed at the old one and never reaches the speak
               * path. Bug 2026-05-14-no-tts-on-first-prompt-after-
               * restart fixed by repointing every per-session field
               * here:
               *
               *   - state.watchSessionId / state.jsonlPath /
               *     state.jsonlOffset move to the new transcript so
               *     the existing pollJsonl watcher (250ms tick reads
               *     state.jsonlPath dynamically) picks up the new
               *     file on its next tick.
               *   - state.bindKey moves to the new PTY id so
               *     handleUtteranceEnd's ptyInject targets the live
               *     session instead of the dying one.
               *   - state.awaitingResponseSince is stamped NOW so the
               *     handleJsonlLine gate ("only speak when this WS
               *     drove the inject OR we're read-only") admits the
               *     first end_turn that lands on the new session even
               *     if the user types the prompt into the brainstorm
               *     UI instead of speaking it.
               *   - state.sessionEndFired / state.compaction
               *     .compactedAt reset so the new session's own end-
               *     of-life pipeline can fire later and so the new
               *     session can also compact when it crosses the
               *     threshold.
               *   - spokenSegmentHashes clears so the speak dedupe doesn't
               *     accidentally suppress a reply whose uuid happens
               *     to match the prior session's last spoken record.
               *   - activeByBindKey re-keyed on the new bindKey so a
               *     second tab's hello against the new session
               *     correctly evicts this socket if needed. */
              const priorBindKey = state.bindKey;
              if (priorBindKey && activeByBindKey.get(priorBindKey) === state) {
                activeByBindKey.delete(priorBindKey);
              }
              state.watchSessionId = fresh.ccSessionId;
              state.jsonlPath = fresh.transcriptPath;
              state.jsonlOffset = 0;
              state.bindKey = fresh.ptyId;
              state.awaitingResponseSince = Date.now();
              state.sessionEndFired = false;
              state.compaction.compactedAt = 0;
              spokenSegmentHashes.clear();
              activeByBindKey.set(state.bindKey, state);
              startJsonlWatch();
              /* Kill the prior PTY AFTER the internal rebind so the
               * pollJsonl watcher already points at the new file by
               * the time onExit's session-end pipeline runs (its
               * lock + sessionEndFired guard turn the duplicate
               * invocation into a no-op anyway, but the timing keeps
               * the brainstorm anchor live-bound throughout). */
              try {
                if (priorBindKey) {
                  const handle =
                    getPty(priorBindKey) || getPtyBySession(priorBindKey);
                  if (handle && !handle.exited) {
                    handle.pty.kill();
                  }
                }
              } catch {
                /* observational; restart already succeeded */
              }
              send({
                t: 'session-restart',
                reason: 'compaction',
                new_session_id: fresh.ccSessionId,
                new_pty_id: fresh.ptyId,
              });
              return { ok: true, new_session_id: fresh.ccSessionId };
            } catch (err) {
              return { ok: false, error: (err as Error).message };
            }
          },
        },
      ).catch((err) => {
        console.log(
          `[lex-compaction] supervisor threw: ${(err as Error).message}`,
        );
      });
    }
  }

  /* Fix 40 (2026-05-26): speak() is now a thin wrapper over the
   * speak-queue controller. The controller owns the piper lifecycle
   * — see lex-voice-speak-controller.ts for the serialise-vs-cancel
   * contract. Same-turn segments (pre-tool ack + end_turn body)
   * queue and play back-to-back; barge / hold-up clears the queue
   * and cancels the in-flight ctx as one atomic boundary. */
  function speak(text: string): void {
    /* Reset the heartbeat silence clock on any real speech (ack, body,
     * or a heartbeat pulse itself) so a pulse only fires after a genuine
     * gap of silence. */
    lastSpeechMs = Date.now();
    /* Pillar 3: route spoken output through the renderer (preserve-list
     * verbatim guard). Passthrough when the flag is off. */
    const spoken = renderForSpeech(text);
    lastSpokenText = spoken;
    speakCtrl.speak(spoken);
  }

  /* Brainstorm-as-durable-primary-entity (2026-05-22, Path B).
   *
   * Direct-llm utterance handler. Runs when the WS is bound to a
   * brainstorm with runtime_mode='direct-llm' (no Lex PTY backing
   * it). Three steps:
   *
   *   1. Persist the user transcript as a brainstorm_chunks row so
   *      the chunk count + retrieval indices stay in sync with
   *      legacy cc-pty brainstorms.
   *   2. Assemble the LLM conversation: system prompt (current Lex
   *      version), live_state snapshot, last_summary (when present),
   *      replay the recent assistant/user history, append the new
   *      user message. Call callVoiceChat (ollama, local-only) and
   *      take the reply text.
   *   3. Persist the assistant reply as a brainstorm_chunks row, hand
   *      the text to speak() so piper streams TTS through the same
   *      pipeline cc-pty uses. lifecycle_state flips through
   *      speaking -> idle so the dashboard sees the state machine. */
  /* Fix 35 Phase A (2026-05-26): direct-llm coalesce loop. Wraps
   * handleDirectLlmUtterance with a single-output-stream gate +
   * post-reply drain so the queue contract is satisfied without
   * touching the ollama call site itself. Sequencing:
   *
   *   1. Stamp inFlightDirectLlmReply=true; run handleDirectLlmUtterance
   *      to completion (await; failures clear the flag in finally).
   *   2. Check pendingUserUtterances; if non-empty, drain via
   *      formatQueueDrain into one combined turn and repeat.
   *   3. Exit when the queue is empty, leaving inFlightDirectLlmReply
   *      cleared so the next fresh utterance dispatches immediately.
   *
   * The loop is async + fire-and-forget at the call site. */
  async function runDirectLlmCoalesceLoop(initial: string): Promise<void> {
    let pending: string = initial;
    while (pending) {
      state.inFlightDirectLlmReply = true;
      try {
        await handleDirectLlmUtterance(pending);
      } finally {
        state.inFlightDirectLlmReply = false;
      }
      if (state.pendingUserUtterances.length === 0) break;
      const queued = state.pendingUserUtterances.slice();
      state.pendingUserUtterances = [];
      const drain = formatQueueDrain(queued);
      if (!drain) break;
      console.log(
        `[voice-ws] direct-llm drain count=${drain.count} chars=${drain.text.length}`,
      );
      pending = drain.text;
    }
  }

  async function handleDirectLlmUtterance(userText: string): Promise<void> {
    const bsId = state.brainstormId;
    if (!bsId) return;
    const bs = getBrainstorm(bsId);
    if (!bs) {
      send({
        t: 'error',
        code: 'no-brainstorm',
        message: 'brainstorm row disappeared mid-turn',
      });
      return;
    }
    const store = getStore();
    /* Step 1: persist the user turn. */
    try {
      const userTurnId = randomUUID();
      const turnIdx = store.db.nextTurnIndex(bsId);
      store.db.insertBrainstormChunk({
        id: userTurnId,
        brainstorm_id: bsId,
        turn_index: turnIdx,
        role: 'user',
        mode: state.mode,
        text: userText,
        model_id: 'voice-direct-llm',
        /* direct-LLM voice path has no CC session bound; per spec
         * (LEX-AUTONOMY-PAYLOAD-SPEC Stage 0) NULL is the
         * documented behavior for non-CC-attached writers. */
        cc_session_id: null,
      });
    } catch (err) {
      console.log(
        `[voice-ws] direct-llm user chunk insert failed: ${(err as Error).message}`,
      );
    }
    /* Step 2: assemble messages + call LLM. Stamps last_user_utterance
     * _at (Phase 3 of LEX-STANDALONE-SUPERVISION) so the idle-watcher
     * resets the silence baseline on every user turn. Combined with
     * lifecycle_state='speaking' the row is fully marked active. */
    store.db.updateBrainstorm(bsId, {
      lifecycle_state: 'speaking',
      last_user_utterance_at: new Date().toISOString(),
    });
    try {
      const sysVersion = buildLexSystemPromptVersioned({ mode: state.mode });
      const snapshot = buildVoiceSnapshot({ activeBrainstormCwd: bs.cwd ?? null });
      /* Replay the last N user/assistant pairs into the chat history
       * so qwen carries multi-turn context. The chunks table already
       * has the freshly-inserted user turn; pull the prior N before
       * it to avoid duplicating the latest message. */
      const HISTORY_TURNS = 16;
      const prior = store.db.listBrainstormChunks(bsId, HISTORY_TURNS + 1, {
        order: 'desc',
      });
      /* Drop the latest entry (the user turn we just inserted) and
       * reverse so messages are oldest-first for the LLM. */
      const historyAsc = prior.slice(1).reverse();
      const messages: Array<{
        role: 'system' | 'user' | 'assistant';
        content: string;
      }> = [
        { role: 'system', content: sysVersion.prompt },
        { role: 'system', content: snapshot },
      ];
      if (bs.last_summary) {
        messages.push({
          role: 'system',
          content: `# Prior session summary\n${bs.last_summary}`,
        });
      }
      for (const c of historyAsc) {
        messages.push({
          role: c.role === 'lex' ? 'assistant' : 'user',
          content: c.text,
        });
      }
      messages.push({ role: 'user', content: userText });
      /* COALESCE Phase B AbortController: bind a controller so a
       * contradiction utterance arriving mid-call can cancel ollama
       * immediately. AbortError is caught below + treated as a
       * "cancelled mid-reply" outcome (no chunk, no speak). */
      const controller = new AbortController();
      state.directLlmAbort = controller;
      let reply;
      try {
        reply = await callVoiceChat(messages, { signal: controller.signal });
      } catch (err) {
        if ((err as Error).name === 'AbortError' || controller.signal.aborted) {
          console.log(
            `[voice-ws] direct-llm reply aborted mid-call bs=${bsId.slice(0, 8)}`,
          );
          send({ t: 'direct-llm-aborted', reason: 'contradiction' });
          return;
        }
        throw err;
      } finally {
        if (state.directLlmAbort === controller) state.directLlmAbort = null;
      }
      /* Step 3: persist the assistant turn + speak it. */
      try {
        const replyTurnId = randomUUID();
        const turnIdx = store.db.nextTurnIndex(bsId);
        store.db.insertBrainstormChunk({
          id: replyTurnId,
          brainstorm_id: bsId,
          turn_index: turnIdx,
          role: 'lex',
          mode: state.mode,
          text: reply.text,
          model_id: reply.modelId,
          cc_session_id: null,
        });
      } catch (err) {
        console.log(
          `[voice-ws] direct-llm assistant chunk insert failed: ${(err as Error).message}`,
        );
      }
      if (state.mode !== 'notes' && !state.suppressSpeakForTurn) {
        await speak(reply.text);
      } else if (state.suppressSpeakForTurn) {
        /* Typed input to Lex-as-LLM: reply lands as text only (panel +
         * chunk already persisted above), never spoken. */
        send({ t: 'tts-skipped', reason: 'text-input' });
      }
      send({ t: 'injected' });
      /* Plan section M (2026-05-22): scan both the user's turn and
       * Lex's reply for a deferral phrase. On regex+LLM gate hit,
       * auto-create a reminder + a deferrals artifact ref on the
       * brainstorm so the user never has to manually capture
       * "phase 2", "future date", "later", etc. Fire-and-forget:
       * detection failures never block voice. */
      void detectDeferral({
        brainstormId: bsId,
        turnText: userText,
        source: 'user',
      }).catch(() => undefined);
      void detectDeferral({
        brainstormId: bsId,
        turnText: reply.text,
        source: 'lex-assistant',
      }).catch(() => undefined);
    } catch (err) {
      send({
        t: 'error',
        code: 'direct-llm',
        message: (err as Error).message,
      });
    } finally {
      const post = store.db.getBrainstorm(bsId);
      const nextLifecycle = post?.attached_worker_session_id
        ? 'attached'
        : 'idle';
      store.db.updateBrainstorm(bsId, { lifecycle_state: nextLifecycle });
    }
  }

  /* Daemon-enforced barge-in. Wave 4 (2026-05-22): client-side VAD
   * teardown alone was unreliable (commit d6f094a fixed one wedge
   * but observation showed TTS still bleeding through on intermittent
   * race conditions). The voice WS is the floor: utterance-start
   * unconditionally calls this so no race between dashboard heal
   * loops and incoming PCM can leave Lex talking over the user.
   *
   * Steps, in order, ALL gated on ttsActive being non-null:
   *   1. Stop piper streaming (kill child process). The 'end' handler
   *      sees `cancelled=true` and stays silent; the 'data' handler
   *      drops any tail chunks already in the kernel pipe buffer.
   *   2. Send a tts-cancel frame so the client's audio engine bumps
   *      its generation counter and discards already-scheduled
   *      AudioBufferSourceNodes plus any binary chunks in flight.
   *   3. Send Ctrl+C to the bound Claude Code PTY so the worker
   *      aborts whatever assistant turn it was mid-generation on.
   *
   * Fix 20 (2026-05-23): step 3 used to be unconditional. The prior
   * "No state check, no gating - utterance-start always kills"
   * directive was revised because it killed Lex mid-tool-use whenever
   * the user spoke while Lex was reasoning silently (no TTS in
   * flight). Repro from FIXES.md row 20: user dispatched a worker
   * task, then spoke again to add context; the second utterance
   * fired a PTY Ctrl+C against Lex's still-running tool sequence
   * and Lex lost mid-flight state.
   *
   * New rule: PTY Ctrl+C only fires when TTS was actually playing.
   * Mid-reasoning, mid-tool-use, or idle: no abort. The mid-tool-use
   * utterance is instead queued via state.pendingUserUtterances in
   * handleUtteranceEnd and dispatched at the next natural turn
   * boundary (when handleJsonlLine clears awaitingResponseSince on
   * the end_turn record). */
  function killActiveTts(reason: 'utterance-start' | 'barge-in'): void {
    /* Fix 40 (2026-05-26): controller owns the ctx + queue + partial-
     * chain bookkeeping. It returns true when a real in-flight ctx
     * was cancelled (vs an idle state with a possibly non-empty
     * queue). The tts-cancel WS frame + PTY Ctrl+C only fire on a
     * real cancellation per the existing Fix 20 contract — an
     * idle-state kill is just a queue-clear and should be silent
     * on the wire. */
    const cancelled = speakCtrl.killActive();
    if (!cancelled) return;
    send({ t: 'tts-cancel', reason });
    /* Only abort the PTY turn when TTS was actually in flight. The
     * user is interrupting Lex's spoken reply; the worker should
     * drop the rest of the turn. When TTS is null we DO NOT abort
     * because the user may be stacking follow-on context onto an
     * in-flight reasoning/tool sequence (handled in
     * handleUtteranceEnd via pendingUserUtterances). */
    if (state.bindKey) {
      const handle = getPty(state.bindKey) || getPtyBySession(state.bindKey);
      if (handle && !handle.exited) {
        try {
          handle.pty.write('\x03');
        } catch {
          /* ignore */
        }
      }
    }
  }

  /* Fix 20 (2026-05-23): flush queued mid-turn-no-tts utterances at
   * the next natural turn boundary. Called from handleJsonlLine when
   * Lex's end_turn record lands (i.e. awaitingResponseSince has just
   * been cleared) AND pendingUserUtterances has at least one entry.
   *
   * Construction is intentionally minimal compared to the live
   * handleUtteranceEnd path: snapshot/gate/partial-chain are skipped
   * because (a) the queued utterances arrived close in time so the
   * original turn's snapshot is still fresh and (b) the queue
   * marker itself tells Lex that these are deferred follow-ons, not
   * the start of a new conversation. Voice tag is preserved so Lex's
   * conversational voice contract still applies. */
  function flushPendingUtterances(): void {
    _flushPendingUtterancesImpl({
      state,
      ptyInject,
      send,
    });
  }

  /* Voice-command dispatch shared by the whisper-transcript path
   * (inside handleUtteranceEnd) and the new wake-command WS frame
   * fired by the client's always-on Web Speech / hotkey listener.
   * The wake path fires while TTS is playing and micGated has paused
   * the VAD, so without dedupe both paths would emit the same frame
   * for one utterance (or log two panic rows). lastVoiceCmdMs holds
   * the most recent fire timestamp per kind and the source tag is
   * surfaced in the log so audit can tell which path won the race. */
  const VOICE_CMD_DEDUPE_MS = 1500;
  function dispatchVoiceCommand(
    kind: VoiceCommandKind,
    source: 'transcript' | 'wake',
    payload?: { project_name?: string },
  ): boolean {
    const now = Date.now();
    const prev = state.lastVoiceCmdMs[kind] ?? 0;
    if (now - prev < VOICE_CMD_DEDUPE_MS) {
      console.log(
        `[voice-ws] voice-command dedupe kind=${kind} source=${source} prev_ms_ago=${now - prev}`,
      );
      return false;
    }
    state.lastVoiceCmdMs[kind] = now;
    switch (kind) {
      case 'panic': {
        try {
          const r = firePanic(getStore().db, {
            caller: source === 'wake' ? 'lex-voice-wake' : 'lex-voice',
            clickedMs: now,
            injector: ptyInject,
          });
          send({
            t: 'panic-fired',
            result: r.result,
            target_anchor_id: r.target?.id ?? null,
          });
        } catch {
          /* never block the voice loop on audit-row write */
        }
        return true;
      }
      case 'end_session': {
        console.log(
          `[voice-ws] voice-cmd matched kind=end_session source=${source} bindKey=${state.bindKey ?? 'null'} watchSessionId=${state.watchSessionId ?? 'null'} brainstormId=${state.brainstormId ?? 'null'}`,
        );
        send({ t: 'session-end', reason: 'voice-command' });
        /* Fix 30: voice "lex end session" must equal clicking the End
         * button. The pipeline call distills + writes ref_summary; the
         * follow-up tears the PTY down and flips the anchor dormant
         * so the dashboard tile + Stream Deck slot release in the same
         * pass. Previous behaviour ran only the pipeline and left the
         * row "live", which broke parity with the UI affordance. */
        void (async () => {
          try {
            await fireSessionEndPipeline('voice-command');
          } catch (err) {
            console.log(
              `[voice-ws] end_session: pipeline threw ${(err as Error).message}`,
            );
          }
          const anchorId = state.brainstormId;
          if (!anchorId) return;
          try {
            const row = getLexSession(anchorId);
            if (row?.current_pty_id) {
              try {
                ptyKill(row.current_pty_id);
              } catch {
                /* best-effort */
              }
            }
            setLexSessionStatus(anchorId, {
              status: 'dormant',
              currentPtyId: null,
            });
            console.log(
              `[voice-ws] end_session: anchor flipped dormant ${anchorId}`,
            );
          } catch (err) {
            console.log(
              `[voice-ws] end_session: anchor teardown failed ${anchorId}: ${(err as Error).message}`,
            );
          }
        })();
        return true;
      }
      case 'mute': {
        send({ t: 'voice-mute', reason: 'voice-command' });
        return true;
      }
      case 'unmute': {
        send({ t: 'voice-unmute', reason: 'voice-command' });
        return true;
      }
      case 'standby': {
        /* Soft mic pause. Client halts STT capture but keeps the
         * wake-word recognizer + TTS state untouched so the operator
         * can rearm with `lex listen`. */
        send({ t: 'voice-standby', reason: 'voice-command' });
        return true;
      }
      case 'listen': {
        /* Rearm STT capture after standby. Wake recognizer is
         * already on; TTS state is independent. */
        send({ t: 'voice-listen', reason: 'voice-command' });
        return true;
      }
      case 'disable': {
        /* One-way teardown. Mic + WS go away; no voice command can
         * rearm because the recognizers are gone. The user must
         * click `start voice` to recover. */
        send({ t: 'voice-disable', reason: 'voice-command' });
        return true;
      }
      case 'hold_up': {
        /* Fix 2026-05-24: hard abort of Lex's current activity.
         * Cancels TTS, sends ^C to the Lex PTY (which makes Claude
         * Code's tool sequencer drop the in-flight tool_use plan and
         * thereby drops any cross-session inject Lex was about to
         * POST), re-opens the mic, and speaks a one-sentence recap +
         * "what is up?" so the user can redirect. The worker is
         * deliberately untouched: no PTY write, no bridge queue
         * write, no /lex/inject-cross-session POST. Already-delivered
         * injects to the worker are NOT clawed back. */
        const intended = state.currentTtsText;
        runHoldUp({
          cancelTts: () => {
            /* Fix 40 (2026-05-26): delegate to speakCtrl.killActive so
             * the queue clear + partialChain capture + ctx-cancellation
             * stay in lock-step with killActiveTts. hold-up always
             * boundaries a logical turn, so any queued same-turn
             * segments must drop with the in-flight ctx. */
            speakCtrl.killActive();
          },
          ctrlCLexPty: () => {
            if (state.bindKey) {
              const handle =
                getPty(state.bindKey) || getPtyBySession(state.bindKey);
              if (handle && !handle.exited) {
                try {
                  handle.pty.write('\x03');
                } catch {
                  /* ignore */
                }
              }
            }
          },
          sendFrame: send,
          speak: (text) => {
            void speak(text);
          },
          intendedText: intended,
        });
        /* Fix 29 (2026-05-25): runHoldUp's Ctrl+C aborts the Lex
         * PTY mid-turn, so no end_turn jsonl record lands to clear
         * awaitingResponseSince at line 746. Without these resets
         * the next utterance hits the mid-turn-no-tts gate, queues
         * into pendingUserUtterances, and never injects (the flush
         * point is gated on the same end_turn that never arrives).
         * Clear the mid-turn state inline so the next user
         * utterance routes through the normal inject path. */
        state.awaitingResponseSince = 0;
        state.pendingUserUtterances = [];
        spokenSegmentHashes.clear();
        return true;
      }
      case 'start_project': {
        /* LEX-AUTONOMY codex 10c (Fix 47 step 3): "lex start project
         * <name>" routes through the same dashboard endpoint that
         * the Start Claude button hits, so the loose-ends gate +
         * VS Code spawn behave identically across surfaces. The
         * voice surface reads the result back to the operator: on
         * 409 it enumerates the first three blocking loose-end
         * classes; on success it confirms the project name. */
        const projectName = (payload?.project_name ?? '').trim();
        if (!projectName) return false;
        void runStartProjectVoice(projectName);
        return true;
      }
    }
  }

  async function runStartProjectVoice(projectName: string): Promise<void> {
    /* Resolve project registry by case-insensitive fuzzy match:
     * exact id, then exact name, then prefix-of-name, then
     * substring. First match wins. Bail with a spoken response
     * when nothing matches so the operator hears the failure. */
    let projectId: string | null = null;
    let projectLabel = projectName;
    try {
      const { listProjects } = await import('../identity/registry.js');
      const projects = listProjects();
      const target = projectName.toLowerCase();
      const exactId = projects.find((p) => p.id.toLowerCase() === target);
      const exactName = projects.find(
        (p) => (p.name ?? '').toLowerCase() === target,
      );
      const prefix = projects.find((p) =>
        (p.name ?? '').toLowerCase().startsWith(target),
      );
      const substr = projects.find((p) =>
        (p.name ?? '').toLowerCase().includes(target),
      );
      const hit = exactId ?? exactName ?? prefix ?? substr ?? null;
      if (hit) {
        projectId = hit.id;
        projectLabel = hit.name ?? hit.id;
      }
    } catch {
      /* registry read failed; fall through to "not found" path */
    }
    if (!projectId) {
      void speak(`Could not find a project matching ${projectName}.`);
      return;
    }
    const port = Number(process.env.DEVNEURAL_PORT ?? 3747);
    const url = `http://127.0.0.1:${port}/projects/${encodeURIComponent(projectId)}/start-claude`;
    const anchorId = state.brainstormId ?? null;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          dangerous: false,
          ...(anchorId ? { anchor_id: anchorId } : {}),
        }),
      });
      if (res.status === 409) {
        const body = (await res.json()) as {
          loose_ends?: {
            ends?: Array<{ class: string; detail?: string }>;
          };
        };
        const ends = body.loose_ends?.ends ?? [];
        const top = ends.slice(0, 3).map((e) => e.class.replace(/_/g, ' '));
        const list =
          top.length > 0 ? top.join(', ') : 'an unspecified loose end';
        void speak(
          `Cannot start ${projectLabel} yet. Loose ends blocking: ${list}.`,
        );
        return;
      }
      if (!res.ok) {
        void speak(
          `Failed to start ${projectLabel}; daemon returned status ${res.status}.`,
        );
        return;
      }
      void speak(`Starting ${projectLabel}.`);
    } catch (err) {
      void speak(
        `Could not reach the daemon to start ${projectLabel}: ${(err as Error).message}.`,
      );
    }
  }

  function isVoiceCommandKind(v: unknown): v is VoiceCommandKind {
    return (
      typeof v === 'string' &&
      (ALL_VOICE_COMMAND_KINDS as ReadonlyArray<string>).includes(v)
    );
  }

  /* N-deep barge integration (2026-05-22): render the unresolved
   * partial chain as a [voice-context] block that prepends the next
   * user inject. Lex's system prompt has the matching rule
   * ("integrate interrupted threads with the latest input as one
   * cohesive natural response"); this block hands Lex the receipts
   * so it can do the integration deterministically. */
  function renderPartialChain(): string {
    if (state.partialChain.length === 0) return '';
    const lines: string[] = [];
    lines.push('[voice-context: interrupted-replies]');
    lines.push(
      'Your prior reply(ies) were cut off mid-delivery by the user. ' +
        'Per the partial-integration rule, weave the interrupted thread(s) ' +
        'with the latest user input into one cohesive natural response. ' +
        'Do not restart the prior reply from scratch and do not repeat ' +
        'fragments the user already heard.',
    );
    for (let i = 0; i < state.partialChain.length; i++) {
      const e = state.partialChain[i]!;
      const delayMs = Math.max(0, e.cancelled_at_ms - e.started_at_ms);
      lines.push('');
      lines.push(
        `Interrupted reply ${i + 1} (cut off ~${delayMs}ms into delivery):`,
      );
      lines.push(`Intended text: ${JSON.stringify(e.intended_text)}`);
    }
    lines.push('');
    lines.push('[end voice-context]');
    return lines.join('\n');
  }

  async function handleUtteranceEnd(): Promise<void> {
    if (state.micBuf.length === 0) {
      send({ t: 'error', code: 'empty-utterance', message: 'no audio' });
      return;
    }
    const pcm = Buffer.concat(state.micBuf);
    state.micBuf = [];
    state.micBufBytes = 0;
    /* Wrap as 16k mono 16-bit WAV (whisper-server expects WAV). */
    const int16 = new Int16Array(
      pcm.buffer,
      pcm.byteOffset,
      pcm.byteLength / 2,
    );
    const wav = pcm16ToWav(int16, 16000);
    let result: { text: string; ms: number };
    try {
      result = await transcribeWav(wav);
    } catch (err) {
      send({ t: 'error', code: 'stt', message: (err as Error).message });
      return;
    }
    /* Post-Whisper sanity drop. Whisper happily transcribes silence
     * and room noise as either an empty string, the literal sentinel
     * `[BLANK_AUDIO]`, or a single throwaway word ("you", "thanks",
     * "okay"). Forwarding any of those to Lex pollutes the brainstorm
     * with phantom turns and burns a Claude Code response on noise.
     * Drop here before anything reaches the chat / brainstorm
     * pipeline; still send a transcript frame with empty text so the
     * client flips back to ready instead of sitting on "transcribing".
     * Panic + end-session triggers are both 2+ words so this floor
     * does not cut them off. */
    const trimmed = result.text.trim();
    const wordCount = trimmed
      ? trimmed.split(/\s+/).filter((w) => w.length > 0).length
      : 0;
    const isBlankMarker = trimmed === '[BLANK_AUDIO]';
    /* A single decisive command word ("go", "stop", "proceed") bypasses
     * the 2-word noise floor so the user can steer tersely. Strip
     * trailing punctuation whisper tends to append ("Go.") first. */
    const isShortCommand =
      wordCount === 1 &&
      SHORT_COMMAND_WORDS.has(trimmed.toLowerCase().replace(/[.!?,]+$/g, ''));
    if (!trimmed || isBlankMarker || (wordCount < 2 && !isShortCommand)) {
      const reason = !trimmed
        ? 'empty'
        : isBlankMarker
          ? 'blank-audio-marker'
          : 'too-few-words';
      console.log(
        `[voice-ws] dropped whisper utterance: reason=${reason} words=${wordCount} text=${JSON.stringify(trimmed)}`,
      );
      send({ t: 'transcript', text: '', ms: result.ms });
      return;
    }
    send({ t: 'transcript', text: result.text, ms: result.ms });
    /* Real voice turn confirmed (passed the noise floor): Lex talks
     * back. Clears any suppression a prior typed turn left set. */
    state.suppressSpeakForTurn = false;
    console.log(
      `[voice-ws] transcript received words=${wordCount} bindKey=${state.bindKey ?? 'null'} duringTts=${state.utteranceStartedDuringTts} text=${JSON.stringify(trimmed.slice(0, 120))}`,
    );
    /* Wave 2 day 2 step 11: persist this utterance into the per-session
     * audio bundle so /brainstorms/:id/audio can serve it back later.
     * Brainstorm sessions retain audio by default; meeting sessions
     * (kind='meeting') only retain audio once consent_acked=1 (BF-17 /
     * spec line 281). The lookup is best-effort: if we can't find the
     * brainstorm row from this socket's bind state, skip persistence
     * rather than retain audio that has no canonical owner row. */
    try {
      const handle = state.bindKey
        ? getPty(state.bindKey) || getPtyBySession(state.bindKey)
        : null;
      const watchSid = handle?.sessionId ?? state.watchSessionId ?? null;
      const ptyId = handle?.ptyId ?? null;
      const bs =
        (watchSid && getBrainstormByClaudeSessionId(watchSid)) ||
        (ptyId && getBrainstormByPty(ptyId)) ||
        null;
      if (bs) {
        const consent = (bs as { kind?: string; consent_acked?: number }).consent_acked ?? 0;
        const kind = (bs as { kind?: string }).kind ?? 'brainstorm';
        const consentOk = kind !== 'meeting' || consent === 1;
        if (consentOk) {
          appendSessionAudio(bs.id, pcm, 16000);
        }
        /* User-turn chunk insert moved into brainstorm-jsonl-ingestor.
         * Previously this block wrote a brainstorm_chunks row keyed on
         * a fresh randomUUID, which produced a duplicate alongside the
         * ingestor's deterministic id (= cc turn uuid). The ingestor
         * runs every 5s and walks the same jsonl on the next tick, so
         * the lag for /lex/recall is bounded but the transcript stream
         * stays a single coherent artifact across voice + typed input. */
      }
    } catch {
      /* audio bundle is observational; never block the turn */
    }
    /* Hands-free stop: if the transcript matches a spoken end-session
     * command, skip the inject path so Lex doesn't reply, and notify
     * the client to tear down. Notes-mode users who want the dictation
     * summary should press Stop instead — voice command is an
     * immediate close. */
    /* Unified Lex voice-command dispatch. Every command requires the
     * literal "lex" prefix so meeting chatter cannot false-fire any
     * branch. The dispatcher resolves the longest-match-wins
     * precedence (panic > end_session > mute > unmute > disable) in
     * one place so the wire frames below stay deterministic.
     *
     *   panic       -> firePanic + 'panic-fired' frame (no inject)
     *   end_session -> 'session-end' frame + run end-session pipeline
     *   mute        -> 'voice-mute' frame; client halts TTS, keeps
     *                  rendering transcript turns with a silent flag
     *   unmute      -> 'voice-unmute' frame; client resumes TTS, no
     *                  auto-replay of messages received during mute
     *   disable     -> 'voice-disable' frame; client teardown
     *                  equivalent to clicking the stop button (in-
     *                  flight Lex thinking + worker actions both
     *                  continue; the user must re-engage via the UI
     *                  to get TTS back) */
    const cmd = matchVoiceCommand(result.text);
    console.log(
      `[voice-ws] matcher result kind=${cmd?.kind ?? 'none'} duringTts=${state.utteranceStartedDuringTts}`,
    );
    if (cmd) {
      dispatchVoiceCommand(
        cmd.kind,
        'transcript',
        cmd.kind === 'start_project' ? { project_name: cmd.project_name } : undefined,
      );
      state.utteranceStartedDuringTts = false;
      return;
    }
    /* Pillar 3 capstone: haiku front desk. When DEVNEURAL_VOICE_HAIKU is
     * on, every inbound utterance routes through frontDeskDecision -
     * control jumps the data lane (never queued), glue is answered alone
     * (zero Opus), a question gets an instant bridge line then falls
     * through to the normal Lex inject (rendered on reply by speak()).
     * Flag off: haikuRoute returns null and this whole block is skipped,
     * so the path below is byte-identical. lex-prefixed ops above still
     * take precedence. assumeDigestFresh: the deterministic fast-lane
     * glue never reads the digest, so it stays answerable; the
     * digest-staleness gate engages when a live model answers from digest
     * content (Lex-authored digest push is a later step). */
    if (useVoiceHaiku()) {
      const dec = haikuRoute(trimmed, { lastTurnMs: 0, assumeDigestFresh: true });
      if (dec) {
        if (dec.route.lane === 'control') {
          const c = dec.route.control!;
          if (c.action === 'interrupt-then-inject' && c.payload) {
            /* redirect: free Lex, then inject the new instruction as this
             * turn (falls through to the normal inject path below). */
            killActiveTts('barge-in');
            result = { text: c.payload, ms: result.ms };
            state.utteranceStartedDuringTts = false;
          } else {
            if (c.action === 'kill-tts') {
              /* quiet / ambiguous stop: silence the voice locally, zero
               * Lex round-trip. NOT a PTY Ctrl+C - Lex keeps working. */
              const cancelled = speakCtrl.killActive();
              if (cancelled) send({ t: 'tts-cancel', reason: 'quiet' });
            } else {
              /* stop-work / abort: interrupt Lex + worker (TTS + Ctrl+C). */
              killActiveTts('barge-in');
            }
            state.utteranceStartedDuringTts = false;
            return;
          }
        } else if (dec.route.lane === 'fast') {
          /* haiku alone: answer glue with zero Opus round-trip. The reply
           * is LIVE haiku in persona (warm + varied) when a key is set,
           * else the deterministic fallback. A bare ack returns null and
           * is absorbed silently. */
          const reply = await composeGlueReply(trimmed, lastSpokenText);
          if (reply) speak(reply);
          state.utteranceStartedDuringTts = false;
          return;
        } else {
          /* slow: instant bridge now, Lex reasons below, reply rendered
           * through the preserve-list when it lands. */
          if (dec.route.bridge) speak(dec.route.bridge);
          state.utteranceStartedDuringTts = false;
          /* fall through to the existing inject path */
        }
      }
    }
    /* Wake-during-TTS gate (path 1 of the voice-cmd-blocked-during-
     * TTS audit). If this utterance began while Lex was streaming TTS
     * and the wake matcher did NOT match a command, drop the inject.
     * The most likely source of such a transcript is AEC residual:
     * Lex's own audio bleeding into the mic, transcribed by whisper
     * as nonsense or as a fragment of Lex's reply. Injecting that as
     * a user turn would derail the brainstorm. The transcript frame
     * already went to the client so the operator can see what
     * happened; only the daemon-side inject is suppressed. */
    if (state.utteranceStartedDuringTts) {
      console.log(
        `[voice-ws] suppressed non-wake utterance during TTS: ${JSON.stringify(result.text.slice(0, 80))}`,
      );
      state.utteranceStartedDuringTts = false;
      return;
    }
    /* Brainstorm-as-durable-primary-entity (2026-05-22, Path B).
     * Direct-llm branch: no PTY, no jsonl watch. Build the system
     * prompt + brainstorm chunks history, call ollama, stream the
     * reply through piper, persist user + assistant chunks. The
     * legacy cc-pty path below stays untouched. */
    if (state.runtimeMode === 'direct-llm' && state.brainstormId) {
      /* Fix 35 Phase A (2026-05-26): single-output-stream invariant
       * for direct-llm.
       *
       * Pre-fix this branch was `void handleDirectLlmUtterance(text)`
       * with no reentrancy guard. A second utterance landing while
       * the first call was still mid-ollama would spawn a parallel
       * ollama request + a concurrent speak(), violating the sealed
       * coalesce contract (point 1: never begin response B while
       * response A is in flight).
       *
       * New behaviour:
       *  - inFlightDirectLlmReply gate: queue subsequent utterances
       *    onto pendingUserUtterances; drain at reply boundary.
       *  - Contradiction case (point 5): if the latest utterance
       *    matches a cancel pattern AND a reply is in flight, drop
       *    the queue and ack the cancel. The in-flight ollama call
       *    is not aborted (it still lands as one assistant chunk),
       *    but the queue is empty so no follow-on inject replays
       *    the original instruction. */
      if (state.inFlightDirectLlmReply) {
        if (detectContradiction(result.text)) {
          const dropped = state.pendingUserUtterances.length;
          state.pendingUserUtterances = [];
          /* COALESCE Phase B: abort the in-flight ollama call so the
           * cancelled instruction stops generating immediately rather
           * than landing as one more assistant chunk after the user
           * already said "cancel". */
          if (state.directLlmAbort) {
            try {
              state.directLlmAbort.abort();
            } catch {
              /* best-effort; controller may have completed */
            }
          }
          console.log(
            `[voice-ws] direct-llm contradiction; cleared queue depth=${dropped} text=${JSON.stringify(result.text.slice(0, 80))} aborted_inflight=true`,
          );
          send({
            t: 'contradiction-cancel',
            text: result.text,
            dropped_count: dropped,
          });
          return;
        }
        state.pendingUserUtterances.push(result.text);
        console.log(
          `[voice-ws] direct-llm mid-reply queue push depth=${state.pendingUserUtterances.length} text=${JSON.stringify(result.text.slice(0, 80))}`,
        );
        send({
          t: 'queued-mid-turn',
          text: result.text,
          queue_depth: state.pendingUserUtterances.length,
        });
        return;
      }
      void runDirectLlmCoalesceLoop(result.text);
      return;
    }
    if (!state.bindKey) {
      send({ t: 'error', code: 'no-bind', message: 'not bound to a Lex PTY' });
      return;
    }
    /* Tag the turn with the active voice mode so Lex can follow her
     * voice contract (shorter, conversational, no markdown lists)
     * without us having to mutate the system prompt mid-session.
     * The marker is recognised in the system prompt; Lex strips it
     * before reasoning. */
    const voiceTag =
      state.mode === 'notes'
        ? '[voice mode: notes, silent reply, capture as artifact] '
        : '[voice mode] ';
    /* Prepend a fresh live-state snapshot to every voice turn. The
     * spawn-time Layer 6 snapshot is stale and Claude Code's harness
     * injects its own "Working directories" block above it, which Lex
     * tends to read instead of Layer 6. Putting the snapshot directly
     * inside the user message (right next to the question) makes it
     * impossible to ignore. The system prompt has the matching rule
     * that says "always answer project/session questions from this
     * block, never from harness cwd lists". */
    let snapshotBlock = '';
    try {
      /* Three-tier memory + docs index (2026-05-22): pass the active
       * brainstorm cwd so buildVoiceSnapshot can locate the Claude
       * Code per-project MEMORY.md and emit memory_index + docs_index
       * sections in the live_state block. Resolution chain: bound
       * PTY -> brainstorm row -> cwd; falls back to the watch session
       * id when the PTY handle is gone. */
      const liveHandle = state.bindKey
        ? getPty(state.bindKey) || getPtyBySession(state.bindKey)
        : null;
      const watchSidForCwd = liveHandle?.sessionId ?? state.watchSessionId ?? null;
      const bsForCwd =
        (watchSidForCwd && getBrainstormByClaudeSessionId(watchSidForCwd)) ||
        (liveHandle?.ptyId && getBrainstormByPty(liveHandle.ptyId)) ||
        null;
      snapshotBlock =
        buildVoiceSnapshot({
          activeBrainstormCwd: bsForCwd?.cwd ?? null,
          query: result.text,
        }) +
        '\n\n';
    } catch {
      /* observability only; fall back to no snapshot rather than
       * blocking the turn */
    }
    /* Wave 3 Lane B step 33 (LX-11b): tool gate check. When the user's
     * transcript matches an internal-vocabulary term, prepend a note
     * instructing Lex to check internal sources before WebSearch. The
     * gate does NOT hard-block the inject; it prepends a note only.
     * Awareness event is emitted by checkToolGate itself. */
    let gateNote = '';
    try {
      const gate = checkToolGate(result.text);
      if (gate.blocked && gate.note) {
        gateNote = gate.note + '\n\n';
      }
    } catch {
      /* gate is observational; never block the turn */
    }
    /* Wave 3 fixup (bug: 2026-05-10-cc-feedback-prompt-unanswerable).
     * Refuse to forward the transcribed utterance when claude code is
     * currently displaying a native rating / y-n / continue prompt.
     * Otherwise the user's voice would land in the prompt response
     * field and submit a bogus rating. Surface the block to the
     * client so the panel can show "voice paused while CC prompt is
     * open"; the user can still answer the prompt manually in the
     * terminal. */
    if (isAwaitingSystemPrompt(state.bindKey)) {
      send({
        t: 'error',
        code: 'cc-feedback-prompt-active',
        message:
          'Claude Code system prompt is open in the terminal. Voice injection paused; answer the prompt in the terminal or wait for it to dismiss.',
      });
      return;
    }
    /* Fix 20 (2026-05-23): mid-turn-no-tts utterance queueing.
     * If Lex is mid-turn (awaitingResponseSince > 0) and no TTS is
     * playing, the user is stacking follow-on context onto an
     * in-flight reasoning / tool sequence. Don't inject mid-stream;
     * push into the pending queue and let handleJsonlLine flush it
     * the moment Lex's end_turn lands. The TTS-active case is a
     * "barge over Lex's reply" and is already handled by
     * killActiveTts (PTY Ctrl+C + tts-cancel + partialChain). */
    if (state.awaitingResponseSince > 0 && !state.ttsActive) {
      /* Addendum 2026-05-24: belt-and-suspenders voice-command
       * punch-through. matchVoiceCommand already ran at the top of
       * handleUtteranceEnd, but re-check at the queue's edge so any
       * future refactor that lands command text here cannot silently
       * swallow it. lex panic / end_session / mute / unmute /
       * disable / hold_up MUST interrupt mid-tool-use; queueing them
       * would defer the interrupt to the next turn boundary, which
       * defeats the wake-word contract. */
      const lateCmd = matchVoiceCommand(result.text);
      if (lateCmd) {
        console.log(
          `[voice-ws] mid-turn-queue: lex command "${lateCmd.kind}" punches through, dispatching synchronously`,
        );
        dispatchVoiceCommand(
          lateCmd.kind,
          'transcript',
          lateCmd.kind === 'start_project'
            ? { project_name: lateCmd.project_name }
            : undefined,
        );
        return;
      }
      state.pendingUserUtterances.push(result.text);
      console.log(
        `[voice-ws] mid-turn-no-tts queue push depth=${state.pendingUserUtterances.length} text=${JSON.stringify(result.text.slice(0, 80))}`,
      );
      send({
        t: 'queued-mid-turn',
        text: result.text,
        queue_depth: state.pendingUserUtterances.length,
      });
      return;
    }
    /* N-deep barge integration: emit the unresolved partial chain
     * as a [voice-context] block ahead of the user's transcript so
     * Lex sees what was interrupted and can weave it into the next
     * reply per the system-prompt rule. */
    let partialChainBlock = '';
    if (state.partialChain.length > 0) {
      partialChainBlock = renderPartialChain() + '\n\n';
    }
    const ir = ptyInject(
      state.bindKey,
      snapshotBlock + gateNote + partialChainBlock + voiceTag + result.text,
      true,
    );
    if (!ir.ok) {
      send({ t: 'error', code: 'inject', message: ir.error });
      return;
    }
    /* Consume the partial chain only after a successful inject. If
     * inject fails, the chain stays so the retry path on the next
     * utterance still carries the partials. */
    state.partialChain = [];
    send({ t: 'injected' });
    state.awaitingResponseSince = Date.now();
    /* Phase 3 of LEX-STANDALONE-SUPERVISION (2026-05-24): stamp the
     * brainstorm row so the idle-watcher resets its silence baseline
     * and the row reflects "speaking" lifecycle. Best-effort lookup
     * via the bound handle's session id; direct-llm path stamps in
     * handleDirectLlmUtterance. handleJsonlLine flips lifecycle_state
     * back to idle/attached on the matching end_turn record. */
    try {
      const handle = state.bindKey
        ? getPty(state.bindKey) || getPtyBySession(state.bindKey)
        : null;
      const bs =
        (handle?.sessionId && getBrainstormByClaudeSessionId(handle.sessionId)) ||
        (handle?.ptyId && getBrainstormByPty(handle.ptyId)) ||
        null;
      if (bs) {
        getStore().db.updateBrainstorm(bs.id, {
          lifecycle_state: 'speaking',
          last_user_utterance_at: new Date().toISOString(),
        });
      }
    } catch {
      /* observational; never block the turn */
    }
    startJsonlWatch();
  }

  socket.on('message', (raw: unknown, isBinary?: boolean) => {
    /* fastify-websocket gives us either a string-ish JSON message or
     * a Buffer of binary PCM. Distinguish by isBinary or by content. */
    if (Buffer.isBuffer(raw) && (isBinary || looksBinary(raw))) {
      if (state.micBufBytes + raw.length > MIC_BUF_MAX) {
        send({
          t: 'error',
          code: 'utterance-too-long',
          message: 'mic buffer overflow; speak shorter',
        });
        state.micBuf = [];
        state.micBufBytes = 0;
        return;
      }
      state.micBuf.push(raw);
      state.micBufBytes += raw.length;
      return;
    }
    let msg: Record<string, unknown>;
    try {
      const text =
        typeof raw === 'string'
          ? raw
          : Buffer.isBuffer(raw)
            ? raw.toString('utf-8')
            : String(raw);
      msg = JSON.parse(text);
    } catch {
      return;
    }
    switch (msg.t) {
      case 'hello':
        if (
          msg.mode === 'conversation' ||
          msg.mode === 'notes' ||
          msg.mode === 'push-to-talk'
        ) {
          state.mode = msg.mode;
        }
        /* Brainstorm-as-durable-primary-entity (2026-05-22, Path B).
         * Prefer brainstorm_id-keyed bind so a standalone direct-llm
         * brainstorm (no Lex PTY) can attach. Falls through to the
         * legacy session_id/pty_id resolver when no brainstorm_id is
         * supplied OR the resolved brainstorm is runtime_mode=
         * 'cc-pty'. The two paths share the same socket from this
         * point on; handleUtteranceEnd branches on state.runtimeMode. */
        if (typeof msg.brainstorm_id === 'string' && msg.brainstorm_id) {
          bindByBrainstorm(msg.brainstorm_id);
        } else {
          bind(typeof msg.session_id === 'string' ? msg.session_id : undefined);
        }
        break;
      case 'set-mode':
        if (
          msg.mode === 'conversation' ||
          msg.mode === 'notes' ||
          msg.mode === 'push-to-talk'
        ) {
          state.mode = msg.mode;
          send({ t: 'mode-set', mode: state.mode });
        }
        break;
      case 'utterance-start':
        /* Daemon-enforced barge-in floor (2026-05-22). Capture
         * whether TTS was active BEFORE the kill so the AEC-bleed
         * gate downstream still sees the truth. */
        state.utteranceStartedDuringTts = state.ttsActive !== null;
        /* User holds the floor until utterance-end; suppress any
         * working-heartbeat pulse for the duration. */
        state.userSpeaking = true;
        killActiveTts('utterance-start');
        state.micBuf = [];
        state.micBufBytes = 0;
        break;
      case 'utterance-end':
        /* User released the floor. Clear the heartbeat suppression and
         * stamp the moment so the cooldown keeps a pulse off the heels
         * of their last word. */
        state.userSpeaking = false;
        state.lastUserSpeechEndMs = Date.now();
        void handleUtteranceEnd();
        break;
      case 'text-input': {
        /* Fix 57 (2026-06-01) COALESCE Phase C: typed input flows
         * through the same coalesce + flush pipeline voice uses. The
         * sealed spec point 6 ("universal voice + text") says there
         * is ONE queue per brainstorm, not two; this frame is the
         * text half of that contract.
         *
         * Skips voice command matching (typing "lex panic" must not
         * fire panic; the typed path has no wake-word convention).
         * Skips the AEC bleed gate (typed input cannot be audio
         * residue). Persistence to brainstorm_chunks happens via the
         * same handleDirectLlmUtterance / brainstorm-jsonl-ingestor
         * paths the voice transcript exercises, so the chunk row
         * lands without a dedicated insert here. */
        const rawText = typeof msg.text === 'string' ? msg.text.trim() : '';
        if (!rawText) {
          send({ t: 'error', code: 'empty-text-input', message: 'text required' });
          break;
        }
        send({ t: 'transcript', text: rawText, ms: 0, source: 'text-input' });
        /* Typed turn: suppress talkback TTS for this turn (text in =
         * text-only reply). A subsequent voice utterance flips it back. */
        state.suppressSpeakForTurn = true;
        if (state.runtimeMode === 'direct-llm' && state.brainstormId) {
          if (state.inFlightDirectLlmReply) {
            if (detectContradiction(rawText)) {
              const dropped = state.pendingUserUtterances.length;
              state.pendingUserUtterances = [];
              if (state.directLlmAbort) {
                try {
                  state.directLlmAbort.abort();
                } catch {
                  /* best-effort */
                }
              }
              send({
                t: 'contradiction-cancel',
                text: rawText,
                dropped_count: dropped,
              });
              break;
            }
            state.pendingUserUtterances.push(rawText);
            send({
              t: 'queued-mid-turn',
              text: rawText,
              queue_depth: state.pendingUserUtterances.length,
            });
            break;
          }
          void runDirectLlmCoalesceLoop(rawText);
          break;
        }
        if (!state.bindKey) {
          send({
            t: 'error',
            code: 'no-bind',
            message: 'not bound to a Lex PTY',
          });
          break;
        }
        if (isAwaitingSystemPrompt(state.bindKey)) {
          send({
            t: 'error',
            code: 'cc-feedback-prompt-active',
            message:
              'Claude Code system prompt is open in the terminal. Text injection paused.',
          });
          break;
        }
        const ir = ptyInject(state.bindKey, rawText, true);
        if (!ir.ok) {
          send({ t: 'error', code: 'inject', message: ir.error });
          break;
        }
        send({ t: 'injected', source: 'text-input' });
        state.awaitingResponseSince = Date.now();
        startJsonlWatch();
        break;
      }
      case 'wake-command': {
        /* Client-side always-on listener (Web Speech API or
         * keyboard hotkey) matched a Lex voice command while the
         * normal VAD/STT path was gated (micGated during TTS). The
         * client posts the matched kind here so we run the same
         * dispatch the transcript path would have. dispatchVoice
         * Command dedupes per-kind in a 1.5s window so the trailing
         * whisper transcript carrying the same phrase no longer
         * fires twice. */
        const kind = (msg as { kind?: unknown }).kind;
        if (!isVoiceCommandKind(kind)) {
          send({
            t: 'error',
            code: 'bad-wake-kind',
            message: 'wake-command requires a valid kind',
          });
          break;
        }
        dispatchVoiceCommand(kind, 'wake');
        break;
      }
      case 'barge-in':
        /* Legacy explicit barge frame. Kept for client backwards
         * compat. utterance-start already does the same kill on
         * its path; this is idempotent when ttsActive has already
         * been nulled. */
        killActiveTts('barge-in');
        break;
      case 'finalize-notes': {
        /* Notes-mode "stop" finalize. The user is ending a dictation
         * session and wants Lex to emit a notes-summary artifact
         * before the WS tears down. We inject a synthetic prompt so
         * the artifact-parser pipeline (Slice C) handles persistence
         * and reminder fan-out without any extra path. The client
         * is expected to wait for the next assistant-text before
         * closing the socket. */
        if (!state.bindKey) {
          send({
            t: 'error',
            code: 'no-bind',
            message: 'cannot finalize: not bound to a Lex PTY',
          });
          break;
        }
        const finalizePrompt =
          '[notes-mode finalize] Emit a single notes-summary artifact ' +
          'summarising the dictation session up to this point. Include ' +
          'summary, action_items, reminders_to_create (with due_at when ' +
          'a date or time was mentioned), and topics_covered. Use the ' +
          '```artifact:notes-summary fenced JSON contract. After the ' +
          'fenced block, write one sentence acknowledging the close.';
        const ir = ptyInject(state.bindKey, finalizePrompt, true);
        if (!ir.ok) {
          send({ t: 'error', code: 'inject', message: ir.error });
          break;
        }
        send({ t: 'finalize-injected' });
        state.awaitingResponseSince = Date.now();
        startJsonlWatch();
        break;
      }
      case 'ping':
        send({ t: 'pong' });
        break;
      default:
        /* unknown message type, ignore for forward-compat */
        break;
    }
  });

  /* End-of-session ingest + summary + RAG embed pipeline. Idempotent
   * across the multiple end paths (voice command, WS close, server-
   * detected disconnect): the first call sets sessionEndFired and any
   * subsequent calls no-op so a brainstorm session never gets a
   * double-summary or a redundant force-ingest. Best-effort: failures
   * are logged not thrown so teardown always proceeds. */
  async function fireSessionEndPipeline(reason: string): Promise<void> {
    if (state.sessionEndFired) {
      console.log(
        `[voice-ws] session-end pipeline: latch already fired reason=${reason}`,
      );
      return;
    }
    state.sessionEndFired = true;
    console.log(
      `[voice-ws] session-end pipeline entered reason=${reason} bindKey=${state.bindKey ?? 'null'} watchSessionId=${state.watchSessionId ?? 'null'} brainstormId=${state.brainstormId ?? 'null'}`,
    );
    try {
      /* Resolve the brainstorm. Direct-llm sockets reach the
       * brainstorm via state.brainstormId without ever touching a
       * PTY; legacy cc-pty sockets reach it via the bound PTY +
       * jsonl session id. */
      let bs = state.brainstormId ? getBrainstorm(state.brainstormId) : null;
      let claudeSessionId: string | null = null;
      if (!bs) {
        const handle = state.bindKey
          ? getPty(state.bindKey) || getPtyBySession(state.bindKey)
          : null;
        claudeSessionId = handle?.sessionId ?? state.watchSessionId ?? null;
        const ptyId = handle?.ptyId ?? null;
        bs =
          (claudeSessionId && getBrainstormByClaudeSessionId(claudeSessionId)) ||
          (ptyId && getBrainstormByPty(ptyId)) ||
          null;
      }
      if (!bs) {
        /* Voice WS without a brainstorm row (read-only TTS bind, or
         * a session that ended before the row was created). Nothing
         * to summarise; skip silently. */
        console.log(
          `[voice-ws] session-end pipeline: brainstorm row not resolved (handle=${state.bindKey ?? 'null'} watch=${state.watchSessionId ?? 'null'} bsId=${state.brainstormId ?? 'null'} reason=${reason}); skipping`,
        );
        return;
      }
      /* Plan section F amendment (2026-05-22): triggers table.
       *
       *   ws-close + direct-llm -> runDistillationFlush (brainstorm
       *     stays alive across voice disconnects; next attached
       *     worker / next voice resume gets fresh last_summary)
       *   voice end-session     -> runSessionEndPipeline (terminal)
       *   compaction-restart    -> runSessionEndPipeline (legacy)
       *   ws-close + cc-pty     -> runSessionEndPipeline (legacy
       *     teardown; cc-pty brainstorms still tear down on ws
       *     close to preserve existing behavior). */
      const isDirectLlm = (bs.runtime_mode ?? 'cc-pty') === 'direct-llm';
      const flushOnly = reason === 'ws-close' && isDirectLlm;
      const runner = flushOnly ? runDistillationFlush : runSessionEndPipeline;
      await runner(
        getBrainstormStore(),
        {
          brainstormId: bs.id,
          claudeSessionId: bs.claude_session_id ?? claudeSessionId,
          mode: bs.mode || state.mode,
          reason,
        },
        (msg) => console.log(msg),
      );
      if (flushOnly) {
        /* Re-arm so a subsequent voice end-session / explicit UI end
         * can still fire the terminal pipeline on the same in-memory
         * state. Without resetting the latch, a voice disconnect
         * followed by an explicit end command would no-op. */
        state.sessionEndFired = false;
      }
    } catch (err) {
      console.log(
        `[voice-ws] session-end pipeline failed: ${(err as Error).message}`,
      );
    }
  }

  function teardown(): void {
    state.closed = true;
    stopJsonlWatch();
    if (state.ttsActive) {
      state.ttsActive.cancel();
      state.ttsActive = null;
    }
    if (state.bindKey && activeByBindKey.get(state.bindKey) === state) {
      activeByBindKey.delete(state.bindKey);
    }
    /* Fix 53 (2026-06-18): drop this connection from the watch-target
     * registry. Value-scan rather than key lookup because the watched
     * target (watchSessionId / jsonlPath) can be late-resolved or
     * re-pointed after the initial claim. */
    for (const [k, v] of activeByWatchTarget) {
      if (v === state) activeByWatchTarget.delete(k);
    }
    /* Fire-and-forget the end-of-session pipeline. Awaiting here would
     * block the close handler and Fastify's WS plumbing; the pipeline
     * does its own best-effort error handling. */
    void fireSessionEndPipeline('ws-close');
  }

  socket.on('close', teardown);
  socket.on('error', teardown);
}

/* Heuristic for "is this binary PCM or a JSON text frame?" — fastify-
 * websocket on some versions doesn't pass isBinary; if the first byte
 * isn't '{' / '[' / '"' / a digit, treat as binary. PCM int16 has
 * roughly uniform-distributed first bytes so almost never starts
 * with one of those text-leading chars. */
function looksBinary(buf: Buffer): boolean {
  if (buf.length < 1) return false;
  const b = buf[0]!;
  return !(b === 0x7b || b === 0x5b || b === 0x22 || (b >= 0x30 && b <= 0x39));
}
