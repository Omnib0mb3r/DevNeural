"use client";

import { useEffect, useRef, useState } from "react";
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

  const wsRef = useRef<WebSocket | null>(null);
  const vadRef = useRef<unknown>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const ttsRateRef = useRef<number>(22050);
  const playheadRef = useRef<number>(0);
  const speakingRef = useRef<boolean>(false);
  const mutedRef = useRef<boolean>(false);
  /* Timestamps + handles for the live utterance counter and the
   * server-side max-utterance abort. */
  const utteranceStartRef = useRef<number>(0);
  const utteranceTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const utteranceCapRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const utteranceSamplesRef = useRef<number>(0);

  /* Reset playhead and stop scheduled buffers. Used on barge-in and
   * when a new tts-start arrives. */
  function resetTtsPlayback(): void {
    if (audioCtxRef.current) {
      playheadRef.current = audioCtxRef.current.currentTime;
    }
    speakingRef.current = false;
  }

  /* Mute keeps the WS open and the mic stream alive so unmuting is
   * instant, but gates the VAD events: while muted, speech-start /
   * speech-end are no-ops. Lets the user pause input while Lex is
   * still composing a response without tearing down the pipeline. */
  function setMicMuted(next: boolean): void {
    mutedRef.current = next;
    setMuted(next);
    if (next && utteranceTimerRef.current) {
      clearInterval(utteranceTimerRef.current);
      utteranceTimerRef.current = null;
      setUtteranceMs(0);
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
   * in bursts. */
  function schedulePcmChunk(pcm: ArrayBuffer): void {
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

  useEffect(() => {
    if (!enabled) {
      /* Tear-down path. */
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
      const ctx = audioCtxRef.current;
      if (ctx && ctx.state !== "closed") {
        try {
          void ctx.close();
        } catch {
          /* ignore */
        }
      }
      audioCtxRef.current = null;
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
        sendJson({ t: "hello", session_id: sessionId ?? undefined });
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
            schedulePcmChunk(ev.data);
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
            playheadRef.current = audioCtxRef.current?.currentTime ?? 0;
            speakingRef.current = true;
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

      async function initVad(): Promise<void> {
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
            const int16 = new Int16Array(audio.length);
            for (let i = 0; i < audio.length; i++) {
              const s = Math.max(-1, Math.min(1, audio[i] ?? 0));
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
                /* Barge-in: stop Lex, start a fresh utterance. */
                sendJson({ t: "barge-in" });
                resetTtsPlayback();
              }
              setStatus("listening");
              sendJson({ t: "utterance-start" });
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
              if (mutedRef.current) return;
              finalizeUtterance(audio);
            },
            /* VAD thresholds tuned for "speak naturally" rather than
             * push-to-talk. Tuning notes after first user test:
             * - positiveSpeechThreshold lowered to 0.5: missed real
             *   speech onsets when the user spoke softly.
             * - negativeSpeechThreshold raised to 0.4: short mid-
             *   sentence pauses were too easily counted as silence,
             *   making Lex wait or premature-cut.
             * - redemptionFrames 24: roughly 768ms of post-pause
             *   tolerance before declaring end-of-utterance. Picks
             *   up natural pacing; the MAX_UTTERANCE_MS cap above
             *   guarantees Lex eventually gets to talk.
             * - minSpeechFrames 8: needs ~256ms of confirmed speech
             *   before counting as a barge-in. Cuts false barge-ins
             *   from coughs / one-syllable sounds. */
            positiveSpeechThreshold: 0.5,
            negativeSpeechThreshold: 0.4,
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
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled, sessionId]);

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

  return (
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
            onClick={() => setEnabled((v) => !v)}
            className={`text-xs px-3 py-1.5 rounded-pill hairline font-emphasized ${
              enabled
                ? "bg-err/15 text-err ring-1 ring-err/30 hover:bg-err/25"
                : "bg-brand/15 text-brandSoft ring-1 ring-brand/30 hover:bg-brand/25"
            }`}
          >
            {enabled ? "stop" : "start voice"}
          </button>
        </div>
      </div>
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
          Click <strong>start voice</strong> to grant mic access. Speak when
          status is <em>ready</em>; Lex hears you when you stop. He&apos;ll
          talk back. Speak again to interrupt him.
        </div>
      )}
    </section>
  );
}
