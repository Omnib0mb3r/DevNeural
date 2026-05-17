"use client";

import { Suspense, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { WikiSearch } from "@/components/WikiSearch";
import { ReferenceList } from "@/components/ReferenceList";
import { UploadModal } from "@/components/UploadModal";
import { Icon } from "@/components/Icon";

export default function WikiPage() {
  const [uploading, setUploading] = useState(false);

  return (
    <AppShell>
      <div className="px-6 py-5 grid grid-cols-3 gap-5">
        <div className="col-span-2 space-y-5">
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <h1 className="font-display text-2xl font-emphasized">
                Wiki and reference
              </h1>
              <button
                onClick={() => setUploading(true)}
                className="h-9 px-3.5 rounded-card bg-brand/10 hairline ring-1 ring-brand/30 text-brandSoft text-xs font-emphasized hover:bg-brand/15 flex items-center gap-2"
              >
                <Icon name="Upload" size={14} /> upload reference
              </button>
            </div>
            <p className="text-sm text-txt3 max-w-2xl">
              Everything Lex has learned about you and your projects, plus reference docs you have uploaded. Search any keyword to find what Lex knows.
            </p>
          </div>
          {/* Suspense required because WikiSearch reads useSearchParams; Next
              static export bails out at prerender otherwise. */}
          <Suspense fallback={<div className="h-32 rounded-panel bg-surface1 animate-pulse" />}>
            <WikiSearch />
          </Suspense>
        </div>
        <div className="col-span-1">
          <ReferenceList />
        </div>
      </div>

      {uploading && <UploadModal onClose={() => setUploading(false)} />}
    </AppShell>
  );
}
