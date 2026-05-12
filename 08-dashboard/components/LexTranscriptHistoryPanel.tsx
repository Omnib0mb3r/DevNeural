"use client";

/**
 * Lex transcript history panel wrapper.
 *
 * Pulls the rolling turn list + voice status off the VoiceCtx and
 * hands them to the pure TranscriptHistory render component. Lives
 * separately so the render component stays free of React-query and
 * VoiceCtx coupling and its render-only tests can drive it with
 * plain props.
 */
import { useVoice } from "./VoiceClient";
import { TranscriptHistory } from "./TranscriptHistory";

export function LexTranscriptHistoryPanel(): React.ReactElement | null {
  const v = useVoice();
  if (!v) return null;
  return <TranscriptHistory turns={v.turns} status={v.status} maxTurns={10} />;
}
