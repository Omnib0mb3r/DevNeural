"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  projects as projectsClient,
  sessions as sessionsClient,
  listProjectAnchorTiles,
  type ProjectAnchorTile,
} from "@/lib/daemon-client";
import { sessionsByProject } from "@/lib/session-helpers";
import { Icon } from "./Icon";
import { StatusDot } from "./StatusDot";
import { SupervisionModeToggle } from "./SupervisionModeToggle";

function relTimeIso(ts: string | undefined): string {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  const diffS = Math.max(0, (Date.now() - d.getTime()) / 1000);
  if (diffS < 60) return `${Math.round(diffS)}s`;
  if (diffS < 3600) return `${Math.round(diffS / 60)}m`;
  if (diffS < 86400) return `${Math.round(diffS / 3600)}h`;
  return `${Math.round(diffS / 86400)}d`;
}

interface Props {
  /** When set, render fewer rows in a tighter grid for embedding inside the
   * home view. Otherwise full grid for the /projects route. */
  compact?: boolean;
  /** Cap how many projects to show in compact mode. */
  limit?: number;
}

function normalizeCwd(cwd: string | undefined): string {
  return (cwd ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function ProjectsGrid({ compact = false, limit }: Props = {}) {
  const qc = useQueryClient();
  const projQ = useQuery({
    queryKey: ["projects"],
    queryFn: projectsClient,
    refetchInterval: 30_000,
  });
  const sessQ = useQuery({
    queryKey: ["sessions"],
    queryFn: sessionsClient,
    refetchInterval: 5_000,
  });
  /* Anchor feed carries supervision_mode + status + phase. Joined to
   * the legacy project record by lowercased cwd so the toggle only
   * renders on tiles that map to a known anchor. */
  const anchorsQ = useQuery({
    queryKey: ["project-anchor-tiles"],
    queryFn: listProjectAnchorTiles,
    refetchInterval: 10_000,
  });
  const anchorByCwd = new Map<string, ProjectAnchorTile>();
  for (const t of anchorsQ.data?.tiles ?? []) {
    anchorByCwd.set(normalizeCwd(t.cwd), t);
  }

  const all = projQ.data?.projects ?? [];
  const sessByProject = sessionsByProject(sessQ.data?.sessions ?? []);
  // Compact: most-recently-active first, capped.
  const cap = limit ?? (compact ? 6 : Infinity);
  const list = compact
    ? [...all]
        .sort((a, b) => Date.parse(b.last_seen) - Date.parse(a.last_seen))
        .slice(0, cap)
    : all;

  const cols = compact ? "grid-cols-2" : "grid-cols-3";

  if (projQ.isLoading) {
    return (
      <div className={`grid ${cols} gap-3`}>
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            className="h-20 rounded-card bg-surface1 hairline animate-pulse"
          />
        ))}
      </div>
    );
  }

  if (all.length === 0) {
    return (
      <div className={compact ? "py-3 text-center" : "rounded-panel bg-surface1 hairline p-10 text-center"}>
        {!compact && <Icon name="FolderPlus" className="text-brandSoft mx-auto mb-3" size={32} />}
        {!compact && (
          <h3 className="font-display text-md font-emphasized mb-1">
            No projects registered yet.
          </h3>
        )}
        <p className="text-txt3 text-sm">
          {compact
            ? "No projects yet. Run a Claude session in any DevNeural-aware repo to auto-register."
            : "Hit \"new project\" above, or run a Claude session in any DevNeural-aware repo on OTLCDEV; it auto-registers."}
        </p>
      </div>
    );
  }

  return (
    <div className={`grid ${cols} gap-3`}>
      {list.map((p) => {
        // Match by both id and name since session slugs decode to varying forms.
        const liveSessions = sessByProject.get(p.name) ?? sessByProject.get(p.id) ?? 0;
        const anchor = anchorByCwd.get(normalizeCwd(p.root));
        const dim = anchor?.supervision_mode === "off";
        return (
          <div
            key={p.id}
            data-testid="projects-grid-tile"
            data-anchor-id={anchor?.anchor_id ?? ""}
            data-supervision-mode={anchor?.supervision_mode ?? ""}
            className={`rounded-card bg-surface1 hairline lift p-4 cursor-pointer transition min-w-0 overflow-hidden ${
              dim ? "opacity-60" : ""
            }`}
          >
            <div className="flex items-center justify-between mb-2">
              <div className="font-display text-sm font-emphasized truncate">
                {p.name}
              </div>
              {liveSessions > 0 && (
                <span className="inline-flex items-center gap-1 text-[11px] font-mono text-live">
                  <StatusDot status="live" pulse /> {liveSessions}
                </span>
              )}
            </div>
            <div className="text-nano text-txt3 truncate" title={p.root}>
              {p.root}
            </div>
            <div className="mt-2 flex items-center justify-between text-[11px] font-mono text-txt3">
              <span className="truncate" title={p.remote ?? "no remote"}>
                {p.remote ? new URL(p.remote.replace(/^git@([^:]+):/, "https://$1/")).pathname.replace(/^\//, "").replace(/\.git$/, "") : "no remote"}
              </span>
              <span>{relTimeIso(p.last_seen)} ago</span>
            </div>
            {anchor && (
              <div className="mt-3 pt-2 border-t border-border2 flex items-center justify-between gap-2 min-w-0">
                <span className="text-nano text-txt3 uppercase tracking-wider shrink-0">
                  supervision
                </span>
                <SupervisionModeToggle
                  anchorId={anchor.anchor_id}
                  initialMode={anchor.supervision_mode}
                  onChange={() =>
                    qc.invalidateQueries({
                      queryKey: ["project-anchor-tiles"],
                    })
                  }
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
