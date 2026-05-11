import { Suspense } from "react";
import { AppShell } from "@/components/AppShell";
import { BrainstormDetailRoute } from "./BrainstormDetailRoute";

/* Static export does not allow dynamic [id] routes without
 * generateStaticParams. Brainstorm ids are user-generated and
 * unbounded, so the detail page is statically rendered as a shell
 * that reads ?id=... at runtime. Mirrors the sessions/detail pattern.
 * Links from BrainstormList, WikiPageModal, and the unified orb
 * SidePanel point here. */
export default function BrainstormDetailPage() {
  return (
    <AppShell>
      <Suspense
        fallback={
          <div className="px-6 py-5 text-nano text-txt3">loading brainstorm…</div>
        }
      >
        <BrainstormDetailRoute />
      </Suspense>
    </AppShell>
  );
}
