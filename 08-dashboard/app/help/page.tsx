"use client";

import { useEffect, useMemo, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { Icon } from "@/components/Icon";
import { MarkdownPanel } from "@/components/MarkdownPanel";

/* Static, browsable, searchable Help surface. Content lives as
 * markdown under 08-dashboard/public/help/*.md so a copy edit does
 * not require a React component rebuild; the page fetches each file
 * at runtime and renders through the shared MarkdownPanel.
 *
 * Section order is fixed (voice -> shortcuts -> pages -> workflows
 * -> glossary). Each section header is anchorable; the optional
 * search box filters sections whose markdown body contains the
 * query string (case-insensitive substring; no fuzzy yet).
 */

interface HelpSection {
  id: string;
  title: string;
  file: string;
}

const SECTIONS: HelpSection[] = [
  { id: "voice-commands", title: "Voice commands", file: "/help/voice-commands.md" },
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
  { id: "workflows", title: "Common workflows", file: "/help/workflows.md" },
  { id: "glossary", title: "Glossary", file: "/help/glossary.md" },
];

export default function HelpPage(): React.ReactElement {
  const [bodies, setBodies] = useState<Record<string, string>>({});
  const [query, setQuery] = useState<string>("");

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

  const filteredIds = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return SECTIONS.map((s) => s.id);
    return SECTIONS.filter((s) =>
      (bodies[s.id] ?? "").toLowerCase().includes(q),
    ).map((s) => s.id);
  }, [bodies, query]);

  return (
    <AppShell>
      <div className="px-6 py-5 space-y-5 max-w-4xl">
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

        {SECTIONS.map((s) => {
          if (!filteredIds.includes(s.id)) return null;
          const body = bodies[s.id];
          if (body === undefined) {
            return (
              <section
                key={s.id}
                id={s.id}
                className="rounded-panel bg-surface1 hairline p-5"
                data-testid={`help-section-${s.id}`}
              >
                <p className="text-sm text-txt3">Loading {s.title}...</p>
              </section>
            );
          }
          return (
            <section
              key={s.id}
              id={s.id}
              className="rounded-panel bg-surface1 hairline p-5"
              data-testid={`help-section-${s.id}`}
            >
              <MarkdownPanel markdown={body} />
            </section>
          );
        })}

        {filteredIds.length === 0 && (
          <div className="rounded-panel bg-surface1 hairline p-6 text-sm text-txt3">
            No help sections match <strong>&ldquo;{query}&rdquo;</strong>. Try a shorter or different keyword.
          </div>
        )}
      </div>
    </AppShell>
  );
}
