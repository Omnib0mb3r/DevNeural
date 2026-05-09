import { AppShell } from "@/components/AppShell";
import { VoiceSettingsPanel } from "@/components/VoiceSettingsPanel";

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
      </div>
    </AppShell>
  );
}
