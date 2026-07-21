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
  prewarmVoiceBrainSession,
  isVoiceBrainSessionWarm,
  isVoiceBrainSessionEnabled,
} from '../lex/voice-brain-session.js';
import {
  getBrainstormByClaudeSessionId,
  getBrainstormByPty,
  getStore as getBrainstormStore,
  getBrainstorm,
  setKind as setBrainstormKind,
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
import {
  buildVoiceSnapshot,
  resolveLexScope,
  resolveLexScopeDetailed,
} from '../lex/snapshot-context.js';
import { callVoiceChat } from '../llm/voice-chat.js';
import { detectDeferral } from '../lex/deferral-detector.js';
import { randomUUID } from 'node:crypto';
import {
  matchPanicCommand,
  ALL_VOICE_COMMAND_KINDS,
  type VoiceCommandKind,
} from './lex-voice-commands.js';
import {
  voiceLexReply,
  type LexReplyOutcome,
} from './voice-top-layer.js';
import {
  isSmartTurnEnabled,
  analyzeTurn,
  decideCoalesce,
  emptyCoalescerState,
  type TurnVerdict,
} from './smart-turn.js';
import { runHoldUp } from './lex-voice-hold-up.js';
/* Voice engine (2026-07-17, VOICE-TOP-LAYER-SPEC): the carved-out
 * modules this monolith now delegates its safety decisions to. */
import { createEchoRegistry, classifyEcho } from './engine/echo-filter.js';
import {
  advanceBargeGate,
  createBargeGateState,
  type BargeGateState,
} from './engine/barge-word-gate.js';
import {
  classifyIncomingTranscript,
  extendedDuringTts,
} from './engine/ws-glue.js';
import {
  createEndpointState,
  decideEndpoint,
  ENDPOINT_CHECK_INTERVAL_MS,
} from './engine/endpoint-governor.js';
import {
  classifyStopUtterance,
  truncateToHeard,
} from './engine/interrupt-arbiter.js';
import {
  createDeliveryRegistry,
  fingerprintUtterance,
} from './engine/delivery-dedupe.js';
import {
  detectContradiction,
  formatQueueDrain,
} from './lex-voice-coalesce.js';
import { firePanic } from '../dashboard/panic-routes.js';
import { getStore } from '../lex/brainstorm-store.js';
import { checkToolGate, notifyLargeFsRead, LARGE_FS_READ_LINE_THRESHOLD } from '../lex/tool-gate.js';
import { runDistillationFlush } from '../lex/session-end-pipeline.js';
import { queueSessionEndPipeline } from '../lex/distill-pending.js';
import { appendUtterance as appendSessionAudio } from './audio-bundle.js';
import { selectTtsContent, decidePreToolAck } from './select-tts-content.js';
import {
  renderForSpeech,
  shouldCaptureAbsorbedAside,
  _pushAbsorbedAsideImpl,
  _formatAbsorbedAsideBlockImpl,
  type AbsorbedAsideEntry,
} from './voice-haiku-wiring.js';
import { splitForSpeech } from './lex-voice-speak-controller.js';
import { useVoiceHaiku } from './voice-haiku.js';
import {
  pushDigest,
  getDigest,
  buildVoiceDigest,
  type LexDigest,
} from './voice-digest.js';

/* Injected daemon logger (mirrors embedder/index.ts's setEmbedderLogger
 * pattern). Every console.log/warn/error in this file used to write to
 * stdout, which the daemon only ever redirects to daemon.stdout.log /
 * daemon.stderr.log via Start-Process; those files sit at 0 bytes after
 * days of uptime, so the whole [voice-ws] / [lex-compaction] diagnostic
 * stream was invisible. Defaults to a no-op so standalone imports (tests,
 * scripts) never crash; daemon.ts (or whichever module first imports this
 * file at daemon startup) must call setVoiceWsLogger(logger) to route
 * these lines into daemon.log. */
let logFn: (msg: string) => void = () => undefined;
export function setVoiceWsLogger(log: (msg: string) => void): void {
  logFn = log;
}

/* Voice modes drive whether the daemon synthesizes Lex's response
 * out loud. The browser still receives transcript + assistant-text
 * events in every mode so the on-screen panel updates regardless. */
type VoiceMode = 'conversation' | 'notes' | 'push-to-talk';

/* Direct-llm reply delivery plan (typed-input transcript fix,
 * 2026-07-19). The Lex transcript panel is fed by LIVE WS frames
 * (assistant-text), never by a brainstorm_chunks poll, so the
 * assistant-text frame is the ONLY channel that renders a reply as text.
 * The direct-llm reply path previously delivered the reply ONLY through
 * speak(), so suppressing TTS for a typed turn (suppressSpeakForTurn)
 * also made the reply INVISIBLE - it was persisted to brainstorm_chunks
 * but never rendered. This decouples the two decisions: renderTranscript
 * fires for EVERY turn with text (typed or voice), independent of
 * whether we speak. speak/ttsSkipped preserve the prior behavior exactly
 * (voice speaks; typed is silent with a tts-skipped frame; notes is
 * silent with no frame). Pure + exported so the decoupling pins without
 * a live WS. */
export interface DirectLlmReplyDelivery {
  /** Emit the assistant-text transcript frame (renders in the panel). */
  renderTranscript: boolean;
  /** Synthesize + speak the reply audio. */
  speak: boolean;
  /** Reason for a tts-skipped frame when audio is intentionally skipped;
   * null when we speak, or when nothing is emitted (notes). */
  ttsSkippedReason: 'text-input' | null;
}

export function planDirectLlmReplyDelivery(input: {
  replyText: string;
  mode: VoiceMode;
  suppressSpeakForTurn: boolean;
}): DirectLlmReplyDelivery {
  const hasText = Boolean(input.replyText);
  const speak =
    hasText && input.mode !== 'notes' && !input.suppressSpeakForTurn;
  const ttsSkippedReason = input.suppressSpeakForTurn ? 'text-input' : null;
  return { renderTranscript: hasText, speak, ttsSkippedReason };
}

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
  /* Half-duplex mic gate (2026-06-18). userSpeaking is true between
   * utterance-start and utterance-end; lastUserSpeechEndMs is the
   * instant the user last stopped. Lex speaking mutes the mic, so any
   * spoken output while the user holds the floor makes Lex deaf to
   * them; these fields let the speak path hold back until the floor
   * clears. */
  userSpeaking: boolean;
  lastUserSpeechEndMs: number;
  /* Absolute user floor (#4, 2026-07-19). True while the user physically
   * holds push-to-talk (the client sends utterance-start on PTT down,
   * utterance-end on release). While held, Lex emits ZERO audio: speak()
   * drops every segment so nothing plays over the user. Distinct from
   * userSpeaking on purpose - userSpeaking is also set by vad-onset on
   * mere mic ENERGY (noise), and gating audio on that would truncate
   * Lex's own in-flight reply. PTT is the one unambiguous floor signal,
   * so only it silences the mouth. VAD interrupts are handled by the
   * word-gated barge, which stops playback only on real non-echo words. */
  pttFloorHeld: boolean;
  /* Talkback speak-suppression gate (2026-06-19). Set true when the
   * turn was triggered by TYPED input (text-input frame), false when
   * triggered by a real voice utterance. The talkback watcher and the
   * direct-llm reply both consult it: typed input gets a text-only
   * reply (panel frame + chunk still land) and is NEVER spoken. Last
   * input source wins, so the user's most recent channel decides
   * whether Lex talks back. Consulted at the two speak() sites (the
   * talkback watcher and the direct-llm reply). The visual +
   * persistence paths are unaffected. */
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
  /* SM-25 smart stacking (2026-07-18, operator): one top-layer voice
   * turn at a time. While a topLayerTurn ask is in flight, newer
   * utterances queue here instead of firing concurrent asks (which
   * produced stacked discrete replies spoken back to back). If the
   * in-flight ask resolves with its reply still UNSPOKEN, the queue
   * supersedes it: one combined re-ask answers everything
   * cohesively. Distinct from pendingUserUtterances above, which is
   * the MID-layer (Lex inject) boundary queue. */
  topTurnInFlight: boolean;
  pendingTopUtterances: string[];
  /* P1 top-owned ack (2026-07-18): true from the moment the TOP layer
   * speaks its own handoff on an escalated forward until the deep
   * turn's end_turn. While true, deep pre-tool acks are suppressed (the
   * top already acked out loud - no double-ack, no stale-ack race).
   * Left false on a fail-safe forward where the top produced no handoff,
   * so the deep pre-tool ack is the safety net there. */
  topOwnsAck: boolean;
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
  /* Fast-lane transcript hole fix (2026-07-15). Bounded ring of
   * conversation-mode asides the haiku fast lane absorbed (glue reply
   * spoken, nothing forwarded to Lex - see the 'fast' lane branch in
   * handleUtteranceEnd and _captureAbsorbedAsideImpl below). Drained
   * into a one-line-per-aside prefix on the NEXT real ptyInject to
   * Lex so she becomes aware of the exchange on her next turn without
   * forcing an extra round-trip; cleared only after that inject
   * succeeds. Capped via _pushAbsorbedAsideImpl (voice-haiku-
   * wiring.ts) so a long chatty gap before Lex's next real turn
   * cannot grow this unbounded. If no real inject happens before
   * session end, the durable record is the brainstorm_chunks rows
   * _captureAbsorbedAsideImpl already wrote - this ring is only the
   * awareness mechanism, never the record of truth. */
  absorbedAsides: AbsorbedAsideEntry[];
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
export function findJsonlBySessionId(sessionId: string): string | null {
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

/* Replay-on-switch (2026-07-09). When a voice client binds to a session
 * that just produced a reply the user may not have heard - they were on
 * another brainstorm, or just switched to this one - speak that last
 * reply once so switching catches you up. Guarded by recency: binding to
 * a session whose last turn is old (loading /lex hours later) never dumps
 * a stale reply. DEVNEURAL_VOICE_REPLAY_ON_SWITCH=0 disables it;
 * DEVNEURAL_VOICE_REPLAY_WINDOW_MS tunes the window (default 8 min). */
const REPLAY_ON_SWITCH =
  (process.env.DEVNEURAL_VOICE_REPLAY_ON_SWITCH ?? '1') !== '0';
const REPLAY_WINDOW_MS = Number(
  process.env.DEVNEURAL_VOICE_REPLAY_WINDOW_MS ?? 8 * 60 * 1000,
);

/* Stale-replay gate (2026-07-16). Four firings in one night (ages 2s,
 * 76s, 43s, 93s): the operator stop/started voice repeatedly and every
 * reconnect re-spoke the previous reply, including ones he had already
 * fully heard ("why do you keep saying that"). The AUDIO replay now
 * requires BOTH: the reply is fresh (<= ~10s, not the 8-min window,
 * which remains the digest-seeding recency), AND the reply was NOT
 * fully delivered - the delivered/cut/miss outcome from the delivery
 * layer is the signal; only cut or miss (or no record at all: the
 * reply landed while no client was attached) may replay. Delivery
 * outcomes live in a MODULE-level map keyed by session jsonl so they
 * survive the per-connection closure across reconnects. */
export const REPLAY_MAX_AGE_MS = Number(
  process.env.DEVNEURAL_VOICE_REPLAY_MAX_AGE_MS ?? 10_000,
);

export interface ReplyDeliveryRecord {
  outcome: LexReplyOutcome;
  ms: number;
}

const lastReplyDeliveryBySession = new Map<string, ReplyDeliveryRecord>();

export function _recordReplyDelivery(
  sessionKey: string | null,
  outcome: LexReplyOutcome,
  ms: number,
): void {
  if (!sessionKey) return;
  lastReplyDeliveryBySession.set(sessionKey, { outcome, ms });
}

export function _getReplyDelivery(
  sessionKey: string | null,
): ReplyDeliveryRecord | null {
  if (!sessionKey) return null;
  return lastReplyDeliveryBySession.get(sessionKey) ?? null;
}

export function _resetReplyDeliveryTracking(): void {
  lastReplyDeliveryBySession.clear();
}

export interface ShouldReplayOnBindInput {
  lastTurn: { text: string; mtimeMs: number } | null;
  /** Most recent delivery outcome recorded for this session, if any. */
  lastDelivery: ReplyDeliveryRecord | null;
  now: number;
  /** Default REPLAY_MAX_AGE_MS. */
  maxAgeMs?: number;
}

export function _shouldReplayOnBindImpl(input: ShouldReplayOnBindInput): {
  replay: boolean;
  reason: string;
} {
  const maxAgeMs = input.maxAgeMs ?? REPLAY_MAX_AGE_MS;
  if (!input.lastTurn || !input.lastTurn.text) {
    return { replay: false, reason: 'no-last-turn' };
  }
  const ageMs = input.now - input.lastTurn.mtimeMs;
  if (ageMs > maxAgeMs) {
    return {
      replay: false,
      reason: `stale (age=${Math.round(ageMs / 1000)}s > ${Math.round(maxAgeMs / 1000)}s)`,
    };
  }
  const d = input.lastDelivery;
  /* A record older than the turn covered the PREVIOUS reply; only a
   * record stamped at/after the turn speaks for this one. */
  if (d && d.ms >= input.lastTurn.mtimeMs && d.outcome === 'delivered') {
    return { replay: false, reason: 'already fully delivered' };
  }
  return {
    replay: true,
    reason: d && d.ms >= input.lastTurn.mtimeMs
      ? `undelivered (${d.outcome})`
      : 'no delivery record (client was away)',
  };
}

export interface LastAssistantTurn {
  text: string;
  mtimeMs: number;
  uuid: string | null;
}

/* Replay-repeat guard (2026-07-17, daemon.log 01:33Z). A ws flap during
 * a daemon boot (client reconnecting every ~1s) re-spoke the same last
 * reply on EVERY fresh socket - ages 5s..9s in the log - until the 10s
 * staleness cap silenced it; the operator heard Lex repeat in a loop.
 * The per-connection replayedOnBind flag dies with each socket and the
 * replay never recorded a delivery, so "no delivery record (client was
 * away)" stayed true across reconnects. The replay IS a delivery: stamp
 * 'delivered' BEFORE speak so even two sockets racing through bind in
 * the same tick cannot both pass the gate. Exported + dependency-
 * injected (same seam pattern as _seedDigestFromLastTurnImpl) so the
 * once-only contract is unit-testable without a real WS. Returns true
 * when it spoke. */
export interface ReplayOnBindDeps {
  getDelivery: (key: string | null) => ReplyDeliveryRecord | null;
  recordDelivery: (
    key: string | null,
    outcome: LexReplyOutcome,
    ms: number,
  ) => void;
  speak: (text: string) => void;
  log: (line: string) => void;
  /** Test seam: pin the clock. Default: Date.now. */
  now?: () => number;
}

export function _replayLastTurnOnBindImpl(
  jsonlPath: string,
  last: LastAssistantTurn,
  bindKey: string | null,
  deps: ReplayOnBindDeps,
): boolean {
  const now = (deps.now ?? Date.now)();
  const decision = _shouldReplayOnBindImpl({
    lastTurn: last,
    lastDelivery: deps.getDelivery(jsonlPath),
    now,
  });
  const ageS = Math.round((now - last.mtimeMs) / 1000);
  if (!decision.replay) {
    deps.log(
      `[voice-ws] replay-on-switch: SKIPPED (${decision.reason}) age=${ageS}s bindKey=${bindKey ?? 'null'}`,
    );
    return false;
  }
  deps.log(
    `[voice-ws] replay-on-switch: speaking last reply (${decision.reason}) age=${ageS}s bindKey=${bindKey ?? 'null'}`,
  );
  deps.recordDelivery(jsonlPath, 'delivered', now);
  deps.speak(last.text);
  return true;
}

/* Extract the most recent assistant reply (concatenated text blocks) from
 * a Claude Code session jsonl, with the file's mtime for the recency
 * guard. Reads only the tail (last 64 KB) so a multi-MB transcript is
 * cheap; a partial first line just fails JSON.parse and is skipped.
 * Exported + dependency-injected so the replay logic is unit-testable
 * without a real file. */
export function readLastAssistantTurn(
  jsonlPath: string,
  deps?: {
    readTail?: (p: string, bytes: number) => string | null;
    statMtimeMs?: (p: string) => number;
  },
): LastAssistantTurn | null {
  const statMtimeMs =
    deps?.statMtimeMs ??
    ((p) => {
      try {
        return fs.statSync(p).mtimeMs;
      } catch {
        return 0;
      }
    });
  const readTail =
    deps?.readTail ??
    ((p, bytes) => {
      try {
        const size = fs.statSync(p).size;
        const start = Math.max(0, size - bytes);
        const fd = fs.openSync(p, 'r');
        try {
          const len = size - start;
          const buf = Buffer.alloc(len);
          fs.readSync(fd, buf, 0, len, start);
          return buf.toString('utf-8');
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        return null;
      }
    });
  const body = readTail(jsonlPath, 65536);
  if (!body) return null;
  const lines = body.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i]?.trim();
    if (!trimmed) continue;
    let rec: {
      type?: string;
      uuid?: string;
      message?: { content?: Array<{ type?: string; text?: string }> };
    };
    try {
      rec = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (rec.type !== 'assistant' || !rec.message?.content) continue;
    const text = rec.message.content
      .filter((b) => b.type === 'text' && b.text)
      .map((b) => b.text)
      .join('')
      .trim();
    if (!text) continue;
    return {
      text,
      mtimeMs: statMtimeMs(jsonlPath),
      uuid: typeof rec.uuid === 'string' ? rec.uuid : null,
    };
  }
  return null;
}

/* Fast-lane cold-start-on-switch fix (2026-07-14). buildVoiceDigest is
 * only pushed at end_turn boundaries, so right after a session bind/
 * switch the digest is stale or absent until Lex's NEXT reply, and the
 * haiku fast lane degrades (queues everything, or answers off nothing)
 * for however long that takes. Fix: at bind, derive a digest from the
 * session's real last turn (already read for replay-on-switch) and push
 * it, so lastLexTurnMs/digest freshness reflect the prior turn instead of
 * a blank slate. Independent of the audio-replay gates in
 * maybeReplayLastTurnOnBind (notes mode / REPLAY_ON_SWITCH / once-per-
 * socket) - those decide whether we SPEAK the last turn, this decides
 * whether the fast lane KNOWS about it, and the two questions differ (a
 * notes session still deserves a warm fast lane on switch). Pure +
 * exported so the seed/no-seed boundary is unit-testable without a real
 * WS or filesystem; mirrors the _flushPendingUtterancesImpl seam below. */
export interface SeedDigestFromLastTurnDeps {
  readLastAssistantTurn: (jsonlPath: string) => LastAssistantTurn | null;
  getDigest: () => { digest: LexDigest; ms: number } | null;
  pushDigest: (digest: LexDigest, atMs: number) => void;
  buildVoiceDigest: (replyText: string, prev?: LexDigest | null) => LexDigest;
  /** Test seam: pin the clock. Default: Date.now. */
  now?: () => number;
  /** Recency window: a last turn older than this never seeds. Default:
   * REPLAY_WINDOW_MS (same "recent" definition as replay-on-switch). */
  replayWindowMs?: number;
}

/* Returns the fresh timestamp both the digest and lastLexTurnMs were
 * stamped with when it seeded (so the caller's closure-local
 * lastLexTurnMs can be reassigned to match - digest.ms >= lastTurnMs must
 * hold for isDigestFresh to read true), or null when it left the
 * freshness gate untouched (no jsonl, no last turn, read failure, or the
 * last turn is older than the recency window). Best-effort: never
 * throws. */
export function _seedDigestFromLastTurnImpl(
  jsonlPath: string | null,
  deps: SeedDigestFromLastTurnDeps,
): number | null {
  if (!jsonlPath) return null;
  const now = (deps.now ?? Date.now)();
  const windowMs = deps.replayWindowMs ?? REPLAY_WINDOW_MS;
  let last: LastAssistantTurn | null;
  try {
    last = deps.readLastAssistantTurn(jsonlPath);
  } catch {
    return null;
  }
  if (!last || !last.text) return null;
  if (now - last.mtimeMs > windowMs) return null;
  try {
    deps.pushDigest(
      deps.buildVoiceDigest(last.text, deps.getDigest()?.digest ?? null),
      now,
    );
  } catch {
    return null;
  }
  return now;
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
  /* One-utterance-one-delivery gate (2026-07-17): queued items whose
   * fingerprint already reached Lex inside the window are dropped
   * before the flush payload is assembled; delivered items are marked
   * after a successful inject. Optional so legacy callers/tests are
   * byte-identical. */
  dedupe?: {
    shouldDeliver(fingerprint: string, nowMs: number): boolean;
    markDelivered(fingerprint: string, nowMs: number): void;
    fingerprint(text: string): string;
  };
}

function _defaultScheduleFollowupCr(fn: () => void, delayMs: number): void {
  const t = setTimeout(fn, delayMs);
  if (typeof (t as { unref?: () => void }).unref === 'function') {
    (t as { unref: () => void }).unref();
  }
}

/* Phase 2 R3/R5: the operator forward is NEVER held to a mid turn
 * boundary. The top layer is the always-reachable arbiter; it routes the
 * operator's substance to mid LIVE (top -> mid). The mid session is a
 * real Claude Code PTY whose composer buffers a live inject that arrives
 * mid-turn and picks it up at the next boundary (exactly how Claude Code
 * voice already behaves), so a mid-turn inject is safe and is precisely
 * what "top never blocks on mid being busy" requires.
 *
 * Before Phase 2 the "mid-turn-no-tts queue" pushed the forward onto
 * state.pendingUserUtterances whenever Lex was mid-turn with no TTS,
 * draining only at Lex's end_turn - the queue R3 kills. This predicate
 * is the one wired seam that governs that branch; it always returns
 * false now, so the forward falls through to the live inject path. Kept
 * as a named export so the "never queue the operator" contract has a
 * single test target and any regression that re-introduces turn-boundary
 * holding has to flip this and fight its test. The double-inject guard
 * that the old branch provided (deliveryRegistry fingerprint) is applied
 * unchanged on the live inject path, so routing live cannot double-speak
 * or double-deliver. */
/* Phase 2 R2 / acceptance-3: the top (Lex voice) headless session
 * starts on Start voice; the control shows "connecting" until it is
 * WARM, then goes live. This watch drives that transition with a
 * `voice-brain` frame:
 *   - ready:false emitted immediately while the top brain is still
 *     warming (client holds "connecting");
 *   - ready:true the moment isWarm() flips (client goes "ready"/live);
 *   - a fail-open cap emits ready:true even if the brain never warms,
 *     so a broken boot can never lock the operator in "connecting"
 *     (matches "never drop / never lock out the operator");
 *   - when the top session is DISABLED, the gate is a no-op: ready:true
 *     immediately, so today's hello-ack->ready behavior is unchanged
 *     ("nothing that works today breaks").
 * Returns a cancel fn the WS calls on teardown so a closed socket
 * leaves no live poll timer. Deps are injected so the poll loop is
 * driven deterministically in tests (no real timers/clock). */
export interface VoiceBrainReadyWatchDeps<T = unknown> {
  enabled: boolean;
  isWarm: () => boolean;
  send: (msg: Record<string, unknown>) => void;
  schedule: (fn: () => void, ms: number) => T;
  clearTimer: (timer: T) => void;
  now: () => number;
  pollMs?: number;
  capMs?: number;
}

export function _startVoiceBrainReadyWatch<T = unknown>(
  deps: VoiceBrainReadyWatchDeps<T>,
): () => void {
  const READY = (): Record<string, unknown> => ({ t: 'voice-brain', ready: true });
  /* Disabled top session: gate does not apply. Go live immediately so
   * the client behaves exactly as it did before Phase 2. */
  if (!deps.enabled) {
    deps.send(READY());
    return () => undefined;
  }
  /* Already warm at attach (the always-live steady state): live now. */
  if (deps.isWarm()) {
    deps.send(READY());
    return () => undefined;
  }
  /* Warming: connecting now, then poll to warm. */
  deps.send({ t: 'voice-brain', ready: false });
  const pollMs = deps.pollMs ?? 300;
  const capMs = deps.capMs ?? 20_000;
  const startedAt = deps.now();
  let timer: T | null = null;
  let stopped = false;
  const finishLive = (): void => {
    stopped = true;
    deps.send(READY());
  };
  const tick = (): void => {
    if (stopped) return;
    if (deps.isWarm()) {
      finishLive();
      return;
    }
    if (deps.now() - startedAt >= capMs) {
      finishLive();
      return;
    }
    timer = deps.schedule(tick, pollMs);
  };
  timer = deps.schedule(tick, pollMs);
  return () => {
    if (stopped) return;
    stopped = true;
    if (timer !== null) deps.clearTimer(timer);
  };
}

export interface MidTurnForwardInput {
  /** Lex (mid) is mid-turn: state.awaitingResponseSince > 0. */
  lexMidTurn: boolean;
  /** TTS is currently playing (a barge, handled elsewhere). */
  ttsActive: boolean;
}

export function _shouldDeferForwardToMidTurnBoundary(
  _input: MidTurnForwardInput,
): boolean {
  return false;
}

/* Mid-turn queue flush. Exported as `_flushPendingUtterancesImpl` so
 * the regression test (lex-voice-ws.flush-cr.test.ts) can drive it
 * without standing up a full WS attach. The closure inside
 * attachLexVoiceWs delegates here; the body lives here so the test
 * exercises the same code path as production. */
export function _flushPendingUtterancesImpl(
  deps: _FlushPendingUtterancesDeps,
): string | null {
  /* Returns the injected payload text (for delivery/integrity
   * verification by the caller) or null when nothing was injected. */
  const { state, ptyInject, send } = deps;
  if (state.pendingUserUtterances.length === 0) return null;
  if (!state.bindKey) return null;
  let queued = state.pendingUserUtterances.slice();
  state.pendingUserUtterances = [];
  if (deps.dedupe) {
    const now = Date.now();
    const kept = queued.filter((t) =>
      deps.dedupe!.shouldDeliver(deps.dedupe!.fingerprint(t), now),
    );
    if (kept.length < queued.length) {
      (deps.log ?? logFn)(
        `[voice-ws] DUPLICATE DELIVERY SUPPRESSED (flush): dropped ${queued.length - kept.length} already-delivered queued utterance(s)`,
      );
    }
    queued = kept;
    if (queued.length === 0) return null;
  }
  const header =
    queued.length === 1
      ? '[voice-context: queued-mid-turn-utterance] The user spoke this while you were mid-turn; it was held until your turn boundary.\n\n'
      : `[voice-context: queued-mid-turn-utterances (${queued.length})] The user spoke these follow-on utterances while you were mid-turn. They were held until your turn boundary; treat as one combined message:\n\n${queued.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n\n`;
  const body = queued.length === 1 ? `${header}${queued[0]}` : header;
  const voiceTag =
    state.mode === 'notes'
      ? '[voice mode: notes, silent reply, capture as artifact] '
      : '[voice mode] ';
  const flushPayload = body + voiceTag;
  const ir = ptyInject(state.bindKey, flushPayload, true);
  if (!ir.ok) {
    send({
      t: 'error',
      code: 'inject',
      message: `flush-mid-turn-queue: ${ir.error}`,
    });
    state.pendingUserUtterances = queued.concat(state.pendingUserUtterances);
    return null;
  }
  if (deps.dedupe) {
    const now = Date.now();
    for (const t of queued) {
      deps.dedupe.markDelivered(deps.dedupe.fingerprint(t), now);
    }
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
  (deps.log ?? logFn)(
    `[voice-ws] mid-turn-no-tts queue flush count=${queued.length}`,
  );
  send({
    t: 'injected',
    source: 'mid-turn-queue-flush',
    count: queued.length,
  });
  state.awaitingResponseSince = Date.now();
  return flushPayload;
}

/* Voice->Lex delivery confirmation (2026-07-16 second wave, operator
 * correction). Live failure at 04:45Z: a committed voice inject sat
 * at the Lex terminal as unsubmitted [Pasted text #66-71] blocks -
 * the trailing CR was silently swallowed and NOTHING self-recovered;
 * the operator had to click into the terminal, type characters, and
 * press Enter by hand. Same class as the bridge VSIX bracketed-paste
 * trailing-Enter drop.
 *
 * This verifies that a committed inject actually SUBMITTED: the bound
 * session's jsonl must grow a user record containing a fingerprint of
 * the injected utterance within the verify interval. Misses fire an
 * idempotent CR retry (final attempt types ' \r' - a space plus
 * Enter, mirroring the manual recovery that provably works); retries
 * exhausted fires onFailure (loud log + client error frame). Pure
 * impl with injected IO, same seam pattern as
 * _flushPendingUtterancesImpl above.
 *
 * Only run for IDLE-time injects (direct turn inject, turn-boundary
 * queue flush): a mid-turn steering inject does not produce its user
 * record until claude picks it up, so confirmation there would false-
 * alarm. Both call sites in this file satisfy that by construction. */
/* Session-end trigger table (2026-07-17 hotfix). A ws-close is NEVER
 * terminal on its own: tonight's flaky socket (pre-keepalive build)
 * fired the terminal pipeline on a routine drop and flipped the LIVE
 * brainstorm to status='ended'; every reconnect then bounced off the
 * bind gate with 'brainstorm-ended' and the operator was locked out
 * of his own session. Disconnects flush distillation state only (the
 * brainstorm stays alive for the reconnect that follows seconds
 * later, in EVERY runtime mode); the terminal pipeline is reserved
 * for explicit intent: the spoken end-session command, the UI end,
 * and compaction-restart. Exported for tests. */
export function _sessionEndActionForReason(
  reason: string,
): 'flush' | 'terminal' {
  return reason === 'ws-close' ? 'flush' : 'terminal';
}

export interface _VerifyInjectDeliveryDeps {
  jsonlPath: string | null;
  /** Byte offset of the jsonl at inject time; only content appended
   * after it is scanned. */
  startOffset: number;
  /** Slice of the injected utterance used to recognize the submitted
   * user record. Matched against PARSED record text so JSON escaping
   * cannot mask a hit. */
  fingerprint: string;
  /** Content-integrity probes (2026-07-16 third wave: FRONT truncation
   * of pasted payloads - the lead of the payload got eaten while the
   * tail landed, three times live, so submission alone proves
   * nothing about completeness). head = a slice of the payload's
   * first non-empty line, tail = a slice of its last non-empty line
   * (single-line probes so composer newline normalization cannot mask
   * a hit). When provided, a landed user record must carry EVERY
   * provided probe to count as confirmed; a record carrying some but
   * not all classifies as a PARTIAL landing and triggers repaste. */
  headFingerprint?: string;
  tailFingerprint?: string;
  /** Re-inject the FULL payload after a partial landing. Fired at
   * most once per verification; the loop keeps scanning for an
   * intact record afterwards. */
  repaste?: () => void;
  statSize: (p: string) => number | null;
  readRange: (p: string, start: number, length: number) => string | null;
  /** Fire a CR retry. attempt is 1-based; the last attempt should
   * escalate to ' \r'. */
  retryCr: (attempt: number) => void;
  onFailure: () => void;
  sleep: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
  /** Interval between checks. Default 4000ms. */
  intervalMs?: number;
  /** CR retries before declaring failure. Default 3. Counts SILENT
   * intervals only (SECONDARY 2026-07-18): an interval where the deep
   * layer was actively producing output does not strike. */
  maxAttempts?: number;
  /** Absolute wall (SECONDARY): when the deep layer keeps producing
   * past this bound without the prompt ever submitting, stop verifying
   * and return 'pending' WITHOUT a stuck banner. Default 300000ms. */
  maxWaitMs?: number;
  /** Optional external "deep PTY is actively producing" signal, OR'd
   * with the intrinsic jsonl-assistant-activity signal. Left unset by
   * the WS (jsonl growth suffices); a future pty-output-recency seam
   * can wire it. Must NOT be a "we injected and are awaiting" flag - an
   * IDLE stuck composer produces no output and must still recover. */
  deepBusy?: () => boolean;
}

/* Single-line head/tail probes for a pasted payload. First and last
 * non-empty lines, bounded, never crossing a newline - the jsonl
 * record preserves the payload's own line structure but probes that
 * span lines would be brittle against any composer normalization. */
export function payloadIntegrityFingerprints(payload: string): {
  head: string;
  tail: string;
} {
  const lines = (payload ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const first = lines[0] ?? '';
  const last = lines[lines.length - 1] ?? '';
  return { head: first.slice(0, 60), tail: last.slice(-40) };
}

function userRecordText(rec: Record<string, unknown>): string | null {
  if (rec.type !== 'user') return null;
  const message = rec.message as
    | { content?: string | Array<{ type?: string; text?: string }> }
    | undefined;
  const c = message?.content;
  return typeof c === 'string'
    ? c
    : Array.isArray(c)
      ? c.map((b) => (typeof b?.text === 'string' ? b.text : '')).join('')
      : '';
}

/* VB-3 (2026-07-18): a prompt injected while the deep layer is mid-turn
 * is not submitted as a user turn - Claude Code ACCEPTS it into its
 * command queue and runs it at the turn boundary. It lands as a
 * queue-operation (operation:'enqueue', content:<payload>) and/or a
 * queued_command (prompt:<payload>) record, NOT a user record. A queued
 * prompt IS delivered; the composer registered the Enter (that is why
 * it queued), so it is the OPPOSITE of a stuck paste. Recognizing it
 * stops the verifier counting it as silence, firing CR retries into a
 * busy composer, and raising the false 'voice error' banner. A genuinely
 * stuck paste writes NEITHER record (unsubmitted composer text), so the
 * stuck-paste failure path is untouched. Only 'enqueue' counts: a
 * dequeue/remove is a cancellation, not a delivery. */
function queuedCommandText(rec: Record<string, unknown>): string | null {
  if (rec.type === 'queue-operation') {
    if (rec.operation !== undefined && rec.operation !== 'enqueue') return null;
    return typeof rec.content === 'string' ? rec.content : null;
  }
  if (rec.type === 'queued_command') {
    return typeof rec.prompt === 'string' ? rec.prompt : null;
  }
  return null;
}

export async function _verifyInjectDeliveryImpl(
  deps: _VerifyInjectDeliveryDeps,
): Promise<'confirmed' | 'failed' | 'no-jsonl' | 'pending' | 'queued'> {
  const { jsonlPath, fingerprint } = deps;
  if (!jsonlPath || !fingerprint) return 'no-jsonl';
  const intervalMs = deps.intervalMs ?? 4_000;
  const maxAttempts = deps.maxAttempts ?? 3;
  const maxWaitMs = deps.maxWaitMs ?? 300_000;
  const log = deps.log ?? logFn;
  let offset = deps.startOffset;
  let repasteUsed = false;
  /* SECONDARY (2026-07-18): count SILENT intervals only. An interval in
   * which the deep layer produced output (an assistant record) does not
   * strike and fires no CR - the injected prompt is queued behind an
   * in-flight turn, not stuck. `iterations` bounds the wait against the
   * absolute wall so a perpetually-busy turn eventually stops verifying
   * (returns 'pending') instead of looping forever. */
  let silentStrikes = 0;
  let iterations = 0;
  while (iterations * intervalMs < maxWaitMs) {
    await deps.sleep(intervalMs);
    iterations++;
    let sawPartial = false;
    let sawDeepActivity = false;
    const size = deps.statSize(jsonlPath);
    if (size !== null && size > offset) {
      const chunk = deps.readRange(jsonlPath, offset, size - offset);
      offset = size;
      if (chunk) {
        for (const line of chunk.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let rec: Record<string, unknown>;
          try {
            rec = JSON.parse(trimmed);
          } catch {
            continue;
          }
          /* Deep layer ACTIVELY producing (assistant record): the
           * queued prompt is not stuck, so this interval is not silent.
           * tool_result records are type 'user' and do not count on
           * their own; a real mid-turn always interleaves assistant
           * records, and an IDLE stuck composer produces none. */
          if (rec.type === 'assistant') sawDeepActivity = true;
          /* VB-3 (2026-07-18): the prompt was queued behind an in-flight
           * turn. That is a DELIVERED prompt (it runs at the turn
           * boundary), not a stuck paste - stop here so no CR retry fires
           * into the busy composer and no false 'voice error' banner is
           * raised. Only 'enqueue' of OUR utterance counts. */
          const queuedText = queuedCommandText(rec);
          if (queuedText !== null && queuedText.includes(fingerprint)) {
            log(
              `[voice-ws] inject delivery confirmed QUEUED: the prompt was accepted into Claude Code's queue behind an in-flight turn and will run at the turn boundary (no stuck paste, no CR retry)`,
            );
            return 'queued';
          }
          const text = userRecordText(rec);
          if (text === null || text === '') continue;
          /* Delivery contract (2026-07-17 00:50Z duplicate-turn fix):
           * the UTTERANCE fingerprint is the delivery signal. A record
           * carrying the operator's words is DELIVERED even when the
           * payload head/tail got eaten by the paste path - repasting
           * a word-carrying landing makes Lex answer the same turn
           * twice, and FAILED must never log on delivered words. Head
           * loss is context damage: log it loudly, do not repair it.
           * Repaste stays reserved for word-LESS fragments (the words
           * themselves were eaten). */
          const utteranceHit = text.includes(fingerprint);
          const headHit = deps.headFingerprint
            ? text.includes(deps.headFingerprint)
            : true;
          const tailHit = deps.tailFingerprint
            ? text.includes(deps.tailFingerprint)
            : true;
          if (utteranceHit) {
            if (!headHit || !tailHit) {
              log(
                `[voice-ws] TRUNCATED DELIVERY: user record landed carrying the utterance but missing payload ${!headHit ? 'head' : 'tail'} (context lost in the paste path); NOT repasting - words were delivered`,
              );
            } else if (repasteUsed) {
              log(
                '[voice-ws] inject delivery confirmed INTACT after repaste (partial landing repaired)',
              );
            } else if (silentStrikes > 0) {
              log(
                `[voice-ws] inject delivery confirmed after ${silentStrikes} CR retr${silentStrikes === 1 ? 'y' : 'ies'}`,
              );
            }
            return 'confirmed';
          }
          if (headHit || tailHit) sawPartial = true;
        }
      }
    }
    if (sawPartial && deps.repaste && !repasteUsed) {
      /* Partial landing: the turn SUBMITTED but arrived truncated
       * (2026-07-16 front-truncation wave). A CR cannot repair lost
       * content - re-paste the full payload once and keep scanning
       * for an intact record. */
      repasteUsed = true;
      log(
        '[voice-ws] INJECT PARTIAL DELIVERY: landed user record is missing payload head/tail; repasting the full payload',
      );
      deps.repaste();
      continue;
    }
    /* SECONDARY signal-based liveness: if the deep layer produced output
     * this interval (or an external busy signal is set), the prompt is
     * queued behind an in-flight turn, not stuck. Pause the stuck clock
     * and fire NO CR into a busy composer; the timeout bounds true
     * SILENCE only. */
    const deepBusy = sawDeepActivity || (deps.deepBusy?.() ?? false);
    if (deepBusy) {
      log(
        '[voice-ws] inject delivery pending: deep layer actively producing (prompt queued behind an in-flight turn), not retrying',
      );
      continue;
    }
    /* True silence: escalate the CR ladder, then fail once exhausted. */
    silentStrikes++;
    if (silentStrikes <= maxAttempts) {
      log(
        `[voice-ws] inject delivery unconfirmed after ${silentStrikes} silent interval(s); firing CR retry ${silentStrikes}/${maxAttempts}`,
      );
      deps.retryCr(silentStrikes);
    } else {
      deps.onFailure();
      return 'failed';
    }
  }
  /* Absolute wall: the deep layer never stopped producing and the
   * prompt never submitted. Stop verifying WITHOUT a stuck banner - the
   * prompt is still legitimately queued, not lost. */
  log(
    `[voice-ws] inject delivery verification stopped after ${Math.round(maxWaitMs / 1000)}s while the deep layer kept producing; prompt still queued (no stuck banner)`,
  );
  return 'pending';
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

/* Notes/meeting mode name-gate (MVP), meeting-notes fixes 2026-07
 * (task 2 / F2). Lex's system-prompt contract otherwise replies to
 * every utterance; in notes mode the room is usually dictating or
 * discussing, not talking to Lex, so replying to everything derails
 * the transcript and burns TTS/LLM cycles on chatter that was never
 * addressed to her. lex-voice-commands.ts's matcher already requires
 * an immediate "lex <command>" prefix for panic/mute/etc: this is a
 * softer sibling heuristic for ordinary requests, not a command.
 *
 * An utterance is forwarded to Lex only when BOTH hold:
 *   1. word-boundary "lex" appears (\blex\b, case-insensitive) so
 *      "flex", "alex", "lexicon", etc. never false-fire; AND
 *   2. it reads as a question or request:
 *        a. the utterance ends in '?' (whisper's own judgement), or
 *        b. an interrogative/imperative lead word ("what", "can",
 *           "summarize", ...) appears within a few tokens AFTER the
 *           "lex" mention: "lex what do you think", "hey lex can
 *           you summarize" both match on (b) via "what" / "can".
 * "let's flex the schedule" never reaches condition 1 (no word-
 * boundary "lex" substring). Plain discussion that never says "lex"
 * never reaches condition 1 either. "lex" mentioned with no ask
 * ("lex is going to be here soon") reaches condition 1 but fails
 * both (a) and (b): it deliberately excludes bare copulas/auxiliaries
 * ("is", "are", "was", "were", "did") from the lead-word set because
 * they read as narration about Lex at least as often as a question
 * addressed to her; genuine questions phrased that way still match
 * via the trailing '?' whisper usually supplies.
 * Anything that fails the gate is still captured to brainstorm_chunks
 * (see captureNotesUtteranceOnly); it is simply never forwarded. */
const NOTES_GATE_LEX_RE = /\blex\b/i;
const NOTES_GATE_TRAILING_Q_RE = /\?\s*$/;
const NOTES_GATE_WINDOW = 4;
const NOTES_GATE_LEAD_WORDS = new Set<string>([
  'what', 'why', 'how', 'when', 'where', 'who', 'whom', 'whose', 'which',
  'can', 'could', 'would', 'will', 'should',
  'tell', 'give', 'summarize', 'summarise', 'explain', 'remind', 'check',
  'help', 'show', 'list', 'find', 'look', 'note', 'capture', 'log',
  'record', 'save', 'confirm', 'verify', 'repeat', 'clarify', 'describe',
  'review', 'answer', 'please', 'start', 'stop', 'pause',
]);

export function isAddressedToLexInNotesMode(rawText: string): boolean {
  const text = (rawText ?? '').trim();
  if (!text) return false;
  if (!NOTES_GATE_LEX_RE.test(text)) return false;
  if (NOTES_GATE_TRAILING_Q_RE.test(text)) return true;
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i] !== 'lex') continue;
    const end = Math.min(tokens.length, i + 1 + NOTES_GATE_WINDOW);
    for (let j = i + 1; j < end; j++) {
      if (NOTES_GATE_LEAD_WORDS.has(tokens[j]!)) return true;
    }
  }
  return false;
}

/* Meeting-notes fixes (2026-07), task 2. Deps for
 * _captureNotesUtteranceOnlyImpl, extracted so the not-addressed
 * notes-mode capture path is unit-testable without a live socket, a
 * PTY, or a real IndexDb: same shape as _FlushPendingUtterancesDeps
 * above. Deliberately has NO ptyInject / handleDirectLlmUtterance
 * dependency: that absence is what proves this path cannot forward
 * to Lex, only capture. */
export interface _CaptureNotesUtteranceDeps {
  brainstormId: string;
  text: string;
  insertChunk: (row: {
    id: string;
    brainstorm_id: string;
    turn_index: number;
    role: 'user';
    mode: 'notes';
    text: string;
    model_id: string;
    cc_session_id: string | null;
  }) => void;
  nextTurnIndex: (brainstormId: string) => number;
  /** Test seam; defaults to node:crypto randomUUID. */
  newId?: () => string;
  log?: (msg: string) => void;
}

export function _captureNotesUtteranceOnlyImpl(
  deps: _CaptureNotesUtteranceDeps,
): void {
  try {
    deps.insertChunk({
      id: (deps.newId ?? randomUUID)(),
      brainstorm_id: deps.brainstormId,
      turn_index: deps.nextTurnIndex(deps.brainstormId),
      role: 'user',
      mode: 'notes',
      text: deps.text,
      model_id: 'voice-notes-capture',
      cc_session_id: null,
    });
  } catch (err) {
    (deps.log ?? logFn)(
      `[voice-ws] notes-mode capture insert failed: ${(err as Error).message}`,
    );
  }
}

/* Fast-lane transcript hole fix (2026-07-15), task 1.
 *
 * The haiku fast lane's 'fast' route (haikuRoute -> composeGlueReply
 * in handleUtteranceEnd) answers small-talk asides - greetings, acks,
 * delivery hints - by speaking a glue reply straight off the daemon.
 * Nothing is ever injected into Lex's PTY for that turn: correct for
 * latency and for BF-4 (the glue model sees only persona + digest +
 * aside, never Lex's own context), but it leaves the exchange with no
 * durable record and no way for Lex to ever learn it happened.
 *
 * This persists BOTH sides directly to brainstorm_chunks the instant
 * the fast lane absorbs, mirroring _captureNotesUtteranceOnlyImpl's
 * shape one level up: same insertChunk/nextTurnIndex/newId/log deps,
 * same try/catch-and-log-never-throw contract, same "no ptyInject /
 * handleDirectLlmUtterance dependency in sight" proof that this path
 * cannot forward by construction. model_id is tagged
 * 'voice-glue-capture' (distinct from 'voice-notes-capture' and
 * 'voice-direct-llm') so these rows are identifiable without
 * inspecting text.
 *
 * Two sequential inserts, not a batch: nextTurnIndex reads
 * MAX(turn_index)+1 fresh from the DB on every call (index-db.ts), so
 * the reply row's index must be requested AFTER the aside row lands,
 * or both rows would claim the same turn_index.
 *
 * No double-store: the aside was never forwarded down the cc-pty
 * inject path (ptyInject is not in this function's dependency list
 * either), so brainstorm-jsonl-ingestor - which is the writer for
 * every OTHER cc-pty chunk row, sourced by walking what the claude
 * CLI itself wrote to its jsonl - never sees this text. This capture
 * is therefore the row's only writer, exactly as
 * _captureNotesUtteranceOnlyImpl is the only writer for an
 * unaddressed notes-mode utterance. */
export interface _CaptureAbsorbedAsideDeps {
  brainstormId: string;
  aside: string;
  reply: string;
  insertChunk: (row: {
    id: string;
    brainstorm_id: string;
    turn_index: number;
    role: 'user' | 'lex';
    mode: 'conversation';
    text: string;
    model_id: string;
    cc_session_id: string | null;
  }) => void;
  nextTurnIndex: (brainstormId: string) => number;
  /** Test seam; defaults to node:crypto randomUUID. */
  newId?: () => string;
  log?: (msg: string) => void;
}

const ABSORBED_ASIDE_MODEL_ID = 'voice-glue-capture';

export function _captureAbsorbedAsideImpl(
  deps: _CaptureAbsorbedAsideDeps,
): void {
  const newId = deps.newId ?? randomUUID;
  const log = deps.log ?? logFn;
  try {
    deps.insertChunk({
      id: newId(),
      brainstorm_id: deps.brainstormId,
      turn_index: deps.nextTurnIndex(deps.brainstormId),
      role: 'user',
      mode: 'conversation',
      text: deps.aside,
      model_id: ABSORBED_ASIDE_MODEL_ID,
      cc_session_id: null,
    });
  } catch (err) {
    log(
      `[voice-ws] absorbed-aside capture (user) insert failed: ${(err as Error).message}`,
    );
  }
  try {
    deps.insertChunk({
      id: newId(),
      brainstorm_id: deps.brainstormId,
      turn_index: deps.nextTurnIndex(deps.brainstormId),
      role: 'lex',
      mode: 'conversation',
      text: deps.reply,
      model_id: ABSORBED_ASIDE_MODEL_ID,
      cc_session_id: null,
    });
  } catch (err) {
    log(
      `[voice-ws] absorbed-aside capture (reply) insert failed: ${(err as Error).message}`,
    );
  }
}

/* Fix 24 live repro (2026-07-16): phantom-barge stash resume, pure
 * impl. Mirrors the _flushPendingUtterancesImpl seam: the closure in
 * attachLexVoiceWs delegates here so the resume rules (freshness
 * window, superseded-by-new-speech, partial-chain un-interrupt,
 * interrupted-segment-first ordering) are unit-testable without a
 * live socket. Returns true when speech was resumed. */
export const BARGE_RESUME_WINDOW_MS = 30_000;

export interface BargeStashEntry {
  interruptedSegment: string | null;
  queuedSegments: string[];
  atMs: number;
  ctrlCPending: boolean;
  /* Fix 24 tail-loss (2026-07-18): the full spoken run shipped to the
   * client at barge time (every segment that got a tts-start, joined).
   * Fix 51 synth-serialization ships every sentence to the client
   * ahead of realtime playback, so by barge time the mid/deep body has
   * drained off the server ttsQueue and the interruptedSegment +
   * queuedSegments snapshot holds only the in-flight sentence. This +
   * playedMs reconstructs the UN-heard tail of the WHOLE body so
   * sentences 2..N are never lost. */
  fullRunText?: string;
  /* Client-reported played offset (ms) from the playback-stopped
   * frame, filled in AFTER the barge fired (the client reports it when
   * it stops the audio element). null until the client reports - or
   * forever on a legacy client with no playback-stopped, where the
   * resume falls back to the per-segment snapshot. */
  playedMs?: number | null;
}

export interface _ResumeBargedSpeechDeps {
  stash: BargeStashEntry;
  nowMs: number;
  /** True when fresh speech started after the barge (in-flight ctx,
   * running drain, or queued segments): the stash is superseded. */
  ttsBusy: boolean;
  partialChain: Array<{
    intended_text: string;
    started_at_ms: number;
    cancelled_at_ms: number;
  }>;
  speak: (text: string) => void;
  reason: string;
  log?: (msg: string) => void;
  windowMs?: number;
  /* Per-char synth-duration estimate for the played_ms -> heard-chars
   * mapping. Omitted in production (truncateToHeard's default); tests
   * pass it for a deterministic offset. */
  msPerChar?: number;
}

/* The kill pushed the interrupted segment onto partialChain as an
 * "interrupted reply". We are un-interrupting it; leaving the entry
 * would tell Lex a line was cut that the operator actually heard in
 * full. */
function _unInterruptPartialChain(deps: _ResumeBargedSpeechDeps): void {
  const lastPartial = deps.partialChain[deps.partialChain.length - 1];
  if (
    deps.stash.interruptedSegment &&
    lastPartial &&
    lastPartial.intended_text === deps.stash.interruptedSegment
  ) {
    deps.partialChain.pop();
  }
}

export function _resumeBargedSpeechImpl(deps: _ResumeBargedSpeechDeps): boolean {
  const windowMs = deps.windowMs ?? BARGE_RESUME_WINDOW_MS;
  if (deps.nowMs - deps.stash.atMs > windowMs) return false;
  if (deps.ttsBusy) return false;

  /* Preferred path (Fix 24 tail-loss, 2026-07-18): re-speak the
   * UN-played remainder of the WHOLE original body, reconstructed from
   * the full spoken run + the client's played offset. The per-segment
   * snapshot loses sentences 2..N once Fix 51 synth-serialization ships
   * them ahead of realtime playback (they drain off the server
   * ttsQueue before the barge). The full-run remainder never loses the
   * tail. Re-spoken as ONE unsplit segment, mirroring the top layer,
   * which resumes its single segment whole. Any still-queued segment
   * (never shipped, so absent from the run text) is appended so a body
   * barged before its tail synthesized still resumes complete. */
  const fullRun = deps.stash.fullRunText?.trim() ?? '';
  if (fullRun && deps.stash.playedMs != null) {
    const heard = truncateToHeard(
      fullRun,
      deps.stash.playedMs,
      deps.msPerChar != null ? { msPerChar: deps.msPerChar } : {},
    );
    const remainder = fullRun.slice(heard.length).trimStart();
    const tail = [remainder, ...deps.stash.queuedSegments]
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .join(' ');
    /* Whole body already heard and nothing queued: genuinely nothing
     * to resume. */
    if (!tail) return false;
    _unInterruptPartialChain(deps);
    (deps.log ?? logFn)(
      `[voice-ws] resuming barged TTS remainder (${deps.reason}): heard=${heard.length}/${fullRun.length} chars, remainder=${tail.length} chars`,
    );
    deps.speak(tail);
    return true;
  }

  /* Legacy fallback: no client offset (playback-stopped never landed).
   * Resume the per-segment snapshot exactly as before. */
  const segments = [
    ...(deps.stash.interruptedSegment ? [deps.stash.interruptedSegment] : []),
    ...deps.stash.queuedSegments,
  ];
  if (segments.length === 0) return false;
  _unInterruptPartialChain(deps);
  (deps.log ?? logFn)(
    `[voice-ws] resuming barged TTS after phantom utterance (${deps.reason}): segments=${segments.length}`,
  );
  for (const seg of segments) deps.speak(seg);
  return true;
}

/* Barge kill decision (2026-07-19, SPEC-2026-07-18-voice-binding-fixes).
 *
 * Live failure: the barge word-gate FIRED during active TTS but audio
 * never stopped. killActiveTts only shipped the client tts-cancel when
 * speakCtrl.killActive() returned true, and killActive() returns false
 * whenever state.ttsActive is null. During a REAL barge the audio is
 * CLIENT-buffered playback that outlives the daemon synth ctx (voice-
 * brain "ask replied" fires before the client finishes playing), so
 * state.ttsActive is already null, killActive() returns false, and NO
 * tts-cancel frame reached the client - audio kept playing.
 *
 * Principle (locked): arm AND kill both point at the SPEECH/PLAYBACK
 * layer (clientPlaybackActive), never the brain (state.ttsActive). So:
 *   - emitCancel keys off the PLAYBACK layer: ship tts-cancel whenever a
 *     real synth ctx was cancelled OR the client is still playing
 *     buffered audio. The client's resetTtsPlayback() is idempotent
 *     (bumps gen, pauses the media element, reports played_ms via
 *     playback-stopped), so a redundant cancel is harmless.
 *   - runTeardown stays gated on a real synth cancellation (`cancelled`)
 *     ONLY, so the destructive parts (bargeStash queue-loss + PTY Ctrl+C)
 *     never fire off a phantom barge and hard-interrupt the worker.
 *
 * Pure + exported so the gate-fire -> cancel-emitted contract pins
 * without a live socket, same seam pattern as _resumeBargedSpeechImpl. */
export interface KillActiveTtsDecisionInput {
  /** speakCtrl.killActive() returned true: a real in-flight synth ctx
   * was cancelled (false when state.ttsActive was already null). */
  cancelled: boolean;
  /** The client is currently playing buffered TTS audio (the
   * SPEECH/PLAYBACK layer - outlives the daemon synth ctx). */
  clientPlaybackActive: boolean;
}

export interface KillActiveTtsDecision {
  /** Ship { t:'tts-cancel' } to the client so it stops the audio. */
  emitCancel: boolean;
  /** Run the destructive turn-teardown (bargeStash / PTY Ctrl+C). */
  runTeardown: boolean;
}

export function _killActiveTtsDecision(
  input: KillActiveTtsDecisionInput,
): KillActiveTtsDecision {
  return {
    emitCancel: input.cancelled || input.clientPlaybackActive,
    runTeardown: input.cancelled,
  };
}

/* SM-25: combine utterances that piled up while a top-layer ask was
 * in flight into ONE message so the voice brain answers them
 * cohesively instead of stacking discrete replies. Module-level +
 * exported so the regression pin can exercise it directly. */
export function mergeOperatorUtterances(parts: string[]): string {
  const clean = parts.map((p) => p.trim()).filter((p) => p.length > 0);
  if (clean.length <= 1) return clean[0] ?? '';
  return clean
    .map((p, i) => (i === 0 ? p : `(operator added before you replied): ${p}`))
    .join('\n');
}

/* ── P1: the TOP layer owns its ack (2026-07-18 spec) ────────────────
 *
 * Today the ack the operator hears on an escalated turn is DEEP-sourced
 * (clampAck of Lex's first sentence, echoed up late). That is a
 * stale-ack race and, paired with the top layer's own handoff line, a
 * double-ack. Move ack ownership to the TOP: the top's spoken handoff
 * IS the ack (it streams instantly, at the top layer's latency), and
 * the deep layer stops emitting pre-tool acks for that turn.
 *
 * `_topOwnsAckAfterForwardImpl` decides whether the top actually acked
 * for a forward: it did iff it spoke something (streamed early lines
 * and/or a final remainder handoff). The fail-safe forward (session
 * down / timeout: forward = raw utterance, no speech, nothing streamed)
 * did NOT ack - there the deep pre-tool ack is the safety net so the
 * operator still hears one ack. Pure + exported so it pins without a
 * socket. */
export function _topOwnsAckAfterForwardImpl(args: {
  earlySpokenCount: number;
  remainderSpeech: string | null;
}): boolean {
  return args.earlySpokenCount > 0 || args.remainderSpeech !== null;
}

/* Whether the deep (Lex) pre-tool ack should be spoken. Suppressed once
 * the top owns the ack (no double-ack, no stale race); spoken as the
 * fallback when the top produced no handoff at all. */
export function _shouldSpeakDeepAckImpl(args: { topOwnsAck: boolean }): {
  speak: boolean;
  reason: string;
} {
  if (args.topOwnsAck) return { speak: false, reason: 'top-owns-ack' };
  return { speak: true, reason: 'no-top-ack-fallback' };
}

/* ── P3: coalesce is the INTERRUPT case only (2026-07-18 spec) ────────
 *
 * Utterances combine into ONE handling ONLY when they stack while a
 * reply is already in flight (the operator interrupted / added
 * mid-reply). A normal sequential turn - nothing in flight - runs as
 * its own fresh turn and is never coalesced. Both queue sites gate on
 * this: the top-layer path (topTurnInFlight) and the direct-llm path
 * (inFlightDirectLlmReply). This is the INPUT-queue scope only; it is
 * NOT the output ack-vs-answer race (that is P1's top-owned ack). Pure
 * + exported so the interrupt-only scope is locked against regression. */
export function _shouldCoalesceMidReplyImpl(args: {
  replyInFlight: boolean;
}): boolean {
  return args.replyInFlight;
}

export function attachLexVoiceWs(socket: FastifyWS): void {
  logFn(`[voice-ws] client connected (attach)`);
  /* 2026-07-16 smoke-test fix 3: boot the voice brain the moment a
   * voice client connects, not lazily on the first ask. Claude takes
   * 4-20s to boot; prewarming here means the first operator utterance
   * meets a WARM brain (real speech + handoff acks) instead of the
   * fail-safe null path (speech=null, forward-only) that made the
   * whole 2026-07-16 session mute. No-op when already warm/disabled. */
  try {
    prewarmVoiceBrainSession();
  } catch {
    /* prewarm is best-effort; the ask path retains its own spawn */
  }
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
    pttFloorHeld: false,
    suppressSpeakForTurn: false,
    compaction: { compactedAt: 0 },
    currentTtsText: null,
    currentTtsStartedAtMs: 0,
    partialChain: [],
    pendingUserUtterances: [],
    topTurnInFlight: false,
    pendingTopUtterances: [],
    topOwnsAck: false,
    directLlmAbort: null,
    brainstormId: null,
    runtimeMode: null,
    inFlightDirectLlmReply: false,
    ttsQueue: [],
    ttsQueueRunning: false,
    absorbedAsides: [],
  };

  /* Last line actually spoken; the haiku fast lane replays it on
   * "say that again" without an Opus round-trip. */
  let lastSpokenText: string | null = null;
  /* DRIVE-QUEUE 1b: timestamp of Lex's last turn boundary. The live
   * digest is pushed with this same ms, so isDigestFresh() is true while
   * the digest tracks the latest turn and goes stale (forcing the fast
   * lane to queue to Lex) the moment a turn boundary advances without a
   * matching push. */
  let lastLexTurnMs = 0;
  /* Replay-on-switch guard: speak the bound session's last reply at most
   * once per socket, even if the read misses or the turn is too old. */
  let replayedOnBind = false;
  /* Phase 2 R2: cancel handle for the top-brain connecting->live watch
   * (started near the close handler, cancelled in teardown). */
  let cancelBrainReadyWatch: (() => void) | null = null;

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
    /* 2026-07-17 item 3: synth/stream failures scream in daemon.log,
     * not just at a possibly-dead client socket. */
    log: logFn,
    onTtsEnd: () => {
      lastTtsEndMs = Date.now();
    },
    /* The live-haiku renderSegment restyle is gone (spec v2): it cost a
     * full LLM round trip before the reply body reached piper. */
  });

  /* One-shot per connection: the first TTS frame dropped on a closed
   * socket screams (2026-07-17 item 3: an evening of silence with
   * zero log evidence - frames were silently discarded here). */
  let loggedTtsDropAfterClose = false;
  function send(msg: Record<string, unknown>): void {
    if (state.closed) {
      if (
        !loggedTtsDropAfterClose &&
        typeof msg.t === 'string' &&
        msg.t.startsWith('tts')
      ) {
        loggedTtsDropAfterClose = true;
        logFn(
          `[voice-ws] SPEAKABLE REPLY DROPPED: ${msg.t} frame discarded - no live voice sink (ws closed); the reply will never be heard`,
        );
      }
      return;
    }
    /* Engine bookkeeping rides the outbound TTS frames: tts-start
     * marks client playback live, remembers the segment text for the
     * echo filter, and extends the run-text record used for played-ms
     * truncation. tts-end/tts-cancel arm the bounded tail fallback
     * (a real client drain signal preempts it). Never blocks the
     * frame. */
    try {
      if (msg.t === 'tts-start') {
        clientPlaybackActive = true;
        if (playbackTailTimer) {
          clearTimeout(playbackTailTimer);
          playbackTailTimer = null;
        }
        const segText = state.currentTtsText;
        if (segText && segText.trim()) {
          echoRegistry.remember(segText, Date.now());
          spokenRunTexts.push(segText);
        }
      } else if (msg.t === 'tts-end' || msg.t === 'tts-cancel') {
        armPlaybackTailFallback();
      }
    } catch {
      /* engine bookkeeping is observational */
    }
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
      maybeReplayLastTurnOnBind();
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
    maybeReplayLastTurnOnBind();
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
  }

  function stopJsonlWatch(): void {
    if (state.watchTimer) {
      clearInterval(state.watchTimer);
      state.watchTimer = null;
    }
  }

  /* Replay-on-switch (item 2). Called once after a bind resolves a
   * jsonl. If the bound session's last assistant reply is recent (within
   * REPLAY_WINDOW_MS) and this is not a silent notes session, speak it
   * once so switching to the session catches you up on what you may have
   * missed. No double-speak risk: the live watcher's offset is stamped at
   * EOF on bind, so the last turn (which is before EOF) is never re-read;
   * this is a separate one-shot speak. The panel already shows the turn
   * from history, so we only add the audio. */
  function maybeReplayLastTurnOnBind(): void {
    /* Fast-lane cold-start-on-switch fix: seed the digest from the real
     * prior turn at bind time, independent of the audio-replay gates
     * below (see _seedDigestFromLastTurnImpl above for why). Gated on
     * useVoiceHaiku so the flag-off path stays byte-identical; best-
     * effort so it can never block a bind. */
    if (useVoiceHaiku()) {
      const seededMs = _seedDigestFromLastTurnImpl(state.jsonlPath, {
        readLastAssistantTurn,
        getDigest,
        pushDigest,
        buildVoiceDigest,
      });
      if (seededMs !== null) lastLexTurnMs = seededMs;
    }
    if (!REPLAY_ON_SWITCH || replayedOnBind) return;
    replayedOnBind = true;
    if (state.mode === 'notes') return;
    if (!state.jsonlPath) return;
    let last: LastAssistantTurn | null = null;
    try {
      last = readLastAssistantTurn(state.jsonlPath);
    } catch {
      return;
    }
    if (!last || !last.text) return;
    /* Stale-replay gate (2026-07-16) + replay-repeat guard (2026-07-17):
     * fresh (<= ~10s), not already fully delivered, and the replay
     * stamps its own delivery so a ws flap cannot re-speak it on every
     * reconnect. See _replayLastTurnOnBindImpl for the contract. */
    _replayLastTurnOnBindImpl(state.jsonlPath, last, state.bindKey, {
      getDelivery: _getReplyDelivery,
      recordDelivery: _recordReplyDelivery,
      speak,
      log: logFn,
    });
  }

  /* The daemon-driven spoken "still working" heartbeat is gone
   * (operator directive 2026-07-21: no hard-coded spoken heartbeats,
   * ever). A typed cc-pty turn used to speak the heartbeat pulse aloud
   * because that timer never checked the typed-input suppression gate,
   * and more fundamentally the operator does not want the daemon
   * generating spoken filler at all. Any "still working" cue will be
   * reborn later as a Layer 1 system-prompt behavior, not a hardwired
   * setInterval that calls speak(). */

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
        /* layer 'mid': this is the deep (MID / brainstorm Lex) layer's
         * reply, delivered back up through the voice layer to the
         * operator - layer 2 of the three-way transcript. */
        layer: 'mid',
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
          /* Mid-turn (tool_use) text and the end_turn body are spoken
           * the SAME way: in full, via the voice brain, sentence-split
           * so piper starts on sentence one and the segments chain
           * gaplessly. There is no mid-turn/end-turn divergence anymore.
           *
           * 2026-07-19: the old clampAck truncated every mid-turn reply
           * to its first sentence (or dropped it to the canned sentinel),
           * so the operator heard silence after the first period on every
           * substantive thing Lex said before a tool call. That
           * divergence WAS the "reply cut at the first sentence" bug. Per-
           * segment hash dedupe (spokenSegmentHashes, stamped above) still
           * stops an identical end_turn block from being re-spoken. */
          if (isPreToolAck) {
            /* P1 top-owned ack: once the TOP layer has spoken its own
             * handoff for this forward (state.topOwnsAck), the first deep
             * mid-turn line is redundant with it - a double-ack and the
             * stale-ack race. Suppress it; it only speaks as the fallback
             * when the top produced no handoff at all (the common case:
             * the top forwards silently, speech=null). Otherwise the
             * mid-turn substance is spoken IN FULL. */
            const deepAck = _shouldSpeakDeepAckImpl({
              topOwnsAck: state.topOwnsAck,
            });
            if (!deepAck.speak) {
              logFn(
                `[voice-ws] deep mid-turn line suppressed reason=${deepAck.reason} text=${JSON.stringify(text.slice(0, 80))}`,
              );
            } else {
              /* decidePreToolAck is total (P0 no-silent-drop): the full
               * mid-turn text to speak, or a NAMED drop only when it is
               * empty (which selectTtsContent already excludes here). */
              const ackDecision = decidePreToolAck(text);
              if (ackDecision.speak) {
                speakViaBrain(ackDecision.speak, true);
              } else {
                logFn(
                  `[voice-ws] mid-turn line dropped reason=${ackDecision.dropReason} text=${JSON.stringify(text.slice(0, 80))}`,
                );
              }
            }
          } else {
            /* TTS is hooked ONLY to the top layer (operator directive
             * 2026-07-15): the voice brain delivers Lex's body in its
             * own voice, streamed sentence-by-sentence as its records
             * land. A miss (session down, 3s timeout) falls back to
             * speaking the raw body sentence-split - Lex's own words,
             * never a canned line; Lex is never silenced by the
             * delivery layer. Fire-and-forget: the post-turn pipeline
             * below never waits on speech. */
            speakViaBrain(text, true);
          }
        } else {
          send({ t: 'tts-skipped', reason: 'already-spoken' });
        }
      }
    }
    /* Pre-tool ack stops here. The follow-on end_turn record from
     * the same Lex turn will run artifacts / attention / large-fs /
     * compaction on the full message text. */
    if (isPreToolAck) return;
    /* P1 top-owned ack: this end_turn is the deep turn boundary, so the
     * top no longer owns an ack for it. The next escalated utterance
     * sets topOwnsAck fresh from its own handoff. */
    state.topOwnsAck = false;
    /* DRIVE-QUEUE 1b: this IS Lex's turn boundary (awaitingResponseSince
     * was just cleared above). Push a fresh small digest derived from
     * Lex's synthesized reply so the haiku fast lane / persona speak from
     * the current moment. BF-4: the only input is fullText, which is
     * Lex's user-facing reply, never raw transcript. Stamp lastLexTurnMs
     * first so a push failure leaves the digest stale (fast lane then
     * queues to Lex rather than answering off a stale digest). Gated +
     * best-effort: with the flag off nothing here runs, and a throw never
     * blocks the turn pipeline below. */
    if (useVoiceHaiku() && fullText && fullText.trim()) {
      try {
        const nowMs = Date.now();
        lastLexTurnMs = nowMs;
        pushDigest(buildVoiceDigest(fullText, getDigest()?.digest ?? null), nowMs);
      } catch {
        /* digest push is best-effort; never block the turn */
      }
    }
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
          log: (msg) => logFn(msg),
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
              /* Worker scope (2026-07-08 review finding): the
               * compaction restart was the one spawn path that
               * rebuilt the prompt WITHOUT scope, so a scoped
               * brainstorm crossing 75% context came back with the
               * global registry snapshot and no scope contract.
               * Same resolution as the anchor open/reopen routes. */
              const restartScope = resolveLexScopeDetailed(brainstormAnchorId);
              const built = buildLexSpawnPrompt({
                lexSessionId: brainstormAnchorId,
                transcriptPaths: [],
                scope: restartScope,
                ...(restartCwd ? { cwd: restartCwd } : {}),
              });
              if (built.feedback_memories.kept.length > 0) {
                logFn(
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
        logFn(
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
  function speak(text: string, opts?: { continuation?: boolean }): void {
    /* No-live-sink guard (2026-07-17 item 3): a speakable reply
     * heading into a closed connection is dead air the operator can
     * only diagnose from this line. The socket cycled every 30-60s
     * tonight, so replies routinely landed in these gaps. */
    if (state.closed) {
      logFn(
        `[voice-ws] SPEAKABLE REPLY DROPPED: no live voice sink (ws closed); text=${JSON.stringify(text.slice(0, 80))}`,
      );
      return;
    }
    /* #4 absolute user floor: while the operator physically holds PTT,
     * Lex emits ZERO audio. Drop the segment (never defer - stale audio
     * must not replay after the user releases). The panel still shows
     * the text; a real turn re-answers after release. Gated on PTT only,
     * NOT userSpeaking, so a VAD energy blip (noise) can never truncate
     * Lex's own in-flight reply. */
    if (state.pttFloorHeld) {
      logFn(
        `[voice-ws] SPEECH SUPPRESSED (user holds PTT floor): text=${JSON.stringify(text.slice(0, 80))}`,
      );
      return;
    }
    /* Pillar 3: route spoken output through the renderer (preserve-list
     * verbatim guard). Passthrough when the flag is off. The safe
     * markdown strip is the only render now; the live-haiku restyle
     * died in spec v2. opts.continuation marks a segment that chains
     * gaplessly onto the audio already scheduled client-side. */
    const spoken = renderForSpeech(text);
    lastSpokenText = spoken;
    speakCtrl.speak(spoken, opts);
  }

  /* Everything spoken goes through the brain (operator directive
   * 2026-07-15: no hardcoded talking). Delivers `text` in the top
   * layer's own voice, streamed sentence-by-sentence. On a brain miss:
   * fallbackRaw=true speaks the raw text (Lex's own words - a
   * protection against the brain silencing Lex, never a canned line);
   * fallbackRaw=false stays silent (filler like recaps and acks is
   * dropped rather than replaced by a template).
   *
   * 'cut' outcome (2026-07-16 failure 1): partials were spoken, then
   * the stream died (idle stall or the session was killed). The tail
   * was never heard, and raw fallback would double-speak the heard
   * prefix - so the delivery is RE-SPOKEN in full once the brain is
   * back (poll for warm, one retry), raw fallback only if the retry
   * also fails. deliverySeq guards staleness: a newer body supersedes
   * a pending redelivery, and the operator is never re-read an old
   * reply after the conversation moved on. */
  let deliverySeq = 0;
  const REDELIVERY_WAIT_MS = 90_000;
  const REDELIVERY_POLL_MS = 3_000;

  function speakViaBrain(text: string, fallbackRaw: boolean): void {
    deliverySeq += 1;
    const seq = deliverySeq;
    /* Stamp the final delivery outcome per session (module-level, keyed
     * by jsonl) so replay-on-switch on a LATER connection knows whether
     * this reply was fully heard. raw() enqueues the complete body to
     * TTS, so a raw fallback counts as delivered for replay purposes -
     * replaying it seconds later would double-speak. */
    const record = (o: LexReplyOutcome): void =>
      _recordReplyDelivery(state.jsonlPath, o, Date.now());
    const raw = (): void => {
      for (const s of splitForSpeech(text)) speak(s, { continuation: true });
    };
    const deliver = (): Promise<'delivered' | 'cut' | 'miss'> =>
      voiceLexReply(text, {
        onSpeech: (line) => {
          for (const s of splitForSpeech(line)) {
            speak(s, { continuation: true });
          }
        },
        log: logFn,
      });
    const redeliverAfterRespawn = async (): Promise<void> => {
      const deadline = Date.now() + REDELIVERY_WAIT_MS;
      while (Date.now() < deadline) {
        if (state.closed || deliverySeq !== seq) {
          logFn(
            '[voice-ws] redelivery abandoned: superseded by a newer delivery or socket closed',
          );
          return;
        }
        if (isVoiceBrainSessionWarm()) {
          logFn(
            `[voice-ws] re-delivering cut reply via respawned brain (body=${text.length} chars)`,
          );
          const second = await deliver();
          if (second !== 'delivered' && fallbackRaw && deliverySeq === seq) {
            logFn(
              `[voice-ws] redelivery ${second}; speaking raw body as final fallback`,
            );
            raw();
            record('delivered');
          } else if (second === 'delivered') {
            record('delivered');
          } else {
            record(second);
          }
          return;
        }
        await new Promise<void>((r) => {
          const t = setTimeout(r, REDELIVERY_POLL_MS);
          if (typeof (t as { unref?: () => void }).unref === 'function') {
            (t as { unref: () => void }).unref();
          }
        });
      }
      if (fallbackRaw && deliverySeq === seq && !state.closed) {
        logFn(
          '[voice-ws] redelivery gave up waiting for warm brain; speaking raw body',
        );
        raw();
        record('delivered');
      }
    };
    void deliver()
      .then((outcome) => {
        if (outcome === 'miss' && fallbackRaw) {
          raw();
          record('delivered');
        } else if (outcome === 'cut') {
          record('cut');
          void redeliverAfterRespawn();
        } else if (outcome === 'miss') {
          record('miss');
        } else {
          record('delivered');
        }
      })
      .catch(() => {
        if (fallbackRaw) {
          raw();
          record('delivered');
        } else {
          record('miss');
        }
      });
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
      logFn(
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
      logFn(
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
      /* Worker scope (2026-07-08): the direct-llm brainstorm sees
       * exactly its supervised worker — system prompt contract +
       * per-turn snapshot both collapse to that scope. */
      const scope = resolveLexScopeDetailed(bsId);
      const sysVersion = buildLexSystemPromptVersioned({
        mode: state.mode,
        scope,
      });
      const snapshot = buildVoiceSnapshot({
        activeBrainstormCwd: bs.cwd ?? null,
        scope,
      });
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
          logFn(
            `[voice-ws] direct-llm reply aborted mid-call bs=${bsId.slice(0, 8)}`,
          );
          send({ t: 'direct-llm-aborted', reason: 'contradiction' });
          return;
        }
        throw err;
      } finally {
        if (state.directLlmAbort === controller) state.directLlmAbort = null;
      }
      /* Step 3: render the reply in the transcript, persist it, then
       * (voice only) speak it. The assistant-text frame is the ONLY
       * channel that puts the reply into the transcript panel, so it must
       * fire BEFORE the TTS gate for EVERY turn - a typed
       * (suppressSpeakForTurn) reply still renders as text even though it
       * is never spoken. Mirrors the cc-pty path, which emits
       * assistant-text ahead of its own speak gate. */
      const replyTurnId = randomUUID();
      const delivery = planDirectLlmReplyDelivery({
        replyText: reply.text,
        mode: state.mode,
        suppressSpeakForTurn: state.suppressSpeakForTurn,
      });
      if (delivery.renderTranscript) {
        send({
          t: 'assistant-text',
          text: reply.text,
          /* layer 'mid': the deep (brainstorm Lex) reply delivered back
           * up to the operator's transcript. */
          layer: 'mid',
          turn_id: replyTurnId,
          brainstorm_id: bsId,
        });
      }
      try {
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
        logFn(
          `[voice-ws] direct-llm assistant chunk insert failed: ${(err as Error).message}`,
        );
      }
      if (delivery.speak) {
        await speak(reply.text);
      } else if (delivery.ttsSkippedReason) {
        /* Typed input to Lex-as-LLM: reply already rendered as text via
         * the assistant-text frame above; never spoken. */
        send({ t: 'tts-skipped', reason: delivery.ttsSkippedReason });
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
  /* Fix 24 live repro, 2026-07-16 smoke test: phantom barge stash.
   *
   * The AEC rework leaves the mic hot during playback, so VAD can fire
   * utterance-start on Lex's own audio or room noise. Pre-fix that
   * killed the ENTIRE remaining spoken body (in-flight segment + every
   * queued sentence) and nothing ever resumed: a phantom transcript
   * ([BLANK_AUDIO], noise words, suppressed echo) is dropped before it
   * can inject, so the partial chain never reached Lex and the queued
   * sentences were simply gone. Observed live at 03:28:30Z: the
   * 1031-char reply body cut mid-playback, whisper then logged the
   * barging "utterance" as [BLANK_AUDIO], and the operator called out
   * the unfinished statement.
   *
   * New contract (words-not-energy barge-in, per the spec v2
   * research): audio still stops INSTANTLY on utterance-start (barge
   * latency is untouched), but what was playing is stashed. When the
   * utterance resolves as phantom, the stash resumes (interrupted
   * sentence restarts, queued sentences follow). When words confirm a
   * real operator turn, the stash is dropped and the deferred PTY
   * Ctrl+C fires - so phantom noise can no longer abort Lex's
   * in-flight turn either. */
  let bargeStash: BargeStashEntry | null = null;

  /* Voice engine wiring (2026-07-17, VOICE-TOP-LAYER-SPEC). Per-
   * connection engine state: what Lex spoke (echo registry + run
   * texts for played-ms truncation), what was delivered (dedupe
   * registry), the word-gated barge state machine, and the extended
   * during-TTS window that closes at CLIENT drain instead of synth
   * end. */
  const echoRegistry = createEchoRegistry();
  const deliveryRegistry = createDeliveryRegistry();
  let bargeGate: BargeGateState = createBargeGateState();
  let clientPlaybackActive = false;
  let playbackTailTimer: ReturnType<typeof setTimeout> | null = null;
  let spokenRunTexts: string[] = [];
  /* Last deterministic hard interrupt (asr fast path), so the whisper
   * transcript of the same words does not double-fire hold_up. */
  let lastHardInterruptMs = 0;

  const engineDuringTts = (): boolean =>
    extendedDuringTts({
      ttsActive: state.ttsActive !== null,
      clientPlaybackActive,
    });

  const isEchoTextNow = (text: string): boolean =>
    classifyEcho(text, echoRegistry, Date.now()).echo;

  /* Legacy-client fallback: without playback-drained frames the
   * clientPlaybackActive flag would stick forever after tts-end. A
   * bounded tail (6s, generous for buffered audio) clears it; a new
   * tts-start or a real drain signal preempts. */
  function armPlaybackTailFallback(): void {
    if (playbackTailTimer) clearTimeout(playbackTailTimer);
    playbackTailTimer = setTimeout(() => {
      playbackTailTimer = null;
      clientPlaybackActive = false;
      spokenRunTexts = [];
    }, 6_000);
    if (
      typeof (playbackTailTimer as { unref?: () => void }).unref === 'function'
    ) {
      (playbackTailTimer as { unref: () => void }).unref();
    }
  }

  /* BASELINE (LAYER-1-CONTROL.md, 2026-07-20): a barge never resumes.
   * Drop the stash and STAY stopped on the noise / echo / finish paths
   * that used to call resumeBargedSpeech. The audio the barge cut is
   * gone; the full L2/L1 statement stays readable as text via the jsonl
   * transcript. The pure resume mechanism (_resumeBargedSpeechImpl) is
   * retained for the documented L1 rebuild but no longer on the hot
   * path. */
  function dropBargeStash(reason: string): void {
    if (!bargeStash) return;
    bargeStash = null;
    logFn(`[voice-ws] barge: stopped, no resume (reason=${reason})`);
  }

  /* Words confirmed a real operator turn behind the barge: drop the
   * stash (no resume) and fire the deferred PTY Ctrl+C so the worker
   * drops the rest of the interrupted turn - the same effect the old
   * unconditional utterance-start kill had, minus the phantom
   * misfires. `withCtrlC=false` for interpreted controls like
   * stop_speaking, whose contract is "silence the voice, Lex keeps
   * working". */
  function confirmRealBarge(withCtrlC: boolean): void {
    const stash = bargeStash;
    if (!stash) return;
    bargeStash = null;
    if (!withCtrlC || !stash.ctrlCPending) return;
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

  function killActiveTts(reason: 'utterance-start' | 'barge-in'): void {
    /* Fix 40 (2026-05-26): controller owns the ctx + queue + partial-
     * chain bookkeeping. It returns true when a real in-flight ctx
     * was cancelled (vs an idle state with a possibly non-empty
     * queue).
     *
     * Barge kill path (2026-07-19): the tts-cancel frame now keys off
     * the SPEECH/PLAYBACK layer, not the brain. A real barge often
     * interrupts CLIENT-buffered playback that outlives the daemon synth
     * ctx (voice-brain "ask replied" fires before the client finishes
     * playing), so state.ttsActive is already null and killActive()
     * returns false - yet audio is still playing and the cancel MUST
     * reach the client. _killActiveTtsDecision emits the cancel whenever
     * a synth ctx was cancelled OR clientPlaybackActive is true, and
     * keeps the destructive parts (bargeStash queue-loss + PTY Ctrl+C)
     * gated on a real cancellation only, so a phantom barge never hard-
     * interrupts the worker (the existing Fix 20 contract). */
    const interruptedSegment = state.currentTtsText;
    const queuedSegments = state.ttsQueue.map((q) => q.cleanText);
    const cancelled = speakCtrl.killActive();
    const decision = _killActiveTtsDecision({ cancelled, clientPlaybackActive });
    if (decision.emitCancel) send({ t: 'tts-cancel', reason });
    if (!decision.runTeardown) return;
    if (reason === 'utterance-start') {
      /* VAD energy, not yet words: stop the audio now, defer the
       * destructive parts (queue loss + PTY Ctrl+C) until the
       * transcript proves the barge real. See bargeStash above. */
      bargeStash = {
        interruptedSegment,
        queuedSegments,
        atMs: Date.now(),
        ctrlCPending: true,
        /* Snapshot the full spoken run NOW, before playback-stopped
         * clears spokenRunTexts: this is every sentence shipped to the
         * client, the source the remainder-resume slices the unheard
         * tail from (Fix 24 tail-loss, 2026-07-18). */
        fullRunText: spokenRunTexts.join(' ').trim(),
        playedMs: null,
      };
      return;
    }
    /* Explicit barge-in frame: a deliberate client action (hotkey /
     * legacy path), no phantom risk. Old behavior: abort the PTY turn
     * immediately. */
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
    const firstQueued = state.pendingUserUtterances[0] ?? null;
    const startOffset = currentJsonlSize();
    const flushPayload = _flushPendingUtterancesImpl({
      state,
      ptyInject,
      send,
      dedupe: {
        shouldDeliver: (fp, now) => deliveryRegistry.shouldDeliver(fp, now),
        markDelivered: (fp, now) => deliveryRegistry.markDelivered(fp, now),
        fingerprint: fingerprintUtterance,
      },
    });
    /* Queue emptied = the flush inject was accepted; verify it
     * actually SUBMITTED (2026-07-16 stuck-paste failure) and landed
     * INTACT (third wave front truncation; partial landings repaste). */
    if (firstQueued && flushPayload) {
      verifyInjectDelivery(
        firstQueued.slice(0, 60),
        startOffset,
        flushPayload,
      );
    }
  }

  /* Size of the bound session jsonl right now; 0 when unknown. Used
   * as the scan baseline for delivery verification. */
  function currentJsonlSize(): number {
    if (!state.jsonlPath) return 0;
    try {
      return fs.statSync(state.jsonlPath).size;
    } catch {
      return 0;
    }
  }

  /* Fire-and-forget delivery verification for an idle-time commit
   * inject. See _verifyInjectDeliveryImpl for the contract. When the
   * full pasted payload is provided, head/tail integrity probes are
   * derived from it and a partial landing (front truncation between
   * the paste writer and the terminal, 2026-07-16 third wave) gets
   * ONE full repaste instead of pointless CR nudges. */
  function verifyInjectDelivery(
    fingerprint: string,
    startOffset: number,
    payload?: string,
  ): void {
    const jsonlPath = state.jsonlPath;
    if (!jsonlPath || !fingerprint.trim()) return;
    const fps = payload ? payloadIntegrityFingerprints(payload) : null;
    void _verifyInjectDeliveryImpl({
      jsonlPath,
      startOffset,
      fingerprint,
      ...(fps?.head ? { headFingerprint: fps.head } : {}),
      ...(fps?.tail ? { tailFingerprint: fps.tail } : {}),
      ...(payload
        ? {
            repaste: () => {
              if (!state.bindKey || state.closed) return;
              /* One repaste per utterance EVER (live 3x duplication,
               * 2026-07-17 03:09Z): the verifier already limits to one
               * per verification loop; this registry key caps it
               * across loops so no combination of partial landings
               * can re-send the same words twice. */
              const repasteKey = `repaste:${fingerprintUtterance(fingerprint)}`;
              if (!deliveryRegistry.shouldDeliver(repasteKey, Date.now())) {
                logFn(
                  '[voice-ws] repaste suppressed: this utterance was already repasted once',
                );
                return;
              }
              deliveryRegistry.markDelivered(repasteKey, Date.now());
              try {
                ptyInject(state.bindKey, payload, true);
              } catch {
                /* best-effort; the loop's failure path stays loud */
              }
            },
          }
        : {}),
      statSize: (p) => {
        try {
          return fs.statSync(p).size;
        } catch {
          return null;
        }
      },
      readRange: (p, start, length) => {
        try {
          const fd = fs.openSync(p, 'r');
          try {
            const buf = Buffer.alloc(length);
            fs.readSync(fd, buf, 0, length, start);
            return buf.toString('utf-8');
          } finally {
            fs.closeSync(fd);
          }
        } catch {
          return null;
        }
      },
      retryCr: (attempt) => {
        if (!state.bindKey || state.closed) return;
        /* Final attempt escalates to space+Enter - the manual
         * recovery that provably submits a stuck paste. Earlier
         * attempts stay a bare CR (idempotent on a clean composer). */
        const nudge = attempt >= 3 ? ' \r' : '\r';
        try {
          ptyInject(state.bindKey, nudge, false);
        } catch {
          /* best-effort */
        }
      },
      onFailure: () => {
        /* No user-facing error. Time-based voice errors are removed by
         * directive: a dormant/slow worker (or a brainstorm forward that
         * legitimately never lands a PTY record) tripped this watchdog
         * dozens of times a night as a false alarm. The CR-retry ladder
         * (retryCr, escalating to space+Enter) still runs silently and
         * self-recovers a genuinely stuck paste; the log line stays so a
         * real stuck paste is still auditable. The scary pill is gone. */
        logFn(
          `[voice-ws] inject delivery unconfirmed after CR retries (silent; no user error by directive) fingerprint=${JSON.stringify(fingerprint.slice(0, 40))}`,
        );
      },
      sleep: (ms) =>
        new Promise((r) => {
          const t = setTimeout(r, ms);
          if (typeof (t as { unref?: () => void }).unref === 'function') {
            (t as { unref: () => void }).unref();
          }
        }),
      log: logFn,
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
      logFn(
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
        logFn(
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
            logFn(
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
            logFn(
              `[voice-ws] end_session: anchor flipped dormant ${anchorId}`,
            );
          } catch (err) {
            logFn(
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
          /* No hardcoded talking: runHoldUp's recap template goes
           * through the brain's own delivery; a miss means the recap
           * is skipped (the abort effects above already happened). */
          speak: (text) => {
            speakViaBrain(text, false);
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
      /* DRIVE-QUEUE 1b: state change. Push a fresh digest so the fast
       * lane knows the moment (which project just started) instead of
       * speaking from a prior turn's stale context. */
      if (useVoiceHaiku()) {
        const nowMs = Date.now();
        lastLexTurnMs = nowMs;
        pushDigest(
          {
            currentTask: `starting ${projectLabel}`,
            lastDecision: `starting ${projectLabel}`,
            openQuestion: '',
            workerStatus: '',
            nextSteps: '',
          },
          nowMs,
        );
      }
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

  /* Resolve the brainstorm this socket is currently bound to, the
   * same way several other blocks in this file already do (e.g. the
   * per-turn feedback lookup around line 1416, the audio-persist
   * block around line 2467): direct-llm sets state.brainstormId
   * directly on bindByBrainstorm; cc-pty never does, so fall back to
   * resolving it from the bound PTY handle's session/pty id. Shared
   * by applyHelloKind and captureNotesUtteranceOnly below so both
   * stay in sync with whatever this connection is actually bound to. */
  function resolveBoundBrainstormId(): string | null {
    if (state.brainstormId) return state.brainstormId;
    try {
      const handle = state.bindKey
        ? getPty(state.bindKey) || getPtyBySession(state.bindKey)
        : null;
      const watchSid = handle?.sessionId ?? state.watchSessionId ?? null;
      const bs =
        (watchSid && getBrainstormByClaudeSessionId(watchSid)) ||
        (handle?.ptyId && getBrainstormByPty(handle.ptyId)) ||
        null;
      return bs?.id ?? null;
    } catch {
      return null;
    }
  }

  /* Meeting-notes fixes (2026-07), task 1. Apply the hello frame's
   * kind to whatever this socket just bound to. Idempotent (a no-op
   * write is skipped) and best-effort: a failure here must never
   * block hello-ack or the bind that already succeeded above. */
  function applyHelloKind(kind: 'brainstorm' | 'meeting'): void {
    try {
      const bsId = resolveBoundBrainstormId();
      if (!bsId) return;
      const existing = getBrainstorm(bsId);
      if (!existing) return;
      const current = existing.kind === 'meeting' ? 'meeting' : 'brainstorm';
      if (current !== kind) {
        setBrainstormKind(bsId, kind);
      }
    } catch {
      /* explicit-confirm kind flip is best-effort; never block hello-ack */
    }
  }

  /* Notes/meeting name-gate (2026-07), task 2. Lex's system-prompt
   * contract otherwise replies to every utterance; in notes mode the
   * room is usually dictating or discussing, not talking to Lex, so
   * every utterance still needs a durable record but only some of
   * them should ever reach Lex. Called by handleUtteranceEnd for the
   * not-addressed branch (the ONLY branch that writes here, by
   * construction; see the isAddressedToLexInNotesMode call site's
   * comment for why that mutual exclusion is what keeps this from
   * double-storing against the cc-pty jsonl-ingestor / the direct-llm
   * handler's own persist step, neither of which this utterance ever
   * reaches). Mirrors the direct-llm user-chunk insert shape
   * (handleDirectLlmUtterance's step 1 below) so the row looks the
   * same across runtimes; model_id is tagged distinctly so a
   * capture-only row is identifiable in future queries.
   *
   * Thin closure over _captureNotesUtteranceOnlyImpl (below), same
   * split as _flushPendingUtterancesImpl: the DB-touching logic is
   * exported with injected deps so tests can assert it writes a
   * chunk WITHOUT going anywhere near ptyInject or
   * handleDirectLlmUtterance: those functions are not even in its
   * dependency list, so it cannot forward by construction. */
  function captureNotesUtteranceOnly(text: string): void {
    const bsId = resolveBoundBrainstormId();
    if (!bsId) return;
    const store = getStore();
    _captureNotesUtteranceOnlyImpl({
      brainstormId: bsId,
      text,
      insertChunk: (row) => store.db.insertBrainstormChunk(row),
      nextTurnIndex: (id) => store.db.nextTurnIndex(id),
    });
  }

  /* Fast-lane transcript hole fix (2026-07-15), task 1. Thin closure
   * over _captureAbsorbedAsideImpl, same split as
   * captureNotesUtteranceOnly directly above: the DB-touching logic
   * lives in the exported impl with injected deps so it is unit-
   * testable without a live socket or a real DB. Called only from the
   * 'fast' lane branch below, gated on
   * shouldCaptureAbsorbedAside(state.mode). */
  function captureAbsorbedAside(aside: string, reply: string): void {
    const bsId = resolveBoundBrainstormId();
    if (!bsId) return;
    const store = getStore();
    _captureAbsorbedAsideImpl({
      brainstormId: bsId,
      aside,
      reply,
      insertChunk: (row) => store.db.insertBrainstormChunk(row),
      nextTurnIndex: (id) => store.db.nextTurnIndex(id),
    });
  }

  /* Smart Turn hold/merge state (spec v2 phase 2), per connection. An
   * utterance the model judges mid-thought is held and merged with the
   * operator's continuation instead of being answered mid-sentence. */
  let smartTurnCoalescer = emptyCoalescerState();

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
    let trimmed = result.text.trim();
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
      logFn(
        `[voice-ws] dropped whisper utterance: reason=${reason} words=${wordCount} text=${JSON.stringify(trimmed)}`,
      );
      send({ t: 'transcript', text: '', ms: result.ms });
      /* BASELINE (LAYER-1-CONTROL.md): VAD fired on echo/noise and killed
       * the spoken body, whisper heard nothing real. Pre-baseline this
       * resumed the barged speech; now a barge NEVER resumes - drop the
       * stash and stay stopped. */
      dropBargeStash(reason);
      return;
    }
    /* layer 'operator': the operator's own utterance, layer 0 of the
     * three-way transcript (you -> voice -> deep -> and back). */
    send({ t: 'transcript', text: result.text, ms: result.ms, layer: 'operator' });
    /* Real voice turn confirmed (passed the noise floor): Lex talks
     * back. Clears any suppression a prior typed turn left set. */
    state.suppressSpeakForTurn = false;
    logFn(
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
    /* The ONE mechanical keyword (spec v2): "lex emergency stop". An
     * emergency kill must not depend on a model round trip, so it is
     * checked before anything else. Every other former keyword (mute,
     * standby, end session, hold up, start project...) is interpreted
     * intent now, handled by the voice top layer below or by the
     * dashboard buttons. */
    if (matchPanicCommand(result.text)) {
      logFn('[voice-ws] panic phrase matched; dispatching');
      confirmRealBarge(true);
      dispatchVoiceCommand('panic', 'transcript');
      state.utteranceStartedDuringTts = false;
      return;
    }
    /* Engine classification (2026-07-17, VOICE-TOP-LAYER-SPEC).
     * Order is the safety property: deterministic stop-class BEFORE
     * the echo filter (a spoken "hold on" interrupts even when Lex's
     * reply contained those words), echo discard BEFORE anything that
     * could turn Lex's own audio into a user turn (top layer, inject,
     * mid-turn queue). Panic already ran above. */
    const engineVerdict = classifyIncomingTranscript({
      text: trimmed,
      echoRegistry,
      nowMs: Date.now(),
      duringTts: state.utteranceStartedDuringTts,
    });
    if (
      engineVerdict.action === 'stop_speaking' ||
      engineVerdict.action === 'interrupt_work'
    ) {
      /* The asr fast path may have already fired for these same words;
       * do not double-interrupt, but still honor the remainder. */
      const recentAsrInterrupt = Date.now() - lastHardInterruptMs < 5_000;
      logFn(
        `[voice-ws] stop-class ${engineVerdict.action} (whisper path) remainder=${JSON.stringify(engineVerdict.remainder.slice(0, 60))} recent_asr_interrupt=${recentAsrInterrupt}`,
      );
      confirmRealBarge(false);
      if (!recentAsrInterrupt) {
        if (engineVerdict.action === 'interrupt_work') {
          lastHardInterruptMs = Date.now();
          dispatchVoiceCommand('hold_up', 'transcript');
        } else {
          const cancelled = speakCtrl.killActive();
          if (cancelled) send({ t: 'tts-cancel', reason: 'quiet' });
        }
      }
      if (!engineVerdict.remainder.trim()) {
        state.utteranceStartedDuringTts = false;
        return;
      }
      /* Substantive content behind the stop phrase forwards through
       * the normal pipeline below. */
      trimmed = engineVerdict.remainder;
      result = { text: engineVerdict.remainder, ms: result.ms };
    } else if (engineVerdict.action === 'echo-drop') {
      logFn(
        `[voice-ws] ECHO DROPPED: transcript matches Lex's own recent TTS (score=${(engineVerdict.echoScore ?? 0).toFixed(2)} matched=${JSON.stringify((engineVerdict.echoMatched ?? '').slice(0, 60))}) text=${JSON.stringify(trimmed.slice(0, 80))}`,
      );
      send({ t: 'echo-dropped', text: trimmed });
      dropBargeStash('echo-filter');
      state.utteranceStartedDuringTts = false;
      return;
    }
    /* Smart Turn semantic endpointing (spec v2 phase 2). The client's
     * VAD ends utterances on 450ms of silence now; this decides whether
     * the operator was actually DONE. 'incomplete' holds the text and
     * merges the continuation (hold window default 1600ms, evaluated at
     * the next event); 'complete'/'unavailable' processes immediately,
     * with any held text prepended. Runs AFTER panic (the kill phrase
     * is never held) and degrades to a no-op when the model file or
     * runtime_config toggle says off. */
    if (isSmartTurnEnabled()) {
      let verdict: TurnVerdict = 'unavailable';
      try {
        verdict = await analyzeTurn(pcm, 16000);
      } catch {
        verdict = 'unavailable';
      }
      const dec = decideCoalesce(
        smartTurnCoalescer,
        verdict,
        trimmed,
        Date.now(),
      );
      smartTurnCoalescer = dec.nextState;
      /* A real event just re-evaluated the coalescer; whatever flush
       * timer was pending belongs to the previous hold. */
      clearHeldTurnFlush();
      if (dec.action === 'hold') {
        logFn(
          `[voice-ws] smart-turn hold (mid-thought): ${JSON.stringify(dec.text.slice(0, 80))}`,
        );
        send({ t: 'turn-held', text: dec.text });
        /* Real words, just mid-thought: the barge is genuine, so the
         * stash must not resume over the operator's continuation. */
        confirmRealBarge(true);
        state.utteranceStartedDuringTts = false;
        /* Governor fallback (2026-07-17, VOICE-TOP-LAYER-SPEC): the
         * coalescer is timer-free by design, so without this a held
         * mid-thought fragment whose speaker never resumed would
         * starve FOREVER (the anti-starvation merge only runs at the
         * NEXT event). The bounded loop re-checks on the governor
         * cadence and force-ships at the hard ceiling. */
        armHeldTurnFlush(dec.nextState.heldSinceMs || Date.now());
        return;
      }
      if (dec.text !== trimmed) {
        logFn(
          `[voice-ws] smart-turn merged held turn: ${JSON.stringify(dec.text.slice(0, 80))}`,
        );
        trimmed = dec.text;
        result = { text: dec.text, ms: result.ms };
      }
    }
    await processTurnText(trimmed, result.ms);
  }

  /* Held-turn governor flush (2026-07-17). While the Smart Turn
   * coalescer holds a mid-thought fragment, re-evaluate on the
   * endpoint governor's cadence; at the hard ceiling pop the held
   * words and ship them through the identical post-endpointing
   * pipeline. Cleared whenever a real event re-runs the coalescer. */
  let heldTurnFlushTimer: ReturnType<typeof setTimeout> | null = null;
  function clearHeldTurnFlush(): void {
    if (heldTurnFlushTimer) {
      clearTimeout(heldTurnFlushTimer);
      heldTurnFlushTimer = null;
    }
  }
  function armHeldTurnFlush(heldSinceMs: number): void {
    clearHeldTurnFlush();
    const tick = (): void => {
      heldTurnFlushTimer = null;
      if (state.closed) return;
      if (!smartTurnCoalescer.heldText) return;
      const d = decideEndpoint(
        createEndpointState(heldSinceMs),
        'incomplete',
        Date.now(),
      );
      if (d.action === 'hold') {
        heldTurnFlushTimer = setTimeout(
          tick,
          d.nextCheckInMs ?? ENDPOINT_CHECK_INTERVAL_MS,
        );
        if (
          typeof (heldTurnFlushTimer as { unref?: () => void }).unref ===
          'function'
        ) {
          (heldTurnFlushTimer as { unref: () => void }).unref();
        }
        return;
      }
      const popped = decideCoalesce(smartTurnCoalescer, 'complete', '', Date.now());
      smartTurnCoalescer = popped.nextState;
      if (popped.action === 'process' && popped.text.trim()) {
        logFn(
          `[voice-ws] held-turn governor flush: hard ceiling reached, shipping ${JSON.stringify(popped.text.slice(0, 80))}`,
        );
        void processTurnText(popped.text, 0);
      }
    };
    heldTurnFlushTimer = setTimeout(tick, ENDPOINT_CHECK_INTERVAL_MS);
    if (
      typeof (heldTurnFlushTimer as { unref?: () => void }).unref === 'function'
    ) {
      (heldTurnFlushTimer as { unref: () => void }).unref();
    }
  }

  /* Post-endpointing turn processing: notes gate -> voice top layer ->
   * inject/queue/direct-llm. Extracted from handleUtteranceEnd
   * (2026-07-17) so the held-turn governor flush can dispatch a
   * starved mid-thought fragment through the IDENTICAL pipeline a
   * merged turn takes. */
  async function processTurnText(text: string, ms: number): Promise<void> {
    let trimmed = text;
    let result: { text: string; ms: number } = { text, ms };
    /* Notes/meeting name-gate (2026-07), task 2. Voice commands above
     * always run first regardless of mode (unchanged). In notes mode,
     * either kind (brainstorm or meeting), every OTHER utterance is
     * captured but only forwarded to Lex (haiku fast-desk, cc-pty
     * inject, or direct-llm generate, all below) when it addresses
     * her by name with a question/request shape. Notes mode never
     * synthesizes TTS regardless of this gate (state.mode === 'notes'
     * checks further down), so short-circuiting here before the
     * haiku block and the cc-pty/direct-llm branches costs nothing
     * mode-relevant and keeps conversation/push-to-talk completely
     * unchanged (they never enter this branch).
     *
     * Double-store guard: a not-addressed turn returns here without
     * ever reaching ptyInject or handleDirectLlmUtterance, so it can
     * never reach a CC jsonl (cc-pty's brainstorm-jsonl-ingestor only
     * sees what the claude CLI itself wrote) or duplicate
     * handleDirectLlmUtterance's own step-1 persist (direct-llm). The
     * capture write below is therefore the utterance's ONLY writer.
     * An addressed turn is NOT captured here: it falls through to
     * the existing forwarding paths, which are themselves the sole
     * writer for THAT turn (the ingestor for cc-pty, step 1 of
     * handleDirectLlmUtterance for direct-llm), so exactly one writer
     * ever touches brainstorm_chunks per utterance either way. */
    if (state.mode === 'notes') {
      if (!isAddressedToLexInNotesMode(trimmed)) {
        captureNotesUtteranceOnly(trimmed);
        state.utteranceStartedDuringTts = false;
        return;
      }
      /* Addressed: fall through unchanged to haiku / cc-pty /
       * direct-llm below. Nothing extra is written here; see the
       * guard note above. */
    }
    await runCoalescedTopLayerTurn(trimmed, result.ms);
  }

  /* SM-25 smart stacking (2026-07-18, operator): serialize top-layer
   * voice turns. Concurrent utterance-ends used to fire concurrent
   * topLayerTurn asks whose replies then played back to back as
   * discrete stacked answers. Now: one turn at a time; utterances
   * arriving mid-turn queue onto state.pendingTopUtterances; when
   * the in-flight turn resolves UNSPOKEN (no streamed lines, nothing
   * at the speakers yet) the queue supersedes it - a single combined
   * re-ask answers everything in one cohesive reply. If speech
   * already streamed, the reply finishes and the queued utterances
   * get one combined follow-up turn. Depth-capped so a pathological
   * loop can never spin the brain forever. */
  async function runCoalescedTopLayerTurn(
    firstUtterance: string,
    sttMs: number,
  ): Promise<void> {
    if (_shouldCoalesceMidReplyImpl({ replyInFlight: state.topTurnInFlight })) {
      state.pendingTopUtterances.push(firstUtterance);
      logFn(
        `[voice-ws] top-layer coalesce: queued while turn in flight depth=${state.pendingTopUtterances.length} text=${JSON.stringify(firstUtterance.slice(0, 60))}`,
      );
      send({
        t: 'queued-mid-turn',
        text: firstUtterance,
        queue_depth: state.pendingTopUtterances.length,
      });
      return;
    }
    state.topTurnInFlight = true;
    try {
      let utterance = firstUtterance;
      for (let depth = 0; depth < 6; depth++) {
        const superseding = await runTopLayerVoiceTurnOnce(utterance, sttMs);
        if (typeof superseding === 'string' && superseding.length > 0) {
          utterance = superseding;
          continue;
        }
        const queued = state.pendingTopUtterances.splice(0);
        if (queued.length === 0) return;
        logFn(
          `[voice-ws] top-layer coalesce: draining ${queued.length} queued utterance(s) as one combined turn`,
        );
        utterance = mergeOperatorUtterances(queued);
      }
      if (state.pendingTopUtterances.length > 0) {
        logFn(
          `[voice-ws] top-layer coalesce: depth cap hit; dropping ${state.pendingTopUtterances.length} queued utterance(s)`,
        );
        state.pendingTopUtterances = [];
      }
    } finally {
      state.topTurnInFlight = false;
    }
  }

  /* Voice top layer (spec v2, 2026-07-15): the one conversational
   * brain the operator talks to. Every utterance that survived the
   * panic check and the notes gate gets ONE speech-first turn from
   * the dedicated persistent session: whatever it says is spoken;
   * a trailing FORWARD: line hands substance to Lex through the
   * normal inject path below; a trailing CONTROL: line fires the
   * existing dispatch effects. No lanes, no whitelist, no canned
   * lines. Fail-safe: session down/timeout/unparseable means the
   * turn forwards untouched - the top layer can never eat the
   * operator's words.
   *
   * SM-25: extracted from handleUtteranceEnd's tail so the coalesce
   * loop above can re-enter it with a combined utterance. Returns a
   * string when the resolved reply was superseded (the caller
   * re-asks with that combined text); returns void when the turn
   * completed (spoken, forwarded, controlled, or absorbed). */
  async function runTopLayerVoiceTurnOnce(
    trimmed: string,
    sttMs: number,
  ): Promise<string | void> {
    let result: { text: string; ms: number } = { text: trimmed, ms: sttMs };
    state.utteranceStartedDuringTts = false;
    /* Layer 1 is UNWIRED (LAYER-1-CONTROL.md, 2026-07-20). The smart
     * haiku talk-layer ask is gone: it returned an empty (chars=0) turn
     * every time and fail-safe-forwarded the operator's words to L2
     * anyway. The operator utterance now forwards straight to L2 - no
     * classify, no rethink/finish, no top-layer speech, no ack round
     * trip, no chars=0. The L1 intelligence is rebuilt on top of this
     * later; see the doc. */
    logFn(`[voice-ws] forward to L2: ${JSON.stringify(trimmed.slice(0, 80))}`);
    /* Coalesce (COALESCE-UTTERANCE-QUEUE point 5): utterances that
     * stacked up while this turn was resolving combine into ONE forward,
     * so L2 gets one cohesive turn instead of stacked replies. */
    if (state.pendingTopUtterances.length > 0) {
      const extras = state.pendingTopUtterances.splice(0);
      logFn(
        `[voice-ws] coalesce: combining ${extras.length} newer utterance(s) into one forward`,
      );
      return mergeOperatorUtterances([trimmed, ...extras]);
    }
    /* Barge (baseline): drop the stash and STAY stopped - a barge never
     * resumes. No deferred Ctrl+C, so L2 finishes its reply and the full
     * statement stays readable as text; only the TTS audio was cut.
     * Truncating L2 is reserved for the deterministic emergency stop. */
    confirmRealBarge(false);
    /* L1 no longer speaks its own ack; the single ack is the deep (L2)
     * pre-tool ack. */
    state.topOwnsAck = false;
    /* Three-way transcript: surface the you -> voice -> deep hop; the L2
     * reply comes back later as an assistant-text (layer 'mid'). */
    send({ t: 'layer-hop', layer: 'top', text: `to Lex (brain): ${trimmed}` });
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
      if (
        _shouldCoalesceMidReplyImpl({
          replyInFlight: state.inFlightDirectLlmReply,
        })
      ) {
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
          logFn(
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
        logFn(
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
          /* Worker scope (2026-07-08): a turn routed to a known
           * brainstorm sees only that brainstorm's supervised
           * worker. Unresolvable rows keep the legacy global view
           * (a non-brainstorm PTY mirror is not a Lex turn). */
          scope: bsForCwd ? resolveLexScope(bsForCwd.id) : null,
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
    /* Fix 20 (2026-05-23) mid-turn-no-tts queue - RETIRED by Phase 2
     * R3/R5. The old rule held the forward onto pendingUserUtterances
     * whenever Lex was mid-turn with no TTS, draining only at end_turn.
     * Phase 2 makes the top layer the always-reachable arbiter that
     * routes to mid LIVE, so this hold is gone: the predicate returns
     * false and the forward falls through to the live inject below,
     * where the mid CC composer buffers a mid-turn paste and picks it
     * up at its next boundary. The block is retained behind the seam
     * (unreachable while the predicate is false) so the contract has a
     * single, tested toggle point. The TTS-active case remains a
     * "barge over Lex's reply" handled earlier by killActiveTts. */
    if (
      _shouldDeferForwardToMidTurnBoundary({
        lexMidTurn: state.awaitingResponseSince > 0,
        ttsActive: Boolean(state.ttsActive),
      })
    ) {
      /* Addendum 2026-05-24, narrowed by spec v2: belt-and-suspenders
       * panic punch-through. The panic phrase already ran at the top
       * of handleUtteranceEnd, but re-check at the queue's edge so any
       * future refactor that lands command text here cannot silently
       * swallow the one mechanical keyword. Interpreted controls were
       * already handled by the top layer before this point. */
      if (matchPanicCommand(result.text)) {
        logFn(
          '[voice-ws] mid-turn-queue: panic phrase punches through, dispatching synchronously',
        );
        dispatchVoiceCommand('panic', 'transcript');
        return;
      }
      /* One utterance = one delivery: if this exact utterance already
       * reached Lex inside the window (asr fast path + whisper double
       * classification, or a re-transcribed echo), do not queue a
       * second copy. */
      const queueFp = fingerprintUtterance(result.text);
      if (!deliveryRegistry.shouldDeliver(queueFp, Date.now())) {
        logFn(
          `[voice-ws] DUPLICATE DELIVERY SUPPRESSED (mid-turn queue): ${JSON.stringify(result.text.slice(0, 60))}`,
        );
        return;
      }
      state.pendingUserUtterances.push(result.text);
      logFn(
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
    /* Fast-lane transcript hole fix (2026-07-15), task 2. This is
     * "the NEXT real inject to Lex" the ring was waiting for: drain
     * every conversation-mode aside the fast lane absorbed since her
     * last real turn into a one-line-per-aside prefix so she knows
     * the exchange happened, even though it never reached her
     * context directly. Empty ring -> '' -> this block is a no-op and
     * the inject stays byte-identical to before this fix. */
    let asideBlock = '';
    if (state.absorbedAsides.length > 0) {
      asideBlock = _formatAbsorbedAsideBlockImpl(state.absorbedAsides) + '\n\n';
    }
    /* One utterance = one delivery (live 3x duplication, 2026-07-17
     * 03:09Z): the direct path marks the fingerprint; the queue,
     * flush, and repaste paths all consult the same registry. */
    const directFp = fingerprintUtterance(result.text);
    if (!deliveryRegistry.shouldDeliver(directFp, Date.now())) {
      logFn(
        `[voice-ws] DUPLICATE DELIVERY SUPPRESSED (direct inject): ${JSON.stringify(result.text.slice(0, 60))}`,
      );
      return;
    }
    const preInjectJsonlSize = currentJsonlSize();
    const injectPayload =
      asideBlock + snapshotBlock + gateNote + partialChainBlock + voiceTag + result.text;
    const ir = ptyInject(state.bindKey, injectPayload, true);
    if (!ir.ok) {
      send({ t: 'error', code: 'inject', message: ir.error });
      return;
    }
    deliveryRegistry.markDelivered(directFp, Date.now());
    /* Idle-time commit inject: verify it actually SUBMITTED (2026-07-16
     * stuck-paste failure - trailing CR silently swallowed, prompt sat
     * at the terminal until the operator pressed Enter by hand) AND
     * landed INTACT (third wave: payload lead eaten by the paste path
     * while the daemon-side text was fine; partial landings repaste). */
    verifyInjectDelivery(result.text.slice(0, 60), preInjectJsonlSize, injectPayload);
    /* Consume the partial chain only after a successful inject. If
     * inject fails, the chain stays so the retry path on the next
     * utterance still carries the partials. Same contract for the
     * aside ring: only cleared once the prefix has actually landed in
     * Lex's PTY. */
    state.partialChain = [];
    state.absorbedAsides = [];
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
      case 'hello': {
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
        /* Meeting-notes fixes (2026-07), task 1 (F1 / explicit
         * confirm). The client's notes-mode "meeting session" toggle
         * rides every hello as kind:'meeting'|'brainstorm'; apply it
         * to whatever bind() / bindByBrainstorm() just resolved. This
         * is the explicit-confirm flip CODEX-REVIEW-002.md:71 asked
         * for: kind only ever changes because the client said so on
         * THIS connection, never inferred silently from mode alone. */
        const helloKind =
          msg.kind === 'meeting'
            ? 'meeting'
            : msg.kind === 'brainstorm'
              ? 'brainstorm'
              : null;
        if (helloKind) applyHelloKind(helloKind);
        break;
      }
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
        /* LEGACY client path (raw-VAD kill). Capture whether TTS was
         * active BEFORE the kill so the AEC-bleed gate downstream
         * still sees the truth. 2026-07-17: the window now extends to
         * client drain, not synth end (the drain-tail hole). New
         * clients send vad-onset instead and the word gate decides. */
        state.utteranceStartedDuringTts = engineDuringTts();
        /* User holds the floor until utterance-end. */
        state.userSpeaking = true;
        /* #4 absolute floor: utterance-start is PTT-down. While the
         * button is held, speak() drops every segment so Lex emits ZERO
         * audio over the user (cleared on utterance-end / release). */
        state.pttFloorHeld = true;
        killActiveTts('utterance-start');
        state.micBuf = [];
        state.micBufBytes = 0;
        break;
      case 'vad-onset': {
        /* Sound-gated barge (LAYER-1-CONTROL.md baseline, 2026-07-20):
         * a VAD onset during playback STOPS the audio immediately - any
         * noise over the floor cuts the TTS, no wait for words. The
         * barge never resumes and the L2/L1 statement stays readable as
         * text, so a false stop on noise costs only the audio. */
        state.utteranceStartedDuringTts = engineDuringTts();
        state.userSpeaking = true;
        state.micBuf = [];
        state.micBufBytes = 0;
        const vadGated = advanceBargeGate(
          bargeGate,
          {
            type: 'vad-onset',
            atMs: Date.now(),
            playbackActive: state.utteranceStartedDuringTts,
          },
          { isEchoText: isEchoTextNow },
        );
        bargeGate = vadGated.state;
        if (vadGated.fire) {
          logFn('[voice-ws] barge VAD-onset FIRED (sound stops playback)');
          killActiveTts('barge-in');
        }
        break;
      }
      case 'asr-interim':
      case 'asr-final': {
        /* Streaming ASR words from the client (Web Speech interims).
         * Two jobs: (1) advance the word gate - 2+ interim words or 1
         * final word that are not Lex's own text stop playback
         * instantly; (2) the deterministic stop-class fast path -
         * "stop" / "hold on" interrupts the Lex turn NOW, no LLM
         * round trip, no queue-to-boundary. */
        const words = typeof msg.text === 'string' ? msg.text.trim() : '';
        if (!words) break;
        const kind = msg.t === 'asr-final' ? 'final' : 'interim';
        const gated = advanceBargeGate(
          bargeGate,
          { type: 'words', kind, text: words, atMs: Date.now() },
          { isEchoText: isEchoTextNow },
        );
        bargeGate = gated.state;
        if (gated.fire) {
          logFn(
            `[voice-ws] barge word-gate FIRED (${kind}) words=${JSON.stringify(words.slice(0, 60))}`,
          );
          killActiveTts('utterance-start');
        }
        if (kind === 'final') {
          const sv = classifyStopUtterance(words);
          if (sv.stop === 'interrupt_work') {
            lastHardInterruptMs = Date.now();
            logFn(
              `[voice-ws] stop-class hard interrupt (asr fast path) text=${JSON.stringify(words.slice(0, 60))}`,
            );
            confirmRealBarge(false);
            dispatchVoiceCommand('hold_up', 'transcript');
          } else if (sv.stop === 'stop_speaking') {
            lastHardInterruptMs = Date.now();
            confirmRealBarge(false);
            const cancelled = speakCtrl.killActive();
            if (cancelled) send({ t: 'tts-cancel', reason: 'quiet' });
          }
        }
        break;
      }
      case 'playback-drained': {
        /* Client's TRUE end of audio (the daemon's tts-end fires at
         * synth-stream end, seconds early). Closes the during-TTS
         * window and the current spoken run. */
        clientPlaybackActive = false;
        if (playbackTailTimer) {
          clearTimeout(playbackTailTimer);
          playbackTailTimer = null;
        }
        spokenRunTexts = [];
        bargeGate = advanceBargeGate(
          bargeGate,
          { type: 'playback-idle', atMs: Date.now() },
          { isEchoText: isEchoTextNow },
        ).state;
        break;
      }
      case 'playback-stopped': {
        /* Interrupt accounting (OpenAI Realtime pattern): the client
         * stopped the element and reports elapsed ms; conversational
         * context truncates to the words the operator actually heard
         * so the assistant never believes it said words that never
         * played. */
        clientPlaybackActive = false;
        if (playbackTailTimer) {
          clearTimeout(playbackTailTimer);
          playbackTailTimer = null;
        }
        const playedMs =
          typeof msg.played_ms === 'number' && Number.isFinite(msg.played_ms)
            ? Math.max(0, msg.played_ms)
            : 0;
        const fullRun = spokenRunTexts.join(' ').trim();
        spokenRunTexts = [];
        /* Fix 24 tail-loss (2026-07-18): if a barge is pending phantom
         * resolution, record the played offset so resumeBargedSpeech
         * can slice the UN-heard remainder of the whole body. The
         * client sends this right after the tts-cancel, well before
         * the phantom is resolved (whisper / top-layer round trip). */
        if (bargeStash) bargeStash.playedMs = playedMs;
        if (fullRun) {
          const heard = truncateToHeard(fullRun, playedMs);
          if (heard.length < fullRun.length) {
            logFn(
              `[voice-ws] playback stopped at ${Math.round(playedMs)}ms; context truncated to ${heard.length}/${fullRun.length} chars actually heard`,
            );
            lastSpokenText = heard || null;
          }
        }
        break;
      }
      case 'utterance-end':
        /* User released the floor; stamp the moment so the half-duplex
         * cooldown keeps Lex's mouth off the heels of their last word. */
        state.userSpeaking = false;
        /* #4 absolute floor released: PTT is up (or the VAD utterance
         * ended), so Lex may speak again. handleUtteranceEnd below
         * processes this turn and the reply flows after this point. */
        state.pttFloorHeld = false;
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
        /* Spec v2: the wake path is the panic escape hatch only (mic
         * gated during TTS, so the always-on client listener is how
         * "lex emergency stop" gets through). Every other kind died
         * with the keyword grammar; reject so a stale client cannot
         * resurrect it. */
        if (kind !== 'panic') {
          send({
            t: 'error',
            code: 'bad-wake-kind',
            message: 'wake-command accepts only kind=panic',
          });
          break;
        }
        dispatchVoiceCommand('panic', 'wake');
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
      logFn(
        `[voice-ws] session-end pipeline: latch already fired reason=${reason}`,
      );
      return;
    }
    state.sessionEndFired = true;
    logFn(
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
        logFn(
          `[voice-ws] session-end pipeline: brainstorm row not resolved (handle=${state.bindKey ?? 'null'} watch=${state.watchSessionId ?? 'null'} bsId=${state.brainstormId ?? 'null'} reason=${reason}); skipping`,
        );
        return;
      }
      /* Plan section F amendment (2026-05-22): triggers table.
       *
       *   ws-close (ANY mode)   -> runDistillationFlush (brainstorm
       *     stays alive across voice disconnects; next attached
       *     worker / next voice resume gets fresh last_summary).
       *     2026-07-17 hotfix: cc-pty used to run the TERMINAL
       *     pipeline here, so one flaky-socket drop flipped a live
       *     brainstorm to status='ended' and locked the operator out
       *     at the bind gate ('brainstorm-ended').
       *   voice end-session     -> runSessionEndPipeline (terminal)
       *   compaction-restart    -> runSessionEndPipeline (legacy) */
      const flushOnly = _sessionEndActionForReason(reason) === 'flush';
      const endInput = {
        brainstormId: bs.id,
        claudeSessionId: bs.claude_session_id ?? claudeSessionId,
        mode: bs.mode || state.mode,
        reason,
      };
      /* SM-23: terminal runs ride the pending-distill queue so a
       * daemon death mid-pipeline leaves a persisted marker and the
       * next cold start forces the owed distillation. Await
       * semantics unchanged. Flush stays direct: it is the light
       * non-terminal variant and owes no marker. */
      if (flushOnly) {
        await runDistillationFlush(getBrainstormStore(), endInput, (msg) =>
          logFn(msg),
        );
      } else {
        await queueSessionEndPipeline(getBrainstormStore(), endInput, (msg) =>
          logFn(msg),
        );
      }
      if (flushOnly) {
        /* Re-arm so a subsequent voice end-session / explicit UI end
         * can still fire the terminal pipeline on the same in-memory
         * state. Without resetting the latch, a voice disconnect
         * followed by an explicit end command would no-op. */
        state.sessionEndFired = false;
      }
    } catch (err) {
      logFn(
        `[voice-ws] session-end pipeline failed: ${(err as Error).message}`,
      );
    }
  }

  function teardown(): void {
    state.closed = true;
    if (cancelBrainReadyWatch) {
      cancelBrainReadyWatch();
      cancelBrainReadyWatch = null;
    }
    stopJsonlWatch();
    clearHeldTurnFlush();
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

  /* Phase 2 R2 / acceptance-3: gate the client's connecting->live
   * transition on the TOP (Lex voice) brain being warm. prewarm above
   * kicked the boot on Start voice; this drives the `voice-brain` frame
   * the client reads (connecting while warming, live on warm, fail-open
   * at the cap, no-op live when the top session is disabled). Started
   * here so every `let`/closure `send` touches is initialized; cancelled
   * in teardown so a closed socket leaves no live poll timer. */
  cancelBrainReadyWatch = _startVoiceBrainReadyWatch<ReturnType<typeof setTimeout>>({
    enabled: isVoiceBrainSessionEnabled(),
    isWarm: isVoiceBrainSessionWarm,
    send,
    schedule: (fn, ms) => {
      const t = setTimeout(fn, ms);
      if (typeof (t as { unref?: () => void }).unref === 'function') {
        (t as { unref: () => void }).unref();
      }
      return t;
    },
    clearTimer: (t) => clearTimeout(t),
    now: () => Date.now(),
  });

  /* Loud close diagnostics (2026-07-17: the socket dropped every
   * 30-60s all evening and nothing logged WHY). Code + reason + which
   * side benefits triage: 1000/1001 = clean client close, 1006 =
   * abnormal (no close frame - process death, idle reaper, network),
   * anything else names itself. */
  socket.on('close', (code: number, reason: Buffer | string) => {
    const reasonText =
      typeof reason === 'string' ? reason : (reason?.toString('utf-8') ?? '');
    logFn(
      `[voice-ws] ws-close code=${code} reason=${JSON.stringify(reasonText || '(none)')} bindKey=${state.bindKey ?? 'null'} ttsActive=${Boolean(state.ttsActive)} (1000/1001=clean client close, 1006=abnormal/no close frame)`,
    );
    teardown();
  });
  socket.on('error', (err: Error) => {
    logFn(
      `[voice-ws] ws-error before close: ${err.message} bindKey=${state.bindKey ?? 'null'}`,
    );
    teardown();
  });
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
