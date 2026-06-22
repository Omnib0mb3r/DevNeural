"use client";

/* Project lifecycle rail (DRIVE-QUEUE 3: wired to live data).
 *
 * Renders the gated lifecycle stepper. When the page passes live stage +
 * gate data (from GET /lex/lifecycle) the rail marks the project's CURRENT
 * stage, defaults the inspected panel to it, and shows the runnable gate
 * status + what the gate needs next. With no live data (empty cold start
 * or daemon offline) it renders the "New Project" stage as the default,
 * matching the scaffold. Additive: this component does not touch
 * ProjectsGrid or the open-sessions live view. */
import { useEffect, useState } from "react";
import {
  LIFECYCLE_STAGES,
  stageIndex,
} from "@/lib/lifecycle-stages";
import type { LifecycleGate } from "@/lib/daemon-client";

interface LifecycleRailProps {
  /** Live effective stage key. Undefined = no live data (scaffold). */
  currentStage?: string;
  gate?: LifecycleGate;
  canAdvance?: boolean;
  nextLabel?: string | null;
  needs?: string;
  loading?: boolean;
}

export function LifecycleRail({
  currentStage,
  gate,
  canAdvance,
  nextLabel,
  needs,
  loading,
}: LifecycleRailProps) {
  /* Empty cold start defaults to New Project; live data marks the real
   * stage. The inspected panel defaults to the current stage. */
  const currentIdx = Math.max(0, stageIndex(currentStage ?? "new_project"));
  const [selected, setSelected] = useState(currentIdx);
  useEffect(() => {
    setSelected(currentIdx);
  }, [currentIdx]);

  const stage = LIFECYCLE_STAGES[selected]!;
  const isLive = currentStage !== undefined;
  const inspectingCurrent = selected === currentIdx;

  return (
    <div className="space-y-4">
      <div className="text-[10px] uppercase tracking-wider text-white/40">
        {loading
          ? "Lifecycle (loading…)"
          : isLive
            ? "Lifecycle"
            : "Lifecycle (cold start)"}
      </div>

      {/* Stage stepper / rail */}
      <div className="flex items-center gap-1 overflow-x-auto pb-1">
        {LIFECYCLE_STAGES.map((st, i) => {
          const isCurrent = isLive && i === currentIdx;
          const isSelected = i === selected;
          return (
            <div key={st.key} className="flex items-center gap-1 shrink-0">
              <button
                type="button"
                onClick={() => setSelected(i)}
                aria-current={isCurrent ? "step" : undefined}
                className={`h-8 px-3 rounded-card text-xs hairline ring-1 transition-colors ${
                  isSelected
                    ? "bg-brand/15 ring-brand/40 text-brandSoft font-emphasized"
                    : isCurrent
                      ? "ring-emerald-400/40 text-emerald-200"
                      : "ring-white/10 text-white/55 hover:text-white"
                }`}
              >
                <span className="opacity-50 mr-1">{i + 1}</span>
                {st.label}
                {isCurrent && <span className="ml-1 text-emerald-300">●</span>}
              </button>
              {i < LIFECYCLE_STAGES.length - 1 && (
                <span className="text-white/25 select-none">{"->"}</span>
              )}
            </div>
          );
        })}
      </div>

      {/* Per-stage panel */}
      <div className="rounded-card hairline ring-1 ring-white/10 p-4 space-y-2">
        <div className="font-emphasized text-sm flex items-center gap-2">
          {stage.label}
          {isLive && inspectingCurrent && (
            <span className="text-[10px] uppercase tracking-wide text-emerald-300/80">
              current
            </span>
          )}
        </div>
        <div className="text-xs text-white/55">{stage.blurb}</div>

        {isLive && inspectingCurrent && gate ? (
          <div className="space-y-1 pt-1">
            <div
              className={`text-[11px] ${
                gate.satisfied ? "text-emerald-300/80" : "text-amber-300/80"
              }`}
            >
              Gate: {gate.satisfied ? "satisfied" : "not satisfied"} —{" "}
              {gate.reason}
            </div>
            {nextLabel && (
              <div className="text-[11px] text-white/50">
                {canAdvance ? "Ready to advance to" : "Next gate"} {"->"}{" "}
                {nextLabel}
                {!canAdvance && needs ? `: needs ${needs}` : ""}
              </div>
            )}
          </div>
        ) : !isLive ? (
          <div className="text-[11px] text-white/40">
            No live project selected. Pick a project to see its stage + gate.
          </div>
        ) : (
          <div className="text-[11px] text-white/40">
            Inspecting a non-current stage (gate status shown on the current
            stage).
          </div>
        )}
      </div>
    </div>
  );
}
