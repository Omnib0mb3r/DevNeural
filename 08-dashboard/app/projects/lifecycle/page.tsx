"use client";

/* Lifecycle dashboard route (DRIVE-QUEUE 3: wired to live data). Additive
 * route - does NOT alter the existing Projects page (app/projects/page.tsx),
 * ProjectsGrid, or the open-sessions live view. Picks a project, reads its
 * live stage + gate from GET /lex/lifecycle, and renders the rail. */
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AppShell } from "@/components/AppShell";
import { LifecycleRail } from "@/components/LifecycleRail";
import { projects, lifecycle } from "@/lib/daemon-client";

function pickDefaultProject(list: { id: string; name: string }[]): string {
  const dev = list.find(
    (p) =>
      p.id.toLowerCase().includes("devneural") ||
      (p.name ?? "").toLowerCase().includes("devneural"),
  );
  return dev?.id ?? list[0]?.id ?? "";
}

export default function ProjectLifecyclePage() {
  const [projectId, setProjectId] = useState<string>("");
  const projectsQ = useQuery({ queryKey: ["projects"], queryFn: projects });
  const projectList = projectsQ.data?.projects ?? [];

  useEffect(() => {
    if (!projectId && projectList.length > 0) {
      setProjectId(pickDefaultProject(projectList));
    }
  }, [projectId, projectList]);

  const project = projectList.find((p) => p.id === projectId);
  const cwd = project?.root ?? "";

  const lifeQ = useQuery({
    queryKey: ["lifecycle", cwd],
    queryFn: () => lifecycle({ cwd }),
    enabled: Boolean(cwd),
    refetchInterval: 30_000,
  });
  const life = lifeQ.data ?? null;

  return (
    <AppShell>
      <div className="px-6 py-5 space-y-5">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <h1 className="font-display text-2xl font-emphasized">
            Project Lifecycle
          </h1>
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            className="font-mono text-xs bg-surface2 text-txt1 rounded-pill px-2 py-1 hairline"
            aria-label="project"
          >
            {projectList.length === 0 && <option value="">no projects</option>}
            {projectList.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name ?? p.id}
              </option>
            ))}
          </select>
        </div>
        <p className="text-xs text-white/50 max-w-prose">
          Gated lifecycle: New Project, Spec, TDD, Execution, Test, Bug
          handling. The current stage + gate status are live from the daemon.
          The existing Projects page and open-sessions view are unchanged.
        </p>
        <LifecycleRail
          currentStage={life?.stage}
          gate={life?.gate}
          canAdvance={life?.can_advance}
          nextLabel={life?.next_label ?? null}
          needs={life?.needs}
          loading={lifeQ.isLoading && Boolean(cwd)}
        />
      </div>
    </AppShell>
  );
}
