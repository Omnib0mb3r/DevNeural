"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";

/**
 * Hands-free voice client for Lex.
 *
 * Wire-up overview:
 *   1. silero VAD on the user's mic (via @ricky0123/vad-web).
 *   2. On VAD speech-start, open the daemon WS (if not open) and
 *      stream PCM frames as binary; on speech-end, send
 *      utterance-end and the daemon transcribes + injects to Lex.
 *   3. Receive Lex's response audio (PCM frames) and play through
 *      the AudioContext using a back-to-back AudioBuffer scheduling
 *      strategy so playback is low-latency and gapless.
 *   4. If VAD detects new user speech while Lex is still speaking,
 *      send barge-in, stop playback, start a fresh utterance.
 *
 * Why an AudioContext rather than HTMLAudioElement: streaming raw
 * PCM. HTMLAudioElement wants a complete container (WAV/MP3); chunked
 * playback would have to buffer the whole response, defeating
 * latency. AudioBufferSourceNode lets us schedule each ~50-200ms
 * chunk as it arrives.
 */
type Status =
  | "idle"
  | "connecting"
  | "ready"
  | "listening"
  | "transcribing"
  | "thinking"
  | "speaking"
  | "error";

type Mode = "conversation" | "notes" | "push-to-talk";

const MODE_LABEL: Record<Mode, string> = {
  conversation: "conversation",
  notes: "notes only",
  "push-to-talk": "push-to-talk",
};

const MODE_HINT: Record<Mode, string> = {
  conversation:
    "Talk freely; Lex listens and replies out loud. Speak again to interrupt him.",
  notes:
    "Lex listens and captures everything to brainstorming notes. He stays silent so you can keep dictating without interruption.",
  "push-to-talk":
    "Hold the talk button, speak, release. No VAD; ignores background noise. Best for noisy rooms.",
};

interface VoicePack {
  name: string;
  sampleRate: number;
}

const SPEED_STORAGE_KEY = "lex-tts-speed";
const SPEED_MIN = 0.5;
const SPEED_MAX = 1.5;
const SPEED_STEP = 0.05;
const SPEED_DEFAULT = 1.0;

/* Barge-in cooldown is edited on the /settings page; VoiceClient just
 * consumes it. Stored on the server in voice-preferences.json; mirrored
 * to localStorage as an optimistic seed so the gate works on the very
 * first reply before piper-status comes back. */
const BARGE_STORAGE_KEY = "lex-barge-cooldown-ms";
const BARGE_MIN = 0;
const BARGE_MAX = 2000;
const BARGE_DEFAULT = 250;

/* Mic VAD sensitivity is edited on the /settings page; VoiceClient only
 * consumes it. localStorage is the optimistic seed so the very first
 * VAD init (before piper-status returns) uses the user's last value
 * rather than the default. Range [0, 1]; 0.5 is the legacy hardcoded
 * threshold pair. */
const VAD_SENSITIVITY_STORAGE_KEY = "lex-vad-sensitivity";
const VAD_SENSITIVITY_MIN = 0;
const VAD_SENSITIVITY_MAX = 1;
const VAD_SENSITIVITY_DEFAULT = 0.5;

/* Mic input gain. Multiplier applied to captured float samples right
 * before the int16 conversion that ships to whisper. 1.0 = passthrough;
 * <1 attenuates a hot mic; >1 boosts a quiet one. Edited on /settings;
 * VoiceClient only consumes it. */
const MIC_GAIN_STORAGE_KEY = "lex-mic-gain";
const MIC_GAIN_MIN = 0;
const MIC_GAIN_MAX = 3.0;
const MIC_GAIN_DEFAULT = 1.0;

/* Map a 0-1 sensitivity knob to silero positive/negative speech
 * thresholds. Higher knob = more sensitive = lower threshold. The
 * 0.1 delta between positive and negative matches the legacy tuning
 * (positive 0.5 / negative 0.4 at sensitivity 0.5). */
function vadThresholds(sensitivity: number): {
  positive: number;
  negative: number;
} {
  const s = Math.max(0, Math.min(1, sensitivity));
  const positive = 0.7 - 0.4 * s;
  const negative = positive - 0.1;
  return { positive, negative };
}

interface Props {
  /** Auto-bind to a specific Lex session. When omitted, the daemon
   * resolves the active brainstorm PTY. */
  sessionId?: string | null;
}

/* Cap on a single utterance. After this many milliseconds of
 * continuous speech we force an utterance-end so the user gets a
 * response even if they're still mid-sentence. Also protects the
 * server from runaway buffers. 30s matches typical "long thought"
 * windows; the user can keep talking after Lex starts responding via
 * barge-in. */
const MAX_UTTERANCE_MS = 30_000;

/* Hard ceiling on the mic buffer in samples (16k Hz mono int16). 30s
 * = 30 * 16000 = 480k samples = 960KB; well below the server cap of
 * 4MB. Used as a defensive abort if VAD never fires speech-end. */
const MAX_UTTERANCE_SAMPLES = 30 * 16000;

export function VoiceClient({ sessionId }: Props) {
  const [status, setStatus] = useState<Status>("idle");
  const [enabled, setEnabled] = useState(false);
  const [muted, setMuted] = useState(false);
  const [lastTranscript, setLastTranscript] = useState<string>("");
  const [lastReply, setLastReply] = useState<string>("");
  const [errMsg, setErrMsg] = useState<string>("");
  /* Live counter shown while the user is talking so they know the
   * mic is still capturing and roughly how much they've said. */
  const [utteranceMs, setUtteranceMs] = useState<number>(0);
  /* Conversation mode = full duplex (default).
   * Notes only        = Lex captures + transcribes, no spoken reply.
   * Push-to-talk      = no VAD, hold the button, release to send. */
  const [mode, setMode] = useState<Mode>("conversation");
  const [voices, setVoices] = useState<VoicePack[]>([]);
  const [activeVoice, setActiveVoiceState] = useState<string>("");
  /* Persisted globally: localStorage holds the optimistic UI value so
   * the slider doesn't snap on remount; the server persists the
   * authoritative length_scale in voice-preferences.json. */
  const [speed, setSpeed] = useState<number>(() => {
    if (typeof window === "undefined") return SPEED_DEFAULT;
    const raw = window.localStorage.getItem(SPEED_STORAGE_KEY);
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n >= SPEED_MIN && n <= SPEED_MAX
      ? n
      : SPEED_DEFAULT;
  });
  const speedSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /* Barge-in cooldown (ms). Suppress VAD-driven barge-in for this long
   * after each tts-start so Lex's own audio bleeding into the mic does
   * not trigger a self-interrupt loop. Server-persisted; localStorage
   * is just optimistic seed so the slider does not snap on remount. */
  const [bargeCooldownMs, setBargeCooldownMs] = useState<number>(() => {
    if (typeof window === "undefined") return BARGE_DEFAULT;
    const raw = window.localStorage.getItem(BARGE_STORAGE_KEY);
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n >= BARGE_MIN && n <= BARGE_MAX
      ? n
      : BARGE_DEFAULT;
  });
  const bargeCooldownRef = useRef<number>(BARGE_DEFAULT);
  bargeCooldownRef.current = bargeCooldownMs;
  /* Mic VAD sensitivity. Read at VAD init via the ref so that re-
   * enabling voice after the user moves the slider picks up the new
   * value without re-rendering the VAD itself (silero VAD does not
   * support live threshold updates). */
  const [vadSensitivity, setVadSensitivity] = useState<number>(() => {
    if (typeof window === "undefined") return VAD_SENSITIVITY_DEFAULT;
    const raw = window.localStorage.getItem(VAD_SENSITIVITY_STORAGE_KEY);
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) &&
      n >= VAD_SENSITIVITY_MIN &&
      n <= VAD_SENSITIVITY_MAX
      ? n
      : VAD_SENSITIVITY_DEFAULT;
  });
  const vadSensitivityRef = useRef<number>(VAD_SENSITIVITY_DEFAULT);
  vadSensitivityRef.current = vadSensitivity;
  /* Mic input gain. Read at every audio-buffer flush via the ref so the
   * /settings slider takes effect on the next utterance without needing
   * to disable + re-enable voice. */
  const [micGain, setMicGain] = useState<number>(() => {
    if (typeof window === "undefined") return MIC_GAIN_DEFAULT;
    const raw = window.localStorage.getItem(MIC_GAIN_STORAGE_KEY);
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n >= MIC_GAIN_MIN && n <= MIC_GAIN_MAX
      ? n
      : MIC_GAIN_DEFAULT;
  });
  const micGainRef = useRef<number>(MIC_GAIN_DEFAULT);
  micGainRef.current = micGain;
  const lastTtsStartAtRef = useRef<number>(0);
  const [pttHolding, setPttHolding] = useState(false);
  const modeRef = useRef<Mode>("conversation");
  modeRef.current = mode;
  /* Status ref so non-React handlers (mute, finalize) can branch on
   * the latest status without going through state. Mirrored via the
   * effect below. */
  const statusRef = useRef<Status>("idle");
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  const wsRef = useRef<WebSocket | null>(null);
  const vadRef = useRef<unknown>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const ttsRateRef = useRef<number>(22050);
  const playheadRef = useRef<number>(0);
  const speakingRef = useRef<boolean>(false);
  const mutedRef = useRef<boolean>(false);
  /* All currently-scheduled TTS sources for the in-flight reply.
   * AudioBufferSourceNode.start() commits the buffer to the audio
   * context's render queue; the only way to silence it is src.stop().
   * Without this we kept hearing the tail of the previous reply over
   * the start of the next one (the "two voices at once" symptom on
   * barge-in). On reset we walk this list, stop+disconnect each, and
   * empty the array so the next reply starts clean. */
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  /* Generation counter so late-arriving binary PCM chunks from a
   * barged-in TTS stream don't get scheduled into the new reply. Each
   * barge-in / new tts-start bumps the gen; chunk handlers compare
   * against a captured value at receive-time. */
  const ttsGenRef = useRef<number>(0);
  /* Timestamps + handles for the live utterance counter and the
   * server-side max-utterance abort. */
  const utteranceStartRef = useRef<number>(0);
  const utteranceTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const utteranceCapRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const utteranceSamplesRef = useRef<number>(0);
  /* Parallel capture rig. Runs alongside silero VAD on its own
   * MediaStream + AudioContext so we always have raw int16 audio
   * for the current utterance even when VAD itself never fires
   * speech-end (e.g. user mutes mid-sentence). VAD still owns the
   * normal end-of-utterance path; this rig only ships when the
   * user explicitly mutes while the status is "listening". */
  const captureStreamRef = useRef<MediaStream | null>(null);
  const captureCtxRef = useRef<AudioContext | null>(null);
  const captureProcRef = useRef<ScriptProcessorNode | null>(null);
  const captureBufRef = useRef<Int16Array[]>([]);
  const captureCapturingRef = useRef<boolean>(false);
  /* Notes-mode finalize awaits the next assistant-text before
   * closing the WS so the user sees the generated summary. */
  const awaitingFinalizeRef = useRef<boolean>(false);
  const finalizeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* Reset playhead, hard-stop every scheduled source, and bump the
   * generation counter so any in-flight binary chunks from the now-
   * cancelled reply get discarded instead of scheduled into the next
   * one. Used on barge-in and on the next tts-start. The bump is what
   * fixes "two voices at once": the server cancels piper, but TCP
   * frames already in flight still arrive client-side; without this
   * gen guard those frames would schedule fresh sources just as the
   * new reply's chunks start landing. */
  function resetTtsPlayback(): void {
    ttsGenRef.current += 1;
    for (const src of activeSourcesRef.current) {
      try {
        src.stop();
      } catch {
        /* already stopped */
      }
      try {
        src.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    activeSourcesRef.current = [];
    if (audioCtxRef.current) {
      playheadRef.current = audioCtxRef.current.currentTime;
    }
    speakingRef.current = false;
  }

  /* Flush the parallel capture buffer to the server as a single
   * binary utterance and send utterance-end. Used by mute-finalize
   * when the user mutes mid-utterance and we want Lex to reply
   * with whatever audio we already captured rather than discarding
   * it. Returns true when audio was shipped. */
  function flushParallelCapture(): boolean {
    if (!captureCapturingRef.current) return false;
    captureCapturingRef.current = false;
    const chunks = captureBufRef.current;
    captureBufRef.current = [];
    if (utteranceTimerRef.current) {
      clearInterval(utteranceTimerRef.current);
      utteranceTimerRef.current = null;
    }
    if (utteranceCapRef.current) {
      clearTimeout(utteranceCapRef.current);
      utteranceCapRef.current = null;
    }
    setUtteranceMs(0);
    const total = chunks.reduce((sum, c) => sum + c.length, 0);
    if (total === 0) return false;
    const merged = new Int16Array(total);
    let off = 0;
    for (const c of chunks) {
      merged.set(c, off);
      off += c.length;
    }
    sendBinary(merged.buffer);
    sendJson({ t: "utterance-end" });
    setStatus("transcribing");
    return true;
  }

  /* Mute keeps the WS open and the mic stream alive so unmuting is
   * instant. If the user mutes mid-utterance (status === listening),
   * flush whatever the parallel capture rig already has so Lex
   * still gets the audio and replies. Otherwise mute just gates
   * future VAD events. */
  function setMicMuted(next: boolean): void {
    mutedRef.current = next;
    setMuted(next);
    if (next) {
      if (statusRef.current === "listening") {
        flushParallelCapture();
      } else if (utteranceTimerRef.current) {
        clearInterval(utteranceTimerRef.current);
        utteranceTimerRef.current = null;
        setUtteranceMs(0);
      }
    }
  }


  function sendJson(obj: Record<string, unknown>): void {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(obj));
    } catch {
      /* ignore */
    }
  }

  function sendBinary(buf: ArrayBufferLike): void {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(buf);
    } catch {
      /* ignore */
    }
  }

  /* Schedule a PCM chunk for back-to-back playback. We maintain
   * playheadRef as the absolute audioContext time at which the next
   * buffer should begin. Each buffer pushes the playhead forward by
   * its own duration, giving gapless playback even if chunks arrive
   * in bursts. `gen` is the ttsGen value captured when the chunk
   * arrived; if a barge-in / new tts-start has bumped it since, drop
   * the chunk so we don't schedule cancelled audio into a fresh reply. */
  function schedulePcmChunk(pcm: ArrayBuffer, gen: number): void {
    if (gen !== ttsGenRef.current) return;
    const ctx = audioCtxRef.current;
    if (!ctx) return;
    const int16 = new Int16Array(pcm);
    const float = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float[i] = (int16[i] ?? 0) / 0x8000;
    }
    const rate = ttsRateRef.current;
    const buffer = ctx.createBuffer(1, float.length, rate);
    buffer.copyToChannel(float, 0);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    /* Start a tiny epsilon ahead of currentTime so the first chunk
     * doesn't underrun. Subsequent chunks chain off playhead. */
    if (playheadRef.current < ctx.currentTime + 0.05) {
      playheadRef.current = ctx.currentTime + 0.05;
    }
    src.start(playheadRef.current);
    playheadRef.current += float.length / rate;
    /* Track so resetTtsPlayback can stop everything on barge-in. Drop
     * the entry on natural end so the array doesn't grow unbounded. */
    activeSourcesRef.current.push(src);
    src.onended = () => {
      const idx = activeSourcesRef.current.indexOf(src);
      if (idx >= 0) activeSourcesRef.current.splice(idx, 1);
    };
  }

  /* Prewarm whisper-server as soon as the voice panel mounts so the
   * first utterance doesn't pay the 3-4s model-load cold start. The
   * endpoint is idempotent: subsequent calls return the already-loaded
   * server status. Fire-and-forget; failure here doesn't block the
   * voice loop, just costs latency on first utterance. */
  useEffect(() => {
    void fetch("/voice/whisper-prewarm", {
      method: "POST",
      credentials: "include",
    }).catch(() => undefined);
  }, []);

  /* Load voice list + currently active voice. Ships with the panel
   * so the picker shows real options instead of guessing. */
  useEffect(() => {
    void fetch("/voice/piper-status", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!j) return;
        if (Array.isArray(j.voices)) setVoices(j.voices);
        if (typeof j.active_voice === "string") setActiveVoiceState(j.active_voice);
        /* Server's persisted speed wins on cold load; localStorage
         * was just a fast pre-hydration so the slider didn't snap. */
        if (typeof j.speed === "number" && Number.isFinite(j.speed)) {
          const clamped = Math.max(SPEED_MIN, Math.min(SPEED_MAX, j.speed));
          setSpeed(clamped);
          if (typeof window !== "undefined") {
            window.localStorage.setItem(SPEED_STORAGE_KEY, String(clamped));
          }
        }
        if (
          typeof j.barge_cooldown_ms === "number" &&
          Number.isFinite(j.barge_cooldown_ms)
        ) {
          const clamped = Math.max(
            BARGE_MIN,
            Math.min(BARGE_MAX, j.barge_cooldown_ms),
          );
          setBargeCooldownMs(clamped);
          if (typeof window !== "undefined") {
            window.localStorage.setItem(BARGE_STORAGE_KEY, String(clamped));
          }
        }
        if (
          typeof j.vad_sensitivity === "number" &&
          Number.isFinite(j.vad_sensitivity)
        ) {
          const clamped = Math.max(
            VAD_SENSITIVITY_MIN,
            Math.min(VAD_SENSITIVITY_MAX, j.vad_sensitivity),
          );
          setVadSensitivity(clamped);
          if (typeof window !== "undefined") {
            window.localStorage.setItem(
              VAD_SENSITIVITY_STORAGE_KEY,
              String(clamped),
            );
          }
        }
        if (
          typeof j.mic_gain === "number" &&
          Number.isFinite(j.mic_gain)
        ) {
          const clamped = Math.max(
            MIC_GAIN_MIN,
            Math.min(MIC_GAIN_MAX, j.mic_gain),
          );
          setMicGain(clamped);
          if (typeof window !== "undefined") {
            window.localStorage.setItem(
              MIC_GAIN_STORAGE_KEY,
              String(clamped),
            );
          }
        }
      })
      .catch(() => undefined);
  }, []);

  /* Persist speed on every change. Debounce server writes so dragging
   * the slider doesn't fire 20 POSTs; localStorage updates immediately
   * because it's free. */
  function changeSpeed(next: number): void {
    const clamped = Math.max(SPEED_MIN, Math.min(SPEED_MAX, next));
    setSpeed(clamped);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(SPEED_STORAGE_KEY, String(clamped));
    }
    if (speedSaveTimerRef.current) clearTimeout(speedSaveTimerRef.current);
    speedSaveTimerRef.current = setTimeout(() => {
      void fetch("/voice/set-speed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ speed: clamped }),
      }).catch(() => undefined);
    }, 250);
  }


  async function changeVoice(name: string): Promise<void> {
    const r = await fetch("/voice/set-voice", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ name }),
    });
    if (r.ok) {
      const j = (await r.json()) as { active_voice?: string; rate?: number };
      if (j.active_voice) setActiveVoiceState(j.active_voice);
      if (typeof j.rate === "number") ttsRateRef.current = j.rate;
    }
  }

  /* Hard teardown of every side-effect this component owns: WebSocket,
   * silero VAD instance, parallel capture rig, audio output context,
   * and any pending finalize timer. Called both from the enabled=false
   * branch (user clicked stop) and from the unmount cleanup (user
   * navigated away). Without the unmount call, the WS and MediaStream
   * survive component teardown because the browser holds internal
   * handles to open sockets and active mic tracks; the next VoiceClient
   * mount shows the "start" button while the old loop is still
   * silently transcribing every word. */
  function tearDownVoice(): void {
    try {
      wsRef.current?.close();
    } catch {
      /* ignore */
    }
    wsRef.current = null;
    const v = vadRef.current as { destroy?: () => void } | null;
    try {
      v?.destroy?.();
    } catch {
      /* ignore */
    }
    vadRef.current = null;
    try {
      captureProcRef.current?.disconnect();
    } catch {
      /* ignore */
    }
    try {
      captureStreamRef.current?.getTracks().forEach((t) => t.stop());
    } catch {
      /* ignore */
    }
    const cctx = captureCtxRef.current;
    if (cctx && cctx.state !== "closed") {
      try {
        void cctx.close();
      } catch {
        /* ignore */
      }
    }
    captureProcRef.current = null;
    captureStreamRef.current = null;
    captureCtxRef.current = null;
    captureCapturingRef.current = false;
    captureBufRef.current = [];
    if (finalizeTimeoutRef.current) {
      clearTimeout(finalizeTimeoutRef.current);
      finalizeTimeoutRef.current = null;
    }
    awaitingFinalizeRef.current = false;
    const ctx = audioCtxRef.current;
    if (ctx && ctx.state !== "closed") {
      try {
        void ctx.close();
      } catch {
        /* ignore */
      }
    }
    audioCtxRef.current = null;
  }

  useEffect(() => {
    if (!enabled) {
      tearDownVoice();
      setStatus("idle");
      return;
    }

    let cancelled = false;
    setStatus("connecting");
    setErrMsg("");

    (async () => {
      /* Open WS first so we can ack-bind before mic touches the user. */
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${proto}//${window.location.host}/voice/lex-ws`);
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onopen = () => {
        sendJson({
          t: "hello",
          session_id: sessionId ?? undefined,
          mode: modeRef.current,
        });
      };
      ws.onclose = () => {
        if (cancelled) return;
        setStatus("error");
        setErrMsg("voice connection closed");
      };
      ws.onerror = () => {
        setStatus("error");
        setErrMsg("voice ws error");
      };
      ws.onmessage = (ev) => {
        if (typeof ev.data === "string") {
          try {
            const msg = JSON.parse(ev.data) as { t: string; [k: string]: unknown };
            handleServerMsg(msg);
          } catch {
            /* malformed json, ignore */
          }
        } else if (ev.data instanceof ArrayBuffer) {
          if (speakingRef.current) {
            schedulePcmChunk(ev.data, ttsGenRef.current);
          }
        }
      };

      function handleServerMsg(msg: { t: string; [k: string]: unknown }): void {
        switch (msg.t) {
          case "hello-ack": {
            const rate = Number(msg.voice_rate) || 22050;
            ttsRateRef.current = rate;
            setStatus("ready");
            void initVad();
            break;
          }
          case "transcript": {
            const text = String(msg.text ?? "").trim();
            setLastTranscript(text);
            if (text) setStatus("thinking");
            else setStatus("ready");
            break;
          }
          case "injected":
            setStatus("thinking");
            break;
          case "assistant-text":
            setLastReply(String(msg.text ?? ""));
            /* If the user pressed stop in notes mode and we are
             * waiting on the finalize summary, this is the turn we
             * were waiting for. Give the artifact-parser a beat to
             * persist the fenced block and any reminders, then
             * tear down. */
            if (awaitingFinalizeRef.current) {
              awaitingFinalizeRef.current = false;
              if (finalizeTimeoutRef.current) {
                clearTimeout(finalizeTimeoutRef.current);
                finalizeTimeoutRef.current = null;
              }
              setTimeout(() => setEnabled(false), 750);
            }
            break;
          case "finalize-injected":
            /* Server ack that the notes-summary prompt was injected.
             * Just surface a status update; the assistant-text turn
             * is what actually matters. */
            setStatus("thinking");
            break;
          case "artifacts":
            /* Slice C: server emitted persisted artifact ids. We
             * don't render them in the panel today; future iteration
             * can show a chip per artifact. */
            break;
          case "tts-start": {
            const rate = Number(msg.rate) || 22050;
            ttsRateRef.current = rate;
            if (!audioCtxRef.current) {
              try {
                const Cls =
                  (window as unknown as { AudioContext?: typeof AudioContext })
                    .AudioContext ??
                  (window as unknown as { webkitAudioContext?: typeof AudioContext })
                    .webkitAudioContext;
                if (Cls) audioCtxRef.current = new Cls({ sampleRate: rate });
              } catch {
                /* fallback: no audio */
              }
            }
            /* Chrome / Safari suspend the AudioContext when the tab
             * loses focus or no user gesture has triggered audio
             * playback yet on this context. The "start voice" click
             * is a gesture, but mute/unmute and tab switches can
             * leave us suspended. Resume defensively on every
             * tts-start so the scheduled buffers actually play. */
            const ctx = audioCtxRef.current;
            if (ctx && ctx.state === "suspended") {
              void ctx.resume().catch(() => undefined);
            }
            playheadRef.current = ctx?.currentTime ?? 0;
            speakingRef.current = true;
            /* Stamp the moment audio actually started flowing so the
             * VAD barge-in handler can swallow self-echo within the
             * configured cooldown window. */
            lastTtsStartAtRef.current = Date.now();
            setStatus("speaking");
            break;
          }
          case "tts-end":
            speakingRef.current = false;
            setStatus("ready");
            break;
          case "error":
            setStatus("error");
            setErrMsg(String(msg.message ?? "voice error"));
            break;
        }
      }

      async function initParallelCapture(): Promise<void> {
        /* Open a dedicated mic stream and run a 16 kHz int16 frame
         * collector in parallel with silero VAD. We only ship from
         * here on the mute-finalize path; normal end-of-utterance
         * still uses the audio buffer VAD itself emits. Two parallel
         * streams is fine on every browser we care about. */
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true },
          });
          if (cancelled) {
            stream.getTracks().forEach((t) => t.stop());
            return;
          }
          captureStreamRef.current = stream;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const Cls: any =
            (window as unknown as { AudioContext?: typeof AudioContext })
              .AudioContext ??
            (window as unknown as { webkitAudioContext?: typeof AudioContext })
              .webkitAudioContext;
          const ctx = new Cls({ sampleRate: 16000 });
          captureCtxRef.current = ctx;
          const src = ctx.createMediaStreamSource(stream);
          const proc = ctx.createScriptProcessor(4096, 1, 1);
          captureProcRef.current = proc;
          proc.onaudioprocess = (e: AudioProcessingEvent) => {
            if (!captureCapturingRef.current) return;
            const f = e.inputBuffer.getChannelData(0);
            const gain = micGainRef.current;
            const i16 = new Int16Array(f.length);
            for (let i = 0; i < f.length; i++) {
              const s = Math.max(-1, Math.min(1, (f[i] ?? 0) * gain));
              i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
            }
            captureBufRef.current.push(i16);
          };
          src.connect(proc);
          proc.connect(ctx.destination);
        } catch {
          /* parallel capture failure is non-fatal; mute-finalize just
           * won't ship audio when this rig isn't up. VAD path keeps
           * working. */
        }
      }

      async function initVad(): Promise<void> {
        if (modeRef.current === "push-to-talk") {
          /* Push-to-talk uses raw getUserMedia + AudioWorklet
           * sampling instead of silero VAD. The user controls
           * utterance boundaries with the talk button; no need to
           * spin up VAD or the parallel capture rig. */
          await initPushToTalk();
          return;
        }
        await initParallelCapture();
        try {
          /* Dynamic import so the package only loads on /lex. */
          const mod = await import("@ricky0123/vad-web");
          if (cancelled) return;
          /* Configure ONNX runtime to load wasm + model from our own
           * /vad/ static path rather than the default CDN, so voice
           * works on Tailscale-only / offline boxes with no internet
           * egress. See public/vad/ for the asset bundle. */
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          try {
            const ort: any = await import("onnxruntime-web");
            ort.env.wasm.wasmPaths = "/vad/";
          } catch {
            /* fallback: vad-web default cdn */
          }
          /* Helper to ship the captured audio + finalize the utterance.
           * Used by both the natural VAD speech-end path and the
           * forced-finalize cap so the server-side handling stays the
           * same in both branches. */
          const finalizeUtterance = (audio: Float32Array) => {
            if (utteranceTimerRef.current) {
              clearInterval(utteranceTimerRef.current);
              utteranceTimerRef.current = null;
            }
            if (utteranceCapRef.current) {
              clearTimeout(utteranceCapRef.current);
              utteranceCapRef.current = null;
            }
            setUtteranceMs(0);
            const gain = micGainRef.current;
            const int16 = new Int16Array(audio.length);
            for (let i = 0; i < audio.length; i++) {
              const s = Math.max(-1, Math.min(1, (audio[i] ?? 0) * gain));
              int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
            }
            sendBinary(int16.buffer);
            sendJson({ t: "utterance-end" });
            setStatus("transcribing");
          };

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let vadInstance: any = null;

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const vad: any = await (mod as any).MicVAD.new({
            baseAssetPath: "/vad/",
            onnxWASMBasePath: "/vad/",
            onSpeechStart: () => {
              if (mutedRef.current) return;
              if (speakingRef.current) {
                /* Self-echo guard: Lex's own audio bleeds into the mic
                 * (laptop speakers, AirPods leak, etc.) and trips VAD
                 * milliseconds after tts-start. Swallow VAD events
                 * within bargeCooldownMs of audio onset so the loop
                 * does not feedback on itself. The cooldown is user-
                 * tunable in the voice panel and persisted server-side. */
                const sinceStart = Date.now() - lastTtsStartAtRef.current;
                if (sinceStart < bargeCooldownRef.current) {
                  return;
                }
                /* Barge-in: stop Lex, start a fresh utterance. */
                sendJson({ t: "barge-in" });
                resetTtsPlayback();
              }
              setStatus("listening");
              sendJson({ t: "utterance-start" });
              /* Reset + arm the parallel capture so a mute mid-
               * utterance has audio to flush. */
              captureBufRef.current = [];
              captureCapturingRef.current = true;
              utteranceStartRef.current = Date.now();
              utteranceSamplesRef.current = 0;
              setUtteranceMs(0);
              if (utteranceTimerRef.current) {
                clearInterval(utteranceTimerRef.current);
              }
              utteranceTimerRef.current = setInterval(() => {
                setUtteranceMs(Date.now() - utteranceStartRef.current);
              }, 100);
              if (utteranceCapRef.current) {
                clearTimeout(utteranceCapRef.current);
              }
              /* Hard cap: if VAD never fires speech-end (user keeps
               * talking through pauses too short to trip the threshold),
               * finalize at MAX_UTTERANCE_MS so Lex actually gets a
               * chance to respond. */
              utteranceCapRef.current = setTimeout(() => {
                if (vadInstance && typeof vadInstance.pause === "function") {
                  vadInstance.pause();
                  /* Pulling buffered audio from the VAD: package
                   * doesn't expose mid-utterance audio, so we drop
                   * the cap-fired utterance and let the user try
                   * again. We DO still send utterance-end so the
                   * server doesn't think we're hanging. */
                  sendJson({ t: "utterance-end" });
                  setStatus("transcribing");
                  /* Resume VAD listening after a moment. */
                  setTimeout(() => {
                    try {
                      vadInstance.start();
                    } catch {
                      /* ignore */
                    }
                  }, 250);
                }
              }, MAX_UTTERANCE_MS);
            },
            onSpeechEnd: (audio: Float32Array) => {
              /* Disarm parallel capture; VAD's audio is the source
               * of truth on the normal end-of-utterance path. */
              captureCapturingRef.current = false;
              captureBufRef.current = [];
              if (mutedRef.current) return;
              finalizeUtterance(audio);
            },
            /* VAD thresholds derived from the user-tunable mic
             * sensitivity (0=ignore noise, 1=fire easily; 0.5 matches
             * the legacy 0.5/0.4 pair). Edited on /settings, persisted
             * server-side. silero VAD does not accept live threshold
             * updates, so the slider only takes effect on the next
             * VAD start (toggle the mic off and back on).
             * - redemptionFrames 24: roughly 768ms of post-pause
             *   tolerance before declaring end-of-utterance. Picks
             *   up natural pacing; the MAX_UTTERANCE_MS cap above
             *   guarantees Lex eventually gets to talk.
             * - minSpeechFrames 8: needs ~256ms of confirmed speech
             *   before counting as a barge-in. Cuts false barge-ins
             *   from coughs / one-syllable sounds. */
            ...(() => {
              const t = vadThresholds(vadSensitivityRef.current);
              return {
                positiveSpeechThreshold: t.positive,
                negativeSpeechThreshold: t.negative,
              };
            })(),
            redemptionFrames: 24,
            preSpeechPadFrames: 8,
            minSpeechFrames: 8,
          });
          vadInstance = vad;
          vadRef.current = vad;
          vad.start();
        } catch (err) {
          setStatus("error");
          setErrMsg(`mic init failed: ${(err as Error).message}`);
        }
      }

      /* Push-to-talk path. Holds a MediaStream + AudioWorklet that
       * forwards 16kHz int16 PCM frames into a buffer; flushes the
       * buffer on talk-button release. No VAD; the user is the gate.
       * Useful when VAD over-fires on background noise. */
      let pttCtx: AudioContext | null = null;
      let pttStream: MediaStream | null = null;
      let pttBuffer: Int16Array[] = [];
      let pttCapturing = false;

      async function initPushToTalk(): Promise<void> {
        try {
          pttStream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true },
          });
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const Cls: any =
            (window as unknown as { AudioContext?: typeof AudioContext })
              .AudioContext ??
            (window as unknown as { webkitAudioContext?: typeof AudioContext })
              .webkitAudioContext;
          pttCtx = new Cls({ sampleRate: 16000 });
          if (!pttCtx) throw new Error("no AudioContext");
          const src = pttCtx.createMediaStreamSource(pttStream);
          /* Use a ScriptProcessorNode for simplicity: it's deprecated
           * but universally supported and the data path is short.
           * AudioWorklet would be cleaner but needs an extra worklet
           * file deployed to /vad/. */
          const proc = pttCtx.createScriptProcessor(4096, 1, 1);
          proc.onaudioprocess = (e) => {
            if (!pttCapturing) return;
            const f = e.inputBuffer.getChannelData(0);
            const gain = micGainRef.current;
            const i16 = new Int16Array(f.length);
            for (let i = 0; i < f.length; i++) {
              const s = Math.max(-1, Math.min(1, (f[i] ?? 0) * gain));
              i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
            }
            pttBuffer.push(i16);
          };
          src.connect(proc);
          proc.connect(pttCtx.destination);
          /* Stash refs on vadRef so the cleanup path tears down. */
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          vadRef.current = {
            destroy: () => {
              try {
                pttStream?.getTracks().forEach((t) => t.stop());
              } catch {
                /* ignore */
              }
              try {
                proc.disconnect();
              } catch {
                /* ignore */
              }
              try {
                src.disconnect();
              } catch {
                /* ignore */
              }
              try {
                if (pttCtx && pttCtx.state !== "closed") void pttCtx.close();
              } catch {
                /* ignore */
              }
            },
          } as { destroy: () => void };
          setStatus("ready");
        } catch (err) {
          setStatus("error");
          setErrMsg(`mic init failed: ${(err as Error).message}`);
        }
      }

      /* Push-to-talk wire helpers exposed via a closure so the
       * top-level component can call them on button mousedown / up.
       * We hang them on the WS object via a side-channel ref so
       * React doesn't have to re-bind. */
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (wsRef.current as any).__pttStart = () => {
        if (modeRef.current !== "push-to-talk") return;
        if (mutedRef.current) return;
        if (speakingRef.current) {
          sendJson({ t: "barge-in" });
          resetTtsPlayback();
        }
        pttBuffer = [];
        pttCapturing = true;
        sendJson({ t: "utterance-start" });
        setStatus("listening");
        utteranceStartRef.current = Date.now();
        if (utteranceTimerRef.current) {
          clearInterval(utteranceTimerRef.current);
        }
        utteranceTimerRef.current = setInterval(() => {
          setUtteranceMs(Date.now() - utteranceStartRef.current);
        }, 100);
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (wsRef.current as any).__pttStop = () => {
        if (modeRef.current !== "push-to-talk") return;
        if (!pttCapturing) return;
        pttCapturing = false;
        if (utteranceTimerRef.current) {
          clearInterval(utteranceTimerRef.current);
          utteranceTimerRef.current = null;
        }
        setUtteranceMs(0);
        const total = pttBuffer.reduce((sum, c) => sum + c.length, 0);
        const merged = new Int16Array(total);
        let off = 0;
        for (const c of pttBuffer) {
          merged.set(c, off);
          off += c.length;
        }
        pttBuffer = [];
        if (merged.length > 0) {
          sendBinary(merged.buffer);
        }
        sendJson({ t: "utterance-end" });
        setStatus("transcribing");
      };
    })();

    return () => {
      cancelled = true;
      /* Deliberately do NOT call tearDownVoice() here. VoiceClient is
       * rendered at the AppShell level so it survives route changes;
       * teardown only happens when the user clicks Stop (enabled=false)
       * or tells Lex to end the session. The cancelled flag is enough
       * to short-circuit any in-flight async work that has not yet
       * resolved when deps change (sessionId or mode swap). */
    };
  }, [enabled, sessionId, mode]);

  function pttDown(): void {
    setPttHolding(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fn = (wsRef.current as any)?.__pttStart as (() => void) | undefined;
    fn?.();
  }
  function pttUp(): void {
    setPttHolding(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fn = (wsRef.current as any)?.__pttStop as (() => void) | undefined;
    fn?.();
  }

  /* Mode change while voice is active: tear down + bring up the new
   * pipeline so VAD vs PTT swap cleanly. The dependent useEffect's
   * deps include mode so this happens automatically; the helper
   * sends a server-side mode-set so the daemon respects notes-mode
   * silence. */
  function changeMode(next: Mode): void {
    setMode(next);
    sendJson({ t: "set-mode", mode: next });
  }

  /* Stop button click. In notes mode with a live socket we don't
   * tear down immediately; we ask Lex to emit a notes-summary
   * artifact first so the dictation session leaves a durable
   * record. The assistant-text handler triggers the actual
   * setEnabled(false) once the summary turn lands. A timeout
   * guards against a stuck Lex so the user always gets out of
   * the panel. */
  function toggleEnabled(): void {
    if (!enabled) {
      setEnabled(true);
      return;
    }
    if (mode === "notes" && wsRef.current?.readyState === WebSocket.OPEN) {
      awaitingFinalizeRef.current = true;
      sendJson({ t: "finalize-notes" });
      setStatus("thinking");
      if (finalizeTimeoutRef.current) clearTimeout(finalizeTimeoutRef.current);
      finalizeTimeoutRef.current = setTimeout(() => {
        awaitingFinalizeRef.current = false;
        setEnabled(false);
      }, 30_000);
      return;
    }
    setEnabled(false);
  }

  const statusLabel: Record<Status, string> = {
    idle: "off",
    connecting: "connecting…",
    ready: "ready",
    listening: "listening",
    transcribing: "transcribing…",
    thinking: "Lex thinking…",
    speaking: "Lex speaking",
    error: "error",
  };

  const statusTone: Record<Status, string> = {
    idle: "text-txt3",
    connecting: "text-txt3",
    ready: "text-promoted",
    listening: "text-promoted",
    transcribing: "text-attn",
    thinking: "text-attn",
    speaking: "text-brandSoft",
    error: "text-err",
  };

  /* Portal target lookup re-runs on every pathname change via the
   * tick state below. The /lex page renders a div#voice-panel-slot;
   * other routes do not, so VoiceClient mounts to nothing visible
   * while keeping its WS/mic/audio pipeline alive in React state. */
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (typeof document === "undefined") return;
    const findSlot = () =>
      setPortalTarget(document.getElementById("voice-panel-slot"));
    findSlot();
    /* MutationObserver catches the slot showing up after a route nav
     * since Next.js client navigation rerenders the page subtree
     * asynchronously; without this we would miss the first /lex visit
     * after a non-/lex initial load. */
    const obs = new MutationObserver(findSlot);
    obs.observe(document.body, { childList: true, subtree: true });
    return () => obs.disconnect();
  }, []);

  const panel = (
    <section className="rounded-panel bg-surface1 hairline">
      <div className="px-5 py-3 border-b border-border1 flex items-center gap-3">
        <Icon name="Mic" className="text-brandSoft" size={16} />
        <h2 className="font-display text-sm font-emphasized">Voice</h2>
        <span className={`text-nano font-mono ${statusTone[status]}`}>
          {statusLabel[status]}
        </span>
        {enabled && status === "listening" && utteranceMs > 0 && (
          <span className="text-nano text-txt3 font-mono">
            {(utteranceMs / 1000).toFixed(1)}s
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <label
            className="flex items-center gap-2 text-nano font-mono text-txt3"
            title="Lex speech rate. Persisted globally; applies to every voice consumer until you change it again."
          >
            <span>speed</span>
            <input
              type="range"
              min={SPEED_MIN}
              max={SPEED_MAX}
              step={SPEED_STEP}
              value={speed}
              onChange={(e) => changeSpeed(Number(e.target.value))}
              className="w-24 accent-brandSoft"
            />
            <span className="text-txt2 tabular-nums w-10 text-right">
              {speed.toFixed(2)}x
            </span>
          </label>
          {enabled && (
            <button
              type="button"
              onClick={() => setMicMuted(!muted)}
              className={`text-xs px-3 py-1.5 rounded-pill hairline font-emphasized ${
                muted
                  ? "bg-attn/15 text-attn ring-1 ring-attn/30 hover:bg-attn/25"
                  : "bg-surface2 text-txt2 hover:bg-surface3"
              }`}
              title="Mute your mic without ending the session. Lex keeps listening on your next unmute."
            >
              {muted ? "muted" : "mute"}
            </button>
          )}
          <button
            type="button"
            onClick={toggleEnabled}
            className={`text-xs px-3 py-1.5 rounded-pill hairline font-emphasized ${
              enabled
                ? "bg-err/15 text-err ring-1 ring-err/30 hover:bg-err/25"
                : "bg-brand/15 text-brandSoft ring-1 ring-brand/30 hover:bg-brand/25"
            }`}
            title={
              enabled && mode === "notes"
                ? "End notes session. Lex will emit a notes-summary before closing."
                : enabled
                  ? "Stop voice."
                  : "Start voice."
            }
          >
            {enabled
              ? mode === "notes" && awaitingFinalizeRef.current
                ? "finalising…"
                : "stop"
              : "start voice"}
          </button>
        </div>
      </div>
      <div className="px-5 py-3 border-b border-border1 flex flex-wrap items-center gap-2">
        <span className="text-nano text-txt3 mr-1">mode</span>
        {(["conversation", "notes", "push-to-talk"] as Mode[]).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => changeMode(m)}
            className={`text-nano px-2.5 py-1 rounded-pill hairline font-mono ${
              mode === m
                ? "bg-brand/20 text-brandSoft ring-1 ring-brand/40"
                : "bg-surface2 text-txt2 hover:bg-surface3"
            }`}
          >
            {MODE_LABEL[m]}
          </button>
        ))}
        {voices.length > 0 && (
          <>
            <span className="text-nano text-txt3 mx-1 ml-3">voice</span>
            <select
              value={activeVoice}
              onChange={(e) => void changeVoice(e.target.value)}
              className="text-nano bg-surface2 hairline rounded-pill px-2 py-1 text-txt2 font-mono"
            >
              {voices.map((v) => (
                <option key={v.name} value={v.name}>
                  {v.name}
                </option>
              ))}
            </select>
          </>
        )}
      </div>
      <div className="px-5 py-3 text-nano text-txt3">{MODE_HINT[mode]}</div>
      {enabled && mode === "push-to-talk" && (
        <div className="px-5 pb-4">
          <button
            type="button"
            onMouseDown={pttDown}
            onMouseUp={pttUp}
            onMouseLeave={() => pttHolding && pttUp()}
            onTouchStart={(e) => {
              e.preventDefault();
              pttDown();
            }}
            onTouchEnd={(e) => {
              e.preventDefault();
              pttUp();
            }}
            className={`w-full py-4 rounded-card font-emphasized text-sm select-none transition-colors ${
              pttHolding
                ? "bg-err/30 text-err ring-2 ring-err/50"
                : "bg-brand/15 text-brandSoft ring-1 ring-brand/30 hover:bg-brand/25"
            }`}
          >
            {pttHolding ? "release to send" : "hold to talk"}
          </button>
        </div>
      )}
      {(lastTranscript || lastReply || errMsg) && (
        <div className="px-5 py-3 space-y-2 text-xs">
          {lastTranscript && (
            <div>
              <span className="text-nano text-txt3 font-mono mr-2">you:</span>
              <span className="text-txt2">{lastTranscript}</span>
            </div>
          )}
          {lastReply && (
            <div>
              <span className="text-nano text-brandSoft font-mono mr-2">lex:</span>
              <span className="text-txt1">{lastReply}</span>
            </div>
          )}
          {errMsg && <div className="text-err">{errMsg}</div>}
        </div>
      )}
      {!enabled && (
        <div className="px-5 py-3 text-nano text-txt3">
          Click <strong>start voice</strong> to grant mic access. Pick a mode
          first if you don&apos;t want default conversation.
        </div>
      )}
    </section>
  );

  return portalTarget ? createPortal(panel, portalTarget) : null;
}
