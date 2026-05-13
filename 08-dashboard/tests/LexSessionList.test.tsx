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
  lexAnchors: vi.fn().mockResolvedValue({ ok: true, anchors: [] }),
  patchLexAnchor: vi.fn().mockResolvedValue({ ok: true }),
  createLexAnchor: vi.fn().mockResolvedValue({ ok: true }),
  openLexAnchor: vi.fn().mockResolvedValue({ ok: true }),
  endLexAnchor: vi.fn().mockResolvedValue({ ok: true }),
  /* Phase C-3: SupervisesPicker fetches project anchor tiles via
   * this helper. The picker also accepts an `options` prop to bypass
   * the call entirely, but LexSessionList does not thread that
   * through, so the mock returns a small fixture. */
  listProjectAnchorTiles: vi.fn().mockResolvedValue({
    ok: true,
    tiles: [
      {
        anchor_id: "proj-A",
        project_slug: "devneural",
        title: "DevNeural",
        cwd: "C:/dev/Projects/DevNeural",
        status: "live",
        current_session_id: "cc-live",
        current_bridge_id: null,
        bridge_connection_count: 0,
        current_pty_id: null,
        transcript_path: null,
        phase: "idle",
        pending_prompt: null,
        last_activity_ms: 0,
        transcript_count: 0,
        supervision_mode: "polling",
      },
    ],
  }),
}));

import {
  LexSessionList,
  PAST_SESSIONS_COLLAPSE_KEY,
} from "../components/LexSessionList";
import { lexAnchors, createLexAnchor } from "@/lib/daemon-client";

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

describe("LexSessionList - C-3 supervises picker", () => {
  it("hides the new-brainstorm form until + button is clicked", () => {
    renderWithQuery(<LexSessionList initialCollapsed={false} />);
    expect(
      screen.queryByTestId("lex-new-brainstorm-form"),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /new brainstorm/i }));
    expect(
      screen.getByTestId("lex-new-brainstorm-form"),
    ).toBeInTheDocument();
  });

  it("posts createLexAnchor with the selected supervises_project_anchor_id", async () => {
    renderWithQuery(<LexSessionList initialCollapsed={false} />);
    fireEvent.click(screen.getByRole("button", { name: /new brainstorm/i }));
    const form = await screen.findByTestId("lex-new-brainstorm-form");
    const picker = form.querySelector(
      "select[data-testid='supervises-picker']",
    ) as HTMLSelectElement;
    expect(picker).toBeTruthy();
    /* Wait for the listProjectAnchorTiles mock to resolve so the
     * picker has the project-A option mounted before we select it. */
    await waitFor(() => {
      expect(picker.querySelector("option[value='proj-A']")).toBeTruthy();
    });
    fireEvent.change(picker, { target: { value: "proj-A" } });
    fireEvent.click(
      screen.getByRole("button", { name: /create brainstorm/i }),
    );
    await waitFor(() => {
      expect(createLexAnchor).toHaveBeenCalledWith({
        supervises_project_anchor_id: "proj-A",
      });
    });
  });

  it("renders the per-row supervises chip with current binding", async () => {
    (lexAnchors as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      anchors: [
        {
          id: "lex-1",
          title: "Brainstorm 1",
          derived_title: null,
          status: "dormant",
          current_pty_id: null,
          cwd: "C:/p",
          created_ms: 1,
          last_activity_ms: 1,
          transcript_count: 0,
          supervises_project_anchor_id: "proj-A",
        },
      ],
    });
    renderWithQuery(<LexSessionList initialCollapsed={false} />);
    const chip = await screen.findByTestId("lex-row-supervises-lex-1");
    expect(chip).toBeInTheDocument();
    /* The compact picker inside the chip reflects the current binding
     * once the listProjectAnchorTiles mock has resolved and the
     * proj-A option exists. */
    const select = chip.querySelector(
      "select[data-testid='supervises-picker']",
    ) as HTMLSelectElement;
    expect(select).toBeTruthy();
    await waitFor(() => {
      expect(select.querySelector("option[value='proj-A']")).toBeTruthy();
    });
    expect(select.value).toBe("proj-A");
  });
});
