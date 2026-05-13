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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  coldStartPreloadToggle,
  injectionLog,
  setColdStartPreloadToggle,
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
            Lex cold-start preload
          </h2>
          <p className="text-nano text-txt3">
            Auto-injects sibling brainstorm context on fresh Lex SessionStart
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
