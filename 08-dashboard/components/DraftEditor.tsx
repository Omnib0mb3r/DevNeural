"use client";

/**
 * Wave 2 day 2 step 10 (BF-7 review / A2) draft editor modal.
 *
 * Inline edit (page_title, page_slug, body_markdown) plus promote /
 * discard. The promote button posts to /drafts/:id/promote and
 * surfaces every conflict case from the spec:
 *   - slug_collision   → user picks resolution (rename / merge / overwrite)
 *   - frozen_target    → user opts in to force:true (or picks rename)
 *   - superseded       → another draft for the slug already promoted; row
 *                        flips to status='superseded' on the daemon
 *   - target_drift     → another tab edited the draft; modal refreshes
 */
import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  patchDraft,
  promoteDraft,
  discardDraft,
  type WikiDraftRow,
  type PromoteDraftBody,
  type PromoteDraftResult,
} from "@/lib/daemon-client";

export interface DraftEditorProps {
  draft: WikiDraftRow;
  onClose: () => void;
}

export function DraftEditor({ draft, onClose }: DraftEditorProps) {
  const qc = useQueryClient();
  const [pageTitle, setPageTitle] = useState(draft.page_title);
  const [pageSlug, setPageSlug] = useState(draft.page_slug);
  const [body, setBody] = useState(draft.body_markdown);
  const [conflict, setConflict] = useState<PromoteDraftResult | null>(null);
  const [resolution, setResolution] = useState<"rename" | "merge" | "overwrite" | "">("");
  const [renameSlug, setRenameSlug] = useState("");
  const [forceFrozen, setForceFrozen] = useState(false);

  /* Snapshot the resolved_at the modal observed at open time so we can
   * detect target-drift if another tab edits the row before we promote.
   * resolved_at is null while the draft is pending; that null is the
   * baseline we send back as expected_resolved_at. */
  const [openedAt] = useState<string | null>(draft.resolved_at);

  const patchM = useMutation({
    mutationFn: () =>
      patchDraft(draft.id, {
        page_title: pageTitle,
        page_slug: pageSlug,
        body_markdown: body,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["drafts"] }),
  });

  const promoteM = useMutation<PromoteDraftResult>({
    mutationFn: async () => {
      /* Save inline edits first so the promoted page reflects the
       * current modal state. If the patch errors we surface that
       * before attempting promote. */
      if (
        pageTitle !== draft.page_title ||
        pageSlug !== draft.page_slug ||
        body !== draft.body_markdown
      ) {
        await patchDraft(draft.id, {
          page_title: pageTitle,
          page_slug: pageSlug,
          body_markdown: body,
        });
      }
      const args: PromoteDraftBody = { expected_resolved_at: openedAt };
      if (resolution) args.resolution = resolution;
      if (resolution === "rename" && renameSlug) args.new_slug = renameSlug;
      if (forceFrozen) args.force = true;
      return promoteDraft(draft.id, args);
    },
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["drafts"] });
      if (!res.ok) {
        setConflict(res);
        return;
      }
      setConflict(null);
      onClose();
    },
  });

  const discardM = useMutation({
    mutationFn: () => discardDraft(draft.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["drafts"] });
      onClose();
    },
  });

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="edit wiki draft"
    >
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col gap-3 overflow-y-auto rounded border border-border1 bg-surface1 p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold">Wiki draft</h2>
          <button type="button" onClick={onClose} className="text-xs text-txt3">
            close
          </button>
        </div>
        <Field label="page_title">
          <input
            value={pageTitle}
            onChange={(e) => setPageTitle(e.target.value)}
            className="w-full rounded border border-border1 bg-surface2 px-2 py-1 font-mono text-sm"
          />
        </Field>
        <Field label="page_slug">
          <input
            value={pageSlug}
            onChange={(e) => setPageSlug(e.target.value)}
            className="w-full rounded border border-border1 bg-surface2 px-2 py-1 font-mono text-sm"
          />
        </Field>
        <Field label="body_markdown">
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={14}
            className="w-full rounded border border-border1 bg-surface2 px-2 py-1 font-mono text-xs"
          />
        </Field>
        <p className="text-xs text-txt3">
          confidence {(draft.confidence * 100).toFixed(0)}% · created {draft.created_at}
        </p>
        {conflict ? <ConflictPrompt
          conflict={conflict}
          resolution={resolution}
          onResolution={setResolution}
          renameSlug={renameSlug}
          onRenameSlug={setRenameSlug}
          forceFrozen={forceFrozen}
          onForceFrozen={setForceFrozen}
        /> : null}
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => promoteM.mutate()}
            disabled={promoteM.isPending}
            className="rounded border border-brandSoft bg-brandSoft px-3 py-1 text-sm text-bg1 disabled:opacity-50"
          >
            {promoteM.isPending ? "promoting…" : "promote"}
          </button>
          <button
            type="button"
            onClick={() => patchM.mutate()}
            disabled={patchM.isPending}
            className="rounded border border-border1 bg-surface2 px-3 py-1 text-sm disabled:opacity-50"
          >
            {patchM.isPending ? "saving…" : "save"}
          </button>
          <button
            type="button"
            onClick={() => discardM.mutate()}
            disabled={discardM.isPending}
            className="ml-auto rounded border border-border1 bg-surface2 px-3 py-1 text-sm text-rose-400 disabled:opacity-50"
          >
            discard
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-txt3">
      <span className="font-mono">{label}</span>
      {children}
    </label>
  );
}

function ConflictPrompt(props: {
  conflict: PromoteDraftResult;
  resolution: "rename" | "merge" | "overwrite" | "";
  onResolution: (v: "rename" | "merge" | "overwrite" | "") => void;
  renameSlug: string;
  onRenameSlug: (v: string) => void;
  forceFrozen: boolean;
  onForceFrozen: (v: boolean) => void;
}) {
  const c = props.conflict.conflict;
  return (
    <div className="rounded border border-amber-500/60 bg-amber-500/10 p-3 text-xs">
      <p className="font-mono text-amber-300">conflict: {c}</p>
      <p className="mt-1 text-txt2">{props.conflict.error}</p>
      {c === "slug_collision" ? (
        <div className="mt-2 flex flex-col gap-2">
          <select
            value={props.resolution}
            onChange={(e) =>
              props.onResolution(
                e.target.value as "rename" | "merge" | "overwrite" | "",
              )
            }
            className="rounded border border-border1 bg-surface2 px-2 py-1 font-mono"
          >
            <option value="">pick a resolution…</option>
            <option value="rename">rename (new slug)</option>
            <option value="merge">merge (append to existing)</option>
            <option value="overwrite">overwrite existing</option>
          </select>
          {props.resolution === "rename" ? (
            <input
              value={props.renameSlug}
              onChange={(e) => props.onRenameSlug(e.target.value)}
              placeholder="new-slug-here"
              className="rounded border border-border1 bg-surface2 px-2 py-1 font-mono"
            />
          ) : null}
        </div>
      ) : null}
      {c === "frozen_target" ? (
        <label className="mt-2 flex items-center gap-2">
          <input
            type="checkbox"
            checked={props.forceFrozen}
            onChange={(e) => props.onForceFrozen(e.target.checked)}
          />
          <span>force overwrite frozen page</span>
        </label>
      ) : null}
      {c === "target_drift" ? (
        <p className="mt-2 text-txt3">close and reopen the modal to refresh</p>
      ) : null}
      {c === "superseded" ? (
        <p className="mt-2 text-txt3">
          slug already promoted by draft{" "}
          <span className="font-mono">{props.conflict.promoted_id}</span>
        </p>
      ) : null}
    </div>
  );
}
