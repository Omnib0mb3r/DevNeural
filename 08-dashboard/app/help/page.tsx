"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { Icon } from "@/components/Icon";
import { MarkdownPanel } from "@/components/MarkdownPanel";

/* Full help section (2026-07-17). Static, browsable, searchable.
 * Content lives as markdown under 08-dashboard/public/help/*.md so a
 * copy edit does not require a React component rebuild; the page
 * fetches each file at runtime and renders through the shared
 * MarkdownPanel.
 *
 * Layout: sticky topic sidebar on the left (anchor navigation with
 * scroll-position highlighting), section cards on the right. Each
 * section header carries a copyable # anchor. The search box filters
 * sections whose title or markdown body contains the query
 * (case-insensitive substring; no fuzzy yet).
 */

interface HelpSection {
  id: string;
  title: string;
  file: string;
}

const SECTIONS: HelpSection[] = [
  { id: "getting-started", title: "Getting started", file: "/help/getting-started.md" },
  { id: "voice-commands", title: "Talking to Lex", file: "/help/voice-commands.md" },
  { id: "voice-guide", title: "How the voice works", file: "/help/voice-guide.md" },
  {
    id: "keyboard-shortcuts",
    title: "Keyboard shortcuts",
    file: "/help/keyboard-shortcuts.md",
  },
  {
    id: "pages-overview",
    title: "Pages overview",
    file: "/help/pages-overview.md",
  },
  {
    id: "brainstorms-and-sessions",
    title: "Brainstorms and sessions",
    file: "/help/brainstorms-and-sessions.md",
  },
  { id: "workflows", title: "Common workflows", file: "/help/workflows.md" },
  {
    id: "troubleshooting",
    title: "Troubleshooting",
    file: "/help/troubleshooting.md",
  },
  { id: "glossary", title: "Glossary", file: "/help/glossary.md" },
];

export default function HelpPage(): React.ReactElement {
  const [bodies, setBodies] = useState<Record<string, string>>({});
  const [query, setQuery] = useState<string>("");
  const [activeId, setActiveId] = useState<string>(SECTIONS[0]?.id ?? "");
  const sectionRefs = useRef<Record<string, HTMLElement | null>>({});

  useEffect(() => {
    /* Fetch every section markdown on mount. Failures degrade to an
     * inline empty body so the page still renders; the section
     * header is shown but the body reads as a stub. */
    let cancelled = false;
    void (async () => {
      const next: Record<string, string> = {};
      for (const s of SECTIONS) {
        try {
          const r = await fetch(s.file, { credentials: "same-origin" });
          if (r.ok) {
            next[s.id] = await r.text();
          } else {
            next[s.id] = `## ${s.title}\n\n_Content failed to load (${r.status})._\n`;
          }
        } catch (err) {
          next[s.id] = `## ${s.title}\n\n_Content failed to load (${(err as Error).message})._\n`;
        }
      }
      if (!cancelled) setBodies(next);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /* Track which section is in view so the sidebar highlights it.
   * IntersectionObserver over the section elements; the topmost
   * intersecting section wins. */
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        const first = visible[0]?.target?.id;
        if (first) setActiveId(first);
      },
      { rootMargin: "-10% 0px -70% 0px" },
    );
    for (const s of SECTIONS) {
      const el = sectionRefs.current[s.id];
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [bodies]);

  const filteredIds = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return SECTIONS.map((s) => s.id);
    return SECTIONS.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        (bodies[s.id] ?? "").toLowerCase().includes(q),
    ).map((s) => s.id);
  }, [bodies, query]);

  return (
    <AppShell>
      <div className="px-6 py-5 space-y-5 max-w-6xl">
        <div className="flex flex-col gap-1">
          <h1 className="font-display text-2xl font-emphasized">Help</h1>
          <p className="text-sm text-txt3">
            How to use the dashboard, what each control does, and the plain-language definitions behind the jargon.
          </p>
        </div>

        <div className="rounded-card bg-surface1 hairline px-3 py-2 flex items-center gap-2">
          <Icon name="Search" size={16} className="text-txt3 shrink-0" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search help (voice, shortcut, brainstorm, ...)"
            className="flex-1 bg-transparent outline-none text-sm text-txt1 placeholder:text-txt3"
            aria-label="Search help"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="text-nano text-txt3 hover:text-txt1 font-mono"
            >
              clear
            </button>
          )}
        </div>

        <div className="flex gap-5 items-start">
          <nav
            aria-label="Help topics"
            className="hidden md:block w-52 shrink-0 sticky top-5 rounded-panel bg-surface1 hairline p-3"
            data-testid="help-toc"
          >
            <p className="text-nano uppercase tracking-wider text-txt3 px-2 pb-2">
              Topics
            </p>
            <ul className="space-y-0.5">
              {SECTIONS.map((s) => {
                const hidden = !filteredIds.includes(s.id);
                return (
                  <li key={s.id}>
                    <a
                      href={`#${s.id}`}
                      className={[
                        "block rounded-md px-2 py-1.5 text-sm transition-colors",
                        hidden
                          ? "text-txt3/50 pointer-events-none"
                          : activeId === s.id
                            ? "bg-surface2 text-txt1 font-medium"
                            : "text-txt2 hover:text-txt1 hover:bg-surface2/60",
                      ].join(" ")}
                      aria-disabled={hidden}
                      onClick={() => setActiveId(s.id)}
                    >
                      {s.title}
                    </a>
                  </li>
                );
              })}
            </ul>
          </nav>

          <div className="flex-1 min-w-0 space-y-5">
            {SECTIONS.map((s) => {
              if (!filteredIds.includes(s.id)) return null;
              const body = bodies[s.id];
              return (
                <section
                  key={s.id}
                  id={s.id}
                  ref={(el) => {
                    sectionRefs.current[s.id] = el;
                  }}
                  className="rounded-panel bg-surface1 hairline p-5 scroll-mt-5"
                  data-testid={`help-section-${s.id}`}
                >
                  <div className="flex items-baseline justify-between pb-1">
                    <span className="sr-only">{s.title}</span>
                    <a
                      href={`#${s.id}`}
                      className="text-txt3/60 hover:text-txt1 text-sm font-mono ml-auto"
                      aria-label={`Link to ${s.title}`}
                      title={`Link to ${s.title}`}
                    >
                      #
                    </a>
                  </div>
                  {body === undefined ? (
                    <p className="text-sm text-txt3">Loading {s.title}...</p>
                  ) : (
                    <MarkdownPanel markdown={body} />
                  )}
                </section>
              );
            })}

            {filteredIds.length === 0 && (
              <div className="rounded-panel bg-surface1 hairline p-6 text-sm text-txt3">
                No help sections match <strong>&ldquo;{query}&rdquo;</strong>. Try a shorter or different keyword.
              </div>
            )}
          </div>
        </div>
      </div>
    </AppShell>
  );
}
