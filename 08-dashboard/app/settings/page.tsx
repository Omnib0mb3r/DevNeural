import Link from "next/link";
import { AppShell } from "@/components/AppShell";
import { VoiceSettingsPanel } from "@/components/VoiceSettingsPanel";
import { Card } from "@/components/ui/Card";
import { Icon } from "@/components/Icon";

export default function SettingsPage() {
  return (
    <AppShell>
      <div className="px-6 py-5 space-y-5 max-w-3xl">
        <header>
          <h1 className="font-display text-2xl font-emphasized">Settings</h1>
          <p className="text-sm text-txt3 mt-1">
            Persistent preferences stored on the daemon.
          </p>
        </header>
        <VoiceSettingsPanel />
        {/* Restarting the daemon and the rest of its diagnostic surface
         * (vitals, services, log tail) live on /system, not here. This
         * card is a discoverable pointer to that control rather than a
         * second copy of the restart mutation: operators who look for
         * "restart" in Settings would otherwise find nothing. */}
        <Card title="Daemon controls" icon="RotateCw">
          <div className="p-5 flex items-center justify-between gap-4">
            <p className="text-xs text-txt3 max-w-md">
              Restart the daemon, watch live vitals and services, and tail
              daemon.log from the System page.
            </p>
            <Link
              href="/system"
              className="px-4 py-1.5 text-xs font-emphasized rounded-pill hairline ring-1 bg-brand/15 text-brandSoft ring-brand/30 hover:bg-brand/25 flex items-center gap-2 shrink-0"
            >
              Open System
              <Icon name="ArrowRight" size={12} />
            </Link>
          </div>
        </Card>
      </div>
    </AppShell>
  );
}
