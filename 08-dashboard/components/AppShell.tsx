"use client";

import { usePathname } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { TopBar } from "./TopBar";
import { StreamDeck } from "./StreamDeck";
import { RightRail } from "./RightRail";
import { VitalsRibbon } from "./VitalsRibbon";
import { CommandPalette } from "./CommandPalette";
import { LexEasterEgg } from "./LexEasterEgg";
import { VoiceClient } from "./VoiceClient";
import { Icon } from "./Icon";
import { listPtys, type PtyEntry } from "@/lib/daemon-client";

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "/";
  // Match the active tab to the topmost path segment.
  const segments = pathname.split("/").filter(Boolean);
  const activeTab = segments.length === 0 ? "/" : `/${segments[0]}`;

  /* Resolve the active Lex brainstorm PTY at the AppShell level so the
   * lifted VoiceClient stays bound to it across route changes. Same
   * filter as the /lex page used to use locally. tanstack query dedupes
   * with the lex page's own ["pty-list"] subscription. */
  const ptysQ = useQuery({
    queryKey: ["pty-list"],
    queryFn: listPtys,
    refetchInterval: 3_000,
  });
  const lexPty: PtyEntry | undefined = (ptysQ.data?.ptys ?? []).find(
    (p) => !p.exited && /\/brainstorm\/?$/i.test(p.cwd.replace(/\\/g, "/")),
  );

  // Layout is constrained to exactly one viewport (100dvh handles mobile
   // URL-bar shifts) so the VitalsRibbon stays pinned to the visible bottom
   // edge regardless of how far the main panel scrolls. The middle row is
   // flex-1 + min-h-0 so its children own the scroll, not the page.
  return (
    <div className="h-[100dvh] flex flex-col overflow-hidden">
      <TopBar activeTab={activeTab} />
      <div className="flex-1 flex min-h-0">
        {/* StreamDeck: hidden below md, visible md+ */}
        <div className="hidden md:flex min-h-0">
          <StreamDeck />
        </div>
        <main className="flex-1 min-w-0 overflow-y-auto pb-14 md:pb-0">{children}</main>
        {/* RightRail: hidden below xl, visible xl+ */}
        <div className="hidden xl:flex min-h-0">
          <RightRail />
        </div>
      </div>
      <VitalsRibbon />
      <CommandPalette />
      <MobileTabBar activeTab={activeTab} />
      <LexEasterEgg />
      {/* Voice client lifted to AppShell so the WS, mic, and audio
       * pipeline survive route changes. Only mounts when a Lex PTY
       * exists (prevents needless WS spawn on cold project state). The
       * panel renders as a fixed bottom-right floating widget so it
       * stays visible on /settings, /wiki, etc. without rearranging
       * the page-specific layout. */}
      {lexPty && (
        <div
          className="fixed bottom-16 right-4 z-30 w-[min(380px,calc(100vw-2rem))] md:bottom-4 md:right-4"
          aria-label="Voice panel"
        >
          <VoiceClient sessionId={lexPty.sessionId ?? null} />
        </div>
      )}
    </div>
  );
}

/* Mobile bottom tab bar — visible only below md so primary nav is reachable
 * without the StreamDeck/sidebar. Touch targets are 44px (anti-slop rule for
 * customer-app, applied here for mobile usability even on internal apps). */
function MobileTabBar({ activeTab }: { activeTab: string }) {
  const TABS = [
    { href: "/",          label: "Home",     icon: "Home" as const },
    { href: "/wiki",      label: "Wiki",     icon: "BookOpen" as const },
    { href: "/sessions",  label: "Sessions", icon: "Terminal" as const },
    { href: "/system",    label: "System",   icon: "Cpu" as const },
  ];
  return (
    <nav
      className="md:hidden fixed bottom-0 left-0 right-0 h-14 bg-surface1 border-t border-border1 flex items-stretch z-40"
      aria-label="Primary navigation"
    >
      {TABS.map((t) => {
        const isActive = t.href === activeTab;
        return (
          <a
            key={t.href}
            href={t.href}
            className={`flex-1 flex flex-col items-center justify-center gap-0.5 text-[11px] font-mono ${
              isActive ? "text-brandSoft" : "text-txt3"
            }`}
            aria-current={isActive ? "page" : undefined}
          >
            <MobileIcon name={t.icon} />
            {t.label}
          </a>
        );
      })}
    </nav>
  );
}

function MobileIcon({ name }: { name: "Home" | "BookOpen" | "Terminal" | "Cpu" }) {
  return <Icon name={name} size={20} />;
}
