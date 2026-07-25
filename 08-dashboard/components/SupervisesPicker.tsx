"use client";

/**
 * Phase C-3: project-anchor picker for brainstorm-to-project binding.
 *
 * One-source-of-truth for the supervises_project_anchor_id dropdown.
 * Reused by:
 *   - LexSessionList's "new brainstorm" inline form (bind on create)
 *   - LexSessionList per-row binding chip (PATCH existing)
 *   - BrainstormDetail's supervision section (PATCH existing)
 *
 * Caller passes the current binding (string | null), an onChange
 * callback (string | null) → void, and an optional `disabled` flag
 * for in-flight mutations. The component itself is purely
 * controlled: it does not mutate or fetch on its own. Project
 * anchors are loaded once via listProjectAnchorTiles and cached by
 * react-query so several pickers on the same page share the lookup.
 */
import { useQuery } from "@tanstack/react-query";
import { listProjectAnchorTiles, type ProjectAnchorTile } from "@/lib/daemon-client";

interface Props {
  value: string | null;
  onChange: (next: string | null) => void;
  disabled?: boolean;
  /* Render compactly (used inline in past-sessions rows). When
   * false the picker is the full-width control used by the
   * new-brainstorm form and the brainstorm detail page. */
  compact?: boolean;
  /* Optional test seam: callers can pass a pre-loaded list to
   * skip the network call. Used by the LexSessionList smoke test
   * so the picker renders synchronously. */
  options?: ProjectAnchorTile[];
}

export function SupervisesPicker({
  value,
  onChange,
  disabled,
  compact,
  options,
}: Props) {
  const q = useQuery({
    queryKey: ["project-anchor-tiles"],
    queryFn: () => listProjectAnchorTiles({ status: "all" }),
    /* The picker is mounted in a few places that re-render on a
     * timer (live row). Stretch the refetch interval so an open
     * dropdown does not lose focus on every dashboard tick. */
    refetchInterval: 30_000,
    /* When the caller supplies options, skip the query entirely
     * so tests can render synchronously. */
    enabled: options === undefined,
  });
  const tiles: ProjectAnchorTile[] = options ?? q.data?.tiles ?? [];
  const sizing = compact
    ? "text-nano px-1.5 py-0.5"
    : "text-xs px-2 py-1.5";
  return (
    <select
      aria-label="Supervises project"
      data-testid="supervises-picker"
      value={value ?? ""}
      disabled={disabled}
      onChange={(e) => {
        const next = e.target.value;
        onChange(next === "" ? null : next);
      }}
      className={`${sizing} rounded-input bg-surface2 hairline text-txt1 outline-none focus:ring-1 focus:ring-brand/60 disabled:opacity-40`}
    >
      <option value="">(no project)</option>
      {tiles.map((t) => {
        const label = t.title?.trim() || t.project_slug;
        const suffix = t.status === "live" ? " · live" : " · offline";
        return (
          <option key={t.anchor_id} value={t.anchor_id}>
            {label}
            {suffix}
          </option>
        );
      })}
    </select>
  );
}
