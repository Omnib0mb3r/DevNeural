"use client";

/**
 * Wave 2 day 5 step 24a (BF-15 / BF-17 / 5.1). Meeting detail with
 * ConsentGate, AttendeeChips, ActionItemList, audio purge countdown,
 * and the explicit promote-to-wiki control (BF-15 — meetings never
 * auto-distill).
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import {
  getMeeting,
  consentAckMeeting,
  setMeetingKeepAudio,
  addMeetingActionItem,
  updateMeetingActionItem,
  promoteMeetingToWiki,
  type MeetingActionItem,
} from "@/lib/daemon-client";
import { AudioPlayer } from "./AudioPlayer";

export function MeetingDetail({ id }: { id: string }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["meeting", id],
    queryFn: () => getMeeting(id),
    refetchInterval: 10_000,
  });
  const ackM = useMutation({
    mutationFn: () => consentAckMeeting(id),
    onSettled: () => qc.invalidateQueries({ queryKey: ["meeting", id] }),
  });
  const keepM = useMutation({
    mutationFn: (keep: boolean) => setMeetingKeepAudio(id, keep),
    onSettled: () => qc.invalidateQueries({ queryKey: ["meeting", id] }),
  });
  const promoteM = useMutation({
    mutationFn: () => promoteMeetingToWiki(id),
    onSettled: () => qc.invalidateQueries({ queryKey: ["meeting", id] }),
  });
  if (q.isLoading) return <p className="p-4 text-sm text-txt3">loading…</p>;
  if (!q.data?.ok) return <p className="p-4 text-sm text-rose-400">{q.data?.error ?? "failed"}</p>;
  const m = q.data.meeting;
  const items = q.data.action_items;
  const purgesAt = q.data.audio_purges_at;
  const acked = (m.consent_acked ?? 0) === 1;
  const attendees = (m.attendees ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return (
    <div className="flex flex-col gap-4 p-4">
      <div>
        <Link href="/meetings" className="text-xs text-txt3 hover:text-brandSoft">
          ← meetings
        </Link>
        <h1 className="mt-1 text-xl font-semibold">
          {m.user_label || m.derived_label || "(untitled meeting)"}
        </h1>
        <p className="text-xs font-mono text-txt3">
          {m.id} · {new Date(m.started_ms).toISOString().slice(0, 16).replace("T", " ")}
          {m.ended_ms ? ` → ${new Date(m.ended_ms).toISOString().slice(11, 16)}` : " (live)"}
        </p>
        {m.meeting_topic ? (
          <p className="text-xs text-txt2">topic: {m.meeting_topic}</p>
        ) : null}
        {attendees.length > 0 ? (
          <div className="mt-1 flex flex-wrap gap-1">
            {attendees.map((a) => (
              <span
                key={a}
                className="rounded-full border border-border1 bg-surface2 px-2 py-0.5 text-[11px] font-mono"
              >
                {a}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      {!acked ? (
        <ConsentGate onAck={() => ackM.mutate()} pending={ackM.isPending} />
      ) : (
        <p className="text-xs text-promoted">
          consent acked at {m.consent_acked_at?.slice(0, 16).replace("T", " ")} by {m.consent_acked_by ?? "user"}
        </p>
      )}
      {acked && m.audio_path ? (
        <AudioPlayer
          src={`/brainstorms/${encodeURIComponent(m.id)}/audio`}
          defaultRate={0.9}
        />
      ) : null}
      {purgesAt ? (
        <p className="text-xs text-amber-300">
          audio purges at {purgesAt.slice(0, 16).replace("T", " ")} unless kept
        </p>
      ) : null}
      {acked ? (
        <button
          type="button"
          onClick={() => keepM.mutate((m.keep_audio ?? 0) !== 1)}
          disabled={keepM.isPending}
          className="self-start rounded border border-border1 bg-surface2 px-3 py-1 text-xs font-mono disabled:opacity-50"
        >
          {(m.keep_audio ?? 0) === 1 ? "release audio retention" : "keep audio (skip purge)"}
        </button>
      ) : null}
      <ActionItemList meetingId={id} items={items} />
      <div>
        <button
          type="button"
          onClick={() => promoteM.mutate()}
          disabled={promoteM.isPending}
          className="rounded border border-brandSoft bg-brandSoft px-3 py-1 text-sm text-bg1 disabled:opacity-50"
        >
          {promoteM.isPending ? "promoting…" : "promote to wiki"}
        </button>
        {promoteM.data?.wiki_page_id ? (
          <p className="mt-1 text-xs text-promoted">
            wrote pending wiki page{" "}
            <Link
              href={`/wiki?id=${encodeURIComponent(promoteM.data.wiki_page_id)}`}
              className="underline"
            >
              {promoteM.data.wiki_page_id}
            </Link>
          </p>
        ) : null}
      </div>
    </div>
  );
}

function ConsentGate(props: { onAck: () => void; pending: boolean }) {
  return (
    <div className="rounded border border-amber-500/60 bg-amber-500/10 p-3 text-xs">
      <p className="font-semibold text-amber-300">Consent gate (BF-17)</p>
      <p className="mt-1">
        meeting audio is dropped at session end until consent is
        acknowledged. transcription still runs in-memory; only the
        WAV bundle and cues file are skipped.
      </p>
      <button
        type="button"
        onClick={props.onAck}
        disabled={props.pending}
        className="mt-2 rounded border border-brandSoft bg-brandSoft px-3 py-1 text-bg1 disabled:opacity-50"
      >
        {props.pending ? "ack…" : "I have consent — start retaining audio"}
      </button>
    </div>
  );
}

function ActionItemList(props: { meetingId: string; items: MeetingActionItem[] }) {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const [assignee, setAssignee] = useState("");
  const [due, setDue] = useState("");
  const addM = useMutation({
    mutationFn: () =>
      addMeetingActionItem(props.meetingId, {
        text,
        ...(assignee ? { assignee } : {}),
        ...(due ? { due } : {}),
      }),
    onSuccess: () => {
      setText("");
      setAssignee("");
      setDue("");
      qc.invalidateQueries({ queryKey: ["meeting", props.meetingId] });
    },
  });
  const updateM = useMutation({
    mutationFn: (args: { id: string; status: MeetingActionItem["status"] }) =>
      updateMeetingActionItem(props.meetingId, args.id, args.status),
    onSettled: () => qc.invalidateQueries({ queryKey: ["meeting", props.meetingId] }),
  });
  return (
    <section>
      <h2 className="text-sm font-semibold">Action items</h2>
      {props.items.length === 0 ? (
        <p className="text-xs text-txt3">none captured.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {props.items.map((a) => (
            <li
              key={a.id}
              className="flex items-center gap-2 rounded border border-border1 bg-surface1 p-2 text-xs"
            >
              <span className={a.status === "open" ? "" : "line-through text-txt3"}>
                {a.text}
              </span>
              {a.assignee ? <span className="font-mono text-txt3">@{a.assignee}</span> : null}
              {a.due ? <span className="font-mono text-txt3">due {a.due}</span> : null}
              <span className="ml-auto flex gap-1">
                {a.status === "open" ? (
                  <button
                    type="button"
                    onClick={() => updateM.mutate({ id: a.id, status: "done" })}
                    className="rounded border border-border1 bg-surface2 px-2 py-0.5 font-mono"
                  >
                    done
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => updateM.mutate({ id: a.id, status: "dismissed" })}
                  className="rounded border border-border1 bg-surface2 px-2 py-0.5 font-mono text-rose-400"
                >
                  dismiss
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) addM.mutate();
        }}
        className="mt-2 flex flex-wrap gap-2 text-xs"
      >
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="action item"
          className="flex-1 min-w-40 rounded border border-border1 bg-surface2 px-2 py-1 font-mono"
        />
        <input
          value={assignee}
          onChange={(e) => setAssignee(e.target.value)}
          placeholder="assignee"
          className="rounded border border-border1 bg-surface2 px-2 py-1 font-mono"
        />
        <input
          type="date"
          value={due}
          onChange={(e) => setDue(e.target.value)}
          className="rounded border border-border1 bg-surface2 px-2 py-1 font-mono"
        />
        <button
          type="submit"
          disabled={addM.isPending || !text.trim()}
          className="rounded border border-border1 bg-surface2 px-3 py-1 font-mono disabled:opacity-50"
        >
          add
        </button>
      </form>
    </section>
  );
}
