"use client";

import { useEffect, useRef, useState } from "react";

const BARGE_STORAGE_KEY = "lex-barge-cooldown-ms";
const BARGE_MIN = 0;
const BARGE_MAX = 2000;
const BARGE_STEP = 50;
const BARGE_DEFAULT = 250;

const VAD_STORAGE_KEY = "lex-vad-sensitivity";
const VAD_MIN = 0;
const VAD_MAX = 1;
const VAD_STEP = 0.05;
const VAD_DEFAULT = 0.5;

const MIC_GAIN_STORAGE_KEY = "lex-mic-gain";
const MIC_GAIN_MIN = 0;
const MIC_GAIN_MAX = 3.0;
const MIC_GAIN_STEP = 0.05;
const MIC_GAIN_DEFAULT = 1.0;

interface PiperStatus {
  ok: boolean;
  active_voice: string;
  rate: number;
  speed: number;
  barge_cooldown_ms: number;
  vad_sensitivity: number;
  mic_gain: number;
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
  const [vadSensitivity, setVadSensitivity] = useState<number>(() => {
    if (typeof window === "undefined") return VAD_DEFAULT;
    const raw = window.localStorage.getItem(VAD_STORAGE_KEY);
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n >= VAD_MIN && n <= VAD_MAX
      ? n
      : VAD_DEFAULT;
  });
  const [micGain, setMicGain] = useState<number>(() => {
    if (typeof window === "undefined") return MIC_GAIN_DEFAULT;
    const raw = window.localStorage.getItem(MIC_GAIN_STORAGE_KEY);
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n >= MIC_GAIN_MIN && n <= MIC_GAIN_MAX
      ? n
      : MIC_GAIN_DEFAULT;
  });
  const [activeVoice, setActiveVoice] = useState<string>("");
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved">(
    "idle",
  );
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const vadSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const micGainSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
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
        if (
          typeof j.vad_sensitivity === "number" &&
          Number.isFinite(j.vad_sensitivity)
        ) {
          const clamped = Math.max(
            VAD_MIN,
            Math.min(VAD_MAX, j.vad_sensitivity),
          );
          setVadSensitivity(clamped);
          if (typeof window !== "undefined") {
            window.localStorage.setItem(VAD_STORAGE_KEY, String(clamped));
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
            window.localStorage.setItem(MIC_GAIN_STORAGE_KEY, String(clamped));
          }
        }
      })
      .catch(() => undefined);
  }, []);

  function changeVadSensitivity(next: number): void {
    const clamped = Math.max(VAD_MIN, Math.min(VAD_MAX, next));
    setVadSensitivity(clamped);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(VAD_STORAGE_KEY, String(clamped));
    }
    setSaveStatus("saving");
    if (vadSaveTimerRef.current) clearTimeout(vadSaveTimerRef.current);
    vadSaveTimerRef.current = setTimeout(() => {
      void fetch("/voice/set-vad-sensitivity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ value: clamped }),
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

  function changeMicGain(next: number): void {
    const clamped = Math.max(MIC_GAIN_MIN, Math.min(MIC_GAIN_MAX, next));
    setMicGain(clamped);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(MIC_GAIN_STORAGE_KEY, String(clamped));
    }
    setSaveStatus("saving");
    if (micGainSaveTimerRef.current) clearTimeout(micGainSaveTimerRef.current);
    micGainSaveTimerRef.current = setTimeout(() => {
      void fetch("/voice/set-mic-gain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ value: clamped }),
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
              htmlFor="mic-gain"
              className="text-sm text-txt1 font-emphasized"
            >
              Mic input level
            </label>
            <span className="text-xs font-mono text-txt2 tabular-nums">
              {micGain.toFixed(2)}x
            </span>
          </div>
          <input
            id="mic-gain"
            type="range"
            min={MIC_GAIN_MIN}
            max={MIC_GAIN_MAX}
            step={MIC_GAIN_STEP}
            value={micGain}
            onChange={(e) => changeMicGain(Number(e.target.value))}
            className="w-full accent-brandSoft"
            aria-describedby="mic-gain-help"
          />
          <p
            id="mic-gain-help"
            className="text-nano text-txt3 leading-relaxed"
          >
            Volume multiplier applied to your mic before whisper hears it.
            1.00x is passthrough; drop below 1 to attenuate a hot mic;
            push above 1 to boost a quiet one. Above ~1.5x clipping is
            likely on already-loud sources. 0 mutes the input entirely.
          </p>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label
              htmlFor="vad-sensitivity"
              className="text-sm text-txt1 font-emphasized"
            >
              Mic sensitivity
            </label>
            <span className="text-xs font-mono text-txt2 tabular-nums">
              {Math.round(vadSensitivity * 100)}
            </span>
          </div>
          <input
            id="vad-sensitivity"
            type="range"
            min={VAD_MIN}
            max={VAD_MAX}
            step={VAD_STEP}
            value={vadSensitivity}
            onChange={(e) => changeVadSensitivity(Number(e.target.value))}
            className="w-full accent-brandSoft"
            aria-describedby="vad-sensitivity-help"
          />
          <p
            id="vad-sensitivity-help"
            className="text-nano text-txt3 leading-relaxed"
          >
            How easily the mic triggers a turn. Lower values ignore
            background noise (better for loud rooms or open offices);
            higher values pick up softer speech but also catch more
            ambient sound. 50 is the default; drop to 20-30 in noisy
            environments.
          </p>
        </div>

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
