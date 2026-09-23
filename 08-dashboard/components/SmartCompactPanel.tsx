"use client";

/**
 * Auto-clear switch panel.
 *
 * One three-segment selector (off / shadow / live) for BOTH halves of
 * auto-clear: smart-compact (the worker /clear + reseed) and
 * smart-clear (the handover-driven wind-down with the trip marks).
 * 2026-09-22: the two runtime modes used to be two switches on the
 * /system page; the operator asked for one. A flip posts the unified
 * POST /lex/auto-clear/mode. A daemon that predates that route answers
 * 404, and the panel then falls back to the two older endpoints
 * (POST /lex/smart-compact/toggle + POST /lex/smart-clear/config) so
 * the switch keeps working across the deploy.
 *
 *   off    : short-circuit. No audit row, no PTY inject, no handover
 *            request. Use to drop the system without bouncing the
 *            daemon when a runaway evaluator is spamming /clear.
 *   shadow : shadow rows always; inject never runs. The
 *            ship-it-default per SMART-COMPACT.md so the operator can
 *            observe every intended fire before opting in.
 *   live   : per-anchor isShadow() decides; otherwise the real
 *            stop / handover / clear / reseed runs.
 *
 * Read side stays on GET /lex/smart-compact/toggle (the two modes are
 * written together, so the one value reads for both). Flip takes
 * effect on the next fire request; no daemon restart.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  setAutoClearMode,
  setSmartClearConfig,
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
  off: "Off. Lex never auto-clears a session. A full context window stays full until you clear it yourself.",
  shadow:
    "Shadow. Lex records every session it would have cleared, but takes no action. Use this to watch the picks before turning it on.",
  live: "Live. When a worker or Lex fills the context window, the session gets a vetted handover, a /clear and a reseed so it picks up where it left off.",
};

/** True when the daemon answered 404: the unified route is not
 * deployed on this daemon yet. Structural check (not instanceof) so a
 * mocked client or a serialised error still routes correctly. */
function isRouteMissing(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { status?: unknown }).status === 404
  );
}

/** Set the auto-clear mode: the unified route first, the two older
 * endpoints only when the unified route is missing. Any other failure
 * propagates so the optimistic flip reverts. */
export async function applyAutoClearMode(mode: SmartCompactMode): Promise<void> {
  try {
    await setAutoClearMode(mode);
    return;
  } catch (err) {
    if (!isRouteMissing(err)) throw err;
  }
  await setSmartCompactToggle(mode);
  await setSmartClearConfig({ mode });
}

export function SmartCompactPanel() {
  const qc = useQueryClient();
  const q = useQuery<SmartCompactToggle>({
    queryKey: QKEY,
    queryFn: smartCompactToggle,
    refetchInterval: 15_000,
  });
  const flip = useMutation({
    mutationFn: (next: SmartCompactMode) => applyAutoClearMode(next),
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
      qc.invalidateQueries({ queryKey: ["smart-clear-config"] });
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
          <h2 className="text-sm font-emphasized text-txt1">Auto-clear</h2>
          <p className="text-nano text-txt3">
            One switch for both halves: when a worker or Lex fills the context window, the session gets a vetted handover, a /clear and a reseed so work continues. (Internally: smart-compact plus smart-clear.)
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
          aria-label="Auto-clear mode"
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
        {/* One plain-English line instead of raw runtime/env dumps.
         * The old footer printed "runtime: live" next to "env:
         * DEVNEURAL_SMART_COMPACT_ENABLED=(unset -> shadow)", which
         * made a correctly-live system look half-configured
         * (2026-07-16 operator audit). Precedence: the dashboard
         * toggle (runtime config) wins; env only seeds boot; else
         * the built-in default. */}
        <p
          data-testid="smart-compact-effective-mode"
          className="text-nano text-txt3"
        >
          {q.isLoading
            ? "…"
            : runtimeValue
              ? `Effective mode: ${mode}, set from this dashboard switch.`
              : envValue
                ? `Effective mode: ${mode}, from the environment variable; the switch above overrides it.`
                : `Effective mode: ${mode}, the built-in default; the switch above overrides it.`}
        </p>
      </div>
    </section>
  );
}
