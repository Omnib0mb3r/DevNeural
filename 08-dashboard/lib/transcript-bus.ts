/**
 * Transcript event bus.
 *
 * The voice transcript stream is owned by VoiceClient (mounted once at
 * app/providers root). The LexTranscriptHistoryPanel previously read
 * the rolling turn list off VoiceCtx, which coupled its update cadence
 * to VoiceClient re-renders. After the duplicate-transcript-render
 * cleanup the panel stopped picking up live turns reliably, so this
 * bus gives the panel a direct subscription channel that fires once
 * per turn regardless of the React render path.
 *
 * VoiceClient emits a turn every time it receives a 'transcript' (user
 * speech recognised) or 'assistant-text' (Lex reply) message; the panel
 * subscribes on mount, maintains its own local list, and surfaces a
 * thinking placeholder via status updates.
 */

/** Three-layer voice topology (2026-07-18): operator -> TOP (fast
 * voice) -> MID (deep reasoning / brainstorm Lex) -> and back. The
 * panel labels each turn by its layer so the round trip is legible.
 * Absent = legacy turn, labelled by role. */
export type TranscriptLayer = "operator" | "top" | "mid";

export interface TranscriptTurn {
  id: string;
  role: "user" | "assistant";
  text: string;
  layer?: TranscriptLayer;
}

export type TranscriptStatus =
  | "idle"
  | "connecting"
  | "warming"
  | "ready"
  | "listening"
  | "transcribing"
  | "thinking"
  | "speaking"
  | "error";

const TURN_EVENT = "lex:transcript-turn";
const STATUS_EVENT = "lex:transcript-status";
const CLEAR_EVENT = "lex:transcript-clear";

export function emitTranscriptTurn(turn: TranscriptTurn): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<TranscriptTurn>(TURN_EVENT, { detail: turn }),
  );
}

export function emitTranscriptStatus(status: TranscriptStatus): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<TranscriptStatus>(STATUS_EVENT, { detail: status }),
  );
}

export function emitTranscriptClear(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(CLEAR_EVENT));
}

export function onTranscriptTurn(
  cb: (turn: TranscriptTurn) => void,
): () => void {
  if (typeof window === "undefined") return () => undefined;
  const handler = (e: Event): void => {
    const ce = e as CustomEvent<TranscriptTurn>;
    if (ce.detail) cb(ce.detail);
  };
  window.addEventListener(TURN_EVENT, handler);
  return () => window.removeEventListener(TURN_EVENT, handler);
}

export function onTranscriptStatus(
  cb: (status: TranscriptStatus) => void,
): () => void {
  if (typeof window === "undefined") return () => undefined;
  const handler = (e: Event): void => {
    const ce = e as CustomEvent<TranscriptStatus>;
    if (ce.detail) cb(ce.detail);
  };
  window.addEventListener(STATUS_EVENT, handler);
  return () => window.removeEventListener(STATUS_EVENT, handler);
}

export function onTranscriptClear(cb: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const handler = (): void => cb();
  window.addEventListener(CLEAR_EVENT, handler);
  return () => window.removeEventListener(CLEAR_EVENT, handler);
}
