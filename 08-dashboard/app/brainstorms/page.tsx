"use client";

import { AppShell } from "@/components/AppShell";
import { BrainstormList } from "@/components/BrainstormList";

export default function BrainstormsPage() {
  return (
    <AppShell>
      <BrainstormList initialKind="brainstorm" />
    </AppShell>
  );
}
