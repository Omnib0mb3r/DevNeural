"use client";

import { useEffect, useState, useRef, useMemo } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useMutation } from "@tanstack/react-query";
import { searchAll, sessions as sessionsClient } from "@/lib/daemon-client";
import { Icon } from "./Icon";

interface Action {
  id: string;
  label: string;
  hint: string;
  icon: "Home" | "BookOpen" | "Terminal" | "FolderGit2" | "Cpu" | "BellRing" | "Brain" | "Plus" | "Upload" | "Search";
  run: () => void;
}

export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const sessQ = useQuery({
    queryKey: ["sessions"],
    queryFn: sessionsClient,
    enabled: open,
  });

  const searchM = useMutation({
    mutationFn: (text: string) => searchAll(text, { top_k: 8 }),
  });

  // Cmd-K / Ctrl-K toggle, plus listen for the global TopBar search trigger
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      } else if (e.key === "Escape" && open) {
        setOpen(false);
      }
    }
    function onOpen() {
      setOpen(true);
    }
    window.addEventListener("keydown", onKey);
    window.addEventListener("open-cmdk", onOpen as EventListener);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("open-cmdk", onOpen as EventListener);
    };
  }, [open]);

  // focus on open
  useEffect(() => {
    if (open) {
      setQ("");
      setActive(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // run search when query gets long enough
  useEffect(() => {
    if (q.trim().length >= 3) {
      const t = setTimeout(() => searchM.mutate(q.trim()), 250);
      return () => clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const navActions: Action[] = useMemo(
    () => [
      { id: "go-home",      label: "Go to Home",      hint: "/",          icon: "Home" as const,        run: () => router.push("/") },
      { id: "go-wiki",      label: "Go to Wiki",      hint: "/wiki",      icon: "BookOpen" as const,    run: () => router.push("/wiki") },
      { id: "go-sessions",  label: "Go to Sessions",  hint: "/sessions",  icon: "Terminal" as const,    run: () => router.push("/sessions") },
      { id: "go-projects",  label: "Go to Projects",  hint: "/projects",  icon: "FolderGit2" as const,  run: () => router.push("/projects") },
      { id: "go-system",    label: "Go to System",    hint: "/system",    icon: "Cpu" as const,         run: () => router.push("/system") },
      { id: "go-reminders", label: "Go to Reminders", hint: "/reminders", icon: "BellRing" as const,    run: () => router.push("/reminders") },
      { id: "go-orb",       label: "Go to Neural network", hint: "/orb",  icon: "Brain" as const,       run: () => router.push("/orb") },
      { id: "new-project",  label: "New project",     hint: "scaffold",   icon: "Plus" as const,        run: () => router.push("/projects?new=1") },
      { id: "upload-ref",   label: "Upload reference",hint: "PDF/img/md", icon: "Upload" as const,      run: () => router.push("/wiki?upload=1") },
    ],
    [router],
  );

  const filteredNav = q.trim()
    ? navActions.filter((a) => a.label.toLowerCase().includes(q.toLowerCase()))
    : navActions;

  const sessionItems: Action[] = (sessQ.data?.sessions ?? []).map((s) => ({
    id: `session-${s.session_id}`,
    label: `Open session: ${s.project_slug.split("-").filter(Boolean).pop() ?? s.session_id}`,
    hint: s.session_id.slice(0, 8),
    icon: "Terminal" as const,
    run: () =>
      router.push(`/sessions/detail?id=${encodeURIComponent(s.session_id)}`),
  }));

  const items: Action[] = [
    ...filteredNav,
    ...(q.trim() ? [] : sessionItems),
  ];

  const searchHits = (searchM.data?.results ?? []).slice(0, 6);

  function openHit(hit: { source: string; url?: string; doc_id?: string; page_id?: string }): void {
    /* Pick the best route per hit source:
     *  - hits with an explicit url take precedence
     *  - wiki_page → /wiki?page=<id> so the wiki tab can scroll/highlight
     *  - reference_chunk → /wiki?ref=<doc_id> (reference docs live in the
     *    wiki tab today; no dedicated /reference route yet)
     *  - raw_chunk has no stable navigable target, so we fall back to
     *    /wiki and pre-fill the search query */
    if (hit.url) {
      router.push(hit.url);
      return;
    }
    if (hit.source === "wiki_page" && hit.page_id) {
      router.push(`/wiki?page=${encodeURIComponent(hit.page_id)}`);
      return;
    }
    if (hit.source === "reference_chunk" && hit.doc_id) {
      router.push(`/wiki?ref=${encodeURIComponent(hit.doc_id)}`);
      return;
    }
    router.push(`/wiki?q=${encodeURIComponent(q.trim())}`);
  }

  function executeActive() {
    if (active < items.length) {
      items[active].run();
      setOpen(false);
    } else if (searchHits.length > 0) {
      const idx = active - items.length;
      const hit = searchHits[idx];
      if (hit) {
        openHit(hit);
        setOpen(false);
      }
    }
  }

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 grid place-items-start pt-24 px-6"
      style={{ background: "var(--c-bg-overlay)" }}
      onClick={() => setOpen(false)}
    >
      <div
        className="w-full max-w-xl rounded-panel bg-surface1 hairline overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2.5 h-12 px-4 border-b border-border1">
          <Icon name="Search" className="text-txt3" size={18} />
          <input
            ref={inputRef}
            type="search"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) =>
                  Math.min(items.length + searchHits.length - 1, a + 1),
                );
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(0, a - 1));
              } else if (e.key === "Enter") {
                e.preventDefault();
                executeActive();
              }
            }}
            placeholder="Type a command, navigate, or search…"
            className="flex-1 bg-transparent outline-none text-base text-txt1 placeholder:text-txt3"
            aria-label="Command palette"
          />
          <kbd className="text-[11px] font-mono text-txt3">ESC</kbd>
        </div>

        <div className="max-h-96 overflow-y-auto">
          {items.length > 0 && (
            <div className="py-2">
              <div className="px-4 text-nano text-txt3 mb-1">
                {q.trim() ? "Actions" : "Navigate / actions"}
              </div>
              {items.map((item, i) => {
                const isActive = i === active;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onMouseEnter={() => setActive(i)}
                    onClick={() => {
                      item.run();
                      setOpen(false);
                    }}
                    className={`w-full flex items-center gap-3 px-4 h-9 text-left text-sm ${
                      isActive ? "bg-surface2 text-txt1" : "text-txt2"
                    }`}
                  >
                    <Icon name={item.icon} size={16} className="text-brandSoft" />
                    <span className="flex-1">{item.label}</span>
                    <span className="text-nano text-txt3">{item.hint}</span>
                  </button>
                );
              })}
            </div>
          )}

          {searchHits.length > 0 && (
            <div className="py-2 border-t border-border2">
              <div className="px-4 text-nano text-txt3 mb-1">Search results</div>
              {searchHits.map((h, i) => {
                const idx = items.length + i;
                const isActive = idx === active;
                return (
                  <button
                    key={i}
                    type="button"
                    onMouseEnter={() => setActive(idx)}
                    onClick={() => {
                      openHit(h);
                      setOpen(false);
                    }}
                    className={`w-full flex flex-col gap-0.5 px-4 py-2 text-left ${
                      isActive ? "bg-surface2" : ""
                    }`}
                  >
                    <div className="flex items-center gap-2 text-xs">
                      <span className="text-nano px-1.5 py-0.5 rounded-pill bg-surface2 text-txt3">
                        {h.source.replace("_", " ")}
                      </span>
                      <span className="text-txt1 font-emphasized truncate flex-1">
                        {h.title ?? h.preview.slice(0, 60)}
                      </span>
                    </div>
                    <div className="text-[11px] font-mono text-txt3 truncate">
                      {h.preview}
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {q.trim().length >= 3 && searchM.isPending && (
            <div className="px-4 py-3 text-nano text-txt3">searching…</div>
          )}
        </div>

        <div className="px-4 py-2 border-t border-border2 flex items-center justify-between text-nano text-txt3">
          <span>
            <kbd className="font-mono">↑↓</kbd> navigate ·{" "}
            <kbd className="font-mono">↵</kbd> select
          </span>
          <span>
            <kbd className="font-mono">⌘K</kbd> toggle
          </span>
        </div>
      </div>
    </div>
  );
}
