/* Voice wiring helpers (trimmed 2026-07-15, spec v2).
 *
 * This module used to carry the haiku front desk (lane router, control
 * channel, whitelist, glue/bridge composers, digest freshness). All of
 * that died with the spec-v2 teardown: the voice top layer
 * (voice-top-layer.ts) is the one conversational brain now. What
 * survives here is the small set of helpers the WS coordinator still
 * needs: the safe spoken-output strip, the heartbeat line, and the
 * absorbed-aside ring the top layer's conversational turns feed.
 */
import { useVoiceHaiku } from './voice-haiku.js';
import { renderSpoken } from './voice-renderer.js';
import { composeHeartbeat } from './voice-heartbeat-haiku.js';
import { heartbeatPhrase } from './lex-voice-heartbeat.js';

/* Spoken-output gate. OFF: the text is returned verbatim (the speak
 * controller's own cleanForTts then runs exactly as today). ON: route
 * through the renderer so numbers/decisions/negations survive verbatim
 * (V5). This is the SAFE synchronous markdown strip; the live-model
 * restyle (renderReplyForSpeech) was removed in spec v2 because it put
 * a full LLM round trip between Lex's reply and the first PCM byte. */
export function renderForSpeech(text: string): string {
  if (!useVoiceHaiku()) return text;
  return renderSpoken(text).spoken;
}

/* Heartbeat line. OFF: the existing duration-aware phrase, unchanged.
 * ON: the grounded persona-correct line (first-person Lex). */
export function heartbeatLine(elapsedMs: number): string {
  if (!useVoiceHaiku()) return heartbeatPhrase(elapsedMs);
  return composeHeartbeat({ lexElapsedMs: elapsedMs });
}

/* Absorbed-aside plumbing (2026-07-15, fast-lane transcript hole fix;
 * retained under spec v2 for the top layer's conversational turns).
 *
 * When the top layer answers a turn itself, the exchange is absorbed
 * entirely on the daemon side: nothing is injected into Lex's PTY, so
 * it never reaches her jsonl and never reaches her awareness.
 * lex-voice-ws.ts persists both sides of an absorbed exchange durably
 * (see _captureAbsorbedAsideImpl there) and also queues it onto a
 * bounded per-connection ring so Lex can be told about it on her NEXT
 * real turn without forcing an extra round-trip. The three helpers
 * below are the pure (no DB, no socket) half of that fix: ring
 * bookkeeping and the text block rendered as an inject prefix.
 * Conversation mode only (shouldCaptureAbsorbedAside); notes mode has
 * its own capture-only path and a silent reply contract. */

export interface AbsorbedAsideEntry {
  atMs: number;
  aside: string;
  reply: string;
}

/** True only for conversation mode. An ADDRESSED notes-mode utterance
 * can still reach the top layer (the name-gate only screens
 * UNADDRESSED ones), but notes mode already owns its capture story
 * (captureNotesUtteranceOnly) and never speaks TTS; this keeps the
 * ring/capture from touching that path at all. push-to-talk is
 * likewise excluded per the operator's original scoping. */
export function shouldCaptureAbsorbedAside(
  mode: 'conversation' | 'notes' | 'push-to-talk',
): boolean {
  return mode === 'conversation';
}

/** Accumulation cap: oldest entries drop silently once the ring holds
 * more than this many. Separate from the smaller DISPLAY cap in
 * _formatAbsorbedAsideBlockImpl below - the ring can hold up to this
 * many, but only the most recent few are ever rendered into an inject
 * prefix. */
export const ABSORBED_ASIDE_RING_MAX = 10;

/** Pure append-and-cap. Returns a new array; never mutates `ring`. */
export function _pushAbsorbedAsideImpl(
  ring: AbsorbedAsideEntry[],
  entry: AbsorbedAsideEntry,
  max: number = ABSORBED_ASIDE_RING_MAX,
): AbsorbedAsideEntry[] {
  const next = ring.concat(entry);
  return next.length > max ? next.slice(next.length - max) : next;
}

/** Display cap for the rendered block: at most this many lines, most
 * recent first-out (oldest dropped first). Independent of
 * ABSORBED_ASIDE_RING_MAX (the ring can carry more than this; the
 * prefix just never shows more than this many). */
const ABSORBED_ASIDE_BLOCK_MAX_LINES = 3;

/** Renders the ring as a one-line-per-aside inject prefix, e.g.
 * `[voice asides since last turn: "good morning" -> "Morning."]` for
 * a single entry, or a multi-line block (still one bracket) for more
 * than one, with a "(+N more)" header suffix when the ring holds more
 * than ABSORBED_ASIDE_BLOCK_MAX_LINES entries. '' for an empty ring -
 * the caller adds no prefix at all in that case. Pure; does not
 * mutate or clear the ring (the caller owns that, only after a
 * successful inject). */
export function _formatAbsorbedAsideBlockImpl(
  ring: ReadonlyArray<AbsorbedAsideEntry>,
): string {
  if (ring.length === 0) return '';
  const dropped = Math.max(0, ring.length - ABSORBED_ASIDE_BLOCK_MAX_LINES);
  const shown = ring.slice(-ABSORBED_ASIDE_BLOCK_MAX_LINES);
  const lines = shown.map((e) => `"${e.aside}" -> "${e.reply}"`);
  const header =
    dropped > 0
      ? `voice asides since last turn (+${dropped} more):`
      : 'voice asides since last turn:';
  if (lines.length === 1) return `[${header} ${lines[0]}]`;
  return `[${header}\n${lines.join('\n')}]`;
}
