"use client";

/**
 * Wave 2 day 2 step 9 (BF-5 / A1) brainstorm detail.
 *
 * Renders the brainstorm row + the artifacts manifest + an AudioPlayer
 * when audio was retained. Cues are loaded lazily from the cues_url
 * so a session without audio doesn't pay the second fetch.
 */
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { AudioPlayer } from "./AudioPlayer";
import {
  getBrainstormApi,
  getBrainstormCuesApi,
  lexSessionArtifacts,
  type AudioCue,
} from "@/lib/daemon-client";

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
  const label = bs.user_label || bs.derived_label || "(untitled)";

  return (
    <div className="flex flex-col gap-4 p-4">
      <div>
        <Link href="/brainstorms" className="text-xs text-txt3 hover:text-brandSoft">
          ← brainstorms
        </Link>
        <h1 className="mt-1 text-xl font-semibold">{label}</h1>
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
      {bs.last_summary ? (
        <section>
          <h2 className="text-sm font-semibold">Summary</h2>
          <p className="whitespace-pre-wrap text-sm text-txt2">{bs.last_summary}</p>
        </section>
      ) : null}
      <ArtifactsSection
        items={artifacts.data?.artifacts ?? []}
        loading={artifacts.isLoading}
      />
    </div>
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
