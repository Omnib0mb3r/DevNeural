"use client";

import { useQuery } from "@tanstack/react-query";
import { diagnostics } from "@/lib/daemon-client";
import { Icon } from "./Icon";
import { StatusDot } from "./StatusDot";

/* /system "Brain diagnostics" panel.
 *
 * Surfaces what the daemon already knows but historically only logged:
 *   - vector store sizes + dirty flags (catches "store growing but not
 *     flushing" or "post-corruption truncation in progress")
 *   - lint queue state (ready / running / pending) + last_run_at +
 *     pending reasons (catches "is the brain actually linting?")
 *   - LLM provider config + model names per task (catches misconfigs)
 *   - embedder model + warm time + p50 latency (catches embed slowdowns)
 *   - active session counts grouped by phase (catches stuck-in-tool etc.)
 *
 * One endpoint (/dashboard/diagnostics), one query, polled every 5s. */

function fmtBytes(bytes: number): string {
  if (!bytes) return "0";
  const u = ["B", "K", "M", "G", "T"];
  const i = Math.min(u.length - 1, Math.floor(Math.log10(bytes) / 3));
  return `${(bytes / 10 ** (i * 3)).toFixed(1)}${u[i]}`;
}

function fmtAge(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.round(ms / 1000)}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  return `${Math.round(ms / 3_600_000)}h ago`;
}

export function DiagnosticsPanel() {
  const q = useQuery({
    queryKey: ["diagnostics"],
    queryFn: diagnostics,
    refetchInterval: 5_000,
  });
  const d = q.data;

  return (
    <section className="rounded-panel bg-surface1 hairline">
      <div className="px-5 py-3 border-b border-border1 flex items-center gap-2">
        <Icon name="Brain" className="text-brandSoft" size={16} />
        <h2 className="font-display text-sm font-emphasized">Brain diagnostics</h2>
        {q.isLoading && (
          <span className="text-nano text-txt3 ml-2">loading…</span>
        )}
        {q.isError && (
          <span className="text-nano text-err ml-2">failed</span>
        )}
      </div>

      {d && (
        <div className="grid grid-cols-2 gap-0 divide-x divide-border2">
          {/* Store sizes */}
          <div className="p-5 space-y-3">
            <div className="text-nano text-txt3 uppercase tracking-wider">
              Vector store
            </div>
            {([
              ["raw_chunks", d.store.raw_chunks],
              ["wiki_pages", d.store.wiki_pages],
              ["reference_chunks", d.store.reference_chunks],
            ] as const).map(([key, c]) => (
              <div
                key={key}
                className="flex items-center justify-between text-sm"
              >
                <span className="text-txt2">{key}</span>
                <span className="text-[11px] font-mono text-txt3 flex items-center gap-2">
                  <span className="text-txt1">{c.count.toLocaleString()}</span>
                  <span>vec {fmtBytes(c.vec_bytes)}</span>
                  <span>meta {fmtBytes(c.meta_bytes)}</span>
                  {c.dirty && (
                    /* "dirty" read as a fault (2026-07-16 operator
                     * audit). It just means new writes since the last
                     * disk snapshot - normal during capture, and the
                     * daemon now auto-saves within 5 minutes. Neutral
                     * copy + tone instead of a warning badge. */
                    <span
                      className="px-1.5 py-0.5 rounded-pill bg-surface2 text-txt3"
                      title="New writes since the last disk snapshot. Normal during capture; auto-saves within 5 minutes (and on backup/shutdown)."
                    >
                      saving soon
                    </span>
                  )}
                </span>
              </div>
            ))}
          </div>

          {/* Lint queue */}
          <div className="p-5 space-y-2">
            <div className="text-nano text-txt3 uppercase tracking-wider">
              Lint queue
            </div>
            <div className="flex items-center gap-2 text-sm">
              <StatusDot
                status={
                  !d.lint_queue.ready
                    ? "fail"
                    : d.lint_queue.running
                      ? "ai"
                      : d.lint_queue.pending
                        ? "live"
                        : "ok"
                }
                pulse={d.lint_queue.running || d.lint_queue.pending}
              />
              <span className="text-txt1">
                {!d.lint_queue.ready
                  ? "not ready"
                  : d.lint_queue.running
                    ? "running"
                    : d.lint_queue.pending
                      ? "pending (debounce)"
                      : "idle"}
              </span>
            </div>
            <div className="text-[11px] font-mono text-txt3">
              last run: {fmtAge(d.lint_queue.last_run_at)} · debounce{" "}
              {d.lint_queue.debounce_ms / 1000}s
            </div>
            {d.lint_queue.pending_reasons.length > 0 && (
              <div className="text-[11px] font-mono text-txt2 truncate">
                reasons: {d.lint_queue.pending_reasons.join(", ")}
              </div>
            )}
          </div>

          {/* LLM provider */}
          <div className="p-5 space-y-2 border-t border-border2 col-span-1">
            <div className="text-nano text-txt3 uppercase tracking-wider">
              LLM provider
            </div>
            {d.llm ? (
              <>
                <div className="flex items-center gap-2 text-sm">
                  <StatusDot status={d.llm.configured ? "ok" : "fail"} />
                  <span className="text-txt1 font-mono">{d.llm.name}</span>
                  <span className="text-[11px] font-mono text-txt3">
                    {d.llm.configured ? "configured" : "unconfigured"}
                  </span>
                </div>
                <div className="text-[11px] font-mono text-txt3 space-y-0.5">
                  <div>ingest: {d.llm.models.ingest}</div>
                  <div>lint: {d.llm.models.lint}</div>
                  <div>reconcile: {d.llm.models.reconcile}</div>
                  <div>selfQuery: {d.llm.models.selfQuery}</div>
                  <div>distillation: {d.llm.models.distillation}</div>
                </div>
                {!d.llm.configured && (
                  <div className="text-[11px] font-mono text-warn">
                    {d.llm.hint}
                  </div>
                )}
              </>
            ) : (
              <div className="text-xs text-txt3">
                LLM disabled (DEVNEURAL_LLM_PROVIDER=none).
              </div>
            )}
          </div>

          {/* Embedder */}
          <div className="p-5 space-y-2 border-t border-border2 col-span-1">
            <div className="text-nano text-txt3 uppercase tracking-wider">
              Embedder
            </div>
            <div className="flex items-center gap-2 text-sm">
              <StatusDot status={d.embedder.warmed_at ? "ok" : "warn"} />
              <span className="text-txt1 font-mono truncate">{d.embedder.model}</span>
              <span className="text-[11px] font-mono text-txt3">
                dim {d.embedder.dim}
              </span>
            </div>
            <div className="text-[11px] font-mono text-txt3">
              {d.embedder.warmed_at
                ? `warmed ${fmtAge(d.embedder.warmed_at)} (${d.embedder.warm_ms}ms)`
                : "not warmed"}
            </div>
            <div className="text-[11px] font-mono text-txt3">
              calls: {d.embedder.embed_calls.toLocaleString()} · items:{" "}
              {d.embedder.embed_items.toLocaleString()}
              {d.embedder.embed_calls > 0 && (
                <>
                  {" "}
                  · avg{" "}
                  {(d.embedder.total_embed_ms / d.embedder.embed_calls).toFixed(0)}
                  ms
                </>
              )}
            </div>
            {d.embedder.last_error && (
              <div className="text-[11px] font-mono text-err truncate">
                last error: {d.embedder.last_error}
              </div>
            )}
          </div>

          {/* Sessions */}
          <div className="p-5 space-y-2 border-t border-border2 col-span-2">
            <div className="text-nano text-txt3 uppercase tracking-wider">
              Sessions
            </div>
            <div className="flex items-center gap-4 text-sm">
              <span className="text-txt2">
                <span className="text-txt1 font-mono">
                  {d.sessions.active}
                </span>{" "}
                active
              </span>
              <span className="text-txt3">
                of{" "}
                <span className="text-txt1 font-mono">
                  {d.sessions.total}
                </span>{" "}
                total
              </span>
              <div className="ml-auto flex items-center gap-3 text-[11px] font-mono text-txt3">
                {([
                  ["thinking", "ai"],
                  ["tool", "ok"],
                  ["permission", "fail"],
                  ["idle", "live"],
                  ["unknown", "idle"],
                ] as const).map(([k, s]) => (
                  <span key={k} className="flex items-center gap-1">
                    <StatusDot status={s} size={6} />
                    {k} {d.sessions.by_phase[k] ?? 0}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
