"use client";

/**
 * Wave 2 day 4 step 19 (A15). Pause-mode toggle on /system.
 * Writes runtime_config.pause_mode (on/off/auto). The daemon's
 * decay loop reads runtime_config first, env var second, default
 * 'auto' last, so the toggle takes effect without a restart.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  listRuntimeConfig,
  setRuntimeConfig,
} from "@/lib/daemon-client";

const OPTIONS: Array<{ value: "on" | "off" | "auto"; label: string }> = [
  { value: "auto", label: "auto (idle for 21d → pause)" },
  { value: "off", label: "off (decay always runs)" },
  { value: "on", label: "on (decay frozen)" },
];

export function PauseModeToggle() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["runtime-config"],
    queryFn: () => listRuntimeConfig(),
  });
  const current =
    q.data?.config.find((r) => r.key === "pause_mode")?.value ?? "auto";
  const setM = useMutation({
    mutationFn: (value: string) => setRuntimeConfig("pause_mode", value),
    onSettled: () => qc.invalidateQueries({ queryKey: ["runtime-config"] }),
  });
  return (
    <section className="rounded-panel bg-surface1 hairline p-4 space-y-2">
      <h2 className="font-display text-sm font-emphasized">Pause mode</h2>
      <p className="text-xs text-txt3">
        controls weight decay on canonical wiki pages. runtime override
        wins over DEVNEURAL_PAUSE_MODE.
      </p>
      <div className="flex flex-col gap-1">
        {OPTIONS.map((o) => (
          <label key={o.value} className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="pause_mode"
              value={o.value}
              checked={current === o.value}
              onChange={() => setM.mutate(o.value)}
              disabled={setM.isPending}
            />
            <span className="font-mono">{o.label}</span>
          </label>
        ))}
      </div>
      {setM.isError ? (
        <p className="text-xs text-rose-400">save failed</p>
      ) : null}
    </section>
  );
}
