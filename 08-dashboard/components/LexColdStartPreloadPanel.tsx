"use client";

/**
 * Lex cold-start preload mode panel.
 *
 * Three-segment selector (off / shadow / live) for the runtime mode
 * backing /lex/cold-start-preload. Shadow is the default: the daemon
 * computes the block and audit-logs it but returns block:'' so the
 * SessionStart hook injects nothing. Operator can watch the shadow
 * rows accumulate in /lex/injection-log before flipping live.
 *
 * Layout mirrors SmartCompactAuditPanel: rounded-panel shell, header
 * with title + subtitle + mode tag, body with the segmented control
 * and a recent-shadow preview snippet pulled from /lex/injection-log
 * filtered by caller_label='cold-start-preload'.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  coldStartPreloadEvents,
  coldStartPreloadToggle,
  injectionLog,
  setColdStartPreloadToggle,
  type ColdStartPreloadEvent,
  type ColdStartPreloadEventGroup,
  type ColdStartPreloadMode,
  type ColdStartPreloadToggle,
  type InjectionLogRow,
} from "@/lib/daemon-client";

const QKEY = ["lex", "cold-start-preload", "toggle"] as const;
const PREVIEW_QKEY = [
  "lex",
  "cold-start-preload",
  "preview",
] as const;
const EVENTS_QKEY = [
  "lex",
  "cold-start-preload",
  "events",
] as const;

const MODES: ColdStartPreloadMode[] = ["off", "shadow", "live"];

const MODE_TONE: Record<ColdStartPreloadMode, string> = {
  off: "text-txt3",
  shadow: "text-warn",
  live: "text-ok",
};

const MODE_BTN: Record<ColdStartPreloadMode, string> = {
  off: "bg-surface2 text-txt2 hover:bg-surface3",
  shadow: "bg-warn/15 text-warn ring-1 ring-warn/30 hover:bg-warn/25",
  live: "bg-ok/15 text-ok ring-1 ring-ok/30 hover:bg-ok/25",
};

function fmtTs(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.valueOf())) return ts;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function fmtGap(ms: number): string {
  if (!ms || ms < 0) return "0";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

function fmtDistilledMs(ms: number | null): string {
  if (!ms) return "-";
  const d = new Date(ms);
  if (Number.isNaN(d.valueOf())) return "-";
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function staleChipForLatest(
  latest: ColdStartPreloadEvent | undefined,
): { text: string; tone: string } | null {
  if (!latest) return null;
  const stale = latest.stale_refs_count ?? 0;
  const synced = latest.synced_refs_count ?? 0;
  const partial = latest.partial_sync === true;
  if (stale === 0 && synced === 0 && !partial) return null;
  const net = Math.max(0, stale - synced);
  if (partial) return { text: `[stale ${net}/partial]`, tone: "text-err" };
  if (net > 0) return { text: `[stale ${net}]`, tone: "text-warn" };
  if (synced > 0) return { text: `[caught up ${synced}]`, tone: "text-ok" };
  return null;
}

function PreloadEventCard({
  group,
  initiallyOpen,
}: {
  group: ColdStartPreloadEventGroup;
  initiallyOpen: boolean;
}): React.ReactElement {
  const [open, setOpen] = useState<boolean>(initiallyOpen);
  const latest = group.rows[0];
  const sibling = latest?.sibling_count ?? 0;
  const turns = latest?.recent_turns_appended ?? 0;
  const failure = latest?.failure_reason ?? null;
  const partial = latest?.partial_sync === true;
  const verdict = latest?.context_verdict ?? null;
  /* "ok" is only honest when nothing degraded. partial_sync=true means
   * the catchup ran out of budget or some refs could not be re-
   * distilled; surfacing it as green OK hid the gap that left Lex
   * landing blind on cold-start. Verdict from Fix 55 overrides when
   * present so the panel shows what Lex actually saw. */
  const verdictTone =
    verdict === "fresh"
      ? "text-ok"
      : verdict === "stale" || verdict === "partial"
        ? "text-warn"
        : verdict === "outdated" || verdict === "empty"
          ? "text-err"
          : null;
  const tone =
    failure
      ? "text-err"
      : (verdictTone ?? (partial ? "text-warn" : "text-ok"));
  const verdictLabel = verdict ? `${verdict} · ` : partial ? "partial · " : "";
  const statusLabel = failure
    ? `failed (${failure})`
    : `${verdictLabel}${sibling} siblings · ${turns} turns`;
  const staleChip = staleChipForLatest(latest);
  return (
    <li
      data-testid="lex-cold-start-preload-event-card"
      data-brainstorm-id={group.brainstorm_id}
      className="rounded-card bg-surface2/40 hairline-soft"
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center gap-2 px-3 py-2 text-left text-xs font-mono hover:bg-surface3/60 rounded-card"
      >
        <span className="text-txt3 shrink-0">{open ? "▾" : "▸"}</span>
        <span className="text-txt1 flex-1 truncate">
          {group.brainstorm_id.slice(0, 12)}
        </span>
        {staleChip && (
          <span
            data-testid="lex-cold-start-preload-stale-chip"
            className={`shrink-0 ${staleChip.tone}`}
          >
            {staleChip.text}
          </span>
        )}
        <span className={`shrink-0 ${tone}`}>{statusLabel}</span>
        <span className="text-txt3 shrink-0">{group.rows.length} events</span>
      </button>
      {open && (
        <ul className="divide-y divide-border2 px-3 pb-2">
          {group.rows.map((r, i) => (
            <li
              key={`${r.ts}-${i}`}
              data-testid="lex-cold-start-preload-event-row"
              className="py-1.5 text-[11px] font-mono space-y-0.5"
            >
              <div className="flex items-center gap-2">
                <span className="text-txt3 w-28 shrink-0">{fmtTs(r.ts)}</span>
                <span
                  className={`uppercase tracking-wider text-nano shrink-0 ${
                    r.failure_reason
                      ? "text-err"
                      : r.context_verdict === "fresh"
                        ? "text-ok"
                        : r.context_verdict === "outdated" ||
                            r.context_verdict === "empty"
                          ? "text-err"
                          : r.context_verdict === "stale" ||
                              r.context_verdict === "partial" ||
                              r.partial_sync === true
                            ? "text-warn"
                            : "text-ok"
                  }`}
                >
                  {r.failure_reason
                    ? "failed"
                    : (r.context_verdict ??
                      (r.partial_sync === true ? "partial" : "ok"))}
                </span>
                <span className="text-txt2 flex-1 truncate">
                  {r.preamble || "(no preamble)"}
                </span>
              </div>
              <div className="flex flex-wrap items-center gap-3 text-txt3 pl-30 pl-[7.5rem]">
                <span>siblings: {r.sibling_count}</span>
                <span>turns: {r.recent_turns_appended}</span>
                <span>distilled: {fmtDistilledMs(r.last_distilled_ms)}</span>
                {r.preloaded_ids.length > 0 && (
                  <span title={r.preloaded_ids.join(", ")}>
                    preloaded: {r.preloaded_ids.length}
                  </span>
                )}
                {r.already_present_ids.length > 0 && (
                  <span title={r.already_present_ids.join(", ")}>
                    cached: {r.already_present_ids.length}
                  </span>
                )}
                {((r.stale_refs_count ?? 0) > 0 ||
                  (r.synced_refs_count ?? 0) > 0 ||
                  r.partial_sync === true) && (
                  <span
                    data-testid="lex-cold-start-preload-stale-row"
                    className={r.partial_sync ? "text-err" : "text-warn"}
                  >
                    stale: {r.stale_refs_count ?? 0} · synced:{" "}
                    {r.synced_refs_count ?? 0}
                    {r.partial_sync ? " · partial" : ""}
                  </span>
                )}
                {r.last_child_session_title && (
                  <span
                    data-testid="lex-cold-start-preload-last-child"
                    className="text-txt2"
                    title={
                      r.last_child_session_id ??
                      r.last_child_session_title ??
                      ""
                    }
                  >
                    last child: {r.last_child_session_title}
                  </span>
                )}
                {(r.distillation_gap_ms ?? 0) > 0 && (
                  <span
                    data-testid="lex-cold-start-preload-distill-gap"
                    className={
                      r.context_verdict === "outdated"
                        ? "text-err"
                        : r.context_verdict === "stale"
                          ? "text-warn"
                          : "text-txt3"
                    }
                  >
                    gap: {fmtGap(r.distillation_gap_ms ?? 0)}
                  </span>
                )}
                {r.cc_session_id && (
                  <span className="text-txt3 truncate">
                    cc: {r.cc_session_id.slice(0, 8)}
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function LexColdStartPreloadPanel() {
  const qc = useQueryClient();
  const q = useQuery<ColdStartPreloadToggle>({
    queryKey: QKEY,
    queryFn: coldStartPreloadToggle,
    refetchInterval: 15_000,
  });
  const preview = useQuery({
    queryKey: PREVIEW_QKEY,
    queryFn: () =>
      injectionLog({ caller_label: "cold-start-preload", limit: 5 }),
    refetchInterval: 15_000,
  });
  /* Per-brainstorm event log. Multiple Lex brainstorms can run
   * concurrently; this panel groups events by brainstorm_id so the
   * user can drill into one session at a time without the other
   * session's noise. Polled at the same cadence as the shadow
   * preview so the UI stays consistent. */
  const events = useQuery({
    queryKey: EVENTS_QKEY,
    queryFn: () => coldStartPreloadEvents({}),
    refetchInterval: 15_000,
  });
  const eventGroups: ColdStartPreloadEventGroup[] = useMemo(() => {
    const data = events.data;
    if (!data) return [];
    return "groups" in data ? data.groups : [];
  }, [events.data]);
  const [sessionFilter, setSessionFilter] = useState<string>("");
  const filteredGroups = useMemo(() => {
    if (!sessionFilter) return eventGroups;
    return eventGroups.filter((g) => g.brainstorm_id === sessionFilter);
  }, [eventGroups, sessionFilter]);
  const flip = useMutation({
    mutationFn: (next: ColdStartPreloadMode) =>
      setColdStartPreloadToggle(next),
    onMutate: async (next: ColdStartPreloadMode) => {
      await qc.cancelQueries({ queryKey: QKEY });
      const prev = qc.getQueryData<ColdStartPreloadToggle>(QKEY);
      if (prev) {
        qc.setQueryData<ColdStartPreloadToggle>(QKEY, { ...prev, mode: next });
      }
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(QKEY, ctx.prev);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: QKEY });
      qc.invalidateQueries({ queryKey: PREVIEW_QKEY });
    },
  });

  const data = q.data;
  const mode: ColdStartPreloadMode = data?.mode ?? "shadow";
  const runtimeValue = data?.runtime_value ?? null;
  const envValue = data?.env_value ?? null;
  const rows: InjectionLogRow[] = preview.data?.logs ?? [];

  return (
    <section
      data-testid="lex-cold-start-preload-panel"
      className="rounded-panel bg-surface1 hairline"
    >
      <header className="px-4 py-3 border-b border-border1 flex items-center justify-between">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-sm font-emphasized text-txt1">
            Carry context into fresh Lex sessions
          </h2>
          <p className="text-nano text-txt3">
            When a new Lex chat opens, Lex preloads what you discussed in related earlier sessions so you do not start from zero.
          </p>
        </div>
        <span
          className={`text-nano uppercase tracking-wider font-mono ${MODE_TONE[mode]}`}
        >
          {q.isLoading ? "…" : mode}
        </span>
      </header>
      <div className="px-4 py-4 space-y-4">
        <div
          role="radiogroup"
          aria-label="Cold-start preload mode"
          className="inline-flex rounded-pill hairline overflow-hidden"
        >
          {MODES.map((m) => {
            const active = mode === m;
            return (
              <button
                key={m}
                type="button"
                data-testid={`lex-cold-start-preload-mode-${m}`}
                role="radio"
                aria-checked={active}
                disabled={q.isLoading || flip.isPending}
                onClick={() => {
                  if (!active) flip.mutate(m);
                }}
                className={`text-xs px-3 py-1.5 font-emphasized transition-colors ${
                  active ? MODE_BTN[m] : "bg-transparent text-txt3 hover:bg-surface2/40"
                } disabled:opacity-50`}
              >
                {m}
              </button>
            );
          })}
        </div>
        <div className="text-nano text-txt3 font-mono space-y-0.5">
          <div>
            runtime:{" "}
            <span className="text-txt2">
              {runtimeValue ?? "(unset → shadow)"}
            </span>
          </div>
          <div>
            env:{" "}
            <span className="text-txt2">
              DEVNEURAL_LEX_COLD_START_PRELOAD_ENABLED=
              {envValue ?? "(unset → shadow)"}
            </span>
          </div>
        </div>
        <div
          data-testid="lex-cold-start-preload-events"
          className="rounded-card bg-surface2/40 hairline-soft px-3 py-2 text-xs space-y-2"
        >
          <div className="flex items-center justify-between gap-2">
            <div className="text-nano text-txt3 uppercase tracking-wider">
              recent preload events
            </div>
            {eventGroups.length > 1 && (
              <select
                data-testid="lex-cold-start-preload-session-select"
                value={sessionFilter}
                onChange={(e) => setSessionFilter(e.target.value)}
                className="bg-surface3 hairline-soft text-[11px] font-mono px-1.5 py-0.5 rounded-card text-txt2"
                aria-label="Filter preload events by brainstorm session"
              >
                <option value="">all sessions ({eventGroups.length})</option>
                {eventGroups.map((g) => (
                  <option key={g.brainstorm_id} value={g.brainstorm_id}>
                    {g.brainstorm_id.slice(0, 12)}
                    {g.cc_session_id
                      ? ` · cc ${g.cc_session_id.slice(0, 6)}`
                      : ""}
                  </option>
                ))}
              </select>
            )}
          </div>
          {events.isLoading ? (
            <div className="text-txt3">loading</div>
          ) : filteredGroups.length === 0 ? (
            <div className="text-txt3">
              No preload events recorded yet. They land here the moment a
              fresh Lex session boots and the cold-start route runs.
            </div>
          ) : (
            <ul className="space-y-1.5">
              {filteredGroups.map((g, i) => (
                <PreloadEventCard
                  key={g.brainstorm_id}
                  group={g}
                  initiallyOpen={i === 0 && filteredGroups.length === 1}
                />
              ))}
            </ul>
          )}
        </div>
        {mode === "shadow" && (
          <div
            data-testid="lex-cold-start-preload-shadow-preview"
            className="rounded-card bg-surface2/40 hairline-soft px-3 py-2 text-xs"
          >
            <div className="text-nano text-txt3 uppercase tracking-wider mb-1">
              recent shadow fires
            </div>
            {preview.isLoading ? (
              <div className="text-txt3">loading</div>
            ) : rows.length === 0 ? (
              <div className="text-txt3">No shadow fires recorded yet.</div>
            ) : (
              <ul className="divide-y divide-border2">
                {rows.map((r) => (
                  <li
                    key={r.id}
                    data-testid="lex-cold-start-preload-shadow-row"
                    className="py-1.5 flex items-start gap-3"
                  >
                    <span className="font-mono text-txt3 w-28 shrink-0">
                      {fmtTs(r.ts)}
                    </span>
                    <span
                      className={`text-nano font-mono uppercase tracking-wider w-16 shrink-0 ${
                        r.decision === "shadow" ? "text-warn" : "text-ok"
                      }`}
                    >
                      {r.decision}
                    </span>
                    <span className="text-txt1 flex-1 min-w-0 truncate">
                      {r.text_preview}
                    </span>
                    <span className="text-nano text-txt3 font-mono shrink-0">
                      {r.text_length}c
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
