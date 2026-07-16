/**
 * Meeting tab audit pin (2026-07-16). The empty state used to link to
 * /sessions/new, a route that does not exist (dead 404 link), and
 * never mentioned the actual start path (the voice panel's meeting
 * toggle in notes mode).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/daemon-client", () => ({
  listMeetings: vi.fn().mockResolvedValue({ ok: true, meetings: [] }),
}));

import { MeetingList } from "../components/MeetingList";

afterEach(() => {
  cleanup();
});

describe("MeetingList empty state", () => {
  it("points at the real start path (voice panel meeting toggle), never the dead /sessions/new", async () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={qc}>
        <MeetingList />
      </QueryClientProvider>,
    );
    await waitFor(() => {
      expect(screen.getByText(/no meetings yet/i)).toBeInTheDocument();
    });
    const link = screen.getByRole("link", { name: /voice panel/i });
    expect(link.getAttribute("href")).toBe("/lex");
    expect(document.querySelector('a[href="/sessions/new"]')).toBeNull();
    expect(screen.getByText(/meeting toggle/i)).toBeInTheDocument();
  });
});
