"use client";

/* Lifecycle dashboard route (spec item 8 scaffold). New, additive route -
 * does NOT alter the existing Projects page (app/projects/page.tsx),
 * ProjectsGrid, or the open-sessions live view. Static preview only. */
import { AppShell } from "@/components/AppShell";
import { LifecycleRail } from "@/components/LifecycleRail";

export default function ProjectLifecyclePage() {
  return (
    <AppShell>
      <div className="px-6 py-5 space-y-5">
        <h1 className="font-display text-2xl font-emphasized">
          Project Lifecycle
        </h1>
        <p className="text-xs text-white/50 max-w-prose">
          Scaffold for the gated project lifecycle (New Project, Spec, TDD,
          Execution, Test, Bug handling). Static preview, no live actions. The
          existing Projects page and open-sessions view are unchanged.
        </p>
        <LifecycleRail />
      </div>
    </AppShell>
  );
}
