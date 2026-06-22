import { AppShell } from "@/components/AppShell";
import { KnowledgeOrb } from "@/src/knowledge/KnowledgeOrb";

export default function KnowledgePage() {
  return (
    <AppShell>
      {/* Project-scoped knowledge index: markdown stores as a browsable
       * map. Distinct from /orb (the global brainstorm/wiki/project graph). */}
      <h1 className="sr-only">Knowledge index</h1>
      <div className="h-[calc(100dvh-10.5rem)] md:h-[calc(100dvh-7rem)] w-full">
        <KnowledgeOrb />
      </div>
    </AppShell>
  );
}
