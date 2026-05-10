import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { DailyBrief } from "@/components/DailyBrief";
import { InstallPrompt } from "@/components/InstallPrompt";
import { ProjectsGrid } from "@/components/ProjectsGrid";
import { Orb } from "@/components/Orb";
import { ReinforcementPanel } from "@/components/ReinforcementPanel";
import { KpiStrip } from "@/components/KpiStrip";
import { Icon } from "@/components/Icon";

export default function HomePage() {
  return (
    <AppShell>
      <div className="px-6 py-5 flex flex-col gap-5">
        <div className="flex items-center justify-end">
          <InstallPrompt />
        </div>
        <KpiStrip />
        <DailyBrief />

        <section className="grid grid-cols-2 gap-5">
          {/* Projects mini panel — compact grid of registered projects */}
          <div className="rounded-panel bg-surface1 hairline overflow-hidden">
            <div className="px-5 py-3 border-b border-border1 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Icon name="FolderGit2" className="text-brandSoft" size={16} />
                <h2 className="font-display text-sm font-emphasized">Projects</h2>
              </div>
              <Link
                href="/projects"
                className="text-nano text-txt3 hover:text-txt1"
              >
                view all
              </Link>
            </div>
            <div className="p-4">
              <ProjectsGrid compact />
            </div>
          </div>

          {/* Neural network mini panel: force-directed graph of wiki + sessions */}
          <div className="rounded-panel bg-surface1 hairline overflow-hidden">
            <div className="px-5 py-3 border-b border-border1 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Icon name="Brain" className="text-brandSoft" size={16} />
                <h2 className="font-display text-sm font-emphasized">Neural network</h2>
              </div>
              <Link
                href="/orb"
                className="text-nano text-txt3 hover:text-txt1"
              >
                expand
              </Link>
            </div>
            <div className="h-[280px]">
              <Orb compact />
            </div>
          </div>
        </section>

        <ReinforcementPanel />
      </div>
    </AppShell>
  );
}
