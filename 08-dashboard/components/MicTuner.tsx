"use client";

import { useEffect, useRef, useState } from "react";
import { getVadModule, resetVadModuleCache } from "@/lib/voice-ort-config";
import { buildVadOptionSet, vadThresholds } from "@/lib/voice-vad-options";

/* Live mic tuner (2026-07-20-mic-tuning-design.md).
 *
 * A self-contained meter for setting the mic sensitivity by eye. Press
 * Start and it opens its OWN mic + silero VAD (independent of any running
 * voice session), reading silero's per-frame `isSpeech` probability - the
 * SAME signal that fires a turn. The bar is that probability; the red line
 * is the current sensitivity threshold (vadThresholds(sensitivity).
 * positive), so it moves the instant the slider above changes. Quiet room
 * should sit left of the line; your voice should cross it (TRIGGER).
 *
 * Own lifecycle: Start acquires, Stop / unmount tears down the VAD and the
 * mic stream so a left-open tuner never holds the mic. */

const REDEMPTION_MS = 800; // meter reads frame prob directly; value is cosmetic

type TunerState = "idle" | "starting" | "live" | "error";

export function MicTuner({ sensitivity }: { sensitivity: number }) {
  const [state, setState] = useState<TunerState>("idle");
  const [prob, setProb] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const vadRef = useRef<any>(null);
  const runningRef = useRef(false);
  // Identity token for the in-flight start(); a Stop/unmount during async
  // init clears it, so the stale post-await guard below no longer reads
  // React state (which is a stale closure and always looked "not starting").
  const startTokenRef = useRef<object | null>(null);

  const threshold = vadThresholds(Math.max(0, Math.min(1, sensitivity))).positive;
  const over = state === "live" && prob >= threshold;

  async function teardown(): Promise<void> {
    runningRef.current = false;
    startTokenRef.current = null;
    const vad = vadRef.current;
    vadRef.current = null;
    if (!vad) return;
    try {
      // vad-web MicVAD: destroy() stops its own-grant stream + frees ORT.
      if (typeof vad.destroy === "function") vad.destroy();
      else if (typeof vad.pause === "function") vad.pause();
    } catch {
      /* best-effort teardown */
    }
    /* destroy() terminates ORT's threaded-backend worker pool but leaves
     * the shared getVadModule() singleton flagged configured=true. Without
     * this reset the next MicVAD.new - in the main voice panel OR a second
     * tuner run - lands on the dead pthread shim and cascades into
     * "no available backend found ... RangeError: Out of memory ...
     * previous call to 'initWasm()' failed." VoiceClient already resets on
     * every teardown/error path; the tuner has to do the same or it
     * poisons ORT for the whole tab. See lib/voice-ort-config.ts. */
    resetVadModuleCache();
  }

  async function start(): Promise<void> {
    if (runningRef.current) return;
    const token = {};
    startTokenRef.current = token;
    setState("starting");
    setErrorMsg(null);
    setProb(0);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mod = (await getVadModule()) as any;
      const opts = buildVadOptionSet(sensitivity, REDEMPTION_MS);
      const vad = await mod.MicVAD.new({
        baseAssetPath: "/vad/",
        onnxWASMBasePath: "/vad/",
        positiveSpeechThreshold: opts.positiveSpeechThreshold,
        negativeSpeechThreshold: opts.negativeSpeechThreshold,
        redemptionMs: opts.redemptionMs,
        preSpeechPadMs: opts.preSpeechPadMs,
        minSpeechMs: opts.minSpeechMs,
        onFrameProcessed: (probs: { isSpeech: number }) => {
          if (!runningRef.current) return;
          const p = typeof probs?.isSpeech === "number" ? probs.isSpeech : 0;
          // light exponential smoothing so the bar reads cleanly
          setProb((prev) => prev * 0.4 + p * 0.6);
        },
      });
      if (startTokenRef.current !== token) {
        // stopped / unmounted mid-init
        try {
          vad.destroy?.();
        } catch {
          /* ignore */
        }
        return;
      }
      vadRef.current = vad;
      runningRef.current = true;
      vad.start();
      setState("live");
    } catch (err) {
      await teardown();
      setState("error");
      setErrorMsg(
        err instanceof Error && /permission|denied|notallowed/i.test(err.message)
          ? "Mic permission denied. Allow the mic and try again."
          : "Could not open the mic. Is it in use or blocked?",
      );
    }
  }

  async function stop(): Promise<void> {
    await teardown();
    setState("idle");
    setProb(0);
  }

  // Stop on unmount so we never leak the mic.
  useEffect(() => {
    return () => {
      void teardown();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const live = state === "live";
  const pct = Math.max(0, Math.min(100, prob * 100));
  const threshPct = Math.max(0, Math.min(100, threshold * 100));

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm text-txt1 font-emphasized">Tune mic</span>
        <button
          type="button"
          onClick={() => (live || state === "starting" ? void stop() : void start())}
          disabled={state === "starting"}
          className={`text-xs font-emphasized px-3 h-8 rounded-input hairline transition-colors disabled:opacity-50 ${
            live
              ? "bg-brandSoft text-white border-transparent"
              : "bg-surface2 text-brand hover:bg-surface2/80"
          }`}
        >
          {state === "starting" ? "starting…" : live ? "Stop" : "Test mic"}
        </button>
      </div>

      <p className="text-nano text-txt3 leading-relaxed">
        Watch the live level. Keep quiet: background should stay left of the
        red trigger line. Then talk: your voice should cross it. Adjust the
        sensitivity slider above until that holds.
      </p>

      {state === "error" && (
        <p className="text-nano text-err leading-relaxed">{errorMsg}</p>
      )}

      <div className={live ? "" : "opacity-45"}>
        <div className="flex items-center justify-between text-nano font-mono text-txt3 mb-1">
          <span>silence</span>
          <span>speech detected →</span>
        </div>
        <div
          className="relative h-9 rounded-input bg-surface2 hairline overflow-hidden"
          role="meter"
          aria-valuemin={0}
          aria-valuemax={1}
          aria-valuenow={Number(prob.toFixed(2))}
          aria-label="Live mic speech level"
        >
          <div
            className="absolute inset-y-0 left-0 rounded-l-input"
            style={{
              width: `${pct}%`,
              background: over
                ? "linear-gradient(90deg,#e0a33a,#e2555a)"
                : "linear-gradient(90deg,#3a8f6f,#4f9e7f)",
              transition: "width 80ms linear",
            }}
          />
          <div
            className="absolute inset-y-0 w-0.5 bg-err"
            style={{ left: `${threshPct}%` }}
            aria-hidden
          />
        </div>
        <div className="flex items-center justify-between text-nano font-mono text-nano text-txt3 mt-1">
          <span>0.0</span>
          <span>trigger @ {threshold.toFixed(2)}</span>
          <span>1.0</span>
        </div>
      </div>

      <div className="flex items-center gap-2 text-xs pt-0.5" aria-live="polite">
        <span
          className="inline-block w-2.5 h-2.5 rounded-full transition-colors"
          style={{
            background: over ? "#e2555a" : "var(--txt3, #6b7688)",
            boxShadow: over ? "0 0 8px #e2555a" : "none",
          }}
          aria-hidden
        />
        <span className="text-txt2">
          {!live ? (
            "Idle. Press Test mic to see the live level."
          ) : over ? (
            <span className="text-err font-emphasized">
              TRIGGER — this sound would start a turn.
            </span>
          ) : (
            "Listening. Below the trigger line."
          )}
        </span>
      </div>
    </div>
  );
}
