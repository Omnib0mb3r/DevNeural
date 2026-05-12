import { AppShell } from "@/components/AppShell";
import { SystemPanel } from "@/components/SystemPanel";
import { LintFindingsPanel } from "@/components/LintFindingsPanel";
import { PauseModeToggle } from "@/components/PauseModeToggle";
import { PanicAuditPanel } from "@/components/PanicAuditPanel";

export default function SystemPage() {
  return (
    <AppShell>
      <div className="px-6 py-5 space-y-5">
        <h1 className="font-display text-2xl font-emphasized">System</h1>
        <SystemPanel />
        <PauseModeToggle />
        <PanicAuditPanel />
        <LintFindingsPanel />
      </div>
    </AppShell>
  );
}
