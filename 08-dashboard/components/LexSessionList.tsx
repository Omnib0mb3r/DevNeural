"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  lexAnchors,
  patchLexAnchor,
  createLexAnchor,
  openLexAnchor,
  endLexAnchor,
  archiveLexAnchor,
  type LexAnchor,
  type ProjectAnchorTile,
} from "@/lib/daemon-client";
import { relTime } from "@/lib/session-helpers";
import { createCollapseStore } from "@/lib/transcript-collapse";
import { emitVoiceAnchorSwitch } from "@/lib/voice-anchor-bus";
import { Icon } from "./Icon";
import { StatusDot } from "./StatusDot";
import { SupervisesPicker } from "./SupervisesPicker";

/* Past Sessions collapse-toggle persistence. Mirrors the
 * TranscriptHistory pattern so a refresh respects the user's choice
 * of capped-height-list vs count-only strip. */
export const PAST_SESSIONS_COLLAPSE_KEY =
  "devneural.lex.past-sessions.collapsed";
const collapseStore = createCollapseStore(PAST_SESSIONS_COLLAPSE_KEY);

/**
 * Past Sessions panel for /lex (PLAN-lex-session-rewrite.md, step 4).
 *
 * Backed by the new /lex/anchors endpoint. Each row is a durable Lex
 * anchor (lex_session). Click "switch to" / "resume" → POST
 * /lex/anchors/:id/open. The daemon either binds to the live PTY
 * (status='live') or spawns a fresh CC session under the same
 * anchor with the reopen-variant system prompt that lists every
 * prior transcript jsonl + the catch-up Read instruction. No more
 * one-row-per-spawn pollution; the anchor row is the canonical
 * identity.
 */
interface Props {
  /* Anchor id of the currently bound Lex session, if any. The /lex
   * page derives this from the live PTY's mapping and threads it
   * down so the row can be highlighted and the End button surfaced
   * inline. */
  activeAnchorId?: string | null;
  /* PTY id of the live Lex session. Threaded down so the End
   * button kills the underlying PTY in addition to flipping the
   * anchor's status. */
  activePtyId?: string | null;
  /* Test seam: override the initial collapsed-state read. */
  initialCollapsed?: boolean;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function displayId(anchor: LexAnchor): string {
  return shortId(anchor.id);
}

function nameFor(anchor: LexAnchor): string {
  return anchor.title?.trim() || anchor.derived_title?.trim() || "";
}

export function LexSessionList({
  activeAnchorId,
  activePtyId,
  initialCollapsed,
}: Props) {
  const qc = useQueryClient();
  const router = useRouter();
  /* SESSIONS-VIEW defect 2 (switch path): switch the live voice to a
   * brainstorm via a SOFT nav + an in-app signal, never a full-page
   * reload. router.push updates ?brainstorm= (deep-link / back-button)
   * and keeps the page mounted; emitVoiceAnchorSwitch tells the global
   * VoiceClient + the Lex page to re-pin the bind on the LIVE socket, so
   * the switch never blips voice. */
  function switchToAnchor(id: string): void {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.searchParams.set("brainstorm", id);
    router.push(url.pathname + url.search);
    emitVoiceAnchorSwitch(id);
  }
  /* Collapsed = count-only strip; expanded = capped-height list with
   * internal scroll. Default expanded on first load; persists every
   * toggle through the shared transcript-collapse store under the
   * past-sessions key. */
  const [collapsed, setCollapsed] = useState<boolean>(
    initialCollapsed ?? false,
  );
  useEffect(() => {
    if (initialCollapsed !== undefined) return;
    setCollapsed(collapseStore.read());
  }, [initialCollapsed]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftLabel, setDraftLabel] = useState("");
  /* Per-row pending state. Without this every row's open button
   * shared the mutation's isPending, so clicking one made all of
   * them flash "opening…" and disabled together. */
  const [pendingRowId, setPendingRowId] = useState<string | null>(null);
  /* Phase C-3: inline "new brainstorm" form is hidden by default;
   * clicking the + button opens it so the user can pick a project
   * to bind before spawning. Submitting it fires createLexAnchor
   * with the supervises field; cancelling collapses it back. */
  const [newOpen, setNewOpen] = useState(false);
  const [newSupervises, setNewSupervises] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["lex-anchors"],
    queryFn: () => lexAnchors({ limit: 50 }),
    refetchInterval: 5_000,
  });

  const patchM = useMutation({
    mutationFn: (vars: {
      id: string;
      patch: Parameters<typeof patchLexAnchor>[1];
    }) => patchLexAnchor(vars.id, vars.patch),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["lex-anchors"] });
      /* Stream Deck + Nav tiles join anchor titles onto the
       * /sessions response, so a rename also has to refresh that
       * query for the deck to reflect the new title without a
       * reload. */
      qc.invalidateQueries({ queryKey: ["sessions"] });
    },
  });

  /* Spawn-or-bind. Server flips between binding to the live PTY (if
   * the anchor's current_pty_id is alive) and spawning a fresh CC
   * session with the reopen-variant system prompt. The dashboard
   * reacts to the resulting pty-list change automatically — voice
   * and the terminal mirror re-target the new ptyId without any
   * extra client wiring. */
  const openM = useMutation({
    mutationFn: (id: string) => openLexAnchor(id),
    /* Hook-level onSuccess so navigation fires immediately after the
     * spawn-or-bind resolves, before the awaited onSettled refetch
     * (per-mutate callbacks run after it, which delayed the reload
     * and flashed the button label back). Navigating with
     * ?brainstorm=<id> re-points the page, inject target, and the
     * voice hello at THIS anchor (bug 2026-07-08: switch was a
     * silent no-op while another PTY was live). */
    onSuccess: (data, id) => {
      if (!data?.ok) return;
      /* SESSIONS-VIEW defect 2: soft nav + bus signal instead of a full
       * reload, so switching sessions never blips the live voice. */
      switchToAnchor(id);
    },
    onSettled: async () => {
      setPendingRowId(null);
      await qc.refetchQueries({ queryKey: ["pty-list"] });
      qc.invalidateQueries({ queryKey: ["lex-anchors"] });
    },
  });

  const endM = useMutation({
    mutationFn: (id: string) => endLexAnchor(id),
    onSuccess: (_data, id) => {
      /* Ending the anchor the URL currently selects would leave a
       * stale ?brainstorm= that fails the voice hello with
       * brainstorm-ended on the next reload. Drop the param in
       * place; no reload needed (the row flips dormant via the
       * invalidations below). */
      if (typeof window !== "undefined") {
        const url = new URL(window.location.href);
        if (url.searchParams.get("brainstorm") === id) {
          url.searchParams.delete("brainstorm");
          window.location.href = url.toString();
        }
      }
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["lex-anchors"] });
      qc.invalidateQueries({ queryKey: ["pty-list"] });
    },
  });

  /* Reversible "remove from this list". Hides the row via the archive
   * bit (migration 053) instead of hard-deleting the anchor, so a
   * misclick on a real session is recoverable (unarchive in the DB).
   * A confirm guards the click; the row disappears on refetch. */
  const archiveM = useMutation({
    mutationFn: (id: string) => archiveLexAnchor(id, true),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["lex-anchors"] });
      qc.invalidateQueries({ queryKey: ["sessions"] });
    },
  });

  const newM = useMutation({
    mutationFn: (opts: { supervises_project_anchor_id: string | null }) =>
      createLexAnchor({
        supervises_project_anchor_id: opts.supervises_project_anchor_id,
      }),
    onSettled: async () => {
      await qc.refetchQueries({ queryKey: ["pty-list"] });
      qc.invalidateQueries({ queryKey: ["lex-anchors"] });
      qc.invalidateQueries({ queryKey: ["project-anchor-tiles"] });
      setNewOpen(false);
      setNewSupervises(null);
    },
  });

  const rows: LexAnchor[] = q.data?.anchors ?? [];

  function startEdit(anchor: LexAnchor) {
    setEditingId(anchor.id);
    setDraftLabel(anchor.title ?? anchor.derived_title ?? "");
  }

  function commitEdit(rowId: string) {
    const next = draftLabel.trim();
    setEditingId(null);
    patchM.mutate({
      id: rowId,
      patch: { title: next.length > 0 ? next : null },
    });
  }

  const liveCount = rows.filter((r) => r.status === "live").length;

  function toggleCollapsed() {
    setCollapsed((prev) => {
      const next = !prev;
      collapseStore.write(next);
      return next;
    });
  }

  return (
    <div
      className="rounded-panel bg-surface1 hairline"
      data-testid="lex-past-sessions"
      data-collapsed={collapsed ? "1" : "0"}
    >
      <div className="px-5 py-3 border-b border-border1 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <Icon name="History" className="text-brandSoft" size={16} />
          <h2 className="font-display text-sm font-emphasized">Past sessions</h2>
          <span className="text-nano text-txt3 ml-1">
            ({rows.length}
            {liveCount > 0 ? `, ${liveCount} live` : ""})
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setNewOpen((v) => !v)}
            disabled={newM.isPending}
            aria-expanded={newOpen}
            aria-controls="lex-new-brainstorm-form"
            className="text-xs px-3 py-1.5 rounded-pill bg-brand/15 text-brandSoft hairline ring-1 ring-brand/30 hover:bg-brand/25 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
            title="Spawn a fresh Lex anchor"
          >
            <Icon name="Plus" size={12} />
            {newM.isPending
              ? "starting…"
              : newOpen
                ? "cancel"
                : "new brainstorm"}
          </button>
          <button
            type="button"
            onClick={toggleCollapsed}
            aria-expanded={!collapsed}
            aria-controls="lex-past-sessions-body"
            className="text-[11px] px-2 py-0.5 rounded-pill hairline font-emphasized bg-surface2 text-txt2 hover:bg-surface3"
          >
            {collapsed ? "expand" : "collapse"}
          </button>
        </div>
      </div>

      {newOpen && !collapsed && (
        <div
          id="lex-new-brainstorm-form"
          data-testid="lex-new-brainstorm-form"
          className="px-5 py-3 border-b border-border1 bg-surface2/40 flex flex-col gap-2"
        >
          <label className="text-nano text-txt3 flex flex-col gap-1">
            <span>Supervises project (optional)</span>
            <SupervisesPicker
              value={newSupervises}
              onChange={setNewSupervises}
              disabled={newM.isPending}
            />
          </label>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() =>
                newM.mutate({ supervises_project_anchor_id: newSupervises })
              }
              disabled={newM.isPending}
              className="text-xs px-3 py-1.5 rounded-pill bg-brand/20 text-brandSoft hairline ring-1 ring-brand/40 hover:bg-brand/30 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {newM.isPending ? "starting…" : "create brainstorm"}
            </button>
            <span className="text-nano text-txt3">
              {newSupervises
                ? "Lex inject-cross-session will land here unless target_session is explicit."
                : "Brainstorm starts unbound — set target_session per call or bind later."}
            </span>
          </div>
        </div>
      )}

      {!collapsed && (
        <div
          id="lex-past-sessions-body"
          /* Cap to roughly 3.5 rows (~56px each at py-2.5 + content);
           * anything past that gets the internal scroll instead of
           * pushing the rest of the page down. */
          className="max-h-56 overflow-y-auto"
          data-testid="lex-past-sessions-body"
        >
          {q.isLoading && (
            <div className="p-4 space-y-2">
              {[0, 1, 2].map((i) => (
                <div key={i} className="h-9 rounded-card bg-surface2 animate-pulse" />
              ))}
            </div>
          )}
          {!q.isLoading && rows.length === 0 && (
            <div className="p-6 text-center text-xs text-txt3">
              No brainstorm sessions yet.
            </div>
          )}
          {!q.isLoading && rows.length > 0 && (
            <ul className="divide-y divide-border2">
              {rows.map((row) => {
                const isLive = row.status === "live";
                const isCurrent =
                  activeAnchorId === row.id ||
                  (activePtyId && row.current_pty_id === activePtyId);
                const editing = editingId === row.id;
                return (
                  <li
                    key={row.id}
                    className={`px-4 py-2.5 flex items-center gap-3 ${
                      isCurrent ? "bg-brand/5" : ""
                    }`}
                  >
                    <StatusDot
                      status={isLive ? "live" : "idle"}
                      pulse={isLive}
                    />
                    <div className="min-w-0 flex-1">
                      {editing ? (
                        <input
                          autoFocus
                          value={draftLabel}
                          onChange={(e) => setDraftLabel(e.target.value)}
                          onBlur={() => commitEdit(row.id)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              commitEdit(row.id);
                            } else if (e.key === "Escape") {
                              e.preventDefault();
                              setEditingId(null);
                            }
                          }}
                          placeholder="name this session"
                          className="w-full px-2 py-1 rounded-input bg-surface2 hairline text-xs text-txt1 outline-none focus:ring-1 focus:ring-brand/60"
                        />
                      ) : (
                        <button
                          type="button"
                          onClick={() => startEdit(row)}
                          className="text-left w-full text-xs text-txt1 hover:text-brandSoft truncate"
                          title="Click to rename"
                        >
                          {nameFor(row) || (
                            <span className="text-txt3 italic">unnamed</span>
                          )}
                        </button>
                      )}
                      <div className="text-nano text-txt3 font-mono truncate">
                        {displayId(row)}
                      </div>
                      <div className="text-nano text-txt3 font-mono flex items-center gap-2">
                        <span>{relTime(row.last_activity_ms)} ago</span>
                        <span>{row.status}</span>
                        {row.transcript_count > 0 && (
                          <span>
                            {row.transcript_count} session
                            {row.transcript_count === 1 ? "" : "s"}
                          </span>
                        )}
                      </div>
                      {/* Phase C-3: per-row supervises binding chip.
                       *
                       * Inline `<select>` PATCHes /lex/anchors/:id
                       * with the new project_session id (or null to
                       * clear). Disabled while the PATCH is in-flight
                       * so a fast double-click does not race the
                       * mutation. */}
                      <div
                        data-testid={`lex-row-supervises-${row.id}`}
                        className="text-nano text-txt3 flex items-center gap-1 mt-0.5"
                      >
                        <span>supervises</span>
                        <SupervisesPicker
                          compact
                          value={row.supervises_project_anchor_id ?? null}
                          disabled={patchM.isPending}
                          onChange={(next) =>
                            patchM.mutate({
                              id: row.id,
                              patch: { supervises_project_anchor_id: next },
                            })
                          }
                        />
                      </div>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      {isLive && isCurrent && (
                        <button
                          type="button"
                          onClick={() => endM.mutate(row.id)}
                          disabled={endM.isPending}
                          className="text-nano px-2 py-1 rounded-pill bg-surface2 hairline hover:bg-surface3 text-txt2 disabled:opacity-40"
                          title="End the live PTY for this anchor and mark it dormant"
                        >
                          end
                        </button>
                      )}
                      {!isCurrent && (
                        <button
                          type="button"
                          onClick={() => {
                            /* Brainstorm-as-durable-primary-entity
                             * (2026-05-22 reconcile #2). For direct-
                             * llm rows, "resume" is just voice
                             * connect by brainstorm_id; do NOT kill
                             * any PTY, do NOT flip the current
                             * brainstorm to status=ended, do NOT
                             * spawn a new CC. Navigate the URL so
                             * the global VoiceClient's hello picks
                             * up ?brainstorm=<id> on its next open. */
                            if (row.runtime_mode === "direct-llm") {
                              /* Soft nav + bus signal, no reload: voice
                               * connect by brainstorm_id without blipping
                               * the live session. */
                              switchToAnchor(row.id);
                              return;
                            }
                            /* cc-pty rows: spawn-or-bind first (a
                             * dormant anchor needs its PTY before the
                             * page can mirror it); the hook-level
                             * onSuccess then navigates with
                             * ?brainstorm=<id>. */
                            setPendingRowId(row.id);
                            openM.mutate(row.id);
                          }}
                          disabled={openM.isPending}
                          className="text-nano px-2 py-1 rounded-pill bg-brand/10 hairline ring-1 ring-brand/30 text-brandSoft hover:bg-brand/20 disabled:opacity-40 disabled:cursor-not-allowed"
                          title={
                            row.runtime_mode === "direct-llm"
                              ? "Voice-connect to this brainstorm (no PTY spawn)"
                              : isLive
                                ? "Bind to the live PTY for this anchor"
                                : row.transcript_count > 0
                                  ? "Spawn a fresh CC session under this anchor; Lex will Read every prior transcript before responding"
                                  : "Spawn a fresh CC session under this anchor (no prior transcripts to load)"
                          }
                        >
                          {pendingRowId === row.id
                            ? "opening…"
                            : row.runtime_mode === "direct-llm"
                              ? "connect"
                              : isLive
                                ? "switch to"
                                : "open"}
                        </button>
                      )}
                      {/* Archive = reversible hide from this list
                       * (migration 053), not a hard delete. Only
                       * offered on dormant, non-current rows so you
                       * cannot archive the session you are actively
                       * in. */}
                      {!isCurrent && !isLive && (
                        <button
                          type="button"
                          data-testid={`lex-row-archive-${row.id}`}
                          onClick={() => {
                            const label = nameFor(row) || shortId(row.id);
                            if (
                              typeof window !== "undefined" &&
                              !window.confirm(
                                `Archive "${label}"?\n\nThis hides the row from Past Sessions (reversible). The anchor and its transcripts are kept.`,
                              )
                            ) {
                              return;
                            }
                            archiveM.mutate(row.id);
                          }}
                          disabled={archiveM.isPending}
                          className="text-nano px-2 py-1 rounded-pill bg-surface2 hairline hover:bg-surface3 text-txt3 hover:text-txt1 disabled:opacity-40 disabled:cursor-not-allowed"
                          title="Archive this session (reversible hide; anchor + transcripts kept)"
                        >
                          {archiveM.isPending ? "…" : "archive"}
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
      {collapsed && (
        <div
          data-testid="lex-past-sessions-strip"
          className="px-5 py-2 text-nano text-txt3 flex items-center gap-2"
        >
          <span>
            {rows.length} session{rows.length === 1 ? "" : "s"}
            {liveCount > 0 ? `, ${liveCount} live` : ""}
          </span>
        </div>
      )}
    </div>
  );
}
