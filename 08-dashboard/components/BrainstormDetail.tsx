"use client";

/**
 * Wave 2 day 2 step 9 (BF-5 / A1) brainstorm detail.
 *
 * Renders the brainstorm row + the artifacts manifest + an AudioPlayer
 * when audio was retained. Cues are loaded lazily from the cues_url
 * so a session without audio doesn't pay the second fetch.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { AudioPlayer } from "./AudioPlayer";
import {
  attachBrainstormWorkerApi,
  detachBrainstormWorkerApi,
  getBrainstormApi,
  getBrainstormCuesApi,
  getBrainstormChunksApi,
  lexAnchor,
  lexSessionArtifacts,
  patchLexAnchor,
  type AudioCue,
  type BrainstormChunkRow,
  type WorkerExpectationRow,
} from "@/lib/daemon-client";
import { SupervisesPicker } from "./SupervisesPicker";

export function BrainstormDetail({ id }: { id: string }) {
  const detail = useQuery({
    queryKey: ["brainstorm", id],
    queryFn: () => getBrainstormApi(id),
    refetchInterval: 10_000,
  });
  const artifacts = useQuery({
    queryKey: ["brainstorm-artifacts", id],
    queryFn: () => lexSessionArtifacts(id),
  });
  const cuesUrl = detail.data?.brainstorm?.cues_url ?? null;
  const cues = useQuery({
    queryKey: ["brainstorm-cues", id],
    queryFn: () => getBrainstormCuesApi(id),
    enabled: Boolean(cuesUrl),
  });
  /* Wave 3 fixup (bug: 2026-05-10-brainstorm-picker-and-transcripts).
   * Pull the brainstorm_chunks rows so the user can read the text
   * transcript alongside the audio. Skips if the row is still
   * mid-ingest (turn_count=0); refetches on the same cadence as the
   * detail row so a live session updates as turns land. */
  /* Fetch newest-N. Brainstorms can exceed 2000 turns; without
   * order=desc the UI only ever sees turns 0..499 and recent Lex
   * replies vanish. Display layer reverses to chronological. */
  const chunks = useQuery({
    queryKey: ["brainstorm-chunks", id],
    queryFn: async () => {
      const r = await getBrainstormChunksApi(id, 500, { order: "desc" });
      if (r.ok) {
        return { ...r, chunks: [...r.chunks].reverse() };
      }
      return r;
    },
    refetchInterval: 10_000,
  });

  if (detail.isLoading) return <p className="p-4 text-sm text-txt3">loading…</p>;
  if (detail.error || !detail.data?.ok)
    return (
      <p className="p-4 text-sm text-rose-400">
        {detail.data?.error ?? "failed to load brainstorm"}
      </p>
    );

  const dec = detail.data.brainstorm;
  const bs = dec.brainstorm;
  const cueList: AudioCue[] = cues.data?.cues ?? [];
  /* Title is the human name only. The full session id stays in the
   * meta line below so it never doubles as the title. Matches the
   * LexSessionList / BrainstormList row layout: name on top,
   * id + meta underneath. */
  const name = bs.user_label?.trim() || bs.derived_label?.trim() || "";

  return (
    <div className="flex flex-col gap-4 p-4">
      <div>
        <Link href="/brainstorms" className="text-xs text-txt3 hover:text-brandSoft">
          ← brainstorms
        </Link>
        <h1 className="mt-1 text-xl font-semibold">
          {name || <span className="text-txt3 italic">unnamed</span>}
        </h1>
        <p className="text-xs font-mono text-txt3">
          {bs.id} · mode {bs.mode} · {bs.turn_count} turns ·{" "}
          {new Date(bs.started_ms).toISOString().slice(0, 16).replace("T", " ")}
          {bs.ended_ms ? ` → ${new Date(bs.ended_ms).toISOString().slice(11, 16)}` : " (live)"}
        </p>
        {bs.project_slug ? (
          <p className="text-xs font-mono text-txt3">project: {bs.project_slug}</p>
        ) : null}
      </div>
      {dec.audio_url ? (
        <AudioPlayer src={dec.audio_url} cues={cueList} defaultRate={0.9} />
      ) : (
        <p className="text-xs text-txt3">no audio retained for this session.</p>
      )}
      <WorkerAttachmentSection brainstormId={id} bs={bs} />
      <ExpectationsSection
        expectations={detail.data.open_expectations ?? []}
      />
      <DeferralsSection
        items={artifacts.data?.artifacts ?? []}
        loading={artifacts.isLoading}
      />
      <SupervisesSection brainstormId={id} />
      {bs.last_summary ? (
        <section>
          <h2 className="text-sm font-semibold">Summary</h2>
          <StalenessPill staleness={detail.data.staleness ?? null} />
          <p className="whitespace-pre-wrap text-sm text-txt2">{bs.last_summary}</p>
        </section>
      ) : null}
      <BrainstormTranscript
        chunks={chunks.data?.chunks ?? []}
        loading={chunks.isLoading}
      />
      <ArtifactsSection
        items={artifacts.data?.artifacts ?? []}
        loading={artifacts.isLoading}
      />
    </div>
  );
}

/* Codex item 6 (Fix 43): per-brainstorm freshness pill. Reads the
 * staleness counts the daemon attaches to GET /brainstorms/:id and
 * renders one of three messages:
 *
 *   no refs        -> nothing (legacy anchors with no transcript refs)
 *   fresh          -> "Summary: N refs fresh"
 *   stale within   -> "Summary: K of N refs catching up..."
 *   stale beyond   -> "Summary: K of N refs STALE - oldest <h>h ago"
 *
 * Threshold for "beyond" matches the stale-watcher default (10 min)
 * so the pill and the bell agree on what counts as actionable. */
const STALE_PILL_BEYOND_MS = 10 * 60_000;

function StalenessPill({
  staleness,
}: {
  staleness:
    | { fresh: number; stale: number; total: number; oldest_stale_ms: number | null }
    | null;
}) {
  if (!staleness || staleness.total === 0) return null;
  if (staleness.stale === 0) {
    return (
      <p
        data-testid="brainstorm-staleness-pill"
        data-tone="ok"
        className="mt-1 text-xs text-ok"
      >
        {staleness.total} refs fresh
      </p>
    );
  }
  const ageMs = staleness.oldest_stale_ms
    ? Date.now() - staleness.oldest_stale_ms
    : 0;
  const beyond = ageMs >= STALE_PILL_BEYOND_MS;
  const ago = ageMs > 0 ? humanAgeShort(ageMs) : "just now";
  if (beyond) {
    return (
      <p
        data-testid="brainstorm-staleness-pill"
        data-tone="err"
        className="mt-1 text-xs text-err"
      >
        {staleness.stale} of {staleness.total} refs STALE - oldest {ago} ago
      </p>
    );
  }
  return (
    <p
      data-testid="brainstorm-staleness-pill"
      data-tone="warn"
      className="mt-1 text-xs text-warn"
    >
      {staleness.stale} of {staleness.total} refs catching up...
    </p>
  );
}

function humanAgeShort(ms: number): string {
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}

/* Brainstorm-as-durable-primary-entity (2026-05-22, Path B + section
 * I). The brainstorm IS the god; CC sessions are tools it attaches.
 * This section surfaces the worker CC binding so the user can:
 *   - see whether a worker is currently bound (attached_worker_
 *     session_id non-null + lifecycle_state='attached')
 *   - manually attach a worker by pasting its cc_session_id
 *   - detach the worker (runDistillationFlush will fire daemon-side
 *     so the next attach inherits fresh last_summary)
 *
 * The legacy SupervisesSection below stays for the cross-session-
 * inject project-anchor binding (a different concept). */
function WorkerAttachmentSection({
  brainstormId,
  bs,
}: {
  brainstormId: string;
  bs: {
    attached_worker_session_id?: string | null;
    lifecycle_state?: string;
    runtime_mode?: string;
  };
}) {
  const qc = useQueryClient();
  const [input, setInput] = useState("");
  const attach = useMutation({
    mutationFn: (cc: string) => attachBrainstormWorkerApi(brainstormId, cc),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["brainstorm", brainstormId] });
      void qc.invalidateQueries({ queryKey: ["brainstorms"] });
    },
    onSuccess: (resp) => {
      if (resp.ok) setInput("");
    },
  });
  const detach = useMutation({
    mutationFn: () => detachBrainstormWorkerApi(brainstormId),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ["brainstorm", brainstormId] });
      void qc.invalidateQueries({ queryKey: ["brainstorms"] });
    },
  });
  const attached = bs.attached_worker_session_id ?? null;
  return (
    <section data-testid="brainstorm-detail-worker">
      <h2 className="text-sm font-semibold">Worker CC</h2>
      <p className="text-nano text-txt3 mb-1">
        The brainstorm is the durable Lex brain. A worker CC session is
        the tool side: it implements, tests, and commits while the
        brainstorm drives. Detach fires a distillation flush so the
        next attach picks up fresh context. runtime={bs.runtime_mode ?? "cc-pty"} ·
        state={bs.lifecycle_state ?? "idle"}
      </p>
      {attached ? (
        <div className="flex items-center gap-2 text-xs">
          <span className="font-mono text-txt2">{attached}</span>
          <button
            type="button"
            onClick={() => detach.mutate()}
            disabled={detach.isPending}
            className="rounded border border-border1 bg-surface2 px-2 py-1 font-mono text-nano hover:border-rose-400 disabled:opacity-50"
          >
            {detach.isPending ? "detaching…" : "detach"}
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2 text-xs">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value.trim())}
            placeholder="cc_session_id (uuid)"
            className="flex-1 rounded border border-border1 bg-surface2 px-2 py-1 font-mono"
            aria-label="worker cc_session_id"
          />
          <button
            type="button"
            onClick={() => input && attach.mutate(input)}
            disabled={!input || attach.isPending}
            className="rounded border border-border1 bg-surface2 px-2 py-1 font-mono text-nano hover:border-brandSoft disabled:opacity-50"
          >
            {attach.isPending ? "attaching…" : "attach"}
          </button>
        </div>
      )}
    </section>
  );
}

/* Phase C-3: binding section.
 *
 * The legacy /brainstorms/:id endpoint feeds off brainstorm_sessions
 * (the write-through mirror table), which does not carry the
 * supervises field. lex_session is the source of truth, so this
 * subsection fetches the matching lex_anchor row by the same id and
 * exposes the SupervisesPicker for inline rebind / clear. PATCHes
 * /lex/anchors/:id; invalidates the anchor query + the past-sessions
 * row so other surfaces refresh without a reload. */
function SupervisesSection({ brainstormId }: { brainstormId: string }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["lex-anchor", brainstormId],
    queryFn: () => lexAnchor(brainstormId),
    refetchInterval: 30_000,
  });
  const patchM = useMutation({
    mutationFn: (next: string | null) =>
      patchLexAnchor(brainstormId, {
        supervises_project_anchor_id: next,
      }),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ["lex-anchor", brainstormId] });
      qc.invalidateQueries({ queryKey: ["lex-anchors"] });
    },
  });
  /* The anchor row may not exist for brainstorms that pre-date
   * migration 018 (lex_session backfill). Render nothing in that
   * case rather than a confusing empty picker. */
  if (q.isLoading) return null;
  if (!q.data?.ok || !q.data.anchor) return null;
  const value = q.data.anchor.supervises_project_anchor_id ?? null;
  return (
    <section data-testid="brainstorm-detail-supervises">
      <h2 className="text-sm font-semibold">Supervises project</h2>
      <p className="text-nano text-txt3 mb-1">
        When set, /lex/inject-cross-session lands here if the caller
        omits target_session. Clear to require an explicit target.
      </p>
      <SupervisesPicker
        value={value}
        onChange={(next) => patchM.mutate(next)}
        disabled={patchM.isPending}
      />
    </section>
  );
}

function BrainstormTranscript(props: {
  chunks: BrainstormChunkRow[];
  loading: boolean;
}) {
  const roleStyle: Record<BrainstormChunkRow["role"], string> = {
    user: "text-brandSoft",
    lex: "text-txt1",
    tool: "text-txt3",
  };
  return (
    <section>
      <h2 className="text-sm font-semibold">Transcript</h2>
      {props.loading ? (
        <p className="text-xs text-txt3">loading…</p>
      ) : props.chunks.length === 0 ? (
        <p className="text-xs text-txt3">no transcript chunks for this session.</p>
      ) : (
        <ol className="flex flex-col gap-2">
          {props.chunks.map((c) => (
            <li
              key={c.id}
              className="rounded border border-border1 bg-surface1 p-2 text-xs"
            >
              <div className="flex items-center gap-2 font-mono text-nano text-txt3">
                <span className={roleStyle[c.role]}>{c.role}</span>
                <span>turn {c.turn_index}</span>
                <span>{c.mode}</span>
                <span className="ml-auto">
                  {new Date(c.created_at).toISOString().slice(11, 19)}
                </span>
              </div>
              <p className="mt-1 whitespace-pre-wrap text-txt2">{c.text}</p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/* Brainstorm-as-durable-primary-entity (2026-05-22, plan section N).
 * Surfaces open lex_worker_expectation rows. Each row shows what
 * Lex told the worker to accomplish, the last evaluation's
 * alignment score (0..1, colour-coded), and the drift summary +
 * suggested correction when the supervisor judged the worker has
 * drifted. Read-only; manual close / cancel buttons can land in a
 * follow-up. */
function ExpectationsSection(props: { expectations: WorkerExpectationRow[] }) {
  if (props.expectations.length === 0) {
    return (
      <section>
        <h2 className="text-sm font-semibold">Expectations</h2>
        <p className="text-xs text-txt3">
          No open expectations. Lex records one whenever it dispatches a
          concrete task to the worker; the 90s tick evaluates alignment.
        </p>
      </section>
    );
  }
  return (
    <section>
      <h2 className="text-sm font-semibold">Expectations</h2>
      <ul className="flex flex-col gap-2">
        {props.expectations.map((e) => {
          const score = e.last_alignment_score;
          const scoreTone =
            score === null
              ? "text-txt3"
              : score >= 0.85
                ? "text-ok"
                : score >= 0.5
                  ? "text-attn"
                  : "text-rose-400";
          return (
            <li
              key={e.id}
              className="rounded border border-border1 bg-surface1 p-2 text-xs"
            >
              <p className="font-semibold">{e.expected_outcome}</p>
              <p className="mt-1 flex flex-wrap gap-3 font-mono text-nano text-txt3">
                <span>anchor={e.anchor_id.slice(0, 8)}</span>
                <span>
                  created={new Date(e.created_at).toISOString().slice(0, 16).replace("T", " ")}
                </span>
                <span className={scoreTone}>
                  alignment={score === null ? "unknown" : score.toFixed(2)}
                </span>
              </p>
              {e.last_drift_summary ? (
                <p className="mt-1 text-rose-400">
                  drift: {e.last_drift_summary}
                </p>
              ) : null}
              {e.last_suggested_correction ? (
                <p className="mt-1 text-txt2">
                  suggested: {e.last_suggested_correction}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/* Plan section N: render artifacts whose kind/title imply a deferral
 * (auto-created by lex/deferral-detector.ts on regex+LLM gate hit).
 * Filters the brainstorm's artifact list for reminder-class entries
 * that the deferral detector emitted; matches on the "deferral"
 * marker stamped on the underlying reminder's tags + the artifact's
 * preview. Pure filter; no extra fetch. */
function DeferralsSection(props: {
  items: { id: string; kind: string; title: string; preview: string }[];
  loading: boolean;
}) {
  const deferrals = props.items.filter(
    (a) =>
      a.kind === "reminder" &&
      (a.preview ?? "").toLowerCase().includes("deferral"),
  );
  const fallback = props.items.filter(
    (a) =>
      a.kind === "reminder" &&
      /\b(later|phase\s*2|defer|future|down the road|some\s?day)\b/i.test(
        a.title ?? "",
      ),
  );
  const merged =
    deferrals.length > 0
      ? deferrals
      : fallback.slice(0, 10);
  return (
    <section>
      <h2 className="text-sm font-semibold">Deferrals</h2>
      <p className="text-nano text-txt3 mb-1">
        Reminders auto-created when Lex or you deferred a concrete task in
        conversation (plan section M).
      </p>
      {props.loading ? (
        <p className="text-xs text-txt3">loading…</p>
      ) : merged.length === 0 ? (
        <p className="text-xs text-txt3">none captured.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {merged.map((a) => (
            <li
              key={a.id}
              className="rounded border border-border1 bg-surface1 p-2 text-xs"
            >
              <p className="font-semibold">{a.title}</p>
              {a.preview ? (
                <p className="text-txt3">{a.preview}</p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ArtifactsSection(props: {
  items: { id: string; kind: string; title: string; preview: string }[];
  loading: boolean;
}) {
  return (
    <section>
      <h2 className="text-sm font-semibold">Artifacts</h2>
      {props.loading ? (
        <p className="text-xs text-txt3">loading…</p>
      ) : props.items.length === 0 ? (
        <p className="text-xs text-txt3">none captured.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {props.items.map((a) => (
            <li
              key={a.id}
              className="rounded border border-border1 bg-surface1 p-2 text-xs"
            >
              <p className="font-mono text-txt3">{a.kind}</p>
              <p className="font-semibold">{a.title}</p>
              <p className="text-txt3">{a.preview}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
