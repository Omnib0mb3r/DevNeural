"use client";

import { use } from "react";
import { AppShell } from "@/components/AppShell";
import { BrainstormDetail } from "@/components/BrainstormDetail";

export default function BrainstormDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return (
    <AppShell>
      <BrainstormDetail id={decodeURIComponent(id)} />
    </AppShell>
  );
}
