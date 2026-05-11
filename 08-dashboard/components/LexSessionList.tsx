"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  lexSessions,
  patchLexSession,
  spawnLex,
  ptyKill,
  type BrainstormSessionRow,
} from "@/lib/daemon-client";
import { relTime } from "@/lib/session-helpers";
import { Icon } from "./Icon";
import { StatusDot } from "./StatusDot";

interface Props {
  /* Currently bound active brainstorm row id (if known). Used so the
   * row matching the live PTY can be highlighted and the End button
   * surfaced inline. */
  activeBrainstormId?: string | null;
  /* PTY id of the live Lex session, threaded down so the End button
   * can also kill the underlying PTY (status PATCH alone leaves the
   * PTY running). */
  activePtyId?: string | null;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

/* Display name for the rename row. Empty when neither the user nor the
 * daemon has set a label, so the input field can show a placeholder
 * instead of pre-filling with the row id (which is rendered on its own
 * line below and should never double as the editable name). */
function nameFor(row: BrainstormSessionRow): string {
  return row.user_label?.trim() || row.derived_label?.trim() || "";
}

export function LexSessionList({ activeBrainstormId, activePtyId }: Props) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(true);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftLabel, setDraftLabel] = useState("");

  const q = useQuery({
    queryKey: ["lex-sessions"],
    queryFn: () => lexSessions({ limit: 50 }),
    refetchInterval: 5_000,
  });

  const patchM = useMutation({
    mutationFn: (vars: {
      id: string;
      patch: Parameters<typeof patchLexSession>[1];
    }) => patchLexSession(vars.id, vars.patch),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["lex-sessions"] });
      /* Stream Deck and Nav tiles join brainstorm labels onto the
       * /sessions response, so a rename also has to refresh that
       * query for the deck to reflect the new title without a page
       * reload. */
      qc.invalidateQueries({ queryKey: ["sessions"] });
    },
  });

  /* Resume passes the prior brainstorm's claude_session_id to
   * /pty/spawn-lex, which appends --resume <id> to the claude CLI
   * args so the conversation history is restored verbatim. Rows
   * with no claude_session_id (PTY died before its jsonl appeared)
   * fall back to "open fresh PTY in same cwd with the same label";
   * the tooltip on the button reflects the difference.
   *
   * If a live Lex PTY is already running we end it first (kill +
   * patch its brainstorm row to status='ended') so /pty/spawn-lex
   * does not race a competing tile in the same brainstorm cwd. The
   * 400ms gap matches the page-level newSessionM mutation in
   * app/lex/page.tsx; without it the new spawn can land before the
   * old taskkill /F /T tree unwind finishes on Windows. */
  const resumeM = useMutation({
    mutationFn: async (row: BrainstormSessionRow) => {
      if (activePtyId) {
        try {
          await ptyKill(activePtyId);
        } catch {
          /* if it was already gone, spawn still proceeds */
        }
      }
      /* End every other active brainstorm row before spawning the
       * resumed PTY. The parent's `activeBrainstormId` prop derives
       * from a 5s-refetched query that often hasn't caught up to the
       * auto-spawned PTY at the moment the user clicks switch-to, so
       * relying on it alone leaves the previously-active row stuck at
       * status='active'. Fetching the live active set here closes the
       * race: any row that is still 'active' (except the one the user
       * is resuming) gets patched to 'ended' before /pty/spawn-lex
       * runs and registers the new active row. */
      try {
        const active = await lexSessions({ status: "active", limit: 50 });
        await Promise.all(
          (active.sessions ?? [])
            .filter((r) => r.id !== row.id)
            .map((r) =>
              patchLexSession(r.id, { status: "ended" }).catch(() => {
                /* observability only; never block the resume */
              }),
            ),
        );
      } catch {
        /* observability only; never block the resume */
      }
      if (activePtyId) {
        await new Promise((r) => setTimeout(r, 400));
      }
      const cwd = row.cwd?.replace(/\//g, "\\");
      const resumeSid = row.claude_session_id ?? undefined;
      const spawned = await spawnLex(cwd ?? undefined, resumeSid);
      if (!spawned.ok || !spawned.ptyId) {
        throw new Error(spawned.error ?? "spawn failed");
      }
      const carry = row.user_label ?? row.derived_label ?? null;
      return {
        ptyId: spawned.ptyId,
        carryLabel: carry,
        resumed: Boolean(spawned.resumed),
      };
    },
    onSettled: async () => {
      await qc.refetchQueries({ queryKey: ["pty-list"] });
      qc.invalidateQueries({ queryKey: ["lex-sessions"] });
    },
  });

  const killM = useMutation({
    mutationFn: async (vars: { brainstormId: string; ptyId?: string | null }) => {
      await patchLexSession(vars.brainstormId, { status: "ended" });
      if (vars.ptyId) {
        try {
          await ptyKill(vars.ptyId);
        } catch {
          /* If the PTY is already gone, the row patch is enough. */
        }
      }
      return true;
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["lex-sessions"] });
      qc.invalidateQueries({ queryKey: ["pty-list"] });
    },
  });

  /* Start a fresh brainstorm. If a Lex PTY is already live we kill it
   * first so spawn-lex doesn't end up with two competing tiles in the
   * brainstorm cwd, then spawn a clean session. The 400ms gap matches
   * the page-level newSessionM mutation in app/lex/page.tsx.
   *
   * onSettled awaits the pty-list refetch so the mutation's isPending
   * flag stays true until the parent page sees the new PTY. Without
   * the await, the page's empty-state condition flickered to true for
   * a 0-3s window while the dashboard waited on the next 3s tick,
   * unmounting the voice panel the user just opened. */
  const newM = useMutation({
    mutationFn: async () => {
      if (activePtyId) {
        try {
          await ptyKill(activePtyId);
        } catch {
          /* PTY may already be gone; spawn anyway. */
        }
        await new Promise((r) => setTimeout(r, 400));
      }
      const spawned = await spawnLex();
      if (!spawned.ok) {
        throw new Error(spawned.error ?? "spawn failed");
      }
      return spawned;
    },
    onSettled: async () => {
      await qc.refetchQueries({ queryKey: ["pty-list"] });
      qc.invalidateQueries({ queryKey: ["lex-sessions"] });
    },
  });

  const rows: BrainstormSessionRow[] = q.data?.sessions ?? [];

  function startEdit(row: BrainstormSessionRow) {
    setEditingId(row.id);
    setDraftLabel(row.user_label ?? row.derived_label ?? "");
  }

  function commitEdit(rowId: string) {
    const next = draftLabel.trim();
    setEditingId(null);
    patchM.mutate({
      id: rowId,
      patch: { user_label: next.length > 0 ? next : null },
    });
  }

  return (
    <div className="rounded-panel bg-surface1 hairline">
      <div className="px-5 py-3 border-b border-border1 flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-2 hover:opacity-80"
          aria-expanded={open}
        >
          <Icon name="History" className="text-brandSoft" size={16} />
          <h2 className="font-display text-sm font-emphasized">Past sessions</h2>
          <span className="text-nano text-txt3 ml-1">({rows.length})</span>
          <Icon name={open ? "ChevronUp" : "ChevronDown"} size={14} className="text-txt3 ml-1" />
        </button>
        <button
          type="button"
          onClick={() => newM.mutate()}
          disabled={newM.isPending}
          className="text-xs px-3 py-1.5 rounded-pill bg-brand/15 text-brandSoft hairline ring-1 ring-brand/30 hover:bg-brand/25 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-1.5"
          title="End the current Lex (if any) and start a fresh brainstorm"
        >
          <Icon name="Plus" size={12} />
          {newM.isPending ? "starting…" : "new brainstorm"}
        </button>
      </div>

      {open && (
        <div className="max-h-72 overflow-y-auto">
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
                const isActive = row.status === "active";
                const isCurrent =
                  activeBrainstormId === row.id ||
                  (activePtyId && row.pty_id === activePtyId);
                const editing = editingId === row.id;
                return (
                  <li
                    key={row.id}
                    className={`px-4 py-2.5 flex items-center gap-3 ${
                      isCurrent ? "bg-brand/5" : ""
                    }`}
                  >
                    <StatusDot
                      status={isActive ? "live" : "idle"}
                      pulse={isActive}
                    />
                    {/* Three lines: editable name, read-only session
                      * id, then meta (last-active + status + turns).
                      * Name is what the user (or Lex) renames; the
                      * id below stays stable so it can be referenced
                      * from logs or other surfaces. */}
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
                        {shortId(row.id)}
                      </div>
                      <div className="text-nano text-txt3 font-mono flex items-center gap-2">
                        <span>{relTime(row.started_ms)} ago</span>
                        <span>{row.status}</span>
                        {row.turn_count > 0 && <span>{row.turn_count} turns</span>}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      {isActive && isCurrent && (
                        <button
                          type="button"
                          onClick={() =>
                            killM.mutate({
                              brainstormId: row.id,
                              ptyId: activePtyId ?? row.pty_id,
                            })
                          }
                          disabled={killM.isPending}
                          className="text-nano px-2 py-1 rounded-pill bg-surface2 hairline hover:bg-surface3 text-txt2 disabled:opacity-40"
                          title="End this session and kill the PTY"
                        >
                          end
                        </button>
                      )}
                      {/* Switch-to renders for every non-current row,
                       * including stale active rows. Earlier this was
                       * gated on `!isActive`, which meant a previous
                       * "active" row whose end-patch raced or failed
                       * during a switch-to would render no button at
                       * all (no end because not current, no switch
                       * because not ended), trapping the user with no
                       * way back. */}
                      {!isCurrent && (
                        <button
                          type="button"
                          onClick={() => resumeM.mutate(row)}
                          disabled={resumeM.isPending}
                          className="text-nano px-2 py-1 rounded-pill bg-brand/10 hairline ring-1 ring-brand/30 text-brandSoft hover:bg-brand/20 disabled:opacity-40 disabled:cursor-not-allowed"
                          title={
                            isActive
                              ? "This brainstorm is still flagged active. End the current Lex and re-bind to this row."
                              : activePtyId
                                ? row.claude_session_id
                                  ? "End the current Lex and restore this conversation via claude --resume"
                                  : "End the current Lex and open a fresh PTY in the same cwd (no claude_session_id was bound to this row, so verbatim resume is unavailable)"
                                : row.claude_session_id
                                  ? "Restore this conversation via claude --resume"
                                  : "Open a fresh PTY in the same cwd with this label (no claude_session_id was bound to this row, so verbatim resume is unavailable)"
                          }
                        >
                          {resumeM.isPending
                            ? "resuming..."
                            : activePtyId || isActive
                              ? "switch to"
                              : "resume"}
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
    </div>
  );
}
