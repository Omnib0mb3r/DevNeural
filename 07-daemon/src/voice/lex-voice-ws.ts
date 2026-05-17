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
  ptyInject,
  getPty,
  getPtyBySession,
  listPtys,
  isAwaitingSystemPrompt,
} from '../dashboard/pty-host.js';
import {
  getBrainstormByClaudeSessionId,
  getBrainstormByPty,
  getStore as getBrainstormStore,
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
import { buildVoiceSnapshot } from '../lex/snapshot-context.js';
import {
  matchVoiceCommand,
  ALL_VOICE_COMMAND_KINDS,
  type VoiceCommandKind,
} from './lex-voice-commands.js';
import { firePanic } from '../dashboard/panic-routes.js';
import { getStore } from '../lex/brainstorm-store.js';
import { checkToolGate, notifyLargeFsRead, LARGE_FS_READ_LINE_THRESHOLD } from '../lex/tool-gate.js';
import { runSessionEndPipeline } from '../lex/session-end-pipeline.js';
import { appendUtterance as appendSessionAudio } from './audio-bundle.js';

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
  /* In-flight TTS handle so barge-in can cancel mid-stream. */
  ttsActive: { cancel: () => void } | null;
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
  /* Mid-session compaction trigger state. Flips compactedAt the
   * moment shouldTriggerCompaction crosses 75% so a trailing
   * end_turn record in the same jsonl tail cannot re-fire the
   * restart while distillation is still running. */
  compaction: CompactionSupervisorState;
}

const MIC_BUF_MAX = 4 * 1024 * 1024; // 4 MB ~= 2 minutes of 16k mono pcm

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
 * tabs open sees every utterance injected once per tab — same audio,
 * same transcript, three injects, three Lex replies. We track the
 * active socket per bindKey and gracefully evict any previous one
 * whenever a fresh hello binds. */
const activeByBindKey = new Map<string, ConnState>();

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

export function attachLexVoiceWs(socket: FastifyWS): void {
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
    compaction: { compactedAt: 0 },
  };

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
    if (state.jsonlPath) startJsonlWatch();
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

  /* Track the last observed assistant turn we've already TTS'd so the
   * watcher doesn't keep speaking the same response if the file is
   * rewritten or we re-read it. */
  let lastSpokenUuid: string | null = null;

  function pollJsonl(): void {
    if (!state.jsonlPath && state.watchSessionId) {
      /* Late jsonl creation: the file may not have existed at bind
       * time but was created on first user/assistant turn. */
      const jsonl = findJsonlBySessionId(state.watchSessionId);
      if (jsonl) {
        state.jsonlPath = jsonl;
        try {
          state.jsonlOffset = fs.statSync(jsonl).size;
        } catch {
          state.jsonlOffset = 0;
        }
      }
    }
    if (!state.jsonlPath) {
      /* Re-resolve the jsonl path if the PTY just bound a session_id. */
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
          try {
            state.jsonlOffset = fs.statSync(jsonl).size;
          } catch {
            /* ignore */
          }
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
     * end_turn from the watched session instead. lastSpokenUuid still
     * dedupes against re-reads. */
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
    if (message.stop_reason !== 'end_turn') return;
    const uuid = String(rec.uuid ?? '');
    if (uuid && uuid === lastSpokenUuid) return;
    const texts: string[] = [];
    for (const c of message.content ?? []) {
      if (c?.type === 'text' && typeof c.text === 'string') texts.push(c.text);
    }
    const text = texts.join('\n').trim();
    if (!text) return;
    lastSpokenUuid = uuid || null;
    state.awaitingResponseSince = 0;
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
    } catch {
      /* observability only */
    }
    send({
      t: 'assistant-text',
      text,
      ...(uuid ? { turn_id: uuid } : {}),
      ...(brainstormForFeedback?.id ? { brainstorm_id: brainstormForFeedback.id } : {}),
      ...(brainstormForFeedback?.prompt_version
        ? { prompt_version: brainstormForFeedback.prompt_version }
        : {}),
    });
    /* Land an assistant turn into brainstorm_chunks the moment it
     * arrives so brainstorm_sessions.turn_count + the /lex/recall
     * retrieval surface track live conversation, not just the
     * session-end backfill. Chunk id is the CC turn uuid so the
     * brainstorm-jsonl-ingestor's next tick re-insert is a no-op
     * via INSERT OR REPLACE. When the uuid is missing (rare race
     * where the jsonl entry has not flushed) we skip; the ingestor
     * will land the row on its tick. Wrapped so a chunk insert
     * failure cannot block the speak path. */
    if (brainstormForFeedback?.id && uuid) {
      try {
        getStore().db.insertBrainstormChunk({
          id: uuid,
          brainstorm_id: brainstormForFeedback.id,
          turn_index: getStore().db.nextTurnIndex(brainstormForFeedback.id),
          role: 'lex',
          mode: brainstormModeForChunk,
          text,
          model_id: process.env.DEVNEURAL_LEX_MODEL_ID ?? 'claude',
          no_decay: 1,
        });
      } catch {
        /* observational; never block speak() */
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
      const persisted = processAssistantTurn(text, {
        brainstormId,
        fallbackTitle: text.slice(0, 60),
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
        text,
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
      const lineCount = text.split('\n').length;
      if (lineCount >= LARGE_FS_READ_LINE_THRESHOLD) {
        /* Extract first word-like pattern as a proxy for the grep arg. */
        const patternMatch = text.match(/grep\s+(?:-[a-z]+\s+)*["']?([^\s"']+)["']?/i);
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
    if (state.mode === 'notes') {
      /* Surface a short ack so the panel can show "captured" — but
       * no audio. */
      send({ t: 'tts-skipped', reason: 'notes-mode' });
    } else {
      speak(text);
    }
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
              const built = buildLexSpawnPrompt({
                lexSessionId: brainstormAnchorId,
                transcriptPaths: [],
              });
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
               *   - lastSpokenUuid clears so the speak dedupe doesn't
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
              lastSpokenUuid = null;
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

  async function speak(text: string): Promise<void> {
    /* Strip markdown asterisks/code fences/heading markers since the
     * voice doesn't render them — they'd come out as "asterisk
     * asterisk emphasis asterisk asterisk" otherwise. */
    const clean = text
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\*([^*]+)\*/g, '$1')
      .replace(/^#+\s+/gm, '')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
      .replace(/\s+/g, ' ')
      .trim();
    if (!clean) return;
    let handle: ReturnType<typeof synthesize>;
    try {
      handle = synthesize(clean);
    } catch (err) {
      send({ t: 'error', code: 'tts', message: (err as Error).message });
      return;
    }
    state.ttsActive = { cancel: handle.cancel };
    send({ t: 'tts-start', rate: handle.sampleRate });
    handle.pcm.on('data', (chunk: Buffer) => sendBinary(chunk));
    handle.pcm.on('end', () => {
      send({ t: 'tts-end' });
      state.ttsActive = null;
    });
    handle.pcm.on('error', (err: Error) => {
      send({ t: 'error', code: 'tts-stream', message: err.message });
      state.ttsActive = null;
    });
    /* Defensive: if handle.done resolves before stream end (shouldn't
     * normally), still mark TTS finished so the next utterance can
     * proceed. */
    void handle.done.then(() => {
      if (state.ttsActive?.cancel === handle.cancel) {
        state.ttsActive = null;
      }
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
        send({ t: 'session-end', reason: 'voice-command' });
        void fireSessionEndPipeline('voice-command');
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
      case 'disable': {
        send({ t: 'voice-disable', reason: 'voice-command' });
        return true;
      }
    }
  }

  function isVoiceCommandKind(v: unknown): v is VoiceCommandKind {
    return (
      typeof v === 'string' &&
      (ALL_VOICE_COMMAND_KINDS as ReadonlyArray<string>).includes(v)
    );
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
    if (!trimmed || isBlankMarker || wordCount < 2) {
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
    if (cmd) {
      dispatchVoiceCommand(cmd.kind, 'transcript');
      state.utteranceStartedDuringTts = false;
      return;
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
      snapshotBlock = buildVoiceSnapshot() + '\n\n';
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
    const ir = ptyInject(
      state.bindKey,
      snapshotBlock + gateNote + voiceTag + result.text,
      true,
    );
    if (!ir.ok) {
      send({ t: 'error', code: 'inject', message: ir.error });
      return;
    }
    send({ t: 'injected' });
    state.awaitingResponseSince = Date.now();
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
        bind(typeof msg.session_id === 'string' ? msg.session_id : undefined);
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
        state.micBuf = [];
        state.micBufBytes = 0;
        /* Path-1 of the wake-during-TTS work. Stamp whether this
         * utterance began inside the daemon's TTS stream so
         * handleUtteranceEnd can run dispatch but suppress the
         * inject for a non-wake transcript (likely AEC bleed
         * coming back through whisper). */
        state.utteranceStartedDuringTts = state.ttsActive !== null;
        break;
      case 'utterance-end':
        void handleUtteranceEnd();
        break;
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
        if (state.ttsActive) {
          state.ttsActive.cancel();
          state.ttsActive = null;
          send({ t: 'tts-end' });
        }
        /* Send Ctrl+C to the PTY so Claude Code aborts its in-flight
         * generation. Without this, the next injected user transcript
         * gets queued behind the old turn and Lex finishes the prior
         * response before answering the interrupt. */
        if (state.bindKey) {
          const bargeHandle =
            getPty(state.bindKey) || getPtyBySession(state.bindKey);
          if (bargeHandle && !bargeHandle.exited) {
            bargeHandle.pty.write('\x03');
          }
        }
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
    if (state.sessionEndFired) return;
    state.sessionEndFired = true;
    try {
      const handle = state.bindKey
        ? getPty(state.bindKey) || getPtyBySession(state.bindKey)
        : null;
      const claudeSessionId =
        handle?.sessionId ?? state.watchSessionId ?? null;
      const ptyId = handle?.ptyId ?? null;
      const bs =
        (claudeSessionId && getBrainstormByClaudeSessionId(claudeSessionId)) ||
        (ptyId && getBrainstormByPty(ptyId)) ||
        null;
      if (!bs) {
        /* Voice WS without a brainstorm row (read-only TTS bind, or
         * a session that ended before the row was created). Nothing
         * to summarise; skip silently. */
        return;
      }
      await runSessionEndPipeline(
        getBrainstormStore(),
        {
          brainstormId: bs.id,
          claudeSessionId: bs.claude_session_id ?? claudeSessionId,
          mode: bs.mode || state.mode,
          reason,
        },
        (msg) => console.log(msg),
      );
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
