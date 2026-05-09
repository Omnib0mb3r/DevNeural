"use client";

import { usePathname } from "next/navigation";
import { TopBar } from "./TopBar";
import { StreamDeck } from "./StreamDeck";
import { RightRail } from "./RightRail";
import { VitalsRibbon } from "./VitalsRibbon";
import { CommandPalette } from "./CommandPalette";
import { LexEasterEgg } from "./LexEasterEgg";
import { Icon } from "./Icon";

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "/";
  // Match the active tab to the topmost path segment.
  const segments = pathname.split("/").filter(Boolean);
  const activeTab = segments.length === 0 ? "/" : `/${segments[0]}`;

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
