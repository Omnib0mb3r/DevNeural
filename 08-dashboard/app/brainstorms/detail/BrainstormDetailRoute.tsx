"use client";

import { useSearchParams } from "next/navigation";
import { BrainstormDetail } from "@/components/BrainstormDetail";

export function BrainstormDetailRoute() {
  const params = useSearchParams();
  const id = params.get("id") ?? "";
  if (!id) {
    return (
      <div className="px-6 py-5 text-sm text-txt3">
        Missing brainstorm id. Open a session from the Brainstorms list.
      </div>
    );
  }
  return <BrainstormDetail id={decodeURIComponent(id)} />;
}
