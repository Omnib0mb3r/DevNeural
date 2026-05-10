"use client";

import { use } from "react";
import { AppShell } from "@/components/AppShell";
import { MeetingDetail } from "@/components/MeetingDetail";

export default function MeetingDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return (
    <AppShell>
      <MeetingDetail id={decodeURIComponent(id)} />
    </AppShell>
  );
}
