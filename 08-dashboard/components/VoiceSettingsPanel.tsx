"use client";

import { useEffect, useRef, useState } from "react";

const BARGE_STORAGE_KEY = "lex-barge-cooldown-ms";
const BARGE_MIN = 0;
const BARGE_MAX = 2000;
const BARGE_STEP = 50;
const BARGE_DEFAULT = 250;

interface PiperStatus {
  ok: boolean;
  active_voice: string;
  rate: number;
  speed: number;
  barge_cooldown_ms: number;
}

/* Persistent voice preferences live in voice-preferences.json on the
 * daemon side. This panel hydrates from /voice/piper-status and writes
 * back through the dedicated /voice/set-* endpoints; localStorage holds
 * an optimistic seed so the slider does not snap on remount. */
export function VoiceSettingsPanel() {
  const [bargeCooldownMs, setBargeCooldownMs] = useState<number>(() => {
    if (typeof window === "undefined") return BARGE_DEFAULT;
    const raw = window.localStorage.getItem(BARGE_STORAGE_KEY);
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n >= BARGE_MIN && n <= BARGE_MAX
      ? n
      : BARGE_DEFAULT;
  });
  const [activeVoice, setActiveVoice] = useState<string>("");
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved">(
    "idle",
  );
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void fetch("/voice/piper-status", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: PiperStatus | null) => {
        if (!j) return;
        if (typeof j.active_voice === "string") setActiveVoice(j.active_voice);
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
      })
      .catch(() => undefined);
  }, []);

  function changeBargeCooldown(next: number): void {
    const clamped = Math.max(
      BARGE_MIN,
      Math.min(BARGE_MAX, Math.round(next)),
    );
    setBargeCooldownMs(clamped);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(BARGE_STORAGE_KEY, String(clamped));
    }
    setSaveStatus("saving");
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      void fetch("/voice/set-barge-cooldown", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ ms: clamped }),
      })
        .then(() => {
          setSaveStatus("saved");
          if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
          idleTimerRef.current = setTimeout(
            () => setSaveStatus("idle"),
            1500,
          );
        })
        .catch(() => setSaveStatus("idle"));
    }, 250);
  }

  return (
    <section className="rounded-panel bg-surface1 hairline">
      <header className="px-5 py-3 border-b border-border1 flex items-center justify-between">
        <div>
          <h2 className="font-display text-sm font-emphasized">Voice</h2>
          <p className="text-nano text-txt3 mt-0.5">
            Persistent across daemon restarts. Active voice:{" "}
            <span className="font-mono text-txt2">
              {activeVoice || "default"}
            </span>
          </p>
        </div>
        <span
          className={`text-nano font-mono ${
            saveStatus === "saved"
              ? "text-ok"
              : saveStatus === "saving"
                ? "text-txt3"
                : "text-transparent"
          }`}
        >
          {saveStatus === "saved" ? "saved" : "saving…"}
        </span>
      </header>

      <div className="px-5 py-4 space-y-5">
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label
              htmlFor="barge-cooldown"
              className="text-sm text-txt1 font-emphasized"
            >
              Barge-in cooldown
            </label>
            <span className="text-xs font-mono text-txt2 tabular-nums">
              {bargeCooldownMs} ms
            </span>
          </div>
          <input
            id="barge-cooldown"
            type="range"
            min={BARGE_MIN}
            max={BARGE_MAX}
            step={BARGE_STEP}
            value={bargeCooldownMs}
            onChange={(e) => changeBargeCooldown(Number(e.target.value))}
            className="w-full accent-brandSoft"
            aria-describedby="barge-cooldown-help"
          />
          <p
            id="barge-cooldown-help"
            className="text-nano text-txt3 leading-relaxed"
          >
            After Lex starts speaking, ignore mic-driven interrupts for this
            many milliseconds. Stops self-echo (Lex&apos;s own audio bleeding
            into the mic) from triggering a barge-in loop. 0 disables the
            guard entirely. 250 ms is the default and works for most laptop
            speaker setups; bump higher if echo is severe.
          </p>
        </div>
      </div>
    </section>
  );
}
