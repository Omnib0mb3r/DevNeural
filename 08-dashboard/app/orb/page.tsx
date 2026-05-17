import { AppShell } from "@/components/AppShell";
import { UnifiedOrb } from "@/src/orb/UnifiedOrb";

export default function OrbPage() {
  return (
    <AppShell>
      {/* Unified orb fills the main content area. Shows brainstorms, wiki,
       * projects, and meetings in a single force-directed graph. */}
      <h1 className="sr-only">Neural network</h1>
      <div className="h-[calc(100dvh-10.5rem)] md:h-[calc(100dvh-7rem)] w-full">
        <UnifiedOrb />
      </div>
    </AppShell>
  );
}
