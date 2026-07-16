"use client";

/**
 * Wave 2 day 5 step 24a (BF-15 / BF-17 / 5.1). Meetings list. Filters
 * by project + date + consent state. Empty state per spec section
 * 5.6 notes the consent-acked requirement before audio retention
 * starts.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { listMeetings, type MeetingRow } from "@/lib/daemon-client";

export function MeetingList() {
  const [project, setProject] = useState("");
  const [date, setDate] = useState("");
  const [consent, setConsent] = useState<"" | "acked" | "pending">("");
  const opts = useMemo(() => {
    const o: Parameters<typeof listMeetings>[0] = { limit: 100 };
    if (project) o.project = project;
    if (date) o.date = date;
    if (consent) o.consent = consent;
    return o;
  }, [project, date, consent]);
  const q = useQuery({
    queryKey: ["meetings", opts],
    queryFn: () => listMeetings(opts),
    refetchInterval: 8_000,
  });
  const rows: MeetingRow[] = q.data?.meetings ?? [];
  return (
    <div className="flex flex-col gap-3 p-4">
      <h1 className="text-xl font-semibold">Meetings</h1>
      <div className="flex flex-wrap gap-2 text-xs">
        <input
          value={project}
          onChange={(e) => setProject(e.target.value.trim())}
          placeholder="project slug"
          className="rounded border border-border1 bg-surface2 px-2 py-1 font-mono"
        />
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="rounded border border-border1 bg-surface2 px-2 py-1 font-mono"
        />
        <select
          value={consent}
          onChange={(e) => setConsent(e.target.value as "" | "acked" | "pending")}
          className="rounded border border-border1 bg-surface2 px-2 py-1 font-mono"
        >
          <option value="">any consent</option>
          <option value="acked">consent acked</option>
          <option value="pending">consent pending</option>
        </select>
      </div>
      {q.isLoading ? (
        <p className="text-sm text-txt3">loading…</p>
      ) : rows.length === 0 ? (
        <div className="rounded border border-dashed border-border1 bg-surface1 p-6 text-center text-sm text-txt3">
          <p>No meetings yet.</p>
          <p className="mt-1">
            Start one from the{" "}
            <Link href="/lex" className="text-brandSoft underline">
              voice panel
            </Link>
            : switch to notes mode and turn on the meeting toggle before
            speaking. The session lands here as a meeting, and audio is only
            retained after you acknowledge consent.
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((m) => {
            const label = m.user_label || m.derived_label || "(untitled)";
            const acked = (m.consent_acked ?? 0) === 1;
            return (
              <li key={m.id} className="rounded border border-border1 bg-surface1 p-3">
                <Link
                  href={`/meetings/detail?id=${encodeURIComponent(m.id)}`}
                  className="font-mono text-sm hover:text-brandSoft"
                >
                  {label}
                </Link>
                <div className="mt-1 flex flex-wrap gap-2 text-[11px] font-mono text-txt3">
                  <span>{new Date(m.started_ms).toISOString().slice(0, 16).replace("T", " ")}</span>
                  <span>{m.turn_count} turns</span>
                  {m.project_slug ? <span>project={m.project_slug}</span> : null}
                  <span className={acked ? "text-promoted" : "text-amber-300"}>
                    {acked ? "consent acked" : "consent pending"}
                  </span>
                  {m.audio_path ? <span className="text-brandSoft">audio</span> : null}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
