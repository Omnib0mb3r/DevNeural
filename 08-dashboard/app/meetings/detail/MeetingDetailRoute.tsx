"use client";

import { useSearchParams } from "next/navigation";
import { MeetingDetail } from "@/components/MeetingDetail";

export function MeetingDetailRoute() {
  const params = useSearchParams();
  const id = params.get("id") ?? "";
  if (!id) {
    return (
      <div className="px-6 py-5 text-sm text-txt3">
        Missing meeting id. Open a session from the Meetings list.
      </div>
    );
  }
  return <MeetingDetail id={decodeURIComponent(id)} />;
}
