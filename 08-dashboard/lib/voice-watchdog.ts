/**
 * Dashboard-side voice-output watchdog.
 *
 * The dashboard schedules TTS PCM as AudioBufferSourceNodes into a
 * single AudioContext that lives for the whole voice session. Three
 * silent-failure modes have shown up over time:
 *
 *  1. AudioContext suspends (tab loses focus, OS audio device flips)
 *     and resume() is never called because the network callback path
 *     does not know the context drifted.
 *  2. BufferSources keep stacking but no `ended` event fires because
 *     the audio clock stalled; the queue depth grows while no audio
 *     actually leaves the speaker.
 *  3. The WS connection is alive and a tts-start has fired, but
 *     no binary frames have arrived for a long stretch, meaning the
 *     server-side piper / TTS bridge has gone quiet without the
 *     client noticing.
 *
 * runWatchdogChecks() is a pure function: caller passes a snapshot
 * of the relevant refs and gets a list of per-check verdicts back.
 * The driving useEffect inside VoiceClient handles state-machine
 * concerns (heal step selection, telemetry batching, banner gating).
 * Pure split exists so the snapshot logic is unit-testable without
 * mounting the React tree.
 */

export type WatchdogCheckKind =
  | "ctx_state"
  | "buffer_stuck"
  | "frame_timeout";

export const FRAME_TIMEOUT_MS = 30_000;
export const BUFFER_STALL_MS = 10_000;

export interface WatchdogProbeState {
  ctxState: AudioContextState | null;
  ttsActive: boolean;
  /** Wall-clock ms when the last binary PCM frame arrived from the
   * server. Null until the first frame of the session lands. */
  lastFrameTsMs: number | null;
  /** Count of currently-scheduled AudioBufferSourceNodes that have
   * not fired their onended yet. */
  activeBufferCount: number;
  /** Wall-clock ms of the most recent buffer-queue progress event:
   * tts-start, a schedule, or an onended. Used to detect a stalled
   * audio clock without needing to peer at AudioContext internals. */
  lastBufferProgressTsMs: number | null;
}

export interface WatchdogCheckResult {
  kind: WatchdogCheckKind;
  ok: boolean;
}

export function runWatchdogChecks(
  state: WatchdogProbeState,
  nowMs: number,
): WatchdogCheckResult[] {
  const results: WatchdogCheckResult[] = [];

  /* Context state is checked unconditionally: a suspended context
   * is a failure regardless of whether a TTS request is in flight,
   * because the next tts-start will hit a dead clock. */
  results.push({
    kind: "ctx_state",
    ok: state.ctxState === "running",
  });

  /* Buffer-stall and frame-timeout only matter while a TTS request
   * is actively expected. Idle silence is the normal state and
   * should not trigger heals. */
  if (state.ttsActive) {
    const buffersOk =
      state.activeBufferCount === 0 ||
      state.lastBufferProgressTsMs == null ||
      nowMs - state.lastBufferProgressTsMs <= BUFFER_STALL_MS;
    results.push({ kind: "buffer_stuck", ok: buffersOk });

    const frameOk =
      state.lastFrameTsMs != null &&
      nowMs - state.lastFrameTsMs <= FRAME_TIMEOUT_MS;
    results.push({ kind: "frame_timeout", ok: frameOk });
  }

  return results;
}

export type VoiceHealthStatus = "fail" | "healed" | "heal_failed";

export interface VoiceHealthEvent {
  ts_ms: number;
  check_kind: WatchdogCheckKind | string;
  status: VoiceHealthStatus;
  heal_attempt: number;
  recovered: 0 | 1;
}

export async function postVoiceHealth(
  events: VoiceHealthEvent[],
): Promise<void> {
  if (events.length === 0) return;
  try {
    await fetch("/dashboard/voice-health", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ events }),
    });
  } catch {
    /* fire-and-forget: a missed telemetry batch must never affect
     * the live audio path. The next batch will land on the next
     * 10s tick. */
  }
}

export interface VoiceHealthRow {
  id: number;
  ts_ms: number;
  check_kind: string;
  status: string;
  heal_attempt: number;
  recovered: number;
}

export async function fetchVoiceHealth(
  limit = 5,
): Promise<VoiceHealthRow[]> {
  try {
    const r = await fetch(
      `/dashboard/voice-health?limit=${encodeURIComponent(limit)}`,
      { credentials: "include" },
    );
    if (!r.ok) return [];
    const j = (await r.json()) as { ok?: boolean; events?: VoiceHealthRow[] };
    return Array.isArray(j.events) ? j.events : [];
  } catch {
    return [];
  }
}
