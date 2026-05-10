"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  dashboardHealth,
  notifications as notificationsClient,
  dismissNotification,
  type Notification,
} from "@/lib/daemon-client";
import { Icon } from "./Icon";
import { StatusDot } from "./StatusDot";
import { lexPickStable } from "@/lib/lex";

const TABS = [
  { href: "/",            label: "Home",           icon: "Home" as const },
  { href: "/brainstorms", label: "Brainstorms",    icon: "Sparkles" as const },
  { href: "/sessions",    label: "Sessions",       icon: "Terminal" as const },
  { href: "/wiki",        label: "Wiki",           icon: "BookOpen" as const },
  { href: "/drafts",      label: "Drafts",         icon: "FilePen" as const },
  { href: "/projects",    label: "Projects",       icon: "FolderGit2" as const },
  { href: "/reminders",   label: "Reminders",      icon: "BellRing" as const },
  { href: "/system",      label: "System",         icon: "Cpu" as const },
  { href: "/orb",         label: "Neural network", icon: "Brain" as const },
  { href: "/lex",         label: "Lex chat",       icon: "Bot" as const },
];

/* TopBar previously had a non-functioning notifications icon, settings
 * icon, and search input. They now all do real work:
 *   - Search input click/focus dispatches `open-cmdk`, which the
 *     CommandPalette listens for. Single source of truth for fuzzy
 *     navigation + search; avoids two parallel search UIs.
 *   - Notifications opens an inline dropdown with the most recent
 *     unread events and a dismiss button per row. "See all" links to
 *     /reminders for the full list.
 *   - Settings is a Link to /system, which holds the diagnostic /
 *     configuration surface (provider info, embedder, lint queue,
 *     log tail). No separate /settings page needed yet. */

export function TopBar({ activeTab }: { activeTab: string }) {
  const qc = useQueryClient();
  const health = useQuery({
    queryKey: ["dashboard-health"],
    queryFn: dashboardHealth,
    refetchInterval: 5_000,
  });
  const notifs = useQuery({
    queryKey: ["notifications", "recent"],
    queryFn: () => notificationsClient(20),
    refetchInterval: 10_000,
  });
  const dismissM = useMutation({
    /* Bell dismiss only clears this dropdown; the activity rail keeps
     * its copy until acknowledged there. Optimistic cache flip so the
     * row disappears on click instead of waiting for the next refetch. */
    mutationFn: (id: string) => dismissNotification(id, "bell"),
    onMutate: async (id: string) => {
      await qc.cancelQueries({ queryKey: ["notifications", "recent"] });
      const prev = qc.getQueryData<{ ok: boolean; notifications: Notification[] }>(
        ["notifications", "recent"],
      );
      if (prev) {
        qc.setQueryData(["notifications", "recent"], {
          ...prev,
          notifications: prev.notifications.map((n) =>
            n.id === id
              ? {
                  ...n,
                  dismissed_scopes: Array.from(
                    new Set([...(n.dismissed_scopes ?? []), "bell"]),
                  ),
                }
              : n,
          ),
        });
      }
      return { prev };
    },
    onError: (_err, _id, ctx) => {
      if (ctx?.prev) qc.setQueryData(["notifications", "recent"], ctx.prev);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["notifications", "recent"] });
      qc.invalidateQueries({ queryKey: ["dashboard", "health"] });
    },
  });

  const unread = health.data?.unread_notifications ?? 0;
  const rollup = health.data?.rollup ?? "ok";
  const rollupLabel =
    rollup === "ok" ? "all systems online" : rollup === "warn" ? "degraded" : "failure";

  /* Visible auth state. dashboardHealth is auth-gated: a 401 there means
   * the dn_session cookie is missing or expired, so the user is locked
   * out even if pages render. Surface this as an explicit pill instead
   * of letting the user guess from "data is stale" symptoms. */
  const authState: "ok" | "locked" | "loading" = health.isLoading
    ? "loading"
    : health.error &&
        (health.error as { status?: number }).status === 401
      ? "locked"
      : "ok";

  const [notifOpen, setNotifOpen] = useState(false);
  const notifRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!notifOpen) return;
    function onClickOutside(e: MouseEvent) {
      if (notifRef.current && !notifRef.current.contains(e.target as Node)) {
        setNotifOpen(false);
      }
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === "Escape") setNotifOpen(false);
    }
    window.addEventListener("mousedown", onClickOutside);
    window.addEventListener("keydown", onEsc);
    return () => {
      window.removeEventListener("mousedown", onClickOutside);
      window.removeEventListener("keydown", onEsc);
    };
  }, [notifOpen]);

  function openCmdK() {
    window.dispatchEvent(new CustomEvent("open-cmdk"));
  }

  /* Bell shows everything (system + activity); per-scope dismiss filter
   * keeps a row hidden here once the user clicks X in this dropdown. */
  const recent = (notifs.data?.notifications ?? [])
    .filter((n) => !(n.dismissed_scopes ?? []).includes("bell"))
    .slice(0, 8);

  return (
    <header className="flex flex-col">
      <div className="flex items-center h-14 px-5 hairline-soft">
        <button
          type="button"
          onClick={() =>
            window.dispatchEvent(new CustomEvent("lex-secret-tap"))
          }
          aria-label="DevNeural"
          className="flex items-center gap-2 relative brand-glow rounded-card -mx-1 px-1 hover:bg-surface2/40 transition"
        >
          <div className="w-8 h-8 rounded-card bg-brand/10 ring-1 ring-brand/30 grid place-items-center">
            <Icon name="Brain" className="text-brandSoft" size={20} />
          </div>
          <div className="font-display font-semibold tracking-tight text-[15px] text-txt1">
            DevNeural
          </div>
          <div className="text-txt3 text-[11px] uppercase tracking-[0.14em] font-medium ml-1 mt-0.5">
            Hub
          </div>
        </button>

        <div className="flex-1 max-w-2xl mx-4">
          <button
            type="button"
            onClick={openCmdK}
            className="group w-full flex items-center gap-2.5 h-9 px-3 rounded-card bg-surface1 hairline focus-within:ring-1 focus-within:ring-brand/60 transition text-left"
            aria-label="Open command palette"
          >
            <Icon name="Search" className="text-txt3" size={16} />
            <span className="flex-1 text-sm text-txt3">
              Search wiki, sessions, projects, reference docs…
            </span>
            <kbd className="hidden md:inline-flex items-center gap-1 px-1.5 h-5 rounded border border-border1 bg-surface2 text-[11px] font-mono text-txt2">
              ⌘ K
            </kbd>
          </button>
        </div>

        <div className="flex items-center gap-2">
          {/* Notifications dropdown */}
          <div className="relative" ref={notifRef}>
            <button
              type="button"
              onClick={() => setNotifOpen((v) => !v)}
              aria-label={`Notifications (${unread} unread)`}
              aria-expanded={notifOpen}
              className="lift relative w-9 h-9 rounded-card hairline grid place-items-center text-txt2 hover:text-txt1"
            >
              <Icon name="Bell" />
              {unread > 0 && (
                <span className="absolute top-1 right-1 w-3.5 h-3.5 rounded-pill bg-brand text-[9px] font-mono text-base grid place-items-center">
                  {unread > 9 ? "9+" : unread}
                </span>
              )}
            </button>
            {notifOpen && (
              <div className="absolute right-0 top-11 w-80 rounded-panel bg-surface1 hairline shadow-lg z-40 overflow-hidden">
                <div className="px-4 py-3 border-b border-border1 flex items-center justify-between">
                  <span className="text-nano text-txt3 uppercase tracking-wider">
                    Recent notifications
                  </span>
                  <Link
                    href="/reminders"
                    onClick={() => setNotifOpen(false)}
                    className="text-[11px] font-mono text-txt3 hover:text-txt1"
                  >
                    see all
                  </Link>
                </div>
                <ul className="max-h-96 overflow-y-auto divide-y divide-border2">
                  {recent.length === 0 && (
                    <li className="px-4 py-6 text-xs text-txt3 text-center">
                      {lexPickStable("empty_notifications", "topbar-bell")}
                    </li>
                  )}
                  {recent.map((n) => {
                    const dot =
                      n.severity === "alert"
                        ? "fail"
                        : n.severity === "warn"
                          ? "warn"
                          : "ai";
                    return (
                      <li
                        key={n.id}
                        className="px-4 py-2.5 flex items-start gap-2.5"
                      >
                        <span className="mt-1">
                          <StatusDot status={dot} />
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="text-xs text-txt1 truncate">
                            {n.title}
                          </div>
                          {n.body && (
                            <div className="text-[11px] font-mono text-txt3 mt-0.5 line-clamp-2">
                              {n.body}
                            </div>
                          )}
                          <div className="text-nano text-txt3 mt-1">
                            {new Date(n.ts).toLocaleString(undefined, {
                              month: "short",
                              day: "numeric",
                              hour: "2-digit",
                              minute: "2-digit",
                            })}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => dismissM.mutate(n.id)}
                          disabled={dismissM.isPending}
                          className="text-txt3 hover:text-txt1 shrink-0"
                          aria-label={`Dismiss ${n.title}`}
                        >
                          <Icon name="X" size={14} />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
          </div>

          <Link
            href="/settings"
            aria-label="Settings"
            className="lift w-9 h-9 rounded-card hairline grid place-items-center text-txt2 hover:text-txt1"
          >
            <Icon name="Settings" />
          </Link>

          {authState === "locked" ? (
            <Link
              href="/unlock"
              aria-label="Locked: click to unlock"
              className="flex items-center gap-1.5 h-9 px-3 rounded-pill hairline text-[11px] font-mono text-err hover:bg-err/10"
              title="Session expired or missing. Click to unlock."
            >
              <Icon name="Lock" size={12} />
              locked
            </Link>
          ) : (
            <div
              className="flex items-center gap-1.5 h-9 px-3 rounded-pill hairline text-[11px] font-mono text-ok"
              title="Authenticated session active"
            >
              <Icon name="Unlock" size={12} />
              unlocked
            </div>
          )}

          <div
            className={`flex items-center gap-1.5 h-9 px-3 rounded-pill hairline shimmer-pill text-[11px] font-mono ${
              rollup === "ok" ? "text-ok" : rollup === "warn" ? "text-warn" : "text-err"
            }`}
          >
            <StatusDot status={rollup === "fail" ? "fail" : rollup} pulse={rollup === "ok"} />
            {rollupLabel}
          </div>
        </div>
      </div>

      <nav className="flex items-center h-11 px-5 hairline-soft border-t border-border2">
        <div className="flex gap-6 -mb-px">
          {TABS.map((t) => {
            const isActive = t.href === activeTab;
            return (
              <Link
                key={t.href}
                href={t.href}
                className={`relative py-3 text-sm font-medium flex items-center gap-2 ${
                  isActive ? "text-txt1 tab-active" : "text-txt2 hover:text-txt1"
                }`}
              >
                <Icon name={t.icon} size={16} /> {t.label}
              </Link>
            );
          })}
        </div>
      </nav>
    </header>
  );
}
