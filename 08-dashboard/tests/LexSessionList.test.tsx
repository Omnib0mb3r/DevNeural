/**
 * LexSessionList render-only tests.
 *
 * Covers the two UX contracts the panel promises:
 *   1. Capped visible height: the body container renders max-h-56 +
 *      overflow-y-auto so a long anchor list scrolls internally
 *      instead of pushing the rest of the dashboard down.
 *   2. Collapse toggle persistence: flipping the toggle writes to
 *      localStorage under the past-sessions key, mount-time read
 *      seeds the initial state, expand clears the key.
 *
 * Daemon-client is mocked so the test does not need a fastify dev
 * server; react-query is wrapped in a fresh QueryClientProvider per
 * test so caches do not leak between specs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";

vi.mock("@/lib/daemon-client", () => ({
  lexAnchors: vi.fn().mockResolvedValue({ ok: true, anchors: [] }),
  patchLexAnchor: vi.fn().mockResolvedValue({ ok: true }),
  createLexAnchor: vi.fn().mockResolvedValue({ ok: true }),
  openLexAnchor: vi.fn().mockResolvedValue({ ok: true }),
  endLexAnchor: vi.fn().mockResolvedValue({ ok: true }),
}));

import {
  LexSessionList,
  PAST_SESSIONS_COLLAPSE_KEY,
} from "../components/LexSessionList";
import { lexAnchors } from "@/lib/daemon-client";

function renderWithQuery(ui: React.ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>{ui}</QueryClientProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  (lexAnchors as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
    ok: true,
    anchors: [],
  });
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("LexSessionList - capped visible height", () => {
  it("renders the body with the max-h-56 scroll container when expanded", () => {
    renderWithQuery(<LexSessionList initialCollapsed={false} />);
    const body = screen.getByTestId("lex-past-sessions-body");
    expect(body.className).toMatch(/max-h-56/);
    expect(body.className).toMatch(/overflow-y-auto/);
  });

  it("hides the body container entirely when collapsed", () => {
    renderWithQuery(<LexSessionList initialCollapsed />);
    expect(
      screen.queryByTestId("lex-past-sessions-body"),
    ).not.toBeInTheDocument();
  });

  it("renders the count-only strip when collapsed", () => {
    renderWithQuery(<LexSessionList initialCollapsed />);
    expect(
      screen.getByTestId("lex-past-sessions-strip"),
    ).toBeInTheDocument();
  });

  it("does not render the strip when expanded", () => {
    renderWithQuery(<LexSessionList initialCollapsed={false} />);
    expect(
      screen.queryByTestId("lex-past-sessions-strip"),
    ).not.toBeInTheDocument();
  });
});

describe("LexSessionList - collapse toggle persistence", () => {
  it("writes '1' to localStorage under the past-sessions key on collapse", () => {
    renderWithQuery(<LexSessionList initialCollapsed={false} />);
    const toggle = screen.getByRole("button", { name: /collapse/i });
    fireEvent.click(toggle);
    expect(window.localStorage.getItem(PAST_SESSIONS_COLLAPSE_KEY)).toBe(
      "1",
    );
  });

  it("clears the localStorage key on expand", () => {
    window.localStorage.setItem(PAST_SESSIONS_COLLAPSE_KEY, "1");
    renderWithQuery(<LexSessionList />);
    /* Mount effect picks up the persisted '1' and renders collapsed. */
    const expandBtn = screen.getByRole("button", { name: /expand/i });
    fireEvent.click(expandBtn);
    expect(window.localStorage.getItem(PAST_SESSIONS_COLLAPSE_KEY)).toBeNull();
  });

  it("flips aria-expanded on the toggle button", () => {
    renderWithQuery(<LexSessionList initialCollapsed={false} />);
    const before = screen.getByRole("button", { name: /collapse/i });
    expect(before).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(before);
    const after = screen.getByRole("button", { name: /expand/i });
    expect(after).toHaveAttribute("aria-expanded", "false");
  });

  it("uses a distinct localStorage key from the transcript collapse", () => {
    expect(PAST_SESSIONS_COLLAPSE_KEY).toBe(
      "devneural.lex.past-sessions.collapsed",
    );
    expect(PAST_SESSIONS_COLLAPSE_KEY).not.toBe(
      "devneural.lex.transcript.collapsed",
    );
  });
});
