/**
 * ProjectsGrid home/projects split pins (2026-07-16 operator audit:
 * the home page duplicated the projects page's supervision selector -
 * redundant; home should show project STATUS instead).
 *
 * Compact (home) tiles render a read-only status row (phase dot +
 * supervision mode text); the interactive toggle renders only on the
 * full /projects grid.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/daemon-client", () => ({
  projects: vi.fn().mockResolvedValue({
    ok: true,
    projects: [
      {
        id: "p1",
        name: "DevNeural",
        root: "C:/dev/Projects/DevNeural",
        remote: null,
        last_seen: new Date().toISOString(),
      },
    ],
  }),
  sessions: vi.fn().mockResolvedValue({ ok: true, sessions: [] }),
  listProjectAnchorTiles: vi.fn().mockResolvedValue({
    ok: true,
    tiles: [
      {
        anchor_id: "anchor-1",
        project_slug: "devneural",
        title: "DevNeural",
        cwd: "C:/dev/Projects/DevNeural",
        status: "live",
        current_session_id: null,
        current_bridge_id: null,
        bridge_connection_count: 0,
        current_pty_id: null,
        transcript_path: null,
        phase: "thinking",
        pending_prompt: null,
        last_activity_ms: Date.now(),
        transcript_count: 3,
        supervision_mode: "event",
      },
    ],
  }),
  patchProjectAnchor: vi.fn(),
}));

import { ProjectsGrid } from "../components/ProjectsGrid";

function renderGrid(compact: boolean) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ProjectsGrid compact={compact} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
});

describe("ProjectsGrid compact vs full", () => {
  it("home (compact) shows read-only status, not the supervision toggle", async () => {
    renderGrid(true);
    await waitFor(() => {
      expect(
        screen.getByTestId("projects-grid-compact-status"),
      ).toBeInTheDocument();
    });
    expect(screen.queryByTestId("supervision-mode-toggle")).toBeNull();
    const status = screen.getByTestId("projects-grid-compact-status");
    expect(status.textContent).toContain("thinking");
    expect(status.textContent).toContain("supervision: event");
  });

  it("projects page (full) keeps the interactive toggle", async () => {
    renderGrid(false);
    await waitFor(() => {
      expect(
        screen.getByTestId("supervision-mode-toggle"),
      ).toBeInTheDocument();
    });
    expect(screen.queryByTestId("projects-grid-compact-status")).toBeNull();
  });
});
