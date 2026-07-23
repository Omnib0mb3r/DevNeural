"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { fsList, registerProjectPath } from "@/lib/daemon-client";
import { Icon } from "./Icon";

interface Props {
  onClose: () => void;
}

/**
 * Add-existing-project folder picker (2026-07-23).
 *
 * Points the registry at a folder already on disk. Browses directories
 * via GET /fs/list, then POST /projects/register-path registers the
 * chosen folder — the daemon auto-resolves its git identity (remote if
 * present, else path) and folds any pre-remote path dupe in. Read-only
 * browsing; directory names only.
 */
export function AddProjectModal({ onClose }: Props) {
  const qc = useQueryClient();
  const [cwd, setCwd] = useState<string | undefined>(undefined);

  const listQ = useQuery({
    queryKey: ["fs-list", cwd ?? "(default)"],
    queryFn: () => fsList(cwd),
  });

  const here = listQ.data?.path;

  const addM = useMutation({
    mutationFn: (p: string) => registerProjectPath(p),
    onSuccess: (r) => {
      if (r.ok) {
        qc.invalidateQueries({ queryKey: ["projects"] });
        qc.invalidateQueries({ queryKey: ["project-anchor-tiles"] });
        onClose();
      }
    },
  });

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center px-6"
      style={{ background: "var(--c-bg-overlay)" }}
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-panel bg-surface1 hairline p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-display text-base font-emphasized">
            Add existing project
          </h2>
          <button
            onClick={onClose}
            aria-label="Close add project modal"
            className="text-txt3 hover:text-txt1"
          >
            <Icon name="X" size={18} />
          </button>
        </div>

        {/* Current path + up */}
        <div className="flex items-center gap-2 mb-2 min-w-0">
          <button
            type="button"
            disabled={!listQ.data?.parent}
            onClick={() =>
              listQ.data?.parent && setCwd(listQ.data.parent ?? undefined)
            }
            className="text-nano px-2 py-1 rounded-pill bg-surface2 hairline hover:bg-surface3 text-txt2 disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
            title="Up one folder"
          >
            <Icon name="ChevronUp" size={12} />
          </button>
          <div
            className="text-nano font-mono text-txt3 truncate flex-1"
            title={here}
          >
            {here ?? "…"}
          </div>
        </div>

        {/* Folder list */}
        <div className="max-h-72 overflow-y-auto rounded-card bg-surface2/40 hairline divide-y divide-border2">
          {listQ.isLoading && (
            <div className="p-4 space-y-2">
              {[0, 1, 2].map((i) => (
                <div
                  key={i}
                  className="h-8 rounded-card bg-surface2 animate-pulse"
                />
              ))}
            </div>
          )}
          {listQ.isError && (
            <div className="p-4 text-xs text-err font-mono">
              {(listQ.error as Error).message}
            </div>
          )}
          {!listQ.isLoading && !listQ.isError && listQ.data && (
            <>
              {listQ.data.dirs.length === 0 && (
                <div className="p-4 text-center text-xs text-txt3">
                  No subfolders here.
                </div>
              )}
              {listQ.data.dirs.map((d) => (
                <div
                  key={d.path}
                  className="px-3 py-2 flex items-center gap-2 min-w-0"
                >
                  <button
                    type="button"
                    onClick={() => setCwd(d.path)}
                    className="flex items-center gap-2 min-w-0 flex-1 text-left text-xs text-txt1 hover:text-brandSoft"
                    title="Open folder"
                  >
                    <Icon
                      name="Folder"
                      size={14}
                      className="text-txt3 shrink-0"
                    />
                    <span className="truncate">{d.name}</span>
                    {d.has_git && (
                      <span
                        className="text-nano font-mono text-brandSoft shrink-0"
                        title="git repo — will auto-tie to its remote"
                      >
                        git
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => addM.mutate(d.path)}
                    disabled={addM.isPending}
                    className="text-nano px-2 py-1 rounded-pill bg-brand/10 hairline ring-1 ring-brand/30 text-brandSoft hover:bg-brand/20 disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
                    title="Register this folder as a project"
                  >
                    add
                  </button>
                </div>
              ))}
            </>
          )}
        </div>

        {addM.data && !addM.data.ok && (
          <div className="mt-3 text-xs text-err font-mono">
            {addM.data.error}
          </div>
        )}
        {addM.isError && (
          <div className="mt-3 text-xs text-err font-mono">
            Failed: {(addM.error as Error).message}
          </div>
        )}

        {/* Add the folder currently open, not just a child */}
        <div className="mt-5 flex items-center justify-between gap-2">
          <span className="text-nano text-txt3">
            Pick a subfolder&apos;s <span className="font-mono">add</span>, or
            add the folder you&apos;re in.
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={onClose}
              className="h-9 px-4 rounded-input text-txt3 hover:text-txt1 text-sm"
            >
              Cancel
            </button>
            <button
              onClick={() => here && addM.mutate(here)}
              disabled={!here || addM.isPending}
              className="h-9 px-4 rounded-input bg-brand hover:bg-brand/90 text-base text-sm font-emphasized disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {addM.isPending ? "adding…" : "add this folder"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
