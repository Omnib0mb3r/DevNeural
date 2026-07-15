"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  reminders as remindersClient,
  notifications as notificationsClient,
  completeReminder,
  dismissNotification,
  correctWikiPage,
} from "@/lib/daemon-client";
import { Icon } from "./Icon";
import { StatusDot } from "./StatusDot";
import { lexMotd } from "@/lib/lex";

type ActivityFilter = "all" | "info" | "warn" | "alert";
const FILTER_CYCLE: ActivityFilter[] = ["all", "info", "warn", "alert"];

export function RightRail() {
  const qc = useQueryClient();
  const router = useRouter();
  const [filter, setFilter] = useState<ActivityFilter>("all");
  const remQ = useQuery({
    queryKey: ["reminders"],
    queryFn: remindersClient,
    refetchInterval: 30_000,
  });
  const notQ = useQuery({
    queryKey: ["notifications", "recent"],
    queryFn: () => notificationsClient(30),
    refetchInterval: 8_000,
  });
  const toggleM = useMutation({
    mutationFn: ({ id, complete }: { id: string; complete: boolean }) =>
      completeReminder(id, complete),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["reminders"] }),
  });
  const dismissM = useMutation({
    /* Activity-rail dismiss only affects this surface; the bell keeps
     * the same notification until acknowledged there separately. */
    mutationFn: (id: string) => dismissNotification(id, "activity"),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["notifications", "recent"] }),
  });
  const correctM = useMutation({
    mutationFn: async (vars: { notifId: string; pageId: string }) => {
      const r = await correctWikiPage(vars.pageId);
      await dismissNotification(vars.notifId, "activity");
      return r;
    },
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["notifications", "recent"] }),
  });

  const openReminders = (remQ.data?.reminders ?? []).filter(
    (r) => !r.completed_at && !r.archived_at,
  );
  /* Activity rail = brain stream only. System notifications stay in
   * the bell. Per-scope dismiss tracking means clearing here doesn't
   * touch the bell row.
   *   curator       - wiki-page injection events
   *   reinforcement - hit / no-hit / correction signals
   *   recap         - "※ recap:" lines forwarded from the user's shell
   *   lex           - Claude's last assistant turn (questions + summaries)
   *                   surfaced on Stop so the user can monitor remotely
   *                   without tabbing back to the VS Code window */
  const ACTIVITY_SOURCES = new Set(["curator", "reinforcement", "recap", "lex"]);
  const allEvents = (notQ.data?.notifications ?? []).filter(
    (n) =>
      ACTIVITY_SOURCES.has(n.source) &&
      !(n.dismissed_scopes ?? []).includes("activity"),
  );
  const events = (filter === "all"
    ? allEvents
    : allEvents.filter((n) => n.severity === filter)
  ).slice(0, 12);

  function cycleFilter(): void {
    const idx = FILTER_CYCLE.indexOf(filter);
    setFilter(FILTER_CYCLE[(idx + 1) % FILTER_CYCLE.length] ?? "all");
  }

  return (
    <aside className="w-80 flex-shrink-0 flex flex-col gap-4 p-4 hairline-soft border-l border-border2 overflow-y-auto">
      {/* Lex MOTD — stable per UTC day, no dismiss. Sets the tone before
       * the user looks at reminders or the activity feed. */}
      <section className="rounded-card bg-surface1 hairline px-4 py-3">
        <div className="flex items-center gap-2 text-nano text-txt3 uppercase tracking-[0.16em]">
          <span className="w-1.5 h-1.5 rounded-pill bg-brand" />
          Lex
        </div>
        <p className="mt-1.5 text-[12px] leading-relaxed text-txt2 italic">
          {lexMotd().replace(/^Lex says:\s*/, "")}
        </p>
      </section>

      {/* reminders */}
      <section className="rounded-card bg-surface1 hairline">
        <div className="px-4 py-3 border-b border-border1 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Icon name="ListChecks" className="text-brandSoft" size={16} />
            <h2 className="font-display text-sm font-emphasized">Reminders</h2>
          </div>
          <span className="text-nano text-txt3">
            {remQ.isError ? "—" : `${openReminders.length} open`}
          </span>
        </div>
        <ul className="divide-y divide-border2">
          {remQ.isError ? (
            <li className="px-4 py-3 text-xs text-err">Daemon not reachable.</li>
          ) : (
            openReminders.length === 0 && (
              <li className="px-4 py-3 text-xs text-txt3">All caught up.</li>
            )
          )}
          {!remQ.isError && openReminders.slice(0, 6).map((r) => (
            <li
              key={r.id}
              className="px-4 py-2.5 flex items-center gap-2.5 lift cursor-pointer"
            >
              <input
                type="checkbox"
                aria-label={`Mark ${r.title} complete`}
                onChange={(e) =>
                  toggleM.mutate({ id: r.id, complete: e.target.checked })
                }
                className="w-3.5 h-3.5 accent-brand bg-surface1"
              />
              <span className="flex-1 truncate text-txt2">{r.title}</span>
              {r.due_at && (
                <span className="text-[11px] font-mono text-txt3">
                  {new Date(r.due_at).toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                  })}
                </span>
              )}
            </li>
          ))}
        </ul>
      </section>

      {/* curator feed */}
      <section className="rounded-card bg-surface1 hairline">
        <div className="px-4 py-3 border-b border-border1 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Icon name="Brain" className="text-brandSoft" size={16} />
            <h2 className="font-display text-sm font-emphasized">Curator feed</h2>
          </div>
          <button
            type="button"
            onClick={cycleFilter}
            className="text-[11px] font-mono text-txt3 hover:text-txt1 flex items-center gap-1"
            aria-label={`Filter curator feed (current: ${filter}). Click to cycle.`}
            title="Click to cycle: all → info → warn → alert"
          >
            <Icon name="Filter" size={12} /> {filter}
          </button>
        </div>
        <ul className="divide-y divide-border2">
          {events.length === 0 && (
            <li className="px-4 py-3 text-xs text-txt3 feed-item">
              {filter === "all"
                ? "Lex is reading along. Nothing in the wiki has matched your prompts yet."
                : filter === "info"
                  ? "No injections recently. Either Lex hasn't found a match or you're working on something genuinely new."
                  : filter === "warn"
                    ? "No corrections lately. Either Lex is on point or you haven't told it otherwise."
                    : "Nothing's on fire. Yet."}
            </li>
          )}
          {events.map((n) => {
            const dot =
              n.severity === "alert" ? "fail" : n.severity === "warn" ? "warn" : "ai";
            const clickable = Boolean(n.link);
            // Curator injection notifications carry the wiki page id in
            // their link as ?page=<id>. Extract so the "wrong" button
            // can post a correction without parsing on the daemon side.
            const wikiPageId = (() => {
              if (n.source !== "curator" || !n.link) return null;
              try {
                const u = new URL(n.link, "http://x");
                return u.searchParams.get("page");
              } catch {
                return null;
              }
            })();
            return (
              <li
                key={n.id}
                className={`group px-4 py-2.5 flex items-start gap-2.5 feed-item ${
                  clickable ? "cursor-pointer hover:bg-surface2/40" : ""
                }`}
                onClick={() => {
                  if (n.link) router.push(n.link);
                }}
                role={clickable ? "button" : undefined}
                tabIndex={clickable ? 0 : undefined}
                onKeyDown={(e) => {
                  if (clickable && (e.key === "Enter" || e.key === " ")) {
                    e.preventDefault();
                    if (n.link) router.push(n.link);
                  }
                }}
                aria-label={
                  clickable
                    ? `${n.title}. Press Enter to open ${n.link}.`
                    : n.title
                }
              >
                <span className="mt-1">
                  <StatusDot status={dot} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-xs text-txt1 line-clamp-2">{n.title}</div>
                  {n.body && (
                    <div className="text-[11px] font-mono text-txt3 mt-0.5 line-clamp-3 break-words">
                      {n.body}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <span className="text-[11px] font-mono text-txt3">
                    {new Date(n.ts).toLocaleTimeString(undefined, {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                  {wikiPageId && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        correctM.mutate({ notifId: n.id, pageId: wikiPageId });
                      }}
                      disabled={correctM.isPending}
                      className="opacity-0 group-hover:opacity-100 focus:opacity-100 text-txt3 hover:text-fail p-1.5 -m-0.5 transition-opacity"
                      aria-label={`Mark this injection wrong (lowers ${wikiPageId} weight)`}
                      title="This was wrong (lowers page weight, archives at 3 corrections)"
                    >
                      <Icon name="ThumbsDown" size={16} />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      dismissM.mutate(n.id);
                    }}
                    disabled={dismissM.isPending}
                    className="opacity-0 group-hover:opacity-100 focus:opacity-100 text-txt3 hover:text-txt1 p-1.5 -m-0.5 transition-opacity"
                    aria-label={`Dismiss ${n.title}`}
                    title="Dismiss"
                  >
                    <Icon name="X" size={16} />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      </section>
    </aside>
  );
}
