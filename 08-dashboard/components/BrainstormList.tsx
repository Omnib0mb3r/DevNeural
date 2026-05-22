"use client";

/**
 * Wave 2 day 2 step 9 (BF-5 / A1) brainstorm list.
 *
 * Filter chips for project_slug + mode + date drive a single
 * /brainstorms call. Empty state per spec section 5.6 routes the
 * user back to /sessions/new (the existing new-session entry point;
 * a dedicated /brainstorms/new is out of Wave 2 scope).
 */
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  listBrainstormsApi,
  createStandaloneBrainstormApi,
  type BrainstormDecorated,
  type BrainstormFilter,
} from "@/lib/daemon-client";

export interface BrainstormListProps {
  initialKind?: "brainstorm" | "meeting";
}

export function BrainstormList({ initialKind = "brainstorm" }: BrainstormListProps) {
  const [project, setProject] = useState<string>("");
  const [mode, setMode] = useState<string>("");
  const [date, setDate] = useState<string>("");
  const filter = useMemo<BrainstormFilter>(() => {
    const f: BrainstormFilter = { kind: initialKind, limit: 100 };
    if (project) f.project = project;
    if (mode) f.mode = mode;
    if (date) f.date = date;
    return f;
  }, [initialKind, project, mode, date]);

  const q = useQuery({
    queryKey: ["brainstorms", filter],
    queryFn: () => listBrainstormsApi(filter),
    refetchInterval: 5_000,
  });

  const router = useRouter();
  const qc = useQueryClient();
  /* Brainstorm-as-durable-primary-entity (2026-05-22, Path B).
   * "+ standalone" mints a brainstorm with runtime_mode=direct-llm
   * and no PTY backing it. Voice WS attaches by brainstorm_id and
   * runs the direct-llm path on every utterance. */
  const createStandalone = useMutation({
    mutationFn: () =>
      createStandaloneBrainstormApi({
        mode: "conversation",
      }),
    onSuccess: (resp) => {
      if (!resp.ok || !resp.brainstorm) return;
      void qc.invalidateQueries({ queryKey: ["brainstorms"] });
      router.push(
        `/brainstorms/detail?id=${encodeURIComponent(resp.brainstorm.brainstorm.id)}`,
      );
    },
  });

  const rows: BrainstormDecorated[] = q.data?.brainstorms ?? [];

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold">Brainstorms</h1>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => createStandalone.mutate()}
              disabled={createStandalone.isPending}
              className="rounded border border-border1 bg-surface2 px-3 py-1 text-sm font-mono hover:border-brandSoft disabled:opacity-50"
              title="Create a brainstorm with no Lex PTY backing it. Voice attaches by brainstorm_id and runs against the local LLM directly."
            >
              {createStandalone.isPending ? "creating…" : "+ standalone"}
            </button>
            <Link
              href="/sessions/new"
              className="rounded border border-border1 bg-surface2 px-3 py-1 text-sm font-mono"
            >
              + new session
            </Link>
          </div>
        </div>
        <p className="text-xs text-txt3">
          Voice and text sessions you have had with Lex. Filter by project, mode, or date to find one.
        </p>
      </div>
      <FilterChips
        project={project}
        mode={mode}
        date={date}
        onProject={setProject}
        onMode={setMode}
        onDate={setDate}
      />
      {q.isLoading ? (
        <p className="text-sm text-txt3">loading…</p>
      ) : rows.length === 0 ? (
        <EmptyState />
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((r) => (
            <BrainstormRow key={r.brainstorm.id} item={r} />
          ))}
        </ul>
      )}
    </div>
  );
}

function FilterChips(props: {
  project: string;
  mode: string;
  date: string;
  onProject: (v: string) => void;
  onMode: (v: string) => void;
  onDate: (v: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <input
        value={props.project}
        onChange={(e) => props.onProject(e.target.value.trim())}
        placeholder="project slug"
        className="rounded border border-border1 bg-surface2 px-2 py-1 font-mono"
        aria-label="filter by project slug"
      />
      <select
        value={props.mode}
        onChange={(e) => props.onMode(e.target.value)}
        className="rounded border border-border1 bg-surface2 px-2 py-1 font-mono"
        aria-label="filter by mode"
      >
        <option value="">any mode</option>
        <option value="conversation">conversation (voice both ways)</option>
        <option value="push-to-talk">push-to-talk (hold mic to speak)</option>
        <option value="notes">notes (dictation, no reply)</option>
      </select>
      <input
        type="date"
        value={props.date}
        onChange={(e) => props.onDate(e.target.value)}
        className="rounded border border-border1 bg-surface2 px-2 py-1 font-mono"
        aria-label="filter by date"
      />
      {(props.project || props.mode || props.date) && (
        <button
          type="button"
          onClick={() => {
            props.onProject("");
            props.onMode("");
            props.onDate("");
          }}
          className="text-txt3 underline"
        >
          clear
        </button>
      )}
    </div>
  );
}

function BrainstormRow({ item }: { item: BrainstormDecorated }) {
  const bs = item.brainstorm;
  const started = new Date(bs.started_ms).toISOString().replace("T", " ").slice(0, 16);
  const ended = bs.ended_ms ? new Date(bs.ended_ms).toISOString().slice(11, 16) : "live";
  /* Match LexSessionList row layout: top line is the human name
   * (user_label or derived_label, "unnamed" placeholder when neither
   * is set), the row id sits on its own dim line below, then the
   * meta line (started/ended + mode + turns + flags). Keeps the id
   * stable as a reference handle without conflating it with the
   * editable name. */
  const name = bs.user_label?.trim() || bs.derived_label?.trim() || "";
  const shortId = bs.id.slice(0, 8);
  return (
    <li className="rounded border border-border1 bg-surface1 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <Link
            href={`/brainstorms/detail?id=${encodeURIComponent(bs.id)}`}
            className="text-sm hover:text-brandSoft truncate block"
          >
            {name || <span className="text-txt3 italic">unnamed</span>}
          </Link>
          <div className="text-[11px] font-mono text-txt3 truncate">{shortId}</div>
        </div>
        <span className="text-xs font-mono text-txt3 flex-shrink-0">
          {started} → {ended}
        </span>
      </div>
      <div className="mt-1 flex flex-wrap gap-2 text-[11px] font-mono text-txt3">
        <span>mode={bs.mode}</span>
        <span>turns={bs.turn_count}</span>
        {bs.project_slug ? <span>project={bs.project_slug}</span> : null}
        {item.audio_url ? <span className="text-brandSoft">audio</span> : null}
        {bs.distilled_at ? <span className="text-brandSoft">distilled</span> : null}
        {bs.runtime_mode && bs.runtime_mode !== "cc-pty" ? (
          <span className="text-brandSoft">runtime={bs.runtime_mode}</span>
        ) : null}
        {bs.lifecycle_state && bs.lifecycle_state !== "idle" ? (
          <span
            className={
              bs.lifecycle_state === "speaking"
                ? "text-attn"
                : bs.lifecycle_state === "ended"
                  ? "text-txt3"
                  : "text-brandSoft"
            }
          >
            state={bs.lifecycle_state}
          </span>
        ) : null}
        {bs.attached_worker_session_id ? (
          <span className="text-brandSoft">
            worker={bs.attached_worker_session_id.slice(0, 8)}
          </span>
        ) : null}
      </div>
    </li>
  );
}

function EmptyState() {
  return (
    <div className="rounded border border-dashed border-border1 bg-surface1 p-6 text-center text-sm text-txt3">
      <p>no brainstorms yet</p>
      <p className="mt-1">
        start one with{" "}
        <Link href="/sessions/new" className="text-brandSoft underline">
          new session
        </Link>
      </p>
    </div>
  );
}
