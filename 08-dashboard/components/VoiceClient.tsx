"use client";

import * as React from "react";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { usePathname } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "./Icon";
import { LexThumbs } from "./LexThumbs";
import { listPtys, type PtyEntry } from "@/lib/daemon-client";
import { emitVoiceSettingUpdate, onVoiceSettingUpdate } from "@/lib/voice-settings-bus";
import { emitTranscriptTurn } from "@/lib/transcript-bus";
import {
  createDedupe,
  getSpeechRecognitionCtor,
  processWakeResults,
  type VoiceCommandKind,
  type SpeechRecognitionLike,
} from "@/lib/voice-wake-word";
import { logWake } from "@/lib/wake-log";
import { logVoice, computeReconnectBackoffMs } from "@/lib/voice-log";
import { getVadModule, resetVadModuleCache } from "@/lib/voice-ort-config";
import { warmAudioContext } from "@/lib/voice-audio-warm";
import {
  runWatchdogChecks,
  postVoiceHealth,
  type VoiceHealthEvent,
  type WatchdogCheckKind,
} from "@/lib/voice-watchdog";
import { VoiceErrorPill } from "./VoiceErrorPill";

/* Wake-word debug badge gating. The badge is dev-only: set
 * NEXT_PUBLIC_LEX_DEBUG_VOICE=1 in .env.local to surface the
 * lastWakeMatched + lastWakeError + wakeWordActive triple inside
 * the voice pill so the post-mute stuck-state can be diagnosed
 * without opening DevTools. Defaults off; the env var is inlined
 * at build time by Next.js, so production bundles do not carry
 * the debug branch. */
const LEX_DEBUG_VOICE =
  typeof process !== "undefined" &&
  process.env.NEXT_PUBLIC_LEX_DEBUG_VOICE === "1";

/* Confidence floor for logging Web Speech result fragments. Web
 * Speech sometimes streams interim transcripts with low confidence
 * (the recognizer is still narrowing down); we log every result if
 * its alts carry a numeric .confidence >= this floor, OR every
 * final-flagged result whose alts have no .confidence at all (older
 * Chromium builds). The matcher still runs on every fragment - the
 * floor only gates the log line. */
const WAKE_LOG_CONFIDENCE_FLOOR = 0.6;

/* Voice control surface exposed to UI islands outside VoiceClient
 * (TopBar mic pill, future status badges). VoiceClient wraps the
 * whole tree in a provider so any descendant can read live state
 * and stop / mute / start voice without prop drilling. */
interface VoiceCtxValue {
  status:
    | "idle"
    | "connecting"
    | "ready"
    | "listening"
    | "transcribing"
    | "thinking"
    | "speaking"
    | "error";
  enabled: boolean;
  muted: boolean;
  /* True while the daemon is streaming TTS to us. The mic capture
   * path is hard-paused for the duration so the speaker's own
   * playback does not loop back through whisper as the user's next
   * utterance. The TopBar pill swaps the mic icon to MicOff while
   * this is true. */
  micGated: boolean;
  /* Rolling turn history. Capped in-memory; full transcript stays in
   * the daemon's jsonl. The TranscriptHistory panel renders the
   * trailing N turns + a thinking placeholder. Assistant turns that
   * arrived while soft-muted are tagged silent=true so the renderer
   * can flag them as "never played aloud". */
  turns: Array<{
    id: string;
    role: "user" | "assistant";
    text: string;
    silent?: boolean;
  }>;
  hasLex: boolean;
  /* Soft mute set by the "Lex mute / shut up / be quiet / stop talking"
   * voice command. TTS is halted; Lex's thinking and worker actions
   * continue. Cleared only by "Lex unmute" or by clicking the mute
   * pill in the panel. */
  softMuted: boolean;
  /* Count of assistant turns that arrived while soft-muted. Used to
   * surface a persistent "unread silent messages" badge next to the
   * pill. Cleared on unmute; never auto-stales. */
  silentMessageCount: number;
  /* True while the always-on wake-word recognizer is live. Rendered
   * as a small "wake" indicator on the pill so the user can confirm
   * Lex command capture is still on even when the foreground mic is
   * micGated during TTS playback. */
  wakeWordActive: boolean;
  /* Dev-only observability surface. Last command kind the matcher
   * locked in + the most recent recognizer error string. Exposed on
   * the context so the pill can render the debug badge without
   * having to grow a separate hook. Always populated; rendering is
   * gated by NEXT_PUBLIC_LEX_DEBUG_VOICE on the consumer side. */
  lastWakeMatched: VoiceCommandKind | null;
  lastWakeError: string | null;
  /* Lex speech rate, persisted globally. Exposed on the context so
   * the TopBar pill can render an inline speed slider without re-
   * deriving from voice-preferences. */
  speed: number;
  speedMin: number;
  speedMax: number;
  speedStep: number;
  setSpeed: (next: number) => void;
  toggleEnabled: () => void;
  setMicMuted: (next: boolean) => void;
  setSoftMuted: (next: boolean) => void;
}
const VoiceCtx = createContext<VoiceCtxValue | null>(null);
export function useVoice(): VoiceCtxValue | null {
  return useContext(VoiceCtx);
}

/* DOM id rendered by app/lex/page.tsx where the full voice panel UI
 * portals into. Other routes don't render this element, in which case
 * the engine still runs (mounted globally in app/providers.tsx) and
 * the floating mini-badge takes over so the user can see / control
 * voice without navigating back to /lex. */
const PANEL_MOUNT_ID = "voice-panel-mount";

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

/* VAD end-of-utterance redemption window in ms. Higher = more
 * tolerance for mid-sentence pauses before silero declares end-of-
 * utterance and Lex starts thinking. Was hardcoded as 24 frames
 * (~768ms); now user-tunable from the voice panel. Server-persisted
 * in voice-preferences.json; localStorage seeds the slider so it
 * doesn't snap on remount. The slider's value is converted to silero
 * frames (32ms each at 16kHz) at VAD init time, so changing it
 * requires a voice-off / voice-on cycle to take effect. */
const VAD_REDEMPTION_STORAGE_KEY = "lex-vad-redemption-ms";
const VAD_REDEMPTION_MIN = 200;
const VAD_REDEMPTION_MAX = 3000;
const VAD_REDEMPTION_DEFAULT = 768;
const SILERO_FRAME_MS = 32;

/* Rolling probability floor for stuck-open VAD recovery. While the
 * listener is open we average silero's per-frame isSpeech probability
 * over the last VAD_PROB_WINDOW_MS; if the average drops below
 * VAD_PROB_FLOOR we force end-of-utterance and recycle the VAD.
 * Catches the case where silero opens on a transient (cough, room
 * noise burst) but no real speech follows and the redemption window
 * never elapses because background frames keep nudging probability
 * just above the negative threshold. Intentionally no hard duration
 * cap: legitimate long utterances stay alive as long as the user
 * keeps speaking above the floor. */
const VAD_PROB_FLOOR = 0.4;
const VAD_PROB_WINDOW_MS = 1500;

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

/* Cap on a single utterance. After this many milliseconds of
 * continuous speech we force an utterance-end so the user gets a
 * response even if they're still mid-sentence. Also protects the
 * server from runaway buffers.
 *
 * 2026-05-22: lifted from 30s to 30 min. The old 30s cap silently
 * dropped the parallel capture buffer on fire, which truncated any
 * long-form utterance the user was still actively producing. The
 * new ceiling is a runaway-protection floor only; the cap-fire path
 * now ships captureBufRef through flushParallelCapture so audio is
 * preserved even when the cap trips. */
const MAX_UTTERANCE_MS = 30 * 60_000;

/* Hard ceiling on the mic buffer in samples (16k Hz mono int16).
 * 30 min * 60s * 16000 = ~28.8M samples = ~57.6MB. Above the legacy
 * 4MB server cap; the WS frame cap was lifted in concert with the
 * MAX_UTTERANCE_MS change. Used as a defensive abort if VAD never
 * fires speech-end. */
const MAX_UTTERANCE_SAMPLES = 30 * 60 * 16000;

/* Voice enable/mute toggles are intentionally NOT persisted across
 * page loads. A page refresh is treated as an explicit reset: voice
 * starts off and the user re-clicks "start voice" to grant mic
 * access. Persisting `enabled` previously caused voice to silently
 * resurrect on every reload whenever a teardown path (tab close,
 * crash, navigation) skipped the explicit stop handler, which left
 * the localStorage flag stuck at "1" forever. */

export function VoiceClient({ children }: { children?: ReactNode }) {
  /* Voice engine is mounted once at the application root (see
   * app/providers.tsx) so the WS, mic stream, and AudioContext
   * survive in-app navigation between /lex, /brainstorms, /wiki,
   * etc. The full panel UI portals to a per-route mount target
   * declared by /lex; on every other route a floating mini-badge
   * surfaces status + mute + stop so the user can see and control
   * voice without losing their place.
   *
   * sessionId is resolved from the same pty-list query the /lex
   * page uses: the most-recently-started non-exited PTY whose cwd
   * ends in /brainstorm. There's only one Lex at a time so binding
   * the engine to "whichever brainstorm PTY is live right now" is
   * the correct behaviour regardless of route. */
  const ptysQ = useQuery({
    queryKey: ["pty-list"],
    queryFn: listPtys,
    refetchInterval: 3_000,
  });
  const lexPty: PtyEntry | undefined = (ptysQ.data?.ptys ?? [])
    .filter(
      (p) => !p.exited && /\/brainstorm\/?$/i.test(p.cwd.replace(/\\/g, "/")),
    )
    .sort((a, b) => b.startedAt - a.startedAt)[0];
  const sessionId: string | null = lexPty?.sessionId ?? null;
  const hasLex = Boolean(lexPty);

  /* hasLex ref so the ws.onclose handler (which closes over its
   * snapshot at WS-open time) can read the live value and suppress
   * the "voice connection closed" error toast when the close was
   * just the server reaping the WS along with a killed Lex PTY. */
  const hasLexRef = useRef<boolean>(false);
  hasLexRef.current = hasLex;

  /* Portal target. /lex renders <div id={PANEL_MOUNT_ID} /> only
   * once a Lex PTY exists (or a spawn is pending); on cold load
   * with no Lex the page shows an empty state and no mount div.
   * Re-resolving the target on pathname OR live-PTY change covers
   * both navigation back to /lex and the user clicking "start lex"
   * from the empty state — without a re-resolve trigger the panel
   * stayed unportaled even after the spawn landed. */
  const pathname = usePathname();
  const [mountEl, setMountEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (typeof document === "undefined") return;
    setMountEl(document.getElementById(PANEL_MOUNT_ID));
  }, [pathname, lexPty?.ptyId]);

  const [status, setStatus] = useState<Status>("idle");
  const [enabled, setEnabled] = useState<boolean>(false);
  const [muted, setMuted] = useState<boolean>(false);

  /* Auto-stop voice when Lex disappears, but debounced so a kill→
   * respawn cycle (switch-to / new-session) doesn't tear the engine
   * down between the old PTY dying and the new one registering.
   * Without the debounce, every "switch to" turned voice off and
   * the user had to manually start voice again on the new session.
   * 2500ms covers the 400ms inter-spawn gap plus typical spawn
   * latency on Windows. */
  useEffect(() => {
    if (!enabled) return;
    if (hasLex) return;
    if (ptysQ.isLoading) return;
    const t = setTimeout(() => {
      if (!hasLexRef.current) setEnabled(false);
    }, 2500);
    return () => clearTimeout(t);
  }, [enabled, hasLex, ptysQ.isLoading]);
  /* Rolling turn history surfaced through VoiceCtx. The TranscriptHistory
   * component renders the trailing N turns (default 10) plus a placeholder
   * while status='thinking'. We cap in-memory at 50 to keep React updates
   * cheap; the daemon retains the canonical jsonl for full history. */
  const [turns, setTurns] = useState<
    Array<{
      id: string;
      role: "user" | "assistant";
      text: string;
      silent?: boolean;
    }>
  >([]);
  const TURNS_BUFFER_CAP = 50;
  /* Soft mute driven by the "lex mute" voice-command family. While
   * true the audio path is suppressed: tts-start does not initialize
   * the AudioContext, incoming PCM chunks are dropped on the floor,
   * and any in-flight playback is cancelled the moment mute fires.
   * Assistant transcript turns still arrive and render so the user
   * can keep reading along; they are tagged silent=true. The "lex
   * unmute" command (or the mute pill) clears the flag. There is NO
   * auto-replay of messages received during the mute window. */
  const [softMuted, setSoftMutedState] = useState<boolean>(false);
  const softMutedRef = useRef<boolean>(false);
  softMutedRef.current = softMuted;
  /* Mic permission gate. Flips true the first time the parallel-
   * capture rig's getUserMedia resolves; the wake-word recognizer
   * waits for this flag before calling SpeechRecognition.start() so
   * Chromium doesn't pop a second permission prompt in parallel
   * with the VAD's getStream(). Reset on every enabled->disabled
   * cycle so a fresh start re-confirms the permission instead of
   * trusting a stale grant from a prior session. */
  const [micPermissionGranted, setMicPermissionGranted] = useState<boolean>(false);
  /* Wake-word listener live state. Independent of mic-mute /
   * micGated / softMuted: the Web Speech recognizer runs whenever
   * voice is enabled and the permission gate is open, regardless of
   * whether the foreground capture path is muted or TTS-gated. The
   * pill renders this as a small "wake" indicator so the user can
   * tell the Lex command suite is still listening during TTS
   * playback (bug 2026-05-14-voice-pill-inconsistent-and-wake-word-
   * muted: the prior pill had no separate wake-word indicator, so
   * the foreground mic icon flipping to MicOff during micGated
   * read as "wake-word also muted" even though it never was). */
  const [wakeWordActive, setWakeWordActive] = useState<boolean>(false);
  /* Observability surfaces for the wake-word path. Driven by
   * logWake-tapped lifecycle handlers below; rendered as a tiny
   * dev-only badge inside the pill when LEX_DEBUG_VOICE is on. */
  const [lastWakeMatched, setLastWakeMatched] = useState<
    VoiceCommandKind | null
  >(null);
  const [lastWakeError, setLastWakeError] = useState<string | null>(null);
  /* Start/stop click idempotency guard. The enable effect kicks off
   * async getUserMedia + MicVAD.new + WS connect; a rapid second
   * click can land before any of that resolves and either no-ops
   * silently (looks like the first click was lost) or stacks a
   * second teardown on top of an unfinished init. busyUntil holds a
   * monotonic deadline (ms) inside which toggleEnabled refuses to
   * flip the state; the deadline clears when the engine reaches a
   * stable status. */
  const enableBusyUntilRef = useRef<number>(0);
  /* Unread-silent-message badge. Counts assistant turns that arrived
   * while soft-muted. Cleared only on unmute (never auto-stales) so
   * the pill keeps signalling "go read the transcript" through long
   * meeting windows. */
  const [silentMessageCount, setSilentMessageCount] = useState<number>(0);
  /* Wave 2 carry-over #1: per-turn thumbs vote on Lex's last reply.
   * The voice WS sends turn_id (claude-code assistant message uuid)
   * + prompt_version on every assistant-text. Both are required by
   * LexThumbs; null defers the render until we get them. */
  const [lastTurn, setLastTurn] = useState<{
    turn_id: string;
    prompt_version: string;
    brainstorm_id: string | null;
  } | null>(null);
  const [errMsg, setErrMsg] = useState<string>("");
  /* Transient neutral banner. Used for non-error notifications that
   * should fade on their own (Settings reset on reconnect, etc.). A
   * separate channel from errMsg so it never lights up the error pill
   * or blocks the retry CTA. Auto-clears via infoMsgTimerRef. */
  const [infoMsg, setInfoMsg] = useState<string>("");
  const infoMsgTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showInfoToast = React.useCallback((msg: string, ms = 4000): void => {
    setInfoMsg(msg);
    if (infoMsgTimerRef.current) clearTimeout(infoMsgTimerRef.current);
    infoMsgTimerRef.current = setTimeout(() => {
      setInfoMsg("");
      infoMsgTimerRef.current = null;
    }, ms);
  }, []);
  useEffect(() => {
    return () => {
      if (infoMsgTimerRef.current) {
        clearTimeout(infoMsgTimerRef.current);
        infoMsgTimerRef.current = null;
      }
    };
  }, []);
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
  /* VAD redemption window. Read at VAD init via the ref; silero does
   * not accept live updates so changes only take effect after a
   * voice-off / voice-on cycle. The slider is wired to a debounced
   * server write so dragging doesn't fire 20 POSTs. */
  const [vadRedemptionMs, setVadRedemptionMs] = useState<number>(() => {
    if (typeof window === "undefined") return VAD_REDEMPTION_DEFAULT;
    const raw = window.localStorage.getItem(VAD_REDEMPTION_STORAGE_KEY);
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) &&
      n >= VAD_REDEMPTION_MIN &&
      n <= VAD_REDEMPTION_MAX
      ? n
      : VAD_REDEMPTION_DEFAULT;
  });
  const vadRedemptionRef = useRef<number>(VAD_REDEMPTION_DEFAULT);
  vadRedemptionRef.current = vadRedemptionMs;
  const vadRedemptionSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  /* Reset soft-mute + silent-message badge whenever the user fully
   * disables voice. A fresh "start voice" cycle always begins
   * unmuted; carrying soft-mute across a teardown would otherwise
   * leave the next session silently dropping TTS. */
  useEffect(() => {
    if (!enabled) {
      softMutedRef.current = false;
      setSoftMutedState(false);
      setSilentMessageCount(0);
      /* Force a fresh permission grant on the next start so the
       * wake-word recognizer waits for getUserMedia again instead of
       * relying on a stale flag from the prior session. The browser
       * itself remembers the grant per-origin so the user does not
       * see a second permission UI; the state reset is purely so the
       * wake-word useEffect's gate works deterministically across
       * enable cycles. */
      setMicPermissionGranted(false);
      setWakeWordActive(false);
    }
  }, [enabled]);

  /* Always-on wake-word listener via the Web Speech API. Runs in
   * parallel with the silero VAD path so the Lex command suite still
   * fires while TTS playback has gated the main mic capture. Feature-
   * detected: Firefox and offline Chromium builds without the cloud
   * STT backend fall back to the keyboard hotkey listener below. The
   * recognizer auto-restarts on `onend` because Chromium pauses the
   * session every ~30s of silence; we keep it running for as long as
   * voice is enabled.
   *
   * Gated on micPermissionGranted (the parallel-capture rig's
   * getUserMedia having resolved at least once) so Chromium's
   * SpeechRecognition.start() doesn't race the VAD's getStream() for
   * the mic permission prompt. Without this gate the user saw two
   * permission prompts on first Enable Audio (bug
   * 2026-05-14-enable-audio-double-permission-prompt): one for plain
   * getUserMedia, one for Web Speech, fired in parallel before the
   * user had a chance to grant the first. Sequencing makes Chromium
   * reuse the grant for the second request so only one prompt
   * surfaces. */
  useEffect(() => {
    if (!enabled) return;
    if (!micPermissionGranted) return;
    if (typeof window === "undefined") return;
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) return;
    let cancelled = false;
    let recognizer: SpeechRecognitionLike | null = null;
    let restartTimer: ReturnType<typeof setTimeout> | null = null;
    /* Watchdog. Web Speech in continuous mode sometimes goes silent
     * indefinitely -- no onresult, no onend, no onerror -- after
     * Chromium loses its connection to the speech backend. Without a
     * watchdog the only path to recovery was the user noticing voice
     * commands had stopped and clicking restart. Track the last
     * lifecycle event (start / result / end / error) and force a
     * recognizer abort + restart when the silence exceeds the
     * threshold. */
    let lastEventMs = Date.now();
    const WATCHDOG_INTERVAL_MS = 10_000;
    const WATCHDOG_SILENCE_MS = 60_000;
    const stamp = (): void => {
      lastEventMs = Date.now();
    };
    const start = (): void => {
      if (cancelled) return;
      try {
        const r = new Ctor();
        r.continuous = true;
        r.interimResults = true;
        r.lang = "en-US";
        r.onresult = (event) => {
          if (cancelled) return;
          stamp();
          /* Iterate NEW results only. processWakeResults reads from
           * event.resultIndex per the Web Speech spec so old
           * finalised fragments are NOT re-matched on every event.
           * Bug 2026-05-14 'Lex unmute fails after Lex shut up'
           * was caused by a 0-based walk that re-dispatched the
           * earlier 'lex shut up' final on every subsequent event,
           * which the 1500ms per-kind dedupe blocked for one burst
           * and then re-fired every ~1.5s afterwards.
           *
           * Logging policy mirrors the prior path: log every
           * candidate whose confidence >= the floor, every final
           * fragment when older Chromium builds omit confidence,
           * and every matched fragment. */
          processWakeResults(event, {
            dispatch: (kind) => dispatchWakeCommandRef.current(kind),
            onCandidate: ({ transcript, matched, confidence, isFinal }) => {
              const shouldLog =
                (confidence !== null &&
                  confidence >= WAKE_LOG_CONFIDENCE_FLOOR) ||
                (confidence === null && isFinal) ||
                matched !== null;
              if (!shouldLog) return;
              logWake("heard", {
                transcript,
                matched,
                confidence,
                isFinal,
                softMuted: softMutedRef.current,
                enabled,
                micPermissionGranted,
              });
            },
          });
        };
        r.onerror = (event) => {
          /* swallow; onend will retry. log + stash for the debug
           * badge so a chain of restart-attempts whose root cause
           * was an upstream error is visible after the fact. */
          const reason =
            typeof event?.error === "string" ? event.error : "unknown";
          logWake("error", { error: reason });
          if (!cancelled) setLastWakeError(reason);
          stamp();
        };
        r.onend = () => {
          if (cancelled) return;
          logWake("end");
          setWakeWordActive(false);
          stamp();
          logWake("restart-attempt", { delayMs: 250 });
          restartTimer = setTimeout(start, 250);
        };
        recognizer = r;
        r.start();
        stamp();
        if (!cancelled) {
          setWakeWordActive(true);
          logWake("start");
        }
      } catch (err) {
        /* SpeechRecognition can throw on rapid start/stop cycles or
         * when another tab is holding the speech session. Backoff +
         * retry. */
        const message = (err as Error | undefined)?.message ?? "throw";
        logWake("error", { error: message, source: "start-throw" });
        if (!cancelled) {
          setLastWakeError(message);
          logWake("restart-attempt", { delayMs: 1000 });
          restartTimer = setTimeout(start, 1000);
        }
      }
    };
    start();
    const watchdogTimer = setInterval(() => {
      if (cancelled) return;
      const silentMs = Date.now() - lastEventMs;
      if (silentMs < WATCHDOG_SILENCE_MS) return;
      /* Recognizer has gone silent past the threshold. Force a
       * restart cycle. abort() triggers onend which re-arms the
       * recognizer via restartTimer; stamp resets the watchdog so
       * the next probe waits a full window before kicking again. */
      logWake("watchdog-restart", { silent_ms: silentMs });
      logVoice(
        "wake-watchdog-restart",
        "wake-word recognizer silent past threshold; forcing restart",
        { silent_ms: silentMs, threshold_ms: WATCHDOG_SILENCE_MS },
        "warn",
      );
      stamp();
      if (recognizer) {
        try {
          recognizer.abort();
        } catch {
          /* ignore; onend may not fire if abort threw, so schedule
           * a manual restart so the watchdog doesn't end up looping
           * on a dead recognizer. */
          if (restartTimer) clearTimeout(restartTimer);
          restartTimer = setTimeout(start, 250);
        }
      } else {
        /* Recognizer never spawned; kick directly. */
        if (restartTimer) clearTimeout(restartTimer);
        restartTimer = setTimeout(start, 250);
      }
    }, WATCHDOG_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(watchdogTimer);
      if (restartTimer) clearTimeout(restartTimer);
      if (recognizer) {
        try {
          recognizer.onresult = null;
          recognizer.onend = null;
          recognizer.onerror = null;
          recognizer.abort();
        } catch {
          /* ignore */
        }
      }
      logWake("abort-cleanup");
      setWakeWordActive(false);
    };
  }, [enabled, micPermissionGranted]);

  /* Keyboard hotkey fallback for the always-on wake-word path. Web
   * Speech is unavailable on Firefox and on offline / air-gapped
   * Chromium builds (the cloud STT backend cannot reach Google);
   * keyboard chords give the user a way to mute / disable / unmute
   * Lex mid-TTS without voice. Bindings:
   *   Ctrl+Alt+M -> mute
   *   Ctrl+Alt+U -> unmute
   *   Ctrl+Alt+D -> disable
   * Targets typing inputs are exempt so the chord does not fire
   * while the user is typing into a textarea / contentEditable. */
  useEffect(() => {
    if (!enabled) return;
    if (typeof window === "undefined") return;
    const handler = (ev: KeyboardEvent): void => {
      if (!ev.ctrlKey || !ev.altKey) return;
      const target = ev.target as HTMLElement | null;
      const tag = target?.tagName ?? "";
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        target?.isContentEditable
      ) {
        return;
      }
      const key = ev.key.toLowerCase();
      let kind: VoiceCommandKind | null = null;
      if (key === "m") kind = "mute";
      else if (key === "u") kind = "unmute";
      else if (key === "d") kind = "disable";
      if (!kind) return;
      ev.preventDefault();
      dispatchWakeCommandRef.current(kind);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [enabled]);

  const wsRef = useRef<WebSocket | null>(null);
  const vadRef = useRef<unknown>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const ttsRateRef = useRef<number>(22050);
  const playheadRef = useRef<number>(0);
  const speakingRef = useRef<boolean>(false);
  const mutedRef = useRef<boolean>(false);
  /* Hard mic gate driven by the daemon's tts-start / tts-end events.
   * Independent of the user-controlled mute toggle: the user can
   * leave mute=off and still expect zero self-echo into whisper while
   * Lex is speaking. */
  const [micGated, setMicGated] = useState<boolean>(false);
  const micGatedRef = useRef<boolean>(false);
  /* True once the server has signalled tts-end for the in-flight reply
   * but the AudioContext still has scheduled buffers playing. The
   * server's tts-end fires as soon as piper finishes streaming PCM,
   * which is typically several seconds before the last buffered chunk
   * actually leaves the speaker, because the client schedules audio
   * back-to-back ahead of the playhead. Clearing the mic gate on
   * tts-end therefore flashed the indicator off mid-sentence. We now
   * defer the gate-clear until the last AudioBufferSourceNode's
   * onended fires, gated by this flag so a late chunk that arrives
   * AFTER tts-end still keeps the indicator lit until it plays out. */
  const streamFinishedRef = useRef<boolean>(false);
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
  /* Voice-output watchdog state. The 10s probe loop reads these
   * refs to decide whether the audio path is healthy and whether
   * to fire a heal step. lastFrameTsMs is bumped on every binary
   * PCM frame; lastBufferProgressTsMs is bumped on tts-start, on
   * every scheduled BufferSource, and on every onended -- so a
   * stalled audio clock surfaces as a gap in the progress
   * timestamp even though the queue depth stays the same. */
  const ttsActiveRef = useRef<boolean>(false);
  const lastFrameTsMsRef = useRef<number | null>(null);
  const lastBufferProgressTsMsRef = useRef<number | null>(null);
  /* Banner gate. Flips to true after two consecutive heal attempts
   * for the same failing-check set both fail to recover the path.
   * Cleared by the in-banner reset click or by the watchdog seeing
   * a clean tick on its own. */
  const [voiceWatchdogDead, setVoiceWatchdogDead] = useState<boolean>(false);
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
  const captureProcRef = useRef<AudioWorkletNode | ScriptProcessorNode | null>(
    null,
  );
  const captureBufRef = useRef<Int16Array[]>([]);
  const captureCapturingRef = useRef<boolean>(false);
  /* Stuck-open VAD recovery state. vadListenerOpenRef is true between
   * onSpeechStart and onSpeechEnd (or any forced close); the rolling
   * probability window only accumulates while it's true so silence
   * between utterances doesn't poison the next utterance's floor. */
  const vadListenerOpenRef = useRef<boolean>(false);
  const probWindowRef = useRef<Array<{ t: number; p: number }>>([]);
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
    /* Barge-in: drop the TTS gate immediately so the new utterance's
     * onSpeechStart doesn't early-return against a stale micGatedRef.
     * Do NOT route through finalizePlaybackEnd here: VAD is already
     * mid-utterance and must not be restarted under it. */
    micGatedRef.current = false;
    setMicGated(false);
    streamFinishedRef.current = false;
    /* Watchdog teardown: the c2335c5 watchdog reads ttsActiveRef +
     * lastBufferProgressTsMsRef on its poll. Without clearing them
     * here, barge-in leaves ttsActive=true with zero active sources
     * and a stale progress timestamp, which the watchdog misreads as
     * a stuck buffer and self-heals (resetVoiceAudio) mid-utterance.
     * Bump the progress clock too so a heal poll mid-fade does not
     * see a fossil timestamp. */
    ttsActiveRef.current = false;
    lastBufferProgressTsMsRef.current = Date.now();
  }

  /* Called when both halves of the playback contract are complete:
   * the server has signalled tts-end (no more chunks coming) AND every
   * scheduled AudioBufferSourceNode has fired its onended (no audio
   * left in the AudioContext queue). Drops the mic gate, restarts the
   * VAD, and reverts status to "ready" (but only if status is still
   * "speaking", so a late onended after the user has already started a
   * new utterance doesn't downgrade a fresh "listening" state. */
  function finalizePlaybackEnd(): void {
    if (!streamFinishedRef.current) return;
    streamFinishedRef.current = false;
    speakingRef.current = false;
    /* Watchdog: TTS request fully drained, the stall + frame-timeout
     * checks should idle until the next tts-start. */
    ttsActiveRef.current = false;
    setStatus((cur) => (cur === "speaking" ? "ready" : cur));
    /* Order matters: clear the gate flag BEFORE restarting VAD so a
     * fast-firing onSpeechStart does not bounce off a still-true
     * micGatedRef. */
    micGatedRef.current = false;
    setMicGated(false);
    try {
      const v = vadRef.current as { start?: () => void } | null;
      v?.start?.();
    } catch {
      /* ignore */
    }
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

  /* Hard mute. The WS stays open so unmuting is instant, but every
   * audio path is shut down: MediaStream tracks disabled (so the
   * mic hardware stops capturing), parallel capture buffer dropped
   * (NOT flushed to Lex — user explicitly said don't listen), any
   * in-flight utterance timers cleared. Unmute re-enables the
   * track. Without this the previous "soft mute" still let Lex
   * hear: it only gated future VAD events, while flushing the
   * captured audio buffer to the server on mute-mid-utterance and
   * leaving track.enabled=true on the hardware.
   * Bug: 2026-05-11-mute-still-hears. */
  function setMicMuted(next: boolean): void {
    mutedRef.current = next;
    setMuted(next);
    const stream = captureStreamRef.current;
    if (stream) {
      for (const track of stream.getAudioTracks()) {
        track.enabled = !next;
      }
    }
    if (next) {
      /* Drop the parallel capture buffer rather than shipping it.
       * Any partial utterance still in memory is intentionally
       * discarded so Lex never sees audio captured while muted. */
      captureCapturingRef.current = false;
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
      if (statusRef.current === "listening") {
        setStatus("ready");
      }
    }
  }

  /* Soft mute: halt outbound TTS, keep transcript turns flowing.
   * Triggered by the "lex mute / shut up / be quiet / stop talking"
   * voice command or directly by clicking the muted-pill toggle.
   * Cancels any in-flight playback the same way barge-in does
   * (resetTtsPlayback walks every scheduled AudioBufferSourceNode
   * and stops it, drops the playhead, and clears speakingRef so
   * subsequent PCM chunks land in the binary handler's softMuted
   * gate instead of scheduling). The status pill drops back to
   * 'ready' so a stale "speaking" state doesn't linger after the
   * audio is gone. On unmute the silent-message badge clears; we
   * never auto-replay messages that arrived during the mute window
   * (spec). */
  function setSoftMuted(next: boolean): void {
    softMutedRef.current = next;
    setSoftMutedState(next);
    if (next) {
      try {
        resetTtsPlayback();
      } catch {
        /* never block the mute path on playback teardown */
      }
      if (
        statusRef.current === "speaking" ||
        statusRef.current === "thinking"
      ) {
        setStatus("ready");
      }
    } else {
      setSilentMessageCount(0);
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

  /* Always-on wake-word dispatch. Driven by the Web Speech API
   * listener and the keyboard-hotkey listener below. Local kinds
   * (disable, mute, unmute) update client state directly so the UI
   * responds instantly even mid-TTS. Server kinds (panic, end_session)
   * route through the daemon's `wake-command` WS message so the same
   * audit log + end-session pipeline that the transcript path runs
   * still fires. The daemon dedupes wake-command vs. the trailing
   * whisper transcript within a 1.5s window per kind; the client
   * keeps its own dedupe so the keyboard hotkey + Web Speech don't
   * double-dispatch the same intent in the same instant. */
  const wakeDedupeRef = useRef(createDedupe(1500));
  function dispatchWakeCommand(kind: VoiceCommandKind): void {
    /* Probe dedupe first WITHOUT mutating state so we can log
     * willDedupe=true for blocked invocations. shouldFire then runs
     * its real call below, which is the one that actually flips the
     * per-kind timestamp on a fire. */
    const fire = wakeDedupeRef.current.shouldFire(kind);
    logWake("dispatch", { kind, willDedupe: !fire });
    if (!fire) return;
    setLastWakeMatched(kind);
    switch (kind) {
      case "disable":
        setEnabled(false);
        return;
      case "mute":
        setSoftMuted(true);
        return;
      case "unmute":
        setSoftMuted(false);
        return;
      case "panic":
      case "end_session":
        sendJson({ t: "wake-command", kind });
        return;
    }
  }
  /* Ref so the Web Speech / hotkey effects can read the latest
   * dispatcher without having to be in the dependency list (which
   * would tear them down on every render). */
  const dispatchWakeCommandRef = useRef(dispatchWakeCommand);
  dispatchWakeCommandRef.current = dispatchWakeCommand;

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
    /* Stamp the frame arrival even before we decide whether to
     * schedule it. A late chunk from a barged-in stream still
     * proves the WS audio path is alive end-to-end. */
    lastFrameTsMsRef.current = Date.now();
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
    lastBufferProgressTsMsRef.current = Date.now();
    /* Track so resetTtsPlayback can stop everything on barge-in. Drop
     * the entry on natural end so the array doesn't grow unbounded. */
    activeSourcesRef.current.push(src);
    src.onended = () => {
      const idx = activeSourcesRef.current.indexOf(src);
      if (idx >= 0) activeSourcesRef.current.splice(idx, 1);
      lastBufferProgressTsMsRef.current = Date.now();
      /* Last scheduled buffer just left the speaker AND the server is
       * done streaming: only now is the mic gate safe to drop. */
      if (
        streamFinishedRef.current &&
        activeSourcesRef.current.length === 0
      ) {
        finalizePlaybackEnd();
      }
    };
  }

  /* Full audio-sink reset. Closes the current AudioContext, warms a
   * fresh one in the same window, and bumps the TTS generation so
   * any in-flight PCM frames land in the new context (or get dropped
   * by the gen guard if their parent reply was already cancelled).
   * This is the heal-step-2 path of the watchdog AND the click
   * handler for the "voice output dead" banner -- both must land
   * here so the operator's manual reset matches the auto-heal path
   * byte-for-byte. */
  function resetVoiceAudio(): void {
    const prev = audioCtxRef.current;
    if (prev && prev.state !== "closed") {
      try {
        void prev.close();
      } catch {
        /* ignore: context may already be closed by a peer reset */
      }
    }
    audioCtxRef.current = null;
    /* Bumping the gen counter discards any PCM frames still in the
     * WS receive buffer; they were destined for the old context's
     * playhead and would scratch into the fresh context if scheduled. */
    ttsGenRef.current += 1;
    activeSourcesRef.current = [];
    playheadRef.current = 0;
    streamFinishedRef.current = false;
    if (typeof window !== "undefined") {
      const win = window as unknown as {
        AudioContext?: typeof AudioContext;
        webkitAudioContext?: typeof AudioContext;
      };
      audioCtxRef.current = warmAudioContext({
        AudioContextCtor: win.AudioContext,
        WebkitAudioContextCtor: win.webkitAudioContext,
      });
    }
    /* Restart the stall clock from the moment the new sink came up
     * so the watchdog's next probe does not immediately re-flag the
     * buffer-stuck check against a zeroed timestamp. */
    lastBufferProgressTsMsRef.current = Date.now();
    logVoice(
      "settings-reset-on-reconnect",
      "voice watchdog reset audio sink",
      {
        prevState: prev?.state ?? null,
        newState: audioCtxRef.current?.state ?? null,
      },
    );
  }

  /* Voice-output watchdog. Polls the audio path every 10s while voice
   * is enabled, runs the pure-function check set, and either heals
   * locally (resume -> close+warm+reattach) or flips the dead banner
   * after two consecutive heal attempts both fail to clear the same
   * set of failing checks. Telemetry batches per tick to
   * /dashboard/voice-health so the operator gets a forensic trail
   * even when the heal worked silently. */
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let lastFailKinds: WatchdogCheckKind[] = [];
    let lastHealAttempt = 0;
    let consecutiveHealFailures = 0;
    let nextHealStep: 1 | 2 = 1;
    /* Fresh enable cycle: clear any stale banner so the user does
     * not see a dead-voice banner from a previous session. */
    setVoiceWatchdogDead(false);

    function runHealStep(step: 1 | 2): void {
      if (step === 1) {
        const ctx = audioCtxRef.current;
        if (ctx && ctx.state !== "running") {
          try {
            void ctx.resume().catch(() => undefined);
          } catch {
            /* resume can throw synchronously on a closed context */
          }
        }
        lastBufferProgressTsMsRef.current = Date.now();
      } else {
        resetVoiceAudio();
      }
    }

    const interval = setInterval(() => {
      if (cancelled) return;
      const now = Date.now();
      const ctx = audioCtxRef.current;
      const checks = runWatchdogChecks(
        {
          ctxState: ctx ? ctx.state : null,
          ttsActive: ttsActiveRef.current,
          lastFrameTsMs: lastFrameTsMsRef.current,
          activeBufferCount: activeSourcesRef.current.length,
          lastBufferProgressTsMs: lastBufferProgressTsMsRef.current,
        },
        now,
      );
      const fails = checks.filter((c) => !c.ok).map((c) => c.kind);
      const events: VoiceHealthEvent[] = [];

      if (fails.length === 0) {
        if (lastFailKinds.length > 0) {
          for (const k of lastFailKinds) {
            events.push({
              ts_ms: now,
              check_kind: k,
              status: "healed",
              heal_attempt: lastHealAttempt,
              recovered: 1,
            });
          }
          lastFailKinds = [];
          lastHealAttempt = 0;
          consecutiveHealFailures = 0;
          nextHealStep = 1;
          setVoiceWatchdogDead(false);
        }
      } else {
        const isRepeat = lastFailKinds.length > 0;
        if (isRepeat) {
          consecutiveHealFailures += 1;
          for (const k of fails) {
            events.push({
              ts_ms: now,
              check_kind: k,
              status: "heal_failed",
              heal_attempt: lastHealAttempt,
              recovered: 0,
            });
          }
          if (consecutiveHealFailures >= 2) {
            setVoiceWatchdogDead(true);
          }
        } else {
          for (const k of fails) {
            events.push({
              ts_ms: now,
              check_kind: k,
              status: "fail",
              heal_attempt: 0,
              recovered: 0,
            });
          }
        }
        if (consecutiveHealFailures < 2) {
          runHealStep(nextHealStep);
          lastHealAttempt = nextHealStep;
          nextHealStep = 2;
        }
        lastFailKinds = fails;
      }

      void postVoiceHealth(events);
    }, 10_000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [enabled]);

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
        if (
          typeof j.vad_redemption_ms === "number" &&
          Number.isFinite(j.vad_redemption_ms)
        ) {
          const clamped = Math.max(
            VAD_REDEMPTION_MIN,
            Math.min(VAD_REDEMPTION_MAX, j.vad_redemption_ms),
          );
          setVadRedemptionMs(clamped);
          if (typeof window !== "undefined") {
            window.localStorage.setItem(
              VAD_REDEMPTION_STORAGE_KEY,
              String(clamped),
            );
          }
        }
      })
      .catch(() => undefined);
  }, []);

  /* Listen for slider updates from VoiceSettingsPanel (/settings route).
   * The settings panel and the engine are separate components: the
   * engine is mounted once at app/providers root and persists across
   * navigation, so its piper-status seed at mount is the only value it
   * had until this subscription was added. The settings panel emits
   * after persisting to the daemon; the engine mirrors the value into
   * its own React state, which the refs (micGainRef, vadSensitivityRef,
   * etc.) pick up on the next render so the live capture path uses the
   * fresh value. Gain applies immediately. VAD threshold / redemption
   * only take effect on the next VAD start (silero ignores live
   * threshold updates, documented elsewhere). */
  useEffect(() => {
    const unsubscribe = onVoiceSettingUpdate((u) => {
      switch (u.key) {
        case "mic_gain":
          if (typeof u.value === "number" && Number.isFinite(u.value)) {
            setMicGain(
              Math.max(MIC_GAIN_MIN, Math.min(MIC_GAIN_MAX, u.value)),
            );
          }
          break;
        case "vad_sensitivity":
          if (typeof u.value === "number" && Number.isFinite(u.value)) {
            setVadSensitivity(
              Math.max(
                VAD_SENSITIVITY_MIN,
                Math.min(VAD_SENSITIVITY_MAX, u.value),
              ),
            );
          }
          break;
        case "barge_cooldown_ms":
          if (typeof u.value === "number" && Number.isFinite(u.value)) {
            setBargeCooldownMs(
              Math.max(BARGE_MIN, Math.min(BARGE_MAX, u.value)),
            );
          }
          break;
        case "vad_redemption_ms":
          if (typeof u.value === "number" && Number.isFinite(u.value)) {
            setVadRedemptionMs(
              Math.max(
                VAD_REDEMPTION_MIN,
                Math.min(VAD_REDEMPTION_MAX, u.value),
              ),
            );
          }
          break;
        case "speed":
          if (typeof u.value === "number" && Number.isFinite(u.value)) {
            setSpeed(Math.max(SPEED_MIN, Math.min(SPEED_MAX, u.value)));
          }
          break;
        case "active_voice":
          if (typeof u.value === "string") {
            setActiveVoiceState(u.value);
          }
          break;
      }
    });
    return unsubscribe;
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


  /* User-tunable end-of-utterance redemption window. Updates
   * localStorage immediately for cheap optimistic UI; debounced
   * server write so dragging the slider doesn't fire 20 POSTs.
   * silero VAD does not accept live updates, so the user must
   * toggle voice off then on for a new value to take effect; the
   * slider tooltip mentions this. */
  function changeVadRedemption(next: number): void {
    const clamped = Math.max(
      VAD_REDEMPTION_MIN,
      Math.min(VAD_REDEMPTION_MAX, next),
    );
    setVadRedemptionMs(clamped);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(VAD_REDEMPTION_STORAGE_KEY, String(clamped));
    }
    if (vadRedemptionSaveTimerRef.current) {
      clearTimeout(vadRedemptionSaveTimerRef.current);
    }
    vadRedemptionSaveTimerRef.current = setTimeout(() => {
      void fetch("/voice/set-vad-redemption", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ ms: clamped }),
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

  useEffect(() => {
    /* Tear down every resource the effect owns. Idempotent: safe to
     * call from the !enabled branch, from React's cleanup phase on
     * deps change (e.g. mode flip from conversation to push-to-talk),
     * or twice in a row. Centralised so the mode-swap path can't leak
     * the prior VAD / MediaStream / WS. A previous shape only torn
     * down on the !enabled flip, which meant switching to PTT mid-
     * session left the conversation-mode VAD live and firing
     * transcripts without the talk key held. */
    function teardown(): void {
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
      /* Disable + restart OOM fix: vad.destroy() terminates ORT's
       * threaded-backend worker pool, but the singleton
       * getVadModule cache still reports configured=true and would
       * hand the next MicVAD.new a half-disposed env. Reset the
       * cache so the next enable cycle re-imports + re-pins
       * cleanly. Tab-switch remount (component unmount with
       * enabled stays true) goes through a different path that
       * never reaches this teardown, so the singleton warm-path
       * stays intact for that case. */
      resetVadModuleCache();
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
      if (utteranceTimerRef.current) {
        clearInterval(utteranceTimerRef.current);
        utteranceTimerRef.current = null;
      }
      if (utteranceCapRef.current) {
        clearTimeout(utteranceCapRef.current);
        utteranceCapRef.current = null;
      }
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

    if (!enabled) {
      teardown();
      setStatus("idle");
      return;
    }

    let cancelled = false;
    let reconnectAttempts = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    setStatus("connecting");
    setErrMsg("");
    logVoice("engine-enable", "voice engine effect entering connect path");

    (async () => {
      /* Open WS first so we can ack-bind before mic touches the user.
       * Wrapped in a connectWs() closure so the onclose handler can
       * re-invoke it for auto-reconnect with exponential backoff.
       * Without this, a transient daemon restart or a bridge bounce
       * left the WS dead and the only path back to live voice was
       * the user clicking 'start voice' again -- the central
       * complaint of the 2026-05-15 voice-loop-restart escalation. */
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${proto}//${window.location.host}/voice/lex-ws`;
      const scheduleReconnect = (reason: string): void => {
        if (cancelled) return;
        if (!hasLexRef.current) {
          /* Lex is gone; let the auto-stop effect flip enabled off. */
          return;
        }
        if (reconnectTimer) clearTimeout(reconnectTimer);
        const delay = computeReconnectBackoffMs(reconnectAttempts);
        reconnectAttempts += 1;
        logVoice("ws-reconnect-scheduled", reason, {
          attempt: reconnectAttempts,
          delay_ms: delay,
        });
        setStatus("connecting");
        setErrMsg(
          `voice connection lost (${reason}); reconnecting in ${Math.round(delay / 1000)}s…`,
        );
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          if (cancelled) return;
          if (!hasLexRef.current) return;
          connectWs();
        }, delay);
      };
      const connectWs = (): void => {
        if (cancelled) return;
        const ws = new WebSocket(wsUrl);
        ws.binaryType = "arraybuffer";
        wsRef.current = ws;

        ws.onopen = () => {
          const wasReconnect = reconnectAttempts > 0;
          reconnectAttempts = 0;
          logVoice("ws-open", "voice ws connected", { reconnect: wasReconnect });
          /* Brainstorm-as-durable-primary-entity (2026-05-22, Path B).
           * If the URL carries ?brainstorm=<id>, prefer it over the
           * legacy lexPty session id. The daemon's bindByBrainstorm
           * resolves runtime_mode and either runs the direct-llm
           * path or falls through to legacy bind() via the brainstorm's
           * claude_session_id. */
          const brainstormIdFromUrl =
            typeof window !== "undefined"
              ? new URL(window.location.href).searchParams.get("brainstorm")
              : null;
          sendJson({
            t: "hello",
            ...(brainstormIdFromUrl
              ? { brainstorm_id: brainstormIdFromUrl }
              : { session_id: sessionId ?? undefined }),
            mode: modeRef.current,
          });
          if (wasReconnect) {
            /* Daemon restart breaks voice: on reconnect the WS re-binds
             * but every cached voice setting (mic gain, VAD threshold,
             * barge cooldown, voice/speed) has to be re-pushed from
             * disk through the bus, otherwise the capture path keeps
             * running on the pre-restart values it cached at mount.
             * Re-fetch /voice/piper-status and broadcast the same
             * voice-settings-bus updates the SettingsPanel emits on a
             * slider change. No modal: one transient toast confirms
             * the silent re-sync. */
            void (async () => {
              try {
                const r = await fetch("/voice/piper-status", {
                  credentials: "include",
                });
                if (!r.ok) return;
                const j = (await r.json()) as {
                  active_voice?: unknown;
                  speed?: unknown;
                  barge_cooldown_ms?: unknown;
                  vad_sensitivity?: unknown;
                  vad_redemption_ms?: unknown;
                  mic_gain?: unknown;
                };
                if (typeof j.active_voice === "string" && j.active_voice) {
                  emitVoiceSettingUpdate({
                    key: "active_voice",
                    value: j.active_voice,
                  });
                }
                if (typeof j.speed === "number" && Number.isFinite(j.speed)) {
                  emitVoiceSettingUpdate({ key: "speed", value: j.speed });
                }
                if (
                  typeof j.barge_cooldown_ms === "number" &&
                  Number.isFinite(j.barge_cooldown_ms)
                ) {
                  emitVoiceSettingUpdate({
                    key: "barge_cooldown_ms",
                    value: j.barge_cooldown_ms,
                  });
                }
                if (
                  typeof j.vad_sensitivity === "number" &&
                  Number.isFinite(j.vad_sensitivity)
                ) {
                  emitVoiceSettingUpdate({
                    key: "vad_sensitivity",
                    value: j.vad_sensitivity,
                  });
                }
                if (
                  typeof j.vad_redemption_ms === "number" &&
                  Number.isFinite(j.vad_redemption_ms)
                ) {
                  emitVoiceSettingUpdate({
                    key: "vad_redemption_ms",
                    value: j.vad_redemption_ms,
                  });
                }
                if (
                  typeof j.mic_gain === "number" &&
                  Number.isFinite(j.mic_gain)
                ) {
                  emitVoiceSettingUpdate({
                    key: "mic_gain",
                    value: j.mic_gain,
                  });
                }
                logVoice(
                  "settings-reset-on-reconnect",
                  "voice settings re-synced after daemon reconnect",
                );
                showInfoToast("voice settings re-synced after daemon restart");
              } catch (err) {
                logVoice(
                  "settings-reset-on-reconnect-failed",
                  (err as Error).message,
                  undefined,
                  "warn",
                );
              }
            })();
          }
        };
        ws.onclose = (ev) => {
          if (cancelled) return;
          /* If the close happened because Lex itself was just ended,
           * the auto-stop effect is already on its way to flipping
           * `enabled` off. Don't surface a noisy ERROR pill in that
           * window — the user explicitly asked for the session to
           * end, so this close is expected. */
          if (!hasLexRef.current) {
            logVoice("ws-close", "lex ended; not reconnecting", {
              code: ev.code,
              reason: ev.reason,
            });
            setStatus("idle");
            setErrMsg("");
            return;
          }
          logVoice(
            "ws-close",
            "voice ws closed unexpectedly",
            { code: ev.code, reason: ev.reason },
            "warn",
          );
          /* Give the auto-reconnect path a finite number of tries
           * before surfacing a hard error. The schedule caps at 30s,
           * so 8 attempts cover ~2 minutes of outage -- past that
           * something is wrong upstream and the user should see the
           * error pill. */
          if (reconnectAttempts >= 8) {
            logVoice(
              "ws-reconnect-giveup",
              "exceeded max reconnect attempts; giving up",
              { attempts: reconnectAttempts },
              "error",
            );
            setStatus("error");
            setErrMsg("voice connection lost; tap stop + start to retry");
            return;
          }
          scheduleReconnect(`code=${ev.code}`);
        };
        ws.onerror = () => {
          logVoice("ws-error", "voice ws error event", undefined, "error");
          /* Don't trip the error pill yet -- onclose almost always
           * follows onerror and the reconnect path handles it. */
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
      };
      /* Kick off the initial connection. Subsequent reconnects fire
       * through scheduleReconnect() above. */
      connectWs();

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
            if (text) {
              setStatus("thinking");
              const turnId = `u-${Date.now()}-${Math.random()
                .toString(36)
                .slice(2, 8)}`;
              setTurns((prev) => {
                const next = [
                  ...prev,
                  {
                    id: turnId,
                    role: "user" as const,
                    text,
                  },
                ];
                return next.length > TURNS_BUFFER_CAP
                  ? next.slice(next.length - TURNS_BUFFER_CAP)
                  : next;
              });
              /* Push to the transcript bus so the dedicated panel
               * surfaces the line without waiting on the VoiceCtx
               * re-render chain. The panel maintains its own list
               * fed by these events. */
              emitTranscriptTurn({ id: turnId, role: "user", text });
            } else setStatus("ready");
            break;
          }
          case "injected":
            setStatus("thinking");
            break;
          case "assistant-text": {
            const replyText = String(msg.text ?? "");
            const tid = typeof msg.turn_id === "string" ? msg.turn_id : "";
            const pv = typeof msg.prompt_version === "string" ? msg.prompt_version : "";
            const bid = typeof msg.brainstorm_id === "string" ? msg.brainstorm_id : null;
            if (tid && pv) {
              setLastTurn({ turn_id: tid, prompt_version: pv, brainstorm_id: bid });
            }
            if (replyText) {
              const turnId =
                tid ||
                `a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
              /* Soft mute tag: capture the flag at the moment the
               * turn lands so a later unmute doesn't retroactively
               * un-flag a turn the user never heard. */
              const silentNow = softMutedRef.current;
              setTurns((prev) => {
                const next = [
                  ...prev,
                  {
                    id: turnId,
                    role: "assistant" as const,
                    text: replyText,
                    silent: silentNow ? true : undefined,
                  },
                ];
                return next.length > TURNS_BUFFER_CAP
                  ? next.slice(next.length - TURNS_BUFFER_CAP)
                  : next;
              });
              if (silentNow) {
                setSilentMessageCount((c) => c + 1);
              }
              emitTranscriptTurn({
                id: turnId,
                role: "assistant",
                text: replyText,
              });
            }
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
          }
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
            /* Soft mute: drop the entire audio path on the floor.
             * The PCM chunks that follow are gated by speakingRef in
             * the binary handler, so leaving speakingRef false here
             * silently discards them. The chat scroll keeps updating
             * via assistant-text frames so the user can still read
             * along. */
            if (softMutedRef.current) {
              break;
            }
            const rate = Number(msg.rate) || 22050;
            ttsRateRef.current = rate;
            /* AudioContext is warmed inside the toggleEnabled() click
             * handler (a user gesture), not here. Lazy-creating in
             * this network callback used to ship a context iOS
             * Safari refused to start, silencing the first reply.
             * The ref should be live by the time we land here; if
             * for any reason it is not (teardown raced ahead of a
             * late tts-start) we skip the audio path rather than
             * fabricate a broken context. */
            /* Chrome / Safari suspend the AudioContext when the tab
             * loses focus. Resume defensively on every tts-start so
             * the scheduled buffers actually play. */
            const ctx = audioCtxRef.current;
            if (ctx && ctx.state === "suspended") {
              void ctx.resume().catch(() => undefined);
            }
            playheadRef.current = ctx?.currentTime ?? 0;
            speakingRef.current = true;
            /* Fresh reply: reset the server-finished flag so an
             * onended for THIS reply only finalises after this reply's
             * own tts-end has landed. */
            streamFinishedRef.current = false;
            /* Watchdog gates: a TTS request is now in flight, and the
             * buffer-progress clock restarts from this instant so the
             * stall check has a fair baseline before any frames land. */
            ttsActiveRef.current = true;
            lastBufferProgressTsMsRef.current = Date.now();
            /* Stamp the moment audio actually started flowing so the
             * VAD barge-in handler can swallow self-echo within the
             * configured cooldown window. */
            lastTtsStartAtRef.current = Date.now();
            setStatus("speaking");
            /* Keep micGated as a UI signal (TopBar mic-icon flips
             * to MicOff during playback) and disarm the parallel
             * capture rig so a mute-finalize during TTS does not
             * ship Lex's own audio. VAD itself stays live (path 1
             * of the voice-cmd-blocked-during-TTS audit) so the
             * wake matcher can catch interrupt commands mid-reply.
             * AEC on the parallel-capture stream + the daemon-side
             * `utteranceStartedDuringTts` gate keep AEC residual
             * out of the inject path. */
            micGatedRef.current = true;
            setMicGated(true);
            captureCapturingRef.current = false;
            captureBufRef.current = [];
            break;
          }
          case "tts-end": {
            /* Server has flushed the last PCM chunk for this reply.
             * That can land seconds before the AudioContext has played
             * the buffered tail (the client schedules audio ahead of
             * the playhead). Mark the stream finished; the actual gate
             * drop happens in finalizePlaybackEnd, called either now
             * (if no buffers remain) or by the last src.onended. */
            streamFinishedRef.current = true;
            if (activeSourcesRef.current.length === 0) {
              finalizePlaybackEnd();
            }
            break;
          }
          case "tts-cancel": {
            /* Daemon-enforced barge-in floor (2026-05-22). The voice
             * WS killed an in-flight TTS stream because a client
             * utterance-start (or legacy barge-in) frame landed. The
             * daemon already stopped piper, dropped tail PCM frames,
             * and sent a Ctrl+C to the bound worker; the client now
             * just has to tear down playback. resetTtsPlayback bumps
             * ttsGenRef so any chunks still in flight on the
             * WebSocket get discarded, stops every active
             * AudioBufferSourceNode, drops the mic gate, and clears
             * ttsActiveRef so the watchdog stops reading a stale
             * playing state. Idempotent if barge-in already triggered
             * the same teardown locally. */
            resetTtsPlayback();
            break;
          }
          case "session-end":
            /* Server-side intent match on the transcript flagged the
             * spoken "lex end session" command. Tear down the same
             * way the Stop button does in conversation mode: flip
             * enabled off and the [enabled] effect closes the WS,
             * mic, audio context, and clears localStorage so the
             * next mount stays idle. */
            setEnabled(false);
            break;
          case "voice-disable":
            /* "lex disable" voice command. Equivalent to clicking
             * the dashboard stop button: stop voice entirely. The
             * [enabled] effect cancels in-flight TTS, clears any
             * queued audio, and shuts the WS + mic + AudioContext
             * down. Lex's thinking + worker actions both keep
             * running on the daemon side; there is no voice resume
             * path other than the user clicking start again. */
            setEnabled(false);
            break;
          case "voice-mute":
            /* "lex mute" family. Soft mute: cancel current TTS
             * playback, drop queued chunks (handled inside
             * setSoftMuted via resetTtsPlayback), keep the WS open
             * so transcript turns continue rendering with a silent
             * marker. Mic capture is NOT touched - the user can
             * keep talking AND the wake-word recognizer can still
             * hear the unmute command. */
            logVoice("wake-fire", "soft-mute (TTS halted; mic untouched)", {
              kind: "mute",
              pre_softMuted: softMutedRef.current,
              post_softMuted: true,
            });
            setSoftMuted(true);
            break;
          case "voice-unmute":
            /* "lex unmute" voice command (and synonyms: resume,
             * come back, you can talk, start talking again). Lift
             * the soft mute and clear the unread-silent badge.
             * Future TTS plays normally; messages received during
             * the mute window are NOT auto-replayed. The setSoft
             * Muted setter (line 980) flips softMutedRef and the
             * sample-rate-locked Web Audio output path picks up
             * fresh chunks on the next tts-start frame, so the
             * next assistant turn plays audibly without requiring
             * a stop+start cycle. */
            logVoice("wake-fire", "soft-unmute (TTS resumes)", {
              kind: "unmute",
              pre_softMuted: softMutedRef.current,
              post_softMuted: false,
            });
            setSoftMuted(false);
            break;
          case "voice-standby":
            /* "lex stand by" family. Soft mic pause: halt STT
             * capture but leave TTS state and the wake-word
             * recognizer alone so the user can rearm with
             * `lex listen`. Mic is muted via the same setMicMuted
             * path the mic-pill click uses; the wake recognizer
             * runs off its own Web Speech stream and is unaffected. */
            logVoice("wake-fire", "standby (mic paused; TTS + wake untouched)", {
              kind: "standby",
              pre_muted: mutedRef.current,
              post_muted: true,
            });
            setMicMuted(true);
            break;
          case "voice-listen":
            /* "lex listen" family. Rearm STT capture after a
             * standby. Wake recognizer is already running; TTS is
             * independent of this path. */
            logVoice("wake-fire", "listen (mic rearmed)", {
              kind: "listen",
              pre_muted: mutedRef.current,
              post_muted: false,
            });
            setMicMuted(false);
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
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            },
          });
          if (cancelled) {
            stream.getTracks().forEach((t) => t.stop());
            return;
          }
          captureStreamRef.current = stream;
          /* First-grant gate for the wake-word recognizer. The
           * getUserMedia returned a stream which means the user
           * granted (or auto-allowed) microphone access; flag this
           * synchronously so the wake-word useEffect can start the
           * Web Speech recognizer without racing a parallel
           * permission prompt. */
          setMicPermissionGranted(true);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const Cls: any =
            (window as unknown as { AudioContext?: typeof AudioContext })
              .AudioContext ??
            (window as unknown as { webkitAudioContext?: typeof AudioContext })
              .webkitAudioContext;
          const ctx = new Cls({ sampleRate: 16000 });
          captureCtxRef.current = ctx;
          const src = ctx.createMediaStreamSource(stream);
          /* AudioWorklet replaces the deprecated ScriptProcessorNode
           * (bug 2026-05-14-vad-scriptprocessornode-deprecation). The
           * worklet module posts Float32 mono frames over its port;
           * gain + Int16 conversion stays on the main thread so the
           * downstream consumer (captureBufRef) is byte-for-byte
           * equivalent to the prior onaudioprocess callback. */
          await ctx.audioWorklet.addModule("/vad-tap.worklet.js");
          if (cancelled) {
            stream.getTracks().forEach((t) => t.stop());
            try {
              await ctx.close();
            } catch {
              /* ignore */
            }
            return;
          }
          const proc = new AudioWorkletNode(ctx, "vad-tap");
          captureProcRef.current = proc;
          proc.port.onmessage = (ev: MessageEvent<Float32Array>) => {
            if (!captureCapturingRef.current) return;
            /* Drop frames while the TTS gate is active. tts-start
             * already disarmed captureCapturingRef but a buffer
             * that landed mid-flip would still push into
             * captureBufRef without this check. */
            if (micGatedRef.current) return;
            const f = ev.data;
            if (!f || f.length === 0) return;
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
          /* Singleton load: getVadModule caches the dynamic import +
           * the configureVadOrt pin, so VoiceClient remount (page
           * nav, mic-mode toggle, dev HMR) reuses the ORT module
           * record instead of forcing a fresh WASM
           * compile/instantiate cycle. The previous behavior re-ran
           * configureVadOrt on every mount; with the threaded WASM
           * build the second remount would OOM the per-tab heap.
           * See lib/voice-ort-config.ts. */
          const mod = await getVadModule();
          if (cancelled) return;
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
              /* No more micGated early-return here. Path 1 of the
               * voice-cmd-blocked-during-TTS audit: VAD stays live
               * during TTS so the wake matcher can catch "Lex
               * disable" / "Lex shut up" mid-reply. The daemon
               * gates the inject on its end so AEC residual that
               * gets transcribed but does not match a wake phrase
               * never lands as a phantom user turn (see
               * `state.utteranceStartedDuringTts` in
               * lex-voice-ws.ts). The barge-in path below still
               * cancels the in-flight TTS playback so the user is
               * heard immediately. */
              /* Hardened barge trigger (2026-05-22): trip on EITHER
               * speakingRef (set when first PCM chunk arrives) OR
               * ttsActiveRef (set on tts-start, earlier in the
               * pipeline). The gap between the two flags is where
               * the old code could miss a barge: tts-start has
               * fired daemon-side, the mic is gated, the user
               * begins speaking, but speakingRef has not flipped
               * yet because no PCM chunk has landed locally. The
               * daemon-side floor (utterance-start unconditionally
               * kills TTS) covers the worst case; this client-side
               * harden keeps the visual + audio teardown tight. */
              if (speakingRef.current || ttsActiveRef.current) {
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
                /* Barge-in: stop Lex, start a fresh utterance. The
                 * explicit barge-in frame is kept for daemon-side
                 * audit clarity, but the daemon will also kill on
                 * the trailing utterance-start regardless. */
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
              /* Arm rolling probability window for stuck-open
               * recovery. Cleared on every open so the previous
               * utterance's frames can't trip an early close on
               * this one. */
              vadListenerOpenRef.current = true;
              probWindowRef.current = [];
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
               * chance to respond.
               *
               * 2026-05-22: cap path now ships the parallel capture
               * buffer via flushParallelCapture so a long-form
               * utterance is delivered to STT even when the cap
               * trips. The legacy behavior dropped audio and forced
               * the user to repeat themselves; we trust STT for long
               * audio instead. */
              utteranceCapRef.current = setTimeout(() => {
                if (vadInstance && typeof vadInstance.pause === "function") {
                  vadInstance.pause();
                  vadListenerOpenRef.current = false;
                  probWindowRef.current = [];
                  const shipped = flushParallelCapture();
                  if (!shipped) {
                    /* No buffered audio (parallel capture was off or
                     * empty). Send utterance-end so the server does
                     * not think we are hanging, even though the cap
                     * fire produced nothing transcribable. */
                    sendJson({ t: "utterance-end" });
                    setStatus("transcribing");
                  }
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
              vadListenerOpenRef.current = false;
              probWindowRef.current = [];
              if (mutedRef.current) return;
              finalizeUtterance(audio);
            },
            /* Stuck-open recovery. Silero invokes this on every
             * 32ms frame whether or not speech is currently open;
             * we only accumulate while the listener is open. If
             * the rolling average isSpeech probability stays below
             * VAD_PROB_FLOOR across the full VAD_PROB_WINDOW_MS,
             * force the listener closed locally and recycle VAD so
             * the next real utterance starts clean. We deliberately
             * do NOT ship audio or send utterance-end here: the
             * daemon's micBuf hasn't received any binary frames yet
             * (those only flow on the real end-of-utterance path),
             * so simply dropping the in-progress utterance leaves
             * the daemon in a consistent state for the next
             * utterance-start. */
            onFrameProcessed: (probs: {
              isSpeech: number;
              notSpeech: number;
            }) => {
              if (!vadListenerOpenRef.current) return;
              const now = Date.now();
              const w = probWindowRef.current;
              w.push({ t: now, p: probs.isSpeech });
              while (w.length > 0 && now - w[0]!.t > VAD_PROB_WINDOW_MS) {
                w.shift();
              }
              /* Require a full window before evaluating so the first
               * 1.5s of an utterance can't trip the floor before
               * we've actually heard the speaker. */
              if (w.length === 0) return;
              if (now - w[0]!.t < VAD_PROB_WINDOW_MS - SILERO_FRAME_MS) {
                return;
              }
              let sum = 0;
              for (const x of w) sum += x.p;
              const avg = sum / w.length;
              if (avg >= VAD_PROB_FLOOR) return;
              vadListenerOpenRef.current = false;
              probWindowRef.current = [];
              captureCapturingRef.current = false;
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
              try {
                vadInstance?.pause?.();
              } catch {
                /* ignore */
              }
              setStatus((cur) =>
                cur === "listening" || cur === "transcribing" ? "ready" : cur,
              );
              setTimeout(() => {
                try {
                  vadInstance?.start?.();
                } catch {
                  /* ignore */
                }
              }, 250);
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
            redemptionFrames: Math.max(
              1,
              Math.round(vadRedemptionRef.current / SILERO_FRAME_MS),
            ),
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
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            },
          });
          /* Hold the mic in a disabled state until the user actually
           * presses talk. getUserMedia activates the OS mic indicator
           * the moment the stream is granted; flipping enabled=false
           * on every track immediately dims that indicator on
           * Chromium/Edge/Firefox and stops the underlying media flow.
           * __pttStart re-enables before reading frames. */
          pttStream.getAudioTracks().forEach((t) => {
            t.enabled = false;
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
            /* TTS gate also applies to push-to-talk: holding the
             * talk button while Lex is speaking should not capture
             * her audio. The user can still barge in by releasing
             * the button and pressing again after tts-end. */
            if (micGatedRef.current) return;
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
        /* Re-enable the mic tracks before the first onaudioprocess
         * tick lands. Was set to enabled=false at init + on every
         * release so the OS mic indicator is dark between presses. */
        pttStream?.getAudioTracks().forEach((t) => {
          t.enabled = true;
        });
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
        /* Disable the mic tracks the moment the user releases so the
         * OS mic indicator goes dark and the underlying media flow
         * stops. Stream + AudioContext stay alive so the next press
         * has no re-grant latency. */
        pttStream?.getAudioTracks().forEach((t) => {
          t.enabled = false;
        });
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
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      logVoice("engine-disable", "voice engine effect cleanup");
      teardown();
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
    /* Idempotency guard against rapid double-clicks. The enable
     * effect kicks off async getUserMedia + MicVAD.new + WS connect;
     * a second click landing before any of that resolves used to
     * stack a teardown on top of an unfinished init which read to
     * the user as "first click was lost, mash the button again". A
     * 400ms cooldown after every flip keeps the state machine clean
     * without throttling intentional single clicks. */
    const now = Date.now();
    if (now < enableBusyUntilRef.current) return;
    enableBusyUntilRef.current = now + 400;
    if (!enabled) {
      /* Warm the AudioContext INSIDE this user-gesture handler. iOS
       * Safari refuses to start the audio clock on a context that
       * was created from a network callback (the tts-start WS
       * message used to do this), so the first reply's PCM chunks
       * were silently dropped. Calling warmAudioContext here commits
       * the gesture; by the time tts-start lands the context is
       * already running and chunks schedule on time. Idempotent;
       * the [enabled] teardown nulls the ref before any second
       * enable. */
      if (!audioCtxRef.current) {
        const win = window as unknown as {
          AudioContext?: typeof AudioContext;
          webkitAudioContext?: typeof AudioContext;
        };
        audioCtxRef.current = warmAudioContext({
          AudioContextCtor: win.AudioContext,
          WebkitAudioContextCtor: win.webkitAudioContext,
        });
      }
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

  const fullPanel = (
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
      <div className="px-5 py-3 border-b border-border1 flex items-center gap-3">
        <label
          className="flex items-center gap-2 text-nano font-mono text-txt3 flex-1"
          title="Pause tolerance after you stop talking before Lex starts thinking. Higher = more time to breathe mid-sentence without losing words. Takes effect on the next voice off / on cycle."
        >
          <span>pause tolerance</span>
          <input
            type="range"
            min={VAD_REDEMPTION_MIN}
            max={VAD_REDEMPTION_MAX}
            step={50}
            value={vadRedemptionMs}
            onChange={(e) => changeVadRedemption(Number(e.target.value))}
            className="flex-1 accent-brandSoft"
          />
          <span className="text-txt2 tabular-nums w-14 text-right">
            {(vadRedemptionMs / 1000).toFixed(2)}s
          </span>
        </label>
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
      {infoMsg && (
        <div
          className="px-5 py-2 text-xs text-txt2 bg-brand/10 ring-1 ring-brand/20 mx-5 mt-3 rounded-card"
          role="status"
          aria-live="polite"
        >
          {infoMsg}
        </div>
      )}
      {(lastTurn || errMsg) && (
        <div className="px-5 py-3 flex items-start gap-3 text-xs">
          {errMsg && (
            /* Multi-line errors (notably the ORT WASM cascade) must
             * render in full so the operator can read the real
             * failure instead of guessing from a truncated suffix.
             * VoiceErrorPill drops the `truncate` class and wraps
             * via whitespace-pre-wrap + break-words. Retry path
             * does an in-place reset: clear errMsg, flip enabled
             * off so the [enabled] cleanup runs (which now resets
             * the VAD module singleton cache), then flip on after
             * a microtask so a fresh init re-imports vad-web and
             * re-pins ORT. The previous window.location.reload()
             * shortcut leaked SAB-backed WebAssembly.Memory across
             * the reload on Windows Chromium (Chromium accounts
             * SAB commits per renderer process, not per document),
             * so the post-reload init landed on a memory budget
             * that already had the prior session's pages
             * committed and OOM'd again. */
            <VoiceErrorPill
              message={errMsg}
              onRetry={() => {
                setErrMsg("");
                setEnabled(false);
                setTimeout(() => setEnabled(true), 0);
              }}
            />
          )}
          {lastTurn && (
            <div className="ml-auto flex items-center gap-2">
              <span className="text-nano text-txt3 font-mono">
                rate last reply
              </span>
              <LexThumbs
                turn_id={lastTurn.turn_id}
                prompt_version={lastTurn.prompt_version}
                brainstorm_id={lastTurn.brainstorm_id}
              />
            </div>
          )}
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

  /* Wrap children in a VoiceCtx provider so UI islands outside this
   * component (TopBar mic pill, future badges) can read live status
   * and call toggleEnabled / setMicMuted without prop drilling. The
   * full panel UI portals into the /lex route's mount target; on
   * every other route the TopBar's <VoiceTopBarPill /> consumes the
   * same context and renders an inline status + mute + stop. */
  const ctxValue: VoiceCtxValue = {
    status,
    enabled,
    muted,
    micGated,
    turns,
    hasLex,
    softMuted,
    silentMessageCount,
    wakeWordActive,
    lastWakeMatched,
    lastWakeError,
    speed,
    speedMin: SPEED_MIN,
    speedMax: SPEED_MAX,
    speedStep: SPEED_STEP,
    setSpeed: changeSpeed,
    toggleEnabled,
    setMicMuted,
    setSoftMuted,
  };
  /* Dead-voice banner. The watchdog flips this true after two
   * consecutive heal attempts both fail to clear a failing check.
   * Mount via a body-level portal so the banner stays on top of
   * any dashboard route the user happens to be on when voice dies,
   * not just /lex. The click handler fires resetVoiceAudio (same
   * path as heal-step-2) so manual reset is byte-for-byte
   * equivalent to what the watchdog already tried. */
  const watchdogBanner =
    voiceWatchdogDead && typeof document !== "undefined"
      ? createPortal(
          <button
            type="button"
            onClick={() => {
              resetVoiceAudio();
              setVoiceWatchdogDead(false);
            }}
            className="fixed top-0 inset-x-0 z-[100] w-full bg-err/90 text-white text-sm font-emphasized px-4 py-2 hover:bg-err transition-colors shadow-lg cursor-pointer text-left"
            aria-label="Voice output dead, click to reset"
            title="Click to close and reopen the audio sink. Same path the watchdog already tried twice."
          >
            voice output dead, click to reset
          </button>,
          document.body,
        )
      : null;
  return (
    <VoiceCtx.Provider value={ctxValue}>
      {children}
      {watchdogBanner}
      {mountEl ? createPortal(fullPanel, mountEl) : null}
    </VoiceCtx.Provider>
  );
}

/* Presentational pill body, split out from VoiceTopBarPill so tests
 * can drive it with synthetic state without standing up the WS + VAD
 * machinery the engine owns. Two-row layout:
 *   ROW 1: "Voice" label, speed slider with N.NNx readout, mic mute,
 *          speaker mute, stop button.
 *   ROW 2: status text on its own line, left-aligned, dim.
 * The stop button anchors row 1 and the status moved to row 2 so a
 * long status string ("LEX THINKING") can never push the stop
 * affordance off-screen on narrow viewports (verified down to the
 * ~390px iPhone width). Row 2 wraps inside its own container; the
 * pill height grows with content rather than overflowing row 1. */
export interface VoicePillViewProps {
  status: VoiceCtxValue["status"];
  enabled: boolean;
  muted: boolean;
  micGated: boolean;
  softMuted: boolean;
  silentMessageCount: number;
  /** True while the always-on wake-word recognizer is live. Drives a
   * small "wake" indicator so the user can confirm Lex commands
   * still listen even when the foreground mic is micGated. */
  wakeWordActive?: boolean;
  /** Dev-only debug surface for the wake-word path. Rendered as a
   * tiny badge inside row 2 when LEX_DEBUG_VOICE is set; never
   * rendered otherwise. */
  lastWakeMatched?: VoiceCommandKind | null;
  lastWakeError?: string | null;
  /** Current Lex speech-rate multiplier; rendered as the slider
   * thumb position and the inline N.NNx readout. */
  speed?: number;
  speedMin?: number;
  speedMax?: number;
  speedStep?: number;
  setSpeed?: (next: number) => void;
  toggleEnabled: () => void;
  setMicMuted: (next: boolean) => void;
  setSoftMuted: (next: boolean) => void;
}

export function VoicePillView(props: VoicePillViewProps): React.ReactElement {
  const {
    status,
    enabled,
    muted,
    micGated,
    softMuted,
    silentMessageCount,
    wakeWordActive,
    lastWakeMatched,
    lastWakeError,
    speed,
    speedMin,
    speedMax,
    speedStep,
    setSpeed,
    toggleEnabled,
    setMicMuted,
    setSoftMuted,
  } = props;
  /* Speed slider defaults so test renders that omit the speed wiring
   * still get a sensible thumb position. Production always threads
   * the full set through VoiceTopBarPill / VoiceCtx. */
  const sliderEnabled = typeof setSpeed === "function";
  const sliderValue = typeof speed === "number" ? speed : 1;
  const sliderMin = typeof speedMin === "number" ? speedMin : 0.5;
  const sliderMax = typeof speedMax === "number" ? speedMax : 1.5;
  const sliderStep = typeof speedStep === "number" ? speedStep : 0.05;
  const statusTone =
    status === "error"
      ? "text-err"
      : status === "listening" || status === "ready"
        ? "text-ok"
        : status === "transcribing" || status === "thinking"
          ? "text-attn"
          : status === "speaking"
            ? "text-brandSoft"
            : "text-txt3";
  const baseLabel =
    status === "idle"
      ? "off"
      : status === "connecting"
        ? "connecting"
        : status === "ready"
          ? "ready"
          : status === "listening"
            ? "listening"
            : status === "transcribing"
              ? "transcribing"
              : status === "thinking"
                ? "thinking"
                : status === "speaking"
                  ? "speaking"
                  : "error";
  /* Soft mute communicates the strongest signal: TTS is silenced
   * until the user explicitly unmutes. Override the transient
   * status label so the pill never reads "speaking" while Lex's
   * audio is being dropped on the floor. */
  const statusLabel = softMuted
    ? "muted (voice)"
    : micGated
      ? "muted (tts)"
      : baseLabel;
  const finalStatusTone = softMuted ? "text-attn" : statusTone;
  const pillTitle = softMuted
    ? `Lex is muted. ${silentMessageCount} silent message${
        silentMessageCount === 1 ? "" : "s"
      } received. Tap the speaker icon or say "Lex unmute" to resume TTS.`
    : micGated
      ? "Mic paused while Lex is speaking. Resumes automatically when TTS finishes."
      : undefined;

  /* Mic icon now reflects the foreground (full-STT) state only.
   * micGated keeps the Mic glyph (NOT MicOff) because the always-
   * on wake-word recognizer is still listening for "Lex shut up"
   * etc.; rendering MicOff during TTS playback misled the user
   * into thinking voice commands were dead. Only an explicit user
   * mute flips to MicOff (bug 2026-05-14-voice-pill-inconsistent-
   * and-wake-word-muted: pill conflated foreground STT with the
   * wake-word path). */
  const micIconName: "Mic" | "MicOff" = muted ? "MicOff" : "Mic";
  const micTone = muted
    ? "text-attn"
    : micGated
      ? "text-txt3"
      : "text-brandSoft";
  /* Reactive pulse on the mic icon while silero is actively
   * listening so the user has a confident "your speech is being
   * captured right now" signal that does not depend on reading the
   * tiny status label. Suppressed while muted / gated. */
  const micPulse = enabled && !muted && !micGated && status === "listening";

  /* Speaker icon mirrors the mic on the output side: tap to mute or
   * unmute Lex's outbound TTS. VolumeX is the universal "speaker
   * silenced" glyph; Volume2 carries an animated set of arcs when
   * Lex is actively speaking so the pulse reads as a waveform. */
  const speakerIconName: "Volume2" | "VolumeX" = softMuted ? "VolumeX" : "Volume2";
  const speakerTone = softMuted
    ? "text-attn"
    : status === "speaking"
      ? "text-brandSoft"
      : "text-txt2";
  const speakerPulse = enabled && !softMuted && status === "speaking";

  return (
    <div
      data-testid="voice-pill-root"
      className="flex items-center gap-1 py-1 px-1 sm:px-2 rounded-card hairline min-w-0 min-h-11"
      title={pillTitle}
    >
      {/* Single-row layout. The status label used to live on its own
       * row below the controls; the user flagged that as "the
       * THINKING label dangles below with no alignment to anything."
       * Inlining the status as a small pill at the head of the row
       * keeps the voice cluster a single self-contained unit. The
       * stop button still anchors the right edge and the slider is
       * still the only flex-1 child, so a long status label compresses
       * the slider before it can push stop off-screen. */}
      <span className="text-[11px] font-emphasized text-txt2 px-1 shrink-0">
        Voice
      </span>
      {/* Status pill. Fixed width so the surrounding TopBar / pill
       * row does not reflow when the label flips between short
       * ("off", "ready") and long ("transcribing", "muted (voice)")
       * states. 7rem comfortably fits the longest possible label
       * ("muted (voice)" = 13 chars uppercase monospace with
       * tracking-wider) plus a small slack. Always rendered so the
       * mobile-row layout has the same fixed footprint as desktop;
       * truncate is left as a safety net for any future label
       * additions that overshoot. */}
      <span
        data-testid="voice-pill-status"
        className={`inline-block w-[7rem] text-nano font-mono uppercase tracking-wider truncate shrink-0 text-left whitespace-nowrap ${finalStatusTone}`}
      >
        {statusLabel}
      </span>
      {LEX_DEBUG_VOICE && (
        <span
          data-testid="voice-pill-wake-debug"
          title={`wakeWordActive=${wakeWordActive ?? false} lastMatched=${
            lastWakeMatched ?? "—"
          } lastError=${lastWakeError ?? "—"}`}
          className="text-[10px] font-mono text-txt3 truncate shrink-0"
        >
          wake={wakeWordActive ? "on" : "off"} · m=
          {lastWakeMatched ?? "—"} · e={lastWakeError ?? "—"}
        </span>
      )}
        <label
          className="flex items-center gap-1.5 min-w-0 flex-1 text-nano font-mono text-txt3"
          title="Lex speech rate. Persisted globally; applies to every voice consumer until you change it again."
        >
          <input
            type="range"
            aria-label="Lex speech rate"
            min={sliderMin}
            max={sliderMax}
            step={sliderStep}
            value={sliderValue}
            disabled={!enabled || !sliderEnabled}
            onChange={(e) => setSpeed?.(Number(e.target.value))}
            className="flex-1 min-w-0 accent-brandSoft disabled:opacity-40"
          />
          <span
            data-testid="voice-pill-speed-readout"
            className="text-txt2 tabular-nums w-10 text-right shrink-0"
          >
            {sliderValue.toFixed(2)}x
          </span>
        </label>
        <button
          type="button"
          aria-label={muted ? "Unmute microphone" : "Mute microphone"}
          aria-pressed={muted}
          onClick={() => setMicMuted(!muted)}
          disabled={!enabled}
          /* w-11 h-11 = 44 CSS px each axis. Apple HIG + WCAG 2.5.5
           * baseline. Inner Icon stays size 16; the click box grows
           * around the visible glyph. */
          className="relative w-11 h-11 grid place-items-center rounded-pill text-txt2 hover:bg-surface2 disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
          title={
            micGated
              ? "Mic paused while Lex speaks. Tap to also user-mute."
              : muted
                ? "Microphone muted. Tap to unmute."
                : "Mute your microphone."
          }
        >
          <Icon
            name={micIconName}
            size={16}
            className={`${micTone} ${micPulse ? "pulse-live" : ""}`}
          />
          {wakeWordActive && (
            <span
              data-testid="voice-pill-wake-indicator"
              aria-label="Lex commands listening"
              title="Always-on wake-word path is listening for Lex commands, even during TTS."
              className={`absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-pill ring-1 ring-base ${
                status === "speaking" ? "bg-brandSoft animate-pulse" : "bg-ok"
              }`}
            />
          )}
        </button>
        <button
          type="button"
          aria-label={softMuted ? "Unmute Lex voice" : "Mute Lex voice"}
          aria-pressed={softMuted}
          onClick={() => setSoftMuted(!softMuted)}
          disabled={!enabled}
          /* w-11 h-11 = 44 CSS px each axis. Matches the mic mute
           * button so the symmetric controls share an identical
           * touch target. */
          className="relative w-11 h-11 grid place-items-center rounded-pill text-txt2 hover:bg-surface2 disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
          title={
            softMuted
              ? `Lex is muted. ${silentMessageCount} silent message${
                  silentMessageCount === 1 ? "" : "s"
                }. Tap to resume TTS.`
              : "Mute Lex's voice. Transcript keeps rendering; tap again to unmute."
          }
        >
          <Icon
            name={speakerIconName}
            size={16}
            className={`${speakerTone} ${speakerPulse ? "pulse-live" : ""}`}
          />
          {softMuted && silentMessageCount > 0 && (
            <span
              className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 grid place-items-center rounded-pill bg-attn text-base text-[10px] font-mono ring-1 ring-attn/40"
              aria-label={`${silentMessageCount} silent message${
                silentMessageCount === 1 ? "" : "s"
              }`}
            >
              {silentMessageCount > 99 ? "99+" : silentMessageCount}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={toggleEnabled}
          aria-label={enabled ? "Stop voice" : "Start voice"}
          /* min-w-11 min-h-11 = 44 CSS px each axis (Apple HIG +
           * WCAG 2.5.5). inline-flex items-center justify-center
           * keeps the small "stop"/"start" label visually unchanged
           * inside an extended click box. The hairline ring + pill
           * radius still paints at the natural padding bounds, so
           * the visible affordance reads at its prior size while
           * the tap zone grows. */
          className={`inline-flex items-center justify-center min-w-11 min-h-11 text-[11px] px-2 py-0.5 rounded-pill hairline font-emphasized shrink-0 ${
            enabled
              ? "bg-err/15 text-err ring-1 ring-err/30 hover:bg-err/25"
              : "bg-brand/15 text-brandSoft ring-1 ring-brand/30 hover:bg-brand/25"
          }`}
          title={enabled ? "Stop voice." : "Start voice."}
        >
          {enabled ? "stop" : "start"}
        </button>
    </div>
  );
}

/* Compact mic pill rendered in the TopBar's right cluster. Lives in
 * this file so it shares the constants + context type with the
 * engine. Renders nothing when there's no live Lex PTY so the bar
 * stays clean on first launch; once Lex is alive the pill surfaces
 * status, the mic + speaker mute icons, and a start/stop toggle. */
export function VoiceTopBarPill(): React.ReactElement | null {
  const v = useVoice();
  if (!v) return null;
  if (!v.hasLex && !v.enabled) return null;
  return (
    <VoicePillView
      status={v.status}
      enabled={v.enabled}
      muted={v.muted}
      micGated={v.micGated}
      softMuted={v.softMuted}
      silentMessageCount={v.silentMessageCount}
      wakeWordActive={v.wakeWordActive}
      lastWakeMatched={v.lastWakeMatched}
      lastWakeError={v.lastWakeError}
      speed={v.speed}
      speedMin={v.speedMin}
      speedMax={v.speedMax}
      speedStep={v.speedStep}
      setSpeed={v.setSpeed}
      toggleEnabled={v.toggleEnabled}
      setMicMuted={v.setMicMuted}
      setSoftMuted={v.setSoftMuted}
    />
  );
}
