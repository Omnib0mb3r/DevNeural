"use client";

/**
 * Lex cold-start preload toggle panel.
 *
 * Mirrors the SmartCompactAuditPanel surface (header + body inside a
 * rounded-panel) but the body is the runtime kill-switch for the
 * cold-start preload feature instead of an audit list. Auto-firing
 * inject features ship default-off on this codebase; the toggle is
 * the operator's opt-in. The hook also gates on
 * DEVNEURAL_LEX_COLD_START_PRELOAD_ENABLED, so either off = no-op.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  coldStartPreloadToggle,
  setColdStartPreloadToggle,
  type ColdStartPreloadToggle,
} from "@/lib/daemon-client";

const QKEY = ["lex", "cold-start-preload", "toggle"] as const;

export function LexColdStartPreloadPanel() {
  const qc = useQueryClient();
  const q = useQuery<ColdStartPreloadToggle>({
    queryKey: QKEY,
    queryFn: coldStartPreloadToggle,
    refetchInterval: 15_000,
  });
  const flip = useMutation({
    mutationFn: (next: boolean) => setColdStartPreloadToggle(next),
    /* Optimistic flip so the switch responds instantly; daemon write
     * lands a beat later. Roll back on failure. */
    onMutate: async (next: boolean) => {
      await qc.cancelQueries({ queryKey: QKEY });
      const prev = qc.getQueryData<ColdStartPreloadToggle>(QKEY);
      if (prev) {
        qc.setQueryData<ColdStartPreloadToggle>(QKEY, {
          ...prev,
          enabled: next,
        });
      }
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(QKEY, ctx.prev);
    },
    onSettled: () => qc.invalidateQueries({ queryKey: QKEY }),
  });

  const data = q.data;
  const enabled = data?.enabled ?? false;
  const runtimeValue = data?.runtime_value ?? null;
  const envValue = data?.env_value ?? null;

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
          className={`text-nano uppercase tracking-wider font-mono ${
            enabled ? "text-ok" : "text-txt3"
          }`}
        >
          {q.isLoading ? "…" : enabled ? "on" : "off"}
        </span>
      </header>
      <div className="px-4 py-4 flex items-center justify-between gap-4">
        <div className="flex flex-col gap-1 text-nano text-txt3 font-mono">
          <span>
            runtime:{" "}
            <span className={enabled ? "text-ok" : "text-txt2"}>
              {runtimeValue ?? "(unset → off)"}
            </span>
          </span>
          <span>
            env:{" "}
            <span className="text-txt2">
              DEVNEURAL_LEX_COLD_START_PRELOAD_ENABLED=
              {envValue ?? "(unset → off)"}
            </span>
          </span>
        </div>
        <button
          type="button"
          data-testid="lex-cold-start-preload-toggle"
          disabled={q.isLoading || flip.isPending}
          onClick={() => flip.mutate(!enabled)}
          className={`text-xs px-3 py-1.5 rounded-pill hairline font-emphasized transition-colors ${
            enabled
              ? "bg-ok/15 text-ok ring-1 ring-ok/30 hover:bg-ok/25"
              : "bg-surface2 text-txt2 hover:bg-surface3"
          } disabled:opacity-50`}
          aria-pressed={enabled}
        >
          {flip.isPending ? "saving…" : enabled ? "disable" : "enable"}
        </button>
      </div>
    </section>
  );
}
