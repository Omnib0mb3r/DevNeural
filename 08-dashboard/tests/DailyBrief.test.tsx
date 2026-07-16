/**
 * Daily brief refresh pins (2026-07-16 operator audit: "dashboard
 * brief is still stale, and refresh button does nothing").
 *
 * The old button only refetched the GET, which re-served the same
 * stale digest file. Refresh must trigger a real server-side
 * regeneration, then refetch.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/daemon-client", () => ({
  dailyBrief: vi.fn().mockResolvedValue({
    summary: {
      generated_at: new Date().toISOString(),
      projects_total: 3,
      active_sessions: 1,
      unread_notifications: 0,
      whats_new_present: true,
      whats_new_age_hours: 200,
    },
    whats_new_markdown: "# whats new\nsome digest",
  }),
  regenerateWhatsNew: vi.fn().mockResolvedValue({ ok: true }),
}));

import { DailyBrief } from "../components/DailyBrief";
import { regenerateWhatsNew } from "@/lib/daemon-client";

function renderBrief() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <DailyBrief />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
});

describe("DailyBrief refresh", () => {
  it("clicking refresh triggers a server-side digest regeneration", async () => {
    renderBrief();
    const btn = await screen.findByLabelText("Refresh brief");
    fireEvent.click(btn);
    await waitFor(() => {
      expect(regenerateWhatsNew).toHaveBeenCalledTimes(1);
    });
  });
});
