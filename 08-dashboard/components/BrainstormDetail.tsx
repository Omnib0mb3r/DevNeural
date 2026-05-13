"use client";

/**
 * Wave 2 day 2 step 9 (BF-5 / A1) brainstorm detail.
 *
 * Renders the brainstorm row + the artifacts manifest + an AudioPlayer
 * when audio was retained. Cues are loaded lazily from the cues_url
 * so a session without audio doesn't pay the second fetch.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { AudioPlayer } from "./AudioPlayer";
import {
  getBrainstormApi,
  getBrainstormCuesApi,
  getBrainstormChunksApi,
  lexAnchor,
  lexSessionArtifacts,
  patchLexAnchor,
  type AudioCue,
  type BrainstormChunkRow,
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
  const chunks = useQuery({
    queryKey: ["brainstorm-chunks", id],
    queryFn: () => getBrainstormChunksApi(id, 500),
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
      <SupervisesSection brainstormId={id} />
      {bs.last_summary ? (
        <section>
          <h2 className="text-sm font-semibold">Summary</h2>
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
