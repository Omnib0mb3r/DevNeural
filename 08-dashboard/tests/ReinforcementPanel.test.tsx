/**
 * Wiki match history panel pins (2026-07-16 operator audit).
 *
 * The table showed jargon ("cos 0.45", "src raw"), had no column
 * headers, and rows were dead - no way to see whether an injected
 * match was accepted or rejected, or what was actually injected.
 * Pins: column headers, plain-English kind labels and details, and
 * the click-to-expand verdict body with the injected preview.
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
  reinforcement: vi.fn().mockResolvedValue({
    ok: true,
    total_bytes: 1024,
    events: [
      {
        ts: new Date().toISOString(),
        kind: "injection",
        session: "sess-1",
        chunk: "chunk-abcdef",
        project: "global",
        source: "raw",
        preview: "the injected transcript excerpt body",
      },
      {
        ts: new Date().toISOString(),
        kind: "raw-no-hit",
        session: "sess-1",
        page: "chunk-abcdef",
        cosine: 0.45,
      },
      {
        ts: new Date().toISOString(),
        kind: "hit",
        session: "sess-2",
        page: "wiki-page-1",
        cosine: 0.82,
        source: "wiki",
      },
    ],
  }),
}));

import { ReinforcementPanel } from "../components/ReinforcementPanel";

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ReinforcementPanel />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
});

describe("ReinforcementPanel", () => {
  it("renders a column-header row", async () => {
    renderPanel();
    const head = await screen.findByTestId("reinforcement-headers");
    const text = head.textContent!.toLowerCase();
    for (const col of ["when", "what happened", "matched", "details"]) {
      expect(text).toContain(col);
    }
  });

  it("speaks plain English instead of cos/raw jargon", async () => {
    renderPanel();
    await waitFor(() => {
      expect(screen.getAllByTestId("reinforcement-row").length).toBe(3);
    });
    const all = screen
      .getAllByTestId("reinforcement-row")
      .map((r) => r.textContent!.toLowerCase())
      .join(" ");
    expect(all).toContain("similarity");
    expect(all).not.toMatch(/\bcos \d/);
    expect(all).not.toMatch(/\bsrc raw\b/);
  });

  it("expands a row to show the verdict sentence and the injected preview", async () => {
    renderPanel();
    const rows = await screen.findAllByTestId("reinforcement-row");
    fireEvent.click(rows[0]!.querySelector("button")!);
    const body = await screen.findByTestId("reinforcement-row-body");
    expect(body.textContent).toContain(
      "the injected transcript excerpt body",
    );
    expect(body.textContent!.toLowerCase()).toContain("sent");
  });

  it("labels outcomes as accepted / not used in the expanded verdict", async () => {
    renderPanel();
    const rows = await screen.findAllByTestId("reinforcement-row");
    /* Row 2: raw-no-hit -> rejected/not-used verdict. */
    fireEvent.click(rows[1]!.querySelector("button")!);
    const body = await screen.findByTestId("reinforcement-row-body");
    expect(body.textContent!.toLowerCase()).toMatch(/not used|rejected/);
    fireEvent.click(rows[1]!.querySelector("button")!);
    /* Row 3: hit -> accepted verdict. */
    fireEvent.click(rows[2]!.querySelector("button")!);
    const body2 = await screen.findByTestId("reinforcement-row-body");
    expect(body2.textContent!.toLowerCase()).toMatch(/accepted|used/);
  });
});
