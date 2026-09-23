/**
 * HandoverList pins (2026-09-22 plan, Task 10, Phase C).
 *
 * The brainstorm detail page lists the timestamped handover files the
 * daemon wrote for the anchor: newest first, each row with its date,
 * kind and verdict, an "unvetted" badge when Lex has not reviewed the
 * file yet, and an expand action that fetches the file body and shows
 * it preformatted (both halves visible, nothing reflowed).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("@/lib/daemon-client", () => ({
  lexHandovers: vi.fn(),
  lexHandoverFile: vi.fn(),
}));

import { HandoverList } from "../components/HandoverList";
import { lexHandovers, lexHandoverFile } from "@/lib/daemon-client";

const handoversMock = lexHandovers as unknown as ReturnType<typeof vi.fn>;
const fileMock = lexHandoverFile as unknown as ReturnType<typeof vi.fn>;

/* Served OLDEST first on purpose: the list must sort, not trust order. */
const ROWS = [
  {
    file: "2026-09-22T10-00-00Z-session-end.md",
    created_at: "2026-09-22T10:00:00.000Z",
    kind: "session-end",
    unvetted: false,
    verdict: "approved",
  },
  {
    file: "2026-09-22T12-30-00Z-crash.md",
    created_at: "2026-09-22T12:30:00.000Z",
    kind: "crash",
    unvetted: true,
    verdict: null,
  },
];

function renderList(anchorId = "anchor-1") {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <HandoverList anchorId={anchorId} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  handoversMock.mockReset();
  fileMock.mockReset();
  handoversMock.mockResolvedValue({ ok: true, handovers: ROWS });
  fileMock.mockResolvedValue({
    ok: true,
    content: "# Handover\n\nworker half\n\n---\n\nLex half",
  });
});

afterEach(() => {
  cleanup();
});

describe("HandoverList - rows", () => {
  it("fetches the anchor's handovers and renders them newest first", async () => {
    renderList("anchor-1");
    const rows = await screen.findAllByTestId("handover-row");
    expect(handoversMock).toHaveBeenCalledWith("anchor-1");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("crash");
    expect(rows[1]).toHaveTextContent("session-end");
    expect(rows[0]).toHaveAttribute(
      "data-file",
      "2026-09-22T12-30-00Z-crash.md",
    );
  });

  it("shows the date, kind and verdict on each row", async () => {
    renderList();
    const rows = await screen.findAllByTestId("handover-row");
    expect(rows[0]).toHaveTextContent("2026-09-22 12:30");
    expect(rows[0]).toHaveTextContent("no verdict");
    expect(rows[1]).toHaveTextContent("2026-09-22 10:00");
    expect(rows[1]).toHaveTextContent("approved");
  });

  it("badges an unvetted handover and only that one", async () => {
    renderList();
    const rows = await screen.findAllByTestId("handover-row");
    expect(
      within(rows[0]!).getByTestId("handover-unvetted"),
    ).toHaveTextContent("unvetted");
    expect(within(rows[1]!).queryByTestId("handover-unvetted")).toBeNull();
  });

  it("reads an empty state when the anchor has no handovers", async () => {
    handoversMock.mockResolvedValue({ ok: true, handovers: [] });
    renderList();
    expect(await screen.findByText(/no handovers yet/i)).toBeInTheDocument();
    expect(screen.queryByTestId("handover-row")).toBeNull();
  });
});

describe("HandoverList - expand", () => {
  it("does not fetch any file body until a row is expanded", async () => {
    renderList();
    await screen.findAllByTestId("handover-row");
    expect(fileMock).not.toHaveBeenCalled();
    expect(screen.queryByTestId("handover-body")).toBeNull();
  });

  it("expanding a row fetches that file and shows it preformatted", async () => {
    renderList("anchor-1");
    const rows = await screen.findAllByTestId("handover-row");
    fireEvent.click(within(rows[0]!).getByRole("button", { name: /expand/i }));
    await waitFor(() => {
      expect(fileMock).toHaveBeenCalledWith(
        "anchor-1",
        "2026-09-22T12-30-00Z-crash.md",
      );
    });
    const body = await screen.findByTestId("handover-body");
    expect(body.tagName).toBe("PRE");
    expect(body).toHaveTextContent("worker half");
    expect(body).toHaveTextContent("Lex half");
  });

  it("collapses again on a second click", async () => {
    renderList();
    const rows = await screen.findAllByTestId("handover-row");
    const toggle = within(rows[0]!).getByRole("button", { name: /expand/i });
    fireEvent.click(toggle);
    await screen.findByTestId("handover-body");
    fireEvent.click(
      within(rows[0]!).getByRole("button", { name: /collapse/i }),
    );
    await waitFor(() => {
      expect(screen.queryByTestId("handover-body")).toBeNull();
    });
  });
});
