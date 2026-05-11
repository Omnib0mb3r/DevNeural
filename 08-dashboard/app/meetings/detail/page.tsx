import { Suspense } from "react";
import { AppShell } from "@/components/AppShell";
import { MeetingDetailRoute } from "./MeetingDetailRoute";

/* Static export does not allow dynamic [id] routes without
 * generateStaticParams. Meeting ids are user-generated and unbounded,
 * so the detail page is statically rendered as a shell that reads
 * ?id=... at runtime. Mirrors the sessions/detail and
 * brainstorms/detail patterns. Links from MeetingList and the unified
 * orb SidePanel point here. */
export default function MeetingDetailPage() {
  return (
    <AppShell>
      <Suspense
        fallback={
          <div className="px-6 py-5 text-nano text-txt3">loading meeting…</div>
        }
      >
        <MeetingDetailRoute />
      </Suspense>
    </AppShell>
  );
}
