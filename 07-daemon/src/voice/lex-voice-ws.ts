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
import { ptyInject, getPty, getPtyBySession, listPtys } from '../dashboard/pty-host.js';
import {
  getBrainstormByClaudeSessionId,
  getBrainstormByPty,
  getStore as getBrainstormStore,
} from '../lex/brainstorm-store.js';
import { processAssistantTurn } from '../lex/artifact-parser.js';
import { buildVoiceSnapshot } from '../lex/snapshot-context.js';
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
}

const MIC_BUF_MAX = 4 * 1024 * 1024; // 4 MB ~= 2 minutes of 16k mono pcm

const SESSION_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* Spoken end-session command. Matched against the transcript before we
 * inject into Lex so the user can stop the voice loop hands-free —
 * "end session", "stop voice", "goodbye Lex" all close the panel
 * without Lex generating a normal text reply that the user would then
 * have to interrupt. Conversation mode tears down immediately; notes
 * mode routes through the existing finalize-notes path so the
 * dictation summary still ships.
 *
 * Whisper transcripts come back lower-cased after our normalize pass
 * (punctuation stripped, whitespace collapsed). Patterns are matched
 * with word boundaries so "extend session" doesn't false-fire. */
const END_SESSION_RE =
  /\b(?:end|stop|finish|close)\s+(?:the\s+|this\s+|our\s+)?(?:session|chat|conversation|voice|listening)\b|\b(?:goodbye|bye)\s+lex\b|\bstop\s+listening\b/;

function matchesEndSession(text: string): boolean {
  const norm = text
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!norm) return false;
  return END_SESSION_RE.test(norm);
}

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
    try {
      const handle = state.bindKey
        ? getPty(state.bindKey) || getPtyBySession(state.bindKey)
        : undefined;
      let bs = null as
        | null
        | { id: string; prompt_version?: string | null };
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
    if (state.mode === 'notes') {
      /* Surface a short ack so the panel can show "captured" — but
       * no audio. */
      send({ t: 'tts-skipped', reason: 'notes-mode' });
      return;
    }
    speak(text);
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
      }
    } catch {
      /* audio bundle is observational; never block the turn */
    }
    if (!result.text.trim()) return;
    /* Hands-free stop: if the transcript matches a spoken end-session
     * command, skip the inject path so Lex doesn't reply, and notify
     * the client to tear down. Notes-mode users who want the dictation
     * summary should press Stop instead — voice command is an
     * immediate close. */
    if (matchesEndSession(result.text)) {
      send({ t: 'session-end', reason: 'voice-command' });
      /* Run ingest + summary + RAG embed before the WS close fires.
       * Fire-and-forget: client teardown happens immediately on the
       * session-end message, pipeline runs in the background. */
      void fireSessionEndPipeline('voice-command');
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
    const ir = ptyInject(
      state.bindKey,
      snapshotBlock + voiceTag + result.text,
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
        break;
      case 'utterance-end':
        void handleUtteranceEnd();
        break;
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
