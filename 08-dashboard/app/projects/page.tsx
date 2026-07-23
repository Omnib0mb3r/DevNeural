"use client";

import { useState } from "react";
import { AppShell } from "@/components/AppShell";
import { ProjectsGrid } from "@/components/ProjectsGrid";
import { NewProjectModal } from "@/components/NewProjectModal";
import { AddProjectModal } from "@/components/AddProjectModal";
import { Icon } from "@/components/Icon";

export default function ProjectsPage() {
  const [creating, setCreating] = useState(false);
  const [adding, setAdding] = useState(false);

  return (
    <AppShell>
      <div className="px-6 py-5 space-y-5">
        <div className="flex items-center justify-between">
          <h1 className="font-display text-2xl font-emphasized">Projects</h1>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setAdding(true)}
              className="h-9 px-3.5 rounded-card bg-surface2 hairline text-txt2 text-xs font-emphasized hover:bg-surface3 flex items-center gap-2"
              title="Point the registry at an existing folder on disk"
            >
              <Icon name="FolderPlus" size={14} /> add existing
            </button>
            <button
              onClick={() => setCreating(true)}
              className="h-9 px-3.5 rounded-card bg-brand/10 hairline ring-1 ring-brand/30 text-brandSoft text-xs font-emphasized hover:bg-brand/15 flex items-center gap-2"
            >
              <Icon name="Plus" size={14} /> new project
            </button>
          </div>
        </div>
        <ProjectsGrid />
      </div>

      {creating && <NewProjectModal onClose={() => setCreating(false)} />}
      {adding && <AddProjectModal onClose={() => setAdding(false)} />}
    </AppShell>
  );
}
