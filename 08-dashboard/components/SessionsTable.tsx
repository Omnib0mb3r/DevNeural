"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  sessions as sessionsClient,
  startClaude,
  type IdleProject,
  type SessionSummary,
} from "@/lib/daemon-client";
import { projectFromSlug, relTime } from "@/lib/session-helpers";
import { Icon } from "./Icon";
import { StatusDot } from "./StatusDot";

const STALE_HIDE_MS = 7 * 24 * 60 * 60 * 1000;

export function SessionsTable() {
  const qc = useQueryClient();
  const router = useRouter();
  const q = useQuery({
    queryKey: ["sessions"],
    queryFn: sessionsClient,
    refetchInterval: 5_000,
  });
  const [showIdle, setShowIdle] = useState(false);
  const [showStale, setShowStale] = useState(false);
  /* Track in-flight start-claude posts per project so the button
   * disables + shows "starting…" until the bridge claims the marker
   * (visible as a new live session row appearing). Reset on success.
   *
   * Fix 39 (2026-05-26): single button. The pre-fix UI had a second
   * "Start (skip permissions)" affordance that flipped dangerous=true
   * for the daemon. Workers no longer accept that flag; the button is
   * dead. Pending-start state collapses to a Set<projectId>. */
  const [pendingStart, setPendingStart] = useState<Set<string>>(new Set());
  const startMutation = useMutation({
    mutationFn: (id: string) => startClaude(id),
    onMutate: (id) => {
      setPendingStart((prev) => {
        const next = new Set(prev);
        next.add(id);
        return next;
      });
    },
    onSettled: (_data, _err, id) => {
      setPendingStart((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      qc.invalidateQueries({ queryKey: ["sessions"] });
    },
  });

  const list: SessionSummary[] = q.data?.sessions ?? [];
  const idleProjects: IdleProject[] = q.data?.idle_projects ?? [];
  const now = Date.now();
  const active = list.filter((s) => s.active);
  const idle = list.filter((s) => !s.active && now - s.last_modified_ms < STALE_HIDE_MS);
  const stale = list.filter((s) => !s.active && now - s.last_modified_ms >= STALE_HIDE_MS);
  const sortByRecency = (a: SessionSummary, b: SessionSummary) =>
    b.last_modified_ms - a.last_modified_ms;
  const visible = [
    ...active.slice().sort(sortByRecency),
    ...(showIdle ? idle.slice().sort(sortByRecency) : []),
    ...(showStale ? stale.slice().sort(sortByRecency) : []),
  ];

  return (
    <div className="rounded-panel bg-surface1 hairline overflow-hidden">
      <div className="px-5 py-3 border-b border-border1 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon name="Terminal" className="text-brandSoft" size={16} />
          <h2 className="font-display text-sm font-emphasized">Sessions on OTLCDEV</h2>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-nano text-txt3">
            {active.length} active · {visible.length} shown
          </span>
          {idle.length > 0 && (
            <button
              onClick={() => setShowIdle((v) => !v)}
              className="text-nano text-txt3 hover:text-txt1"
              aria-expanded={showIdle}
            >
              {showIdle ? `Hide ${idle.length} idle` : `+${idle.length} idle`}
            </button>
          )}
          {stale.length > 0 && (
            <button
              onClick={() => setShowStale((v) => !v)}
              className="text-nano text-txt3 hover:text-txt1"
              aria-expanded={showStale}
            >
              {showStale ? `Hide ${stale.length} stale` : `+${stale.length} stale`}
            </button>
          )}
        </div>
      </div>

      {q.isLoading && (
        <div className="p-6 space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-12 rounded-card bg-surface2 animate-pulse" />
          ))}
        </div>
      )}

      {!q.isLoading && visible.length === 0 && idleProjects.length === 0 && (
        <div className="p-8 text-center text-txt3 text-sm">
          No Claude sessions captured yet. Open a Claude Code terminal in any VS Code window on
          OTLCDEV, type one prompt, then refresh.
        </div>
      )}

      {idleProjects.length > 0 && (
        <div className="border-b border-border1">
          <div className="px-5 py-2 text-nano text-txt3 uppercase tracking-[0.16em]">
            Ready to start ({idleProjects.length})
          </div>
          <ul className="divide-y divide-border2">
            {idleProjects.map((p) => {
              const pending = pendingStart.has(p.id);
              return (
                <li
                  key={p.id}
                  className="px-5 py-3 flex items-center justify-between gap-3"
                >
                  <div className="min-w-0">
                    <div className="text-sm text-txt1 font-emphasized truncate">
                      {p.name}
                    </div>
                    <div className="text-nano text-txt3 font-mono truncate">
                      {p.root}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => startMutation.mutate(p.id)}
                      className="px-3 py-1.5 text-xs font-emphasized rounded-pill bg-surface2 hairline hover:bg-surface3 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {pending ? "starting…" : "Start Claude"}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {visible.length > 0 && (
        <table className="w-full">
          <thead>
            <tr className="text-left text-nano text-txt3 border-b border-border2">
              <th className="px-5 py-2 font-normal">Project</th>
              <th className="px-3 py-2 font-normal">Session ID</th>
              <th className="px-3 py-2 font-normal">Status</th>
              <th className="px-3 py-2 font-normal">Captured state</th>
              <th className="px-5 py-2 font-normal text-right">Last activity</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((s) => {
              const href = `/sessions/detail?id=${encodeURIComponent(s.session_id)}`;
              return (
                <tr
                  key={s.session_id}
                  className="border-b border-border2 lift cursor-pointer"
                  onClick={() => router.push(href)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      router.push(href);
                    }
                  }}
                  tabIndex={0}
                  role="link"
                  aria-label={`Open session ${projectFromSlug(s.project_slug)}`}
                >
                  <td className="px-5 py-3">
                    {/* Real link kept inside the cell so keyboard nav, screen
                     * readers, middle-click "open in new tab", and right-click
                     * "copy link" all keep working. The row's onClick handles
                     * tap-anywhere behavior on top of that. */}
                    <Link
                      href={href}
                      onClick={(e) => e.stopPropagation()}
                      className="text-txt1 hover:text-brandSoft font-emphasized text-sm"
                    >
                      {projectFromSlug(s.project_slug)}
                    </Link>
                  </td>
                  <td className="px-3 py-3 font-mono text-xs text-txt3">
                    {s.session_id.slice(0, 12)}
                  </td>
                  <td className="px-3 py-3">
                    <span className="inline-flex items-center gap-1.5 text-xs">
                      <StatusDot status={s.active ? "live" : "idle"} pulse={s.active} />
                      {s.active ? "active" : "idle"}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-xs text-txt2">
                    <span className="inline-flex items-center gap-2">
                      {s.has_task && (
                        <span className="inline-flex items-center gap-1 text-[11px] font-mono text-txt3">
                          <Icon name="ListTodo" size={12} /> task
                        </span>
                      )}
                      {s.has_summary && (
                        <span className="inline-flex items-center gap-1 text-[11px] font-mono text-txt3">
                          <Icon name="ScrollText" size={12} /> summary
                        </span>
                      )}
                      {!s.has_task && !s.has_summary && <span className="text-txt3">—</span>}
                    </span>
                  </td>
                  <td className="px-5 py-3 text-right text-[11px] font-mono text-txt3">
                    {relTime(s.last_modified_ms)} ago
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
