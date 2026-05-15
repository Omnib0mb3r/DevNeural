"use client";

/**
 * Voice diagnostics panel.
 *
 * Surfaces the voice-log + wake-log ring buffers maintained in
 * lib/voice-log.ts and lib/wake-log.ts as a visible dashboard panel
 * so the user can see WHY voice broke without opening DevTools. The
 * underlying capture was wired in the E1 commit (WS auto-reconnect +
 * wake-word watchdog) so every WS open/close, reconnect attempt, mic
 * permission state change, VAD transition, wake-word fire, error,
 * and watchdog kick is already landing in the ring buffer.
 *
 * Two columns:
 *   - Voice pipeline: 50 most-recent voice-log entries. Level-tinted.
 *   - Wake-word: 20 most-recent wake-log entries.
 *
 * Live: subscribes to the 'lex-voice-log-append' custom event and
 * re-renders on every push. Also polls on a 2s interval so wake-log
 * entries (which fire through a different channel) still show up.
 */
import { useEffect, useState } from "react";
import {
  getVoiceLog,
  VOICE_LOG_EVENT_NAME,
  type VoiceLogEntry,
  type VoiceLogLevel,
} from "@/lib/voice-log";
import type { WakeLogEntry } from "@/lib/wake-log";

const LEVEL_TONE: Record<VoiceLogLevel, string> = {
  info: "text-txt2",
  warn: "text-attn",
  error: "text-err",
};

function fmtTs(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.valueOf())) return ts;
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function fmtData(data: unknown): string {
  if (data === undefined || data === null) return "";
  try {
    const s = JSON.stringify(data);
    return s.length > 120 ? `${s.slice(0, 117)}…` : s;
  } catch {
    return String(data);
  }
}

function readWakeLog(): WakeLogEntry[] {
  if (typeof window === "undefined") return [];
  return [...(window.__lexWakeLog ?? [])];
}

export function VoiceDiagnosticsPanel(): React.ReactElement {
  const [voiceEntries, setVoiceEntries] = useState<VoiceLogEntry[]>([]);
  const [wakeEntries, setWakeEntries] = useState<WakeLogEntry[]>([]);
  const [collapsed, setCollapsed] = useState<boolean>(true);

  useEffect(() => {
    /* Hydrate from the ring buffers on mount so existing entries
     * (captured before the panel rendered) appear immediately. */
    setVoiceEntries(getVoiceLog());
    setWakeEntries(readWakeLog());

    const onAppend = () => {
      setVoiceEntries(getVoiceLog());
    };
    window.addEventListener(VOICE_LOG_EVENT_NAME, onAppend);
    /* Wake-log writes don't fire a custom event today; poll on a
     * short interval so this column still refreshes. Voice-log
     * pushes also re-refresh the wake column for free since the
     * custom event handler reads both buffers. */
    const poll = setInterval(() => {
      setVoiceEntries(getVoiceLog());
      setWakeEntries(readWakeLog());
    }, 2_000);
    return () => {
      window.removeEventListener(VOICE_LOG_EVENT_NAME, onAppend);
      clearInterval(poll);
    };
  }, []);

  const errorCount = voiceEntries.filter((e) => e.level === "error").length;
  const warnCount = voiceEntries.filter((e) => e.level === "warn").length;
  const headerTone =
    errorCount > 0
      ? "text-err"
      : warnCount > 0
        ? "text-attn"
        : "text-txt2";

  return (
    <section
      data-testid="voice-diagnostics-panel"
      className="rounded-panel bg-surface1 hairline"
    >
      <header className="px-4 py-3 border-b border-border1 flex items-center justify-between gap-3">
        <div className="flex flex-col gap-0.5 min-w-0">
          <h2 className="text-sm font-emphasized text-txt1">
            Voice diagnostics
          </h2>
          <p className="text-nano text-txt3">
            WS reconnects, mic / VAD / wake-word transitions, errors — live
          </p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <span
            className={`text-nano font-mono uppercase tracking-wider ${headerTone}`}
            title={`${voiceEntries.length} voice events, ${wakeEntries.length} wake events, ${errorCount} errors, ${warnCount} warnings`}
          >
            {voiceEntries.length}v · {wakeEntries.length}w
            {errorCount > 0 ? ` · ${errorCount} err` : ""}
            {warnCount > 0 ? ` · ${warnCount} warn` : ""}
          </span>
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            className="text-nano font-mono text-txt3 hover:text-txt1"
            aria-expanded={!collapsed}
          >
            {collapsed ? "expand" : "collapse"}
          </button>
        </div>
      </header>
      {!collapsed && (
        <div className="grid md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-border2">
          <div className="px-4 py-3">
            <div className="text-nano text-txt3 uppercase tracking-wider mb-2">
              Voice pipeline ({voiceEntries.length})
            </div>
            {voiceEntries.length === 0 ? (
              <div className="text-xs text-txt3">
                No voice events yet. The buffer fills on engine enable,
                WS open/close, mic permission changes, VAD transitions,
                and errors.
              </div>
            ) : (
              <ul
                data-testid="voice-diagnostics-voice-list"
                className="max-h-96 overflow-y-auto space-y-1 font-mono text-[11px]"
              >
                {voiceEntries
                  .slice()
                  .reverse()
                  .slice(0, 50)
                  .map((e, idx) => (
                    <li
                      key={`${e.ts}-${idx}`}
                      data-testid="voice-diagnostics-voice-row"
                      className={`flex items-start gap-2 ${LEVEL_TONE[e.level]}`}
                    >
                      <span className="text-txt3 w-16 shrink-0">
                        {fmtTs(e.ts)}
                      </span>
                      <span className="uppercase text-nano w-32 shrink-0">
                        {e.kind}
                      </span>
                      <span className="flex-1 min-w-0 break-all">
                        {e.msg}
                        {e.data !== undefined && (
                          <span className="text-txt3 ml-2">
                            {fmtData(e.data)}
                          </span>
                        )}
                      </span>
                    </li>
                  ))}
              </ul>
            )}
          </div>
          <div className="px-4 py-3">
            <div className="text-nano text-txt3 uppercase tracking-wider mb-2">
              Wake-word ({wakeEntries.length})
            </div>
            {wakeEntries.length === 0 ? (
              <div className="text-xs text-txt3">
                No wake-word events yet. The buffer fills on
                recognizer start / result / end / error and on every
                dispatched wake-command.
              </div>
            ) : (
              <ul
                data-testid="voice-diagnostics-wake-list"
                className="max-h-96 overflow-y-auto space-y-1 font-mono text-[11px]"
              >
                {wakeEntries
                  .slice()
                  .reverse()
                  .map((e, idx) => (
                    <li
                      key={`${e.ts}-${idx}`}
                      data-testid="voice-diagnostics-wake-row"
                      className="flex items-start gap-2 text-txt2"
                    >
                      <span className="text-txt3 w-16 shrink-0">
                        {fmtTs(e.ts)}
                      </span>
                      <span className="flex-1 min-w-0 break-all">
                        {e.msg}
                        {e.data !== undefined && (
                          <span className="text-txt3 ml-2">
                            {fmtData(e.data)}
                          </span>
                        )}
                      </span>
                    </li>
                  ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
