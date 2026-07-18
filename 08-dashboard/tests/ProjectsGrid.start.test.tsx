/**
 * Operator control restore (2026-07-18): the home (compact) ProjectsGrid
 * tiles must offer a "Start Claude" button for a not-running project,
 * wired to the EXISTING start path (startClaude -> POST
 * /projects/:id/start-claude). The voice-wave home/projects de-dup
 * (cc26d96) left home tiles read-only; the operator lost the ability to
 * launch a pty-controlled Claude session from the home view. This pins
 * the button back. Buttons/rendering only - no bridge/pty/status logic.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  fireEvent,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const { startClaudeMock } = vi.hoisted(() => ({
  startClaudeMock: vi.fn().mockResolvedValue({ ok: true }),
}));

vi.mock("@/lib/daemon-client", () => ({
  projects: vi.fn().mockResolvedValue({
    ok: true,
    projects: [
      {
        id: "p-idle",
        name: "IdleRepo",
        root: "C:/dev/Projects/IdleRepo",
        remote: null,
        last_seen: new Date().toISOString(),
      },
    ],
  }),
  sessions: vi.fn().mockResolvedValue({ ok: true, sessions: [] }),
  listProjectAnchorTiles: vi.fn().mockResolvedValue({ ok: true, tiles: [] }),
  startClaude: startClaudeMock,
  patchProjectAnchor: vi.fn(),
}));

import { ProjectsGrid } from "../components/ProjectsGrid";

function renderGrid() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ProjectsGrid compact />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  startClaudeMock.mockClear();
});

describe("ProjectsGrid home tiles: Start Claude control", () => {
  it("renders Start Claude on a not-running home tile and hits the existing start path on click", async () => {
    renderGrid();
    const btn = await screen.findByTestId("projects-grid-start-claude");
    expect(btn.textContent).toContain("Start Claude");
    fireEvent.click(btn);
    await waitFor(() =>
      expect(startClaudeMock).toHaveBeenCalledWith("p-idle"),
    );
  });
});
