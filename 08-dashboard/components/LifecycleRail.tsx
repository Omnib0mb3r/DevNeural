"use client";

/* Project lifecycle rail (spec item 8 scaffold, 2026-06-20).
 *
 * Static, additive preview of the gated lifecycle: a stage stepper + a
 * per-stage panel stub. NO live actions, NO backend wiring - selecting a
 * stage only swaps the local panel stub. Mirrors the backend ProjectStage
 * model (07-daemon/src/lex/project-lifecycle.ts). The real stage source
 * (project_session.stage), gate exit criteria, and stage-aware greeting
 * wire in a later phase. This component does not touch ProjectsGrid or the
 * open-sessions live view. */
import { useState } from "react";

interface StageStub {
  key: string;
  label: string;
  blurb: string;
}

const STAGES: StageStub[] = [
  {
    key: "new_project",
    label: "New Project",
    blurb: "Intake: name, topology, technology, target outcome, scope.",
  },
  {
    key: "spec",
    label: "Spec",
    blurb: "Brainstorm until the plan is dialed in (framework + decisions).",
  },
  {
    key: "tdd",
    label: "TDD",
    blurb: "Plan becomes tests + a definition of passing, result-level.",
  },
  {
    key: "execution",
    label: "Execution",
    blurb: "Lex drives the worker through the plan.",
  },
  {
    key: "test",
    label: "Test",
    blurb: "Drive to green: all tests pass and the real metric moves.",
  },
  {
    key: "bug_handling",
    label: "Bug handling",
    blurb: "Triage + close; meta-loop on wrong tests; done when clean.",
  },
];

export function LifecycleRail() {
  const [selected, setSelected] = useState(0);
  const stage = STAGES[selected];

  return (
    <div className="space-y-4">
      <div className="text-[10px] uppercase tracking-wider text-white/40">
        Lifecycle (scaffold - not wired)
      </div>

      {/* Stage stepper / rail */}
      <div className="flex items-center gap-1 overflow-x-auto pb-1">
        {STAGES.map((st, i) => (
          <div key={st.key} className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              onClick={() => setSelected(i)}
              className={`h-8 px-3 rounded-card text-xs hairline ring-1 transition-colors ${
                i === selected
                  ? "bg-brand/15 ring-brand/40 text-brandSoft font-emphasized"
                  : "ring-white/10 text-white/55 hover:text-white"
              }`}
            >
              <span className="opacity-50 mr-1">{i + 1}</span>
              {st.label}
            </button>
            {i < STAGES.length - 1 && (
              <span className="text-white/25 select-none">{"->"}</span>
            )}
          </div>
        ))}
      </div>

      {/* Per-stage panel stub */}
      <div className="rounded-card hairline ring-1 ring-white/10 p-4 space-y-2">
        <div className="font-emphasized text-sm">{stage.label}</div>
        <div className="text-xs text-white/55">{stage.blurb}</div>
        <div className="text-[11px] text-amber-300/70">
          Stub: gate exit criterion and live actions are not wired yet
          (next phase).
        </div>
      </div>
    </div>
  );
}
