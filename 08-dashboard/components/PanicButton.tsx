"use client";

/**
 * Global panic button (PANIC-BUTTON.md step 4 + 5).
 *
 * Sits in the dashboard top bar next to the voice stop control. One
 * click sends \x1b\x1b to the daemon's resolved single-target anchor
 * via POST /panic. Three visual states:
 *   - idle:     red outline, ready to fire
 *   - firing:   solid red pulse for ~250ms, disabled
 *   - cooldown: 1s lockout after fire to prevent double-tap
 *
 * Also wires the global keybind Ctrl+Alt+. (period) so the panic fires
 * even when focus is on a Steer textarea or somewhere else on the page.
 * The keybind ignores keydown events that originate inside an input,
 * textarea, or contentEditable so typing a period doesn't trigger it
 * accidentally.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { firePanic, type PanicResponse } from "@/lib/daemon-client";
import { Icon } from "./Icon";

type Phase = "idle" | "firing" | "cooldown";

const FIRING_MS = 250;
const COOLDOWN_MS = 1000;

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (el.isContentEditable) return true;
  return false;
}

export function PanicButton(): React.ReactElement {
  const [phase, setPhase] = useState<Phase>("idle");
  const [lastResult, setLastResult] = useState<PanicResponse["result"] | null>(
    null,
  );
  const inFlight = useRef<boolean>(false);

  const fire = useCallback(async (caller: string) => {
    if (inFlight.current) return;
    if (phase !== "idle") return;
    inFlight.current = true;
    setPhase("firing");
    try {
      const r = await firePanic(caller);
      setLastResult(r.result);
    } catch {
      setLastResult("no_target");
    } finally {
      setTimeout(() => {
        setPhase("cooldown");
        setTimeout(() => {
          setPhase("idle");
          inFlight.current = false;
        }, COOLDOWN_MS - FIRING_MS);
      }, FIRING_MS);
    }
  }, [phase]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!e.ctrlKey || !e.altKey) return;
      if (e.key !== ".") return;
      if (isTypingTarget(e.target)) return;
      e.preventDefault();
      void fire("dashboard-keybind");
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fire]);

  const disabled = phase !== "idle";
  const baseTitle =
    "Send double-ESC to active worker (interrupt current tool / generation). Keybind: Ctrl+Alt+.";
  const resultTitle =
    lastResult === "accepted"
      ? `${baseTitle} - last fire: accepted`
      : lastResult === "no_target"
        ? `${baseTitle} - last fire: no live worker`
        : lastResult === "pty_not_found"
          ? `${baseTitle} - last fire: pty not found`
          : baseTitle;

  return (
    <div className="flex items-center gap-1.5">
      <button
        type="button"
        onClick={() => void fire("dashboard")}
        disabled={disabled}
        aria-label="Emergency stop active worker"
        title={resultTitle}
        className={`lift relative w-9 h-9 rounded-card hairline grid place-items-center transition ${
          phase === "firing"
            ? "bg-err text-base ring-1 ring-err/60 animate-pulse"
            : phase === "cooldown"
              ? "bg-err/10 text-err/50 ring-1 ring-err/20 cursor-not-allowed"
              : "bg-transparent text-err ring-1 ring-err/40 hover:bg-err/10"
        }`}
      >
        <Icon name="OctagonAlert" size={16} />
      </button>
      {/* Visible keybind hint. Matches the top-bar kbd scale used by the
       * command-palette search button. Hidden below md so narrow
       * viewports keep the right-cluster controls on screen. */}
      <kbd
        aria-hidden="true"
        className="hidden md:inline-flex items-center gap-1 px-1.5 h-5 rounded border border-border1 bg-surface2 text-[11px] font-mono text-txt2"
      >
        Ctrl+Alt+.
      </kbd>
    </div>
  );
}
