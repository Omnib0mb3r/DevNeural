/**
 * SmartCompactAuditPanel render tests.
 *
 * Covers:
 *   - empty-state copy when the feed has no rows.
 *   - tone-coded action column for every action value.
 *   - row expand toggles payload_text body; collapsed by default.
 *   - payload_text body falls back to summary_preview for legacy rows.
 *   - empty-payload row renders the '(no payload captured)' fallback.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";

vi.mock("@/lib/daemon-client", () => ({
  recentSmartCompacts: vi.fn(),
}));

import { SmartCompactAuditPanel } from "../components/SmartCompactAuditPanel";
import { recentSmartCompacts } from "@/lib/daemon-client";

type Row = {
  id: string;
  ts: string;
  anchor_id: string | null;
  cc_session_id: string | null;
  caller: string;
  reason: string;
  action: "fire" | "wrap" | "shadow" | "noop";
  pre_ctx_pct: number | null;
  post_ctx_pct: number | null;
  summary_preview: string | null;
  payload_text: string | null;
};

const mock = recentSmartCompacts as unknown as ReturnType<typeof vi.fn>;

function row(over: Partial<Row> = {}): Row {
  const base: Row = {
    id: "row-1",
    ts: new Date(1_000_000).toISOString(),
    anchor_id: "anchor-aaaaaaaa",
    cc_session_id: null,
    caller: "scheduler",
    reason: "window-open",
    action: "fire",
    pre_ctx_pct: 60,
    post_ctx_pct: null,
    summary_preview: "preview line",
    payload_text: "full payload body",
  };
  return { ...base, ...over };
}

function renderWithQuery() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <SmartCompactAuditPanel />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mock.mockReset();
  mock.mockResolvedValue({ ok: true, rows: [] });
});

afterEach(() => {
  cleanup();
});

describe("SmartCompactAuditPanel - render", () => {
  it("shows empty-state copy when the feed has no rows", async () => {
    renderWithQuery();
    await waitFor(() =>
      expect(
        screen.getByText(/No smart-compact attempts recorded yet/),
      ).toBeInTheDocument(),
    );
  });

  it("tone-codes the action column per outcome", async () => {
    mock.mockResolvedValue({
      ok: true,
      rows: [
        row({ id: "s", action: "shadow" }),
        row({ id: "f", action: "fire" }),
        row({ id: "w", action: "wrap" }),
        row({ id: "n", action: "noop" }),
      ],
    });
    renderWithQuery();
    await waitFor(() => {
      const rows = screen.getAllByTestId("smart-compact-row");
      expect(rows).toHaveLength(4);
    });
    const actionEls = screen.getAllByTestId("smart-compact-action");
    expect(actionEls[0]!.className).toMatch(/text-txt3/);
    expect(actionEls[1]!.className).toMatch(/text-ok/);
    expect(actionEls[2]!.className).toMatch(/text-warn/);
    expect(actionEls[3]!.className).toMatch(/text-err/);
  });
});

describe("SmartCompactAuditPanel - expand", () => {
  it("rows start collapsed; click toggles the body open", async () => {
    mock.mockResolvedValue({
      ok: true,
      rows: [row({ id: "r1", payload_text: "expanded body lives here" })],
    });
    renderWithQuery();
    await waitFor(() =>
      expect(screen.getByTestId("smart-compact-row")).toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId("smart-compact-row-body"),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByTestId("smart-compact-row").querySelector("button")!,
    );
    const body = screen.getByTestId("smart-compact-row-body");
    expect(body).toHaveTextContent("expanded body lives here");
  });

  it("falls back to summary_preview when payload_text is null (legacy row)", async () => {
    mock.mockResolvedValue({
      ok: true,
      rows: [
        row({
          id: "legacy",
          payload_text: null,
          summary_preview: "legacy preview only",
        }),
      ],
    });
    renderWithQuery();
    await waitFor(() =>
      expect(screen.getByTestId("smart-compact-row")).toBeInTheDocument(),
    );
    fireEvent.click(
      screen.getByTestId("smart-compact-row").querySelector("button")!,
    );
    expect(screen.getByTestId("smart-compact-row-body")).toHaveTextContent(
      "legacy preview only",
    );
  });

  it("renders the (no payload captured) fallback when both fields are null", async () => {
    mock.mockResolvedValue({
      ok: true,
      rows: [
        row({ id: "empty", payload_text: null, summary_preview: null }),
      ],
    });
    renderWithQuery();
    await waitFor(() =>
      expect(screen.getByTestId("smart-compact-row")).toBeInTheDocument(),
    );
    fireEvent.click(
      screen.getByTestId("smart-compact-row").querySelector("button")!,
    );
    expect(screen.getByTestId("smart-compact-row-body")).toHaveTextContent(
      "(no payload captured)",
    );
  });

  it("clicking the open row collapses it again", async () => {
    mock.mockResolvedValue({
      ok: true,
      rows: [row({ id: "r1" })],
    });
    renderWithQuery();
    await waitFor(() =>
      expect(screen.getByTestId("smart-compact-row")).toBeInTheDocument(),
    );
    const button = screen.getByTestId("smart-compact-row")
      .querySelector("button")!;
    fireEvent.click(button);
    expect(screen.getByTestId("smart-compact-row-body")).toBeInTheDocument();
    fireEvent.click(button);
    expect(
      screen.queryByTestId("smart-compact-row-body"),
    ).not.toBeInTheDocument();
  });
});
