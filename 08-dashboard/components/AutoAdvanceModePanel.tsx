"use client";

/**
 * Autonomous supervisor auto-advance runtime toggle panel
 * (phase 4).
 *
 * Three-segment selector (off / shadow / live) for the runtime
 * mode backing the daemon's auto-advance loop. Mirrors
 * SmartCompactPanel so the /system page stays consistent.
 *
 *   off    — loop dormant. No quiescence eval, no footer parse,
 *            no auto_advance_log rows. Default. Flip to shadow
 *            after migration 027/028 land + the daemon bounce.
 *   shadow — loop runs every tick. Each pass that passes the
 *            gates writes an auto_advance_log row with
 *            decision='shadow' + a would-inject preview. NO
 *            crossSessionInject fires. Use to observe what the
 *            loop WOULD have advanced for at least one
 *            productive session before opting in.
 *   live   — loop fires for real. Each clean-idle-done turn
 *            atomically claims the next backlog item and
 *            invokes crossSessionInject with caller_label=
 *            'auto-supervisor'. Lex still handles judgment
 *            cases (status=needs_input, needs_attention=true)
 *            because the loop hard-gates on status=done +
 *            needs_input=false + needs_attention=false.
 *
 * Backed by runtime_config.auto_advance_mode through GET/POST
 * /lex/auto-advance/toggle. Flip takes effect on the next tick;
 * no daemon restart needed.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  autoAdvanceToggle,
  setAutoAdvanceToggle,
  type AutoAdvanceMode,
  type AutoAdvanceToggle,
} from "@/lib/daemon-client";

const QKEY = ["lex", "auto-advance", "toggle"] as const;

const MODES: AutoAdvanceMode[] = ["off", "shadow", "live"];

const MODE_TONE: Record<AutoAdvanceMode, string> = {
  off: "text-txt3",
  shadow: "text-warn",
  live: "text-ok",
};

const MODE_BTN: Record<AutoAdvanceMode, string> = {
  off: "bg-surface2 text-txt2 hover:bg-surface3",
  shadow: "bg-warn/15 text-warn ring-1 ring-warn/30 hover:bg-warn/25",
  live: "bg-ok/15 text-ok ring-1 ring-ok/30 hover:bg-ok/25",
};

const MODE_BLURB: Record<AutoAdvanceMode, string> = {
  off: "loop dormant: no quiescence eval, no auto_advance_log rows.",
  shadow:
    "loop logs decision='shadow' on every clean-idle-done turn but never injects.",
  live: "loop fires crossSessionInject on every clean-idle-done turn; Lex still handles judgment cases.",
};

export function AutoAdvanceModePanel() {
  const qc = useQueryClient();
  const q = useQuery<AutoAdvanceToggle>({
    queryKey: QKEY,
    queryFn: autoAdvanceToggle,
    refetchInterval: 15_000,
  });
  const flip = useMutation({
    mutationFn: (next: AutoAdvanceMode) => setAutoAdvanceToggle(next),
    onMutate: async (next: AutoAdvanceMode) => {
      await qc.cancelQueries({ queryKey: QKEY });
      const prev = qc.getQueryData<AutoAdvanceToggle>(QKEY);
      if (prev) {
        qc.setQueryData<AutoAdvanceToggle>(QKEY, { ...prev, mode: next });
      }
      return { prev };
    },
    onError: (_e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(QKEY, ctx.prev);
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: QKEY });
    },
  });

  const data = q.data;
  const mode: AutoAdvanceMode = data?.mode ?? "off";
  const runtimeValue = data?.runtime_value ?? null;
  const envValue = data?.env_value ?? null;

  return (
    <section
      data-testid="auto-advance-panel"
      className="rounded-panel bg-surface1 hairline"
    >
      <header className="px-4 py-3 border-b border-border1 flex items-center justify-between">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-sm font-emphasized text-txt1">
            Auto-advance supervisor
          </h2>
          <p className="text-nano text-txt3">
            Runtime kill-switch for the daemon&apos;s clean-idle-done backlog pump
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
          aria-label="Auto-advance mode"
          className="inline-flex rounded-pill hairline overflow-hidden"
        >
          {MODES.map((m) => {
            const active = mode === m;
            return (
              <button
                key={m}
                type="button"
                data-testid={`auto-advance-mode-${m}`}
                role="radio"
                aria-checked={active}
                disabled={q.isLoading || flip.isPending}
                onClick={() => {
                  if (!active) flip.mutate(m);
                }}
                className={`text-xs px-3 py-1.5 font-emphasized transition-colors ${
                  active
                    ? MODE_BTN[m]
                    : "bg-transparent text-txt3 hover:bg-surface2/40"
                } disabled:opacity-50`}
              >
                {m}
              </button>
            );
          })}
        </div>
        <p className="text-nano text-txt3">{MODE_BLURB[mode]}</p>
        <div className="text-nano text-txt3 font-mono space-y-0.5">
          <div>
            runtime:{" "}
            <span className="text-txt2">
              {runtimeValue ?? "(unset → off)"}
            </span>
          </div>
          <div>
            env:{" "}
            <span className="text-txt2">
              DEVNEURAL_AUTO_ADVANCE_MODE=
              {envValue ?? "(unset → off)"}
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
