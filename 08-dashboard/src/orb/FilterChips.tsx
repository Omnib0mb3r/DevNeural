"use client";

import type { UnifiedNodeKind } from "./types";

export interface FilterState {
  brainstorm: boolean;
  wiki: boolean;
  project: boolean;
  meeting: boolean;
}

interface FilterChipsProps {
  filters: FilterState;
  onChange: (next: FilterState) => void;
}

const CHIPS: { kind: UnifiedNodeKind; label: string }[] = [
  { kind: "brainstorm", label: "brainstorms" },
  { kind: "wiki",       label: "wiki" },
  { kind: "project",    label: "projects" },
  { kind: "meeting",    label: "meetings" },
];

export function FilterChips({ filters, onChange }: FilterChipsProps) {
  function toggle(kind: UnifiedNodeKind) {
    onChange({ ...filters, [kind]: !filters[kind] });
  }

  return (
    <div className="flex items-center gap-1">
      {CHIPS.map(({ kind, label }) => {
        const active = filters[kind];
        return (
          <button
            key={kind}
            type="button"
            onClick={() => toggle(kind)}
            aria-pressed={active}
            className={`font-mono px-2 py-0.5 rounded-pill text-nano transition ${
              active
                ? "bg-brand/20 text-brandSoft ring-1 ring-brand/40"
                : "text-txt3 hover:text-txt1"
            }`}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
