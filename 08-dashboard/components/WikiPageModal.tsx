"use client";

import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { wikiPage, searchAll, type SearchHit } from "@/lib/daemon-client";
import { Icon } from "./Icon";
import { StatusDot } from "./StatusDot";

/* Modal for previewing a wiki page from the search results.
 * The wiki has no dedicated detail route yet; this overlay lets the
 * user read the full Pattern + Evidence + Cross-refs without leaving
 * the search context. Esc / click outside / ✕ closes.
 *
 * Two integrations with sessions:
 *  1. Evidence lines that contain a session UUID become clickable
 *     deep links to /sessions/detail (precise, page-cited source).
 *  2. A "Related transcripts" section runs a vector search using the
 *     page's summary against raw_chunks, surfacing the top 5
 *     semantically-related session chunks. Catches transcripts the
 *     page itself never cited but still shares the same insight. */

const SESSION_UUID_RE =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;

/* Pick a distinctive ~6-word phrase out of a chunk's preview to use
 * as the highlight query when navigating to /sessions/detail. The
 * server-side scan does a case-insensitive substring match, so we
 * want a phrase long enough to be unique within the session but
 * short enough to survive minor punctuation differences. */
function pickHighlightPhrase(text: string): string {
  if (!text) return "";
  // Prefer a quoted span if one exists; high-info and naturally
  // distinctive.
  const quoted = text.match(/[\"'`]([^\"'`]{8,80})[\"'`]/);
  if (quoted?.[1]) return quoted[1].trim();
  // Otherwise take first ~6 words after any leading boilerplate.
  const stripped = text.replace(/^[\s\W]+/, "").trim();
  const words = stripped.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  return words.slice(0, 6).join(" ").slice(0, 80);
}

interface Props {
  id: string;
  onClose: () => void;
}

export function WikiPageModal({ id, onClose }: Props) {
  const router = useRouter();
  const q = useQuery({
    queryKey: ["wiki-page", id],
    queryFn: () => wikiPage(id),
    retry: false,
  });

  /* Vector search using the loaded page's title+summary as query.
   * Runs only after the page resolves; falls back to silence if the
   * page didn't return summary (e.g. parse failure). */
  const queryText = useMemo(() => {
    const p = q.data?.page;
    if (!p) return "";
    return `${p.title}\n\n${p.summary}\n\n${p.pattern.slice(0, 500)}`;
  }, [q.data]);

  const related = useQuery({
    queryKey: ["wiki-page-related", id, queryText],
    queryFn: () =>
      searchAll(queryText, { collections: ["raw_chunk"], limit: 5 }),
    enabled: queryText.length > 0,
    staleTime: 60_000,
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function openSession(sessionId: string, query?: string): void {
    const params = new URLSearchParams({ id: sessionId });
    if (query) params.set("q", query);
    router.push(`/sessions/detail?${params.toString()}`);
  }

  function openRelated(hit: SearchHit): void {
    const meta = hit.metadata ?? {};
    const sid = typeof meta.session_id === "string" ? meta.session_id : null;
    if (!sid) return;
    // The page trigger / title are LLM-abstracted strings that rarely
    // appear verbatim in the transcript, so passing them as the
    // highlight query produced "no matches" on the session detail.
    // Use a chunk-grounded phrase instead: pull a distinctive ~6-word
    // window from the matched chunk's own text. That guarantees the
    // session view scrolls to the actual hit and highlights it.
    const previewSrc =
      typeof meta.text_preview === "string"
        ? meta.text_preview
        : (hit.preview ?? "");
    const phrase = pickHighlightPhrase(previewSrc);
    openSession(sid, phrase);
  }

  function renderEvidenceLine(line: string): React.ReactNode {
    const m = line.match(SESSION_UUID_RE);
    if (!m) return line;
    const sid = m[0];
    const before = line.slice(0, m.index ?? 0);
    const after = line.slice((m.index ?? 0) + sid.length);
    return (
      <>
        {before}
        <button
          type="button"
          onClick={() => openSession(sid, q.data?.page?.trigger ?? "")}
          className="font-mono text-brandSoft hover:underline"
          title="Open this session"
        >
          {sid.slice(0, 12)}
        </button>
        {after}
      </>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-start pt-16 px-6"
      style={{ background: "var(--c-bg-overlay)" }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl max-h-[80vh] overflow-y-auto rounded-panel bg-surface1 hairline"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-3 border-b border-border1 flex items-center justify-between gap-3 sticky top-0 bg-surface1 z-10">
          <div className="flex items-center gap-2 min-w-0">
            <Icon name="BookOpen" className="text-brandSoft" size={16} />
            <h2 className="font-display text-sm font-emphasized truncate">
              {q.data?.page?.title ?? id}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-txt3 hover:text-txt1"
          >
            <Icon name="X" size={18} />
          </button>
        </div>

        {q.isLoading && (
          <div className="p-6 text-xs text-txt3">loading page…</div>
        )}
        {q.isError && (
          <div className="p-6 text-xs text-err">
            Failed to load: {(q.error as Error).message}
          </div>
        )}
        {q.data && !q.data.ok && (
          <div className="p-6 text-xs text-err">{q.data.error}</div>
        )}
        {q.data?.ok && q.data.page && (
          <article className="p-6 space-y-5 text-sm">
            <div className="flex items-center gap-3 text-[11px] font-mono text-txt3">
              <span className="inline-flex items-center gap-1.5">
                <StatusDot
                  status={
                    q.data.page.status === "canonical"
                      ? "ok"
                      : q.data.page.status === "pending"
                        ? "ai"
                        : "idle"
                  }
                />
                {q.data.page.status}
              </span>
              <span>weight {q.data.page.weight.toFixed(2)}</span>
              <span>hits {q.data.page.hits}</span>
              <span>corrections {q.data.page.corrections}</span>
              <span>· last touched {q.data.page.last_touched}</span>
            </div>
            {q.data.page.summary && (
              <section>
                <div className="text-nano text-txt3 uppercase tracking-wider mb-1">
                  Summary
                </div>
                <p className="text-txt2 whitespace-pre-wrap">
                  {q.data.page.summary}
                </p>
              </section>
            )}
            {q.data.page.pattern && (
              <section>
                <div className="text-nano text-txt3 uppercase tracking-wider mb-1">
                  Pattern
                </div>
                <p className="text-txt2 whitespace-pre-wrap font-mono text-xs">
                  {q.data.page.pattern}
                </p>
              </section>
            )}
            {q.data.page.evidence?.length > 0 && (
              <section>
                <div className="text-nano text-txt3 uppercase tracking-wider mb-1">
                  Evidence
                </div>
                <ul className="text-txt2 text-xs space-y-1 list-disc pl-5">
                  {q.data.page.evidence.map((e, i) => (
                    <li key={i} className="font-mono">
                      {renderEvidenceLine(e)}
                    </li>
                  ))}
                </ul>
              </section>
            )}

            <section>
              <div className="text-nano text-txt3 uppercase tracking-wider mb-1 flex items-center gap-2">
                <Icon name="Terminal" size={11} className="text-brandSoft" />
                Related transcripts
                <span className="text-txt3">
                  {related.isPending
                    ? "searching…"
                    : `${related.data?.results?.length ?? 0} hit(s)`}
                </span>
              </div>
              {!related.isPending && (related.data?.results?.length ?? 0) === 0 && (
                <p className="text-xs text-txt3">
                  No related transcript chunks found in raw_chunks.
                </p>
              )}
              <ul className="space-y-1.5">
                {(related.data?.results ?? []).map((h, i) => {
                  const meta = h.metadata ?? {};
                  const sid =
                    typeof meta.session_id === "string" ? meta.session_id : "";
                  const slug =
                    typeof meta.project_id === "string"
                      ? meta.project_id
                      : "global";
                  const preview =
                    typeof meta.text_preview === "string"
                      ? meta.text_preview
                      : (h.preview ?? "");
                  return (
                    <li
                      key={i}
                      onClick={() => openRelated(h)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          openRelated(h);
                        }
                      }}
                      className="rounded-card bg-surface2/50 hairline px-3 py-2 text-xs cursor-pointer hover:ring-1 hover:ring-brand/40"
                    >
                      <div className="flex items-center gap-2 mb-0.5 text-[11px] font-mono text-txt3">
                        <span>{slug.slice(0, 12)}</span>
                        <span className="text-txt3">·</span>
                        <span>{sid.slice(0, 8)}</span>
                        <span className="ml-auto">score {h.score.toFixed(2)}</span>
                      </div>
                      <p className="text-txt2 line-clamp-2 font-mono whitespace-pre-wrap">
                        {preview}
                      </p>
                    </li>
                  );
                })}
              </ul>
            </section>
            {(q.data.page.source_brainstorms?.length ?? 0) > 0 && (
              <section>
                <div className="text-nano text-txt3 uppercase tracking-wider mb-1 flex items-center gap-2">
                  <Icon name="Sparkles" size={11} className="text-brandSoft" />
                  Source brainstorms
                  {q.data.page.derived_from_brainstorm ? (
                    <span className="text-brandSoft">(primary)</span>
                  ) : null}
                </div>
                <ul className="text-txt2 text-xs space-y-1">
                  {q.data.page.source_brainstorms!.map((bid) => (
                    <li key={bid} className="font-mono">
                      <a
                        href={`/brainstorms/detail?id=${encodeURIComponent(bid)}`}
                        className="hover:text-brandSoft underline"
                      >
                        {bid}
                      </a>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {(q.data.page.source_meetings?.length ?? 0) > 0 && (
              <section>
                <div className="text-nano text-txt3 uppercase tracking-wider mb-1 flex items-center gap-2">
                  <Icon name="Mic" size={11} className="text-brandSoft" />
                  Source meetings
                  {q.data.page.derived_from_meeting ? (
                    <span className="text-brandSoft">(primary)</span>
                  ) : null}
                </div>
                <ul className="text-txt2 text-xs space-y-1">
                  {q.data.page.source_meetings!.map((mid) => (
                    <li key={mid} className="font-mono">
                      <a
                        href={`/meetings/detail?id=${encodeURIComponent(mid)}`}
                        className="hover:text-brandSoft underline"
                      >
                        {mid}
                      </a>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {q.data.page.cross_refs?.length > 0 && (
              <section>
                <div className="text-nano text-txt3 uppercase tracking-wider mb-1">
                  Cross-references
                </div>
                <ul className="text-txt2 text-xs space-y-1 list-disc pl-5">
                  {q.data.page.cross_refs.map((c) => (
                    <li key={c} className="font-mono">{c}</li>
                  ))}
                </ul>
              </section>
            )}
            {q.data.page.log?.length > 0 && (
              <section>
                <div className="text-nano text-txt3 uppercase tracking-wider mb-1">
                  Log
                </div>
                <ul className="text-txt3 text-[11px] space-y-0.5 font-mono">
                  {q.data.page.log.slice(-10).map((l, i) => (
                    <li key={i}>{l}</li>
                  ))}
                </ul>
              </section>
            )}
            <div className="text-nano text-txt3 font-mono">
              id: {q.data.page.id}
            </div>
          </article>
        )}
      </div>
    </div>
  );
}
