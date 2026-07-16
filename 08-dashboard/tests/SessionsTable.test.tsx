/**
 * Sessions page merged-table pins (2026-07-16 operator directive:
 * "combine this table... one table with the status and start buttons
 * and indicators and ID and all that" - no separate status section
 * below the start-claude section).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/daemon-client", () => ({
  sessions: vi.fn().mockResolvedValue({
    ok: true,
    sessions: [
      {
        session_id: "sess-live-123456",
        project_slug: "C--dev-Projects-DevNeural",
        jsonl_path: "x.jsonl",
        bytes: 10,
        last_modified_ms: Date.now(),
        active: true,
        has_summary: false,
        has_task: true,
        phase: "idle",
        pending_prompt: null,
        context: null,
        user_label: null,
        derived_label: null,
      },
    ],
    idle_projects: [
      {
        id: "proj-lpcc",
        name: "LPCC",
        root: "C:/dev/Projects/LPCC",
      },
    ],
  }),
  startClaude: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

import { SessionsTable } from "../components/SessionsTable";

function renderTable() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <SessionsTable />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
});

describe("SessionsTable merged table", () => {
  it("renders sessions and startable projects as rows of ONE table", async () => {
    renderTable();
    await waitFor(() => {
      expect(screen.getAllByRole("table")).toHaveLength(1);
    });
    const table = screen.getByRole("table");
    /* Startable project row lives INSIDE the table with its button. */
    const startBtn = screen.getByRole("button", { name: /start claude/i });
    expect(table.contains(startBtn)).toBe(true);
    /* Session row in the same table. */
    expect(table.textContent).toContain("sess-live-12");
    /* The separate section header is gone. */
    expect(screen.queryByText(/ready to start/i)).toBeNull();
  });

  it("startable rows read as 'not running' in the status column", async () => {
    renderTable();
    await waitFor(() => {
      expect(screen.getByText(/not running/i)).toBeInTheDocument();
    });
  });
});
