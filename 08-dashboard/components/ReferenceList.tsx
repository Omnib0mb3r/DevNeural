"use client";

import { useQuery } from "@tanstack/react-query";
import { referenceDocs } from "@/lib/daemon-client";
import { Icon } from "./Icon";

const KIND_ICONS: Record<string, "FileText" | "Image" | "FileAudio" | "FileVideo" | "FileType"> = {
  pdf: "FileText",
  markdown: "FileText",
  text: "FileText",
  docx: "FileType",
  image: "Image",
  png: "Image",
  jpg: "Image",
  audio: "FileAudio",
  video: "FileVideo",
};

export function ReferenceList() {
  const q = useQuery({
    queryKey: ["reference-docs"],
    queryFn: () => referenceDocs(),
    refetchInterval: 30_000,
  });

  const docs = q.data?.docs ?? [];

  return (
    <section className="rounded-panel bg-surface1 hairline">
      <div className="px-5 py-3 border-b border-border1 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon name="Library" className="text-brandSoft" size={16} />
          <h2 className="font-display text-sm font-emphasized">Uploaded references</h2>
        </div>
        <span className="text-nano text-txt3">{docs.length} docs</span>
      </div>

      {q.isLoading && (
        <div className="p-6 text-nano text-txt3">loading…</div>
      )}
      {!q.isLoading && docs.length === 0 && (
        <div className="p-6 text-xs text-txt3">
          No reference docs ingested yet. Drop a PDF, image, or markdown to start.
        </div>
      )}

      {docs.length > 0 && (
        <ul className="divide-y divide-border2 max-h-80 overflow-y-auto">
          {docs.map((d) => {
            const iconName = KIND_ICONS[d.kind?.toLowerCase() ?? ""] ?? "FileText";
            return (
              <li key={d.doc_id} className="px-5 py-2.5 flex items-center gap-3 lift">
                <Icon name={iconName} className="text-txt3" size={14} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-txt1 truncate">{d.filename}</div>
                  <div className="text-nano text-txt3 mt-0.5 flex items-center gap-2">
                    <span>{d.kind}</span>
                    <span>·</span>
                    <span>{d.project_id || "global"}</span>
                    {d.chunk_count != null && (
                      <>
                        <span>·</span>
                        <span>{d.chunk_count} chunks</span>
                      </>
                    )}
                  </div>
                </div>
                <span className="text-nano text-txt3 shrink-0">
                  {new Date(d.uploaded_at).toLocaleDateString(undefined, {
                    month: "short",
                    day: "numeric",
                  })}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
