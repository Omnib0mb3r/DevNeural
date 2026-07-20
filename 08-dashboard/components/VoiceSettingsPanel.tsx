"use client";

import { useEffect, useRef, useState } from "react";
import { emitVoiceSettingUpdate } from "@/lib/voice-settings-bus";
import { migrateLegacyMicGain } from "@/lib/mic-gain-migration";
import { fetchVoiceHealth, type VoiceHealthRow } from "@/lib/voice-watchdog";
import {
  getPersistedAudioOutputDevice,
  listAudioOutputs,
  setPersistedAudioOutputDevice,
  supportsSinkSelection,
  type AudioOutputDevice,
} from "@/lib/audio-output";
import { MicTuner } from "./MicTuner";

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

/* One-time legacy correction: placebo-era near-mute gains become an
 * actual mute now that gain feeds VAD triggering. See
 * lib/mic-gain-migration.ts. Corrections are pushed to the daemon
 * pref and the live voice client so every source of truth heals. */
function applyMicGainMigration(value: number): number {
  return migrateLegacyMicGain(value, {
    storageKey: MIC_GAIN_STORAGE_KEY,
    postCorrection: (corrected) => {
      emitVoiceSettingUpdate({ key: "mic_gain", value: corrected });
      void fetch("/voice/set-mic-gain", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ value: corrected }),
      }).catch(() => undefined);
    },
  });
}

interface VoiceOption {
  name: string;
  sampleRate?: number;
}

interface PiperStatus {
  ok: boolean;
  active_voice: string;
  rate: number;
  speed: number;
  vad_sensitivity: number;
  mic_gain: number;
  voices?: VoiceOption[];
}

/* en_GB-alba-medium -> "Alba (GB, medium)". Falls back to the raw
 * name for anything that doesn't match the piper locale-speaker-quality
 * shape, so an oddly-named model still renders instead of vanishing. */
function prettyVoiceLabel(name: string): string {
  const m = name.match(/^[a-z]{2}_([A-Z]{2})-(.+)-([a-z]+)$/);
  if (!m) return name;
  const [, region, speaker, quality] = m;
  const spk = speaker
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
  return `${spk} (${region}, ${quality})`;
}

/* Persistent voice preferences live in voice-preferences.json on the
 * daemon side. This panel hydrates from /voice/piper-status and writes
 * back through the dedicated /voice/set-* endpoints; localStorage holds
 * an optimistic seed so the slider does not snap on remount. */
export function VoiceSettingsPanel() {
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
    const n = applyMicGainMigration(raw ? Number(raw) : NaN);
    return Number.isFinite(n) && n >= MIC_GAIN_MIN && n <= MIC_GAIN_MAX
      ? n
      : MIC_GAIN_DEFAULT;
  });
  const [activeVoice, setActiveVoice] = useState<string>("");
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved">(
    "idle",
  );

  /* Output-device routing (phone Bluetooth). Purely client-side: no
   * daemon endpoint, nothing to hydrate from /voice/piper-status.
   * "" means "system default" and is stored as a cleared preference
   * (null) rather than a literal empty string; see
   * setPersistedAudioOutputDevice. sinkSelectionSupported is a
   * platform capability, not a preference, so it is computed once. */
  const [outputDevices, setOutputDevices] = useState<AudioOutputDevice[]>([]);
  const [selectedOutputDeviceId, setSelectedOutputDeviceId] =
    useState<string>(() => getPersistedAudioOutputDevice() ?? "");
  const [sinkSelectionSupported] = useState<boolean>(() =>
    supportsSinkSelection(),
  );
  const vadSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const micGainSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* Last 5 voice-output watchdog events, polled from
   * /dashboard/voice-health every 10s. Surfaces here so the operator
   * can see in-panel why TTS went silent (and whether the heal worked)
   * instead of opening the daemon log. */
  const [healthRows, setHealthRows] = useState<VoiceHealthRow[]>([]);
  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      const rows = await fetchVoiceHealth(5);
      if (!cancelled) setHealthRows(rows);
    }
    void load();
    const t = setInterval(() => {
      void load();
    }, 10_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  /* Populate the "Play through" list on mount and whenever the OS
   * device set changes (Bluetooth headset paired/unpaired, USB audio
   * plugged in). Harmless no-op on platforms without setSinkId; the
   * list still renders, it's just rendered disabled. */
  useEffect(() => {
    let cancelled = false;
    function refresh(): void {
      void listAudioOutputs().then((devices) => {
        if (!cancelled) setOutputDevices(devices);
      });
    }
    refresh();
    if (typeof navigator !== "undefined" && navigator.mediaDevices) {
      navigator.mediaDevices.addEventListener("devicechange", refresh);
    }
    return () => {
      cancelled = true;
      if (typeof navigator !== "undefined" && navigator.mediaDevices) {
        navigator.mediaDevices.removeEventListener("devicechange", refresh);
      }
    };
  }, []);

  useEffect(() => {
    void fetch("/voice/piper-status", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: PiperStatus | null) => {
        if (!j) return;
        if (typeof j.active_voice === "string") setActiveVoice(j.active_voice);
        if (Array.isArray(j.voices)) {
          setVoices(
            j.voices.filter(
              (v): v is VoiceOption =>
                !!v && typeof v.name === "string",
            ),
          );
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
          const migrated = applyMicGainMigration(j.mic_gain);
          const clamped = Math.max(
            MIC_GAIN_MIN,
            Math.min(MIC_GAIN_MAX, migrated),
          );
          setMicGain(clamped);
          if (typeof window !== "undefined") {
            window.localStorage.setItem(MIC_GAIN_STORAGE_KEY, String(clamped));
          }
        }
      })
      .catch(() => undefined);
  }, []);

  /* Discrete choice, not a dragged slider, so no debounce and no
   * daemon round-trip: this preference is entirely client-side
   * (localStorage + the same-window settings bus that the live
   * VoiceClient subscribes to). "" clears the preference back to
   * "system default" instead of persisting a literal empty string. */
  function changeOutputDevice(deviceId: string): void {
    setSelectedOutputDeviceId(deviceId);
    setPersistedAudioOutputDevice(deviceId || null);
    emitVoiceSettingUpdate({ key: "audio_output_device", value: deviceId });
  }

  function changeVadSensitivity(next: number): void {
    const clamped = Math.max(VAD_MIN, Math.min(VAD_MAX, next));
    setVadSensitivity(clamped);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(VAD_STORAGE_KEY, String(clamped));
    }
    emitVoiceSettingUpdate({ key: "vad_sensitivity", value: clamped });
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
    emitVoiceSettingUpdate({ key: "mic_gain", value: clamped });
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

  /* Switch the TTS voice model. Optimistically reflect the pick, POST it
   * to the daemon (which validates the .onnx is installed and persists to
   * voice-preferences.json), and roll back the label if the daemon
   * rejects it. Applies to the next spoken turn; a running synth finishes
   * on the old voice. */
  function changeVoice(name: string): void {
    if (!name || name === activeVoice) return;
    const previous = activeVoice;
    setActiveVoice(name);
    setSaveStatus("saving");
    void fetch("/voice/set-voice", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ name }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { ok?: boolean } | null) => {
        if (!j || !j.ok) {
          setActiveVoice(previous);
          setSaveStatus("idle");
          return;
        }
        emitVoiceSettingUpdate({ key: "active_voice", value: name });
        setSaveStatus("saved");
        if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
        idleTimerRef.current = setTimeout(() => setSaveStatus("idle"), 1500);
      })
      .catch(() => {
        setActiveVoice(previous);
        setSaveStatus("idle");
      });
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
              htmlFor="tts-voice"
              className="text-sm text-txt1 font-emphasized"
            >
              Voice
            </label>
          </div>
          <select
            id="tts-voice"
            value={activeVoice}
            disabled={voices.length === 0}
            onChange={(e) => changeVoice(e.target.value)}
            className="w-full h-9 px-3 rounded-input bg-surface2 hairline text-txt1 outline-none focus:ring-1 focus:ring-brand/60 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            aria-describedby="tts-voice-help"
          >
            {voices.length === 0 && (
              <option value="">{activeVoice || "loading…"}</option>
            )}
            {voices.map((v) => (
              <option key={v.name} value={v.name}>
                {prettyVoiceLabel(v.name)}
              </option>
            ))}
          </select>
          <p id="tts-voice-help" className="text-nano text-txt3 leading-relaxed">
            Which Piper model speaks Lex&apos;s replies. Applies to the next
            spoken turn; a reply already playing finishes on the old voice.
          </p>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label
              htmlFor="audio-output-device"
              className="text-sm text-txt1 font-emphasized"
            >
              Play through
            </label>
          </div>
          <select
            id="audio-output-device"
            value={selectedOutputDeviceId}
            disabled={!sinkSelectionSupported}
            onChange={(e) => changeOutputDevice(e.target.value)}
            className="w-full h-9 px-3 rounded-input bg-surface2 hairline text-txt1 outline-none focus:ring-1 focus:ring-brand/60 text-sm disabled:opacity-50 disabled:cursor-not-allowed"
            aria-describedby="audio-output-device-help"
          >
            <option value="">System default</option>
            {outputDevices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label}
              </option>
            ))}
          </select>
          <p
            id="audio-output-device-help"
            className="text-nano text-txt3 leading-relaxed"
          >
            {sinkSelectionSupported
              ? "Which speaker or Bluetooth device Lex's replies play through. Applies live to a running voice session."
              : "iOS does not allow web apps to choose the output device; audio follows the phone's own routing."}
          </p>
        </div>

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
            How easily any sound triggers a turn. The scale was rebuilt so
            low is nearly deaf: below ~10 barely reacts, 20-35 suits a loud
            room, 50+ picks up soft speech (and more ambient noise). Use the
            tuner below to set it by eye. Applies live to a running voice
            session; no need to toggle voice off and back on.
          </p>
        </div>

        <div className="pt-1">
          <MicTuner sensitivity={vadSensitivity} />
        </div>

        <div className="space-y-2 pt-2 border-t border-border1">
          <div className="flex items-center justify-between">
            <span className="text-sm text-txt1 font-emphasized">
              Voice output watchdog
            </span>
            <span className="text-nano font-mono text-txt3">
              last 5 events
            </span>
          </div>
          {healthRows.length === 0 ? (
            <p className="text-nano text-txt3 leading-relaxed">
              No watchdog events recorded. The dashboard probes the audio
              path every 10 seconds while voice is enabled; rows appear here
              only when a check fails or a self-heal runs.
            </p>
          ) : (
            <ul className="space-y-1 text-nano font-mono">
              {healthRows.map((row) => {
                const ts = new Date(row.ts_ms);
                const hh = String(ts.getHours()).padStart(2, "0");
                const mm = String(ts.getMinutes()).padStart(2, "0");
                const ss = String(ts.getSeconds()).padStart(2, "0");
                const statusTone =
                  row.recovered === 1
                    ? "text-ok"
                    : row.status === "heal_failed"
                      ? "text-err"
                      : "text-attn";
                return (
                  <li
                    key={row.id}
                    className="flex items-center gap-2 tabular-nums"
                  >
                    <span className="text-txt3 w-20">
                      {hh}:{mm}:{ss}
                    </span>
                    <span className="text-txt2 w-28 truncate">
                      {row.check_kind}
                    </span>
                    <span className={`${statusTone} w-24`}>{row.status}</span>
                    <span className="text-txt3">
                      heal {row.heal_attempt} {row.recovered === 1 ? "ok" : ""}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
