"use client";

/**
 * Smart-compact runtime toggle panel.
 *
 * Three-segment selector (off / shadow / live) for the runtime mode
 * backing /lex/smart-compact/fire. Mirrors LexColdStartPreloadPanel
 * so the /system page lays out consistently.
 *
 *   off    — short-circuit: no audit row, no PTY inject. Smart
 *            compact entirely inert. Use to drop the system without
 *            bouncing the daemon when a runaway evaluator is
 *            spamming /clear.
 *   shadow — shadow rows always; inject never runs. The
 *            ship-it-default per SMART-COMPACT.md so the operator
 *            can observe every intended fire before opting in.
 *   live   — per-anchor isShadow() decides; otherwise inject +
 *            fire/wrap.
 *
 * Backed by runtime_config.smart_compact_mode through GET/POST
 * /lex/smart-compact/toggle. Flip takes effect on the next fire
 * request — no daemon restart.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  setSmartCompactToggle,
  smartCompactToggle,
  type SmartCompactMode,
  type SmartCompactToggle,
} from "@/lib/daemon-client";

const QKEY = ["lex", "smart-compact", "toggle"] as const;

const MODES: SmartCompactMode[] = ["off", "shadow", "live"];

const MODE_TONE: Record<SmartCompactMode, string> = {
  off: "text-txt3",
  shadow: "text-warn",
  live: "text-ok",
};

const MODE_BTN: Record<SmartCompactMode, string> = {
  off: "bg-surface2 text-txt2 hover:bg-surface3",
  shadow: "bg-warn/15 text-warn ring-1 ring-warn/30 hover:bg-warn/25",
  live: "bg-ok/15 text-ok ring-1 ring-ok/30 hover:bg-ok/25",
};

const MODE_BLURB: Record<SmartCompactMode, string> = {
  off: "fire is inert: no audit row, no PTY inject.",
  shadow: "fire logs a shadow row but never injects into a worker.",
  live: "per-anchor shadow gate decides; otherwise /clear + summary inject.",
};

export function SmartCompactPanel() {
  const qc = useQueryClient();
  const q = useQuery<SmartCompactToggle>({
    queryKey: QKEY,
    queryFn: smartCompactToggle,
    refetchInterval: 15_000,
  });
  const flip = useMutation({
    mutationFn: (next: SmartCompactMode) => setSmartCompactToggle(next),
    onMutate: async (next: SmartCompactMode) => {
      await qc.cancelQueries({ queryKey: QKEY });
      const prev = qc.getQueryData<SmartCompactToggle>(QKEY);
      if (prev) {
        qc.setQueryData<SmartCompactToggle>(QKEY, { ...prev, mode: next });
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
  const mode: SmartCompactMode = data?.mode ?? "shadow";
  const runtimeValue = data?.runtime_value ?? null;
  const envValue = data?.env_value ?? null;

  return (
    <section
      data-testid="smart-compact-panel"
      className="rounded-panel bg-surface1 hairline"
    >
      <header className="px-4 py-3 border-b border-border1 flex items-center justify-between">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-sm font-emphasized text-txt1">
            Smart compact mode
          </h2>
          <p className="text-nano text-txt3">
            Runtime kill-switch for the auto-/clear + summary pipeline
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
          aria-label="Smart compact mode"
          className="inline-flex rounded-pill hairline overflow-hidden"
        >
          {MODES.map((m) => {
            const active = mode === m;
            return (
              <button
                key={m}
                type="button"
                data-testid={`smart-compact-mode-${m}`}
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
              {runtimeValue ?? "(unset → shadow)"}
            </span>
          </div>
          <div>
            env:{" "}
            <span className="text-txt2">
              DEVNEURAL_SMART_COMPACT_ENABLED=
              {envValue ?? "(unset → shadow)"}
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
