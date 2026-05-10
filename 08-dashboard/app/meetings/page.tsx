"use client";

import { AppShell } from "@/components/AppShell";
import { MeetingList } from "@/components/MeetingList";

export default function MeetingsPage() {
  return (
    <AppShell>
      <MeetingList />
    </AppShell>
  );
}
