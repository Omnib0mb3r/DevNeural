"use client";

/**
 * Lex transcript history panel wrapper.
 *
 * Subscribes directly to the transcript event bus so it picks up new
 * lines the moment VoiceClient receives them, instead of riding on the
 * VoiceCtx re-render chain. The bus seed-fills from useVoice().turns
 * on mount so the panel still renders the buffered history when the
 * user navigates back to /lex mid-session, then takes over via live
 * events for everything that arrives afterwards.
 *
 * The status used for the thinking placeholder still comes from
 * VoiceCtx because nothing else publishes it; turns are the part that
 * needed decoupling.
 */
import { useEffect, useRef, useState } from "react";
import { useVoice } from "./VoiceClient";
import { TranscriptHistory } from "./TranscriptHistory";
import {
  onTranscriptTurn,
  type TranscriptTurn,
} from "@/lib/transcript-bus";

const TURNS_BUFFER_CAP = 50;

export function LexTranscriptHistoryPanel(): React.ReactElement | null {
  const v = useVoice();
  const seededRef = useRef(false);
  const [turns, setTurns] = useState<TranscriptTurn[]>([]);

  /* Seed once from the VoiceCtx buffer so a fresh mount mid-session
   * shows the recent history. After the first seed we ignore further
   * VoiceCtx.turns updates because the bus is now the authoritative
   * source; otherwise stale React state could overwrite a newer bus
   * event on a context re-render. */
  useEffect(() => {
    if (seededRef.current) return;
    if (!v || !v.turns) return;
    seededRef.current = true;
    if (v.turns.length > 0) setTurns(v.turns.slice(-TURNS_BUFFER_CAP));
  }, [v]);

  useEffect(() => {
    const unsubscribe = onTranscriptTurn((turn) => {
      setTurns((prev) => {
        const next = [...prev, turn];
        return next.length > TURNS_BUFFER_CAP
          ? next.slice(next.length - TURNS_BUFFER_CAP)
          : next;
      });
    });
    return unsubscribe;
  }, []);

  return (
    <TranscriptHistory turns={turns} status={v?.status} maxTurns={10} />
  );
}
