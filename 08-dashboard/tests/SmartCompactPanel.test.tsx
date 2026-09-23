/**
 * SmartCompactPanel render + interaction smoke.
 *
 * Pins:
 *   - The three-segment selector renders one button per mode and
 *     marks the current mode active via aria-checked.
 *   - The card is the one Auto-clear switch (2026-09-22): a flip posts
 *     the unified /lex/auto-clear/mode route, and only when that route
 *     is missing (404, daemon predates it) falls back to the two older
 *     endpoints (smart-compact toggle + smart-clear config).
 *   - The runtime + env footer reflects the values returned by
 *     /lex/smart-compact/toggle.
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
  smartCompactToggle: vi.fn().mockResolvedValue({
    ok: true,
    mode: "shadow",
    runtime_value: null,
    env_value: null,
    default_mode: "shadow",
  }),
  setSmartCompactToggle: vi.fn().mockResolvedValue({
    ok: true,
    mode: "live",
    runtime_value: "live",
    env_value: null,
    default_mode: "shadow",
  }),
  setAutoClearMode: vi.fn(),
  setSmartClearConfig: vi.fn().mockResolvedValue({
    ok: true,
    mode: "live",
    thresholdPct: 40,
    ceilingPct: 60,
  }),
}));

import { SmartCompactPanel } from "../components/SmartCompactPanel";
import {
  setAutoClearMode,
  setSmartClearConfig,
  setSmartCompactToggle,
} from "@/lib/daemon-client";

const autoClearMock = setAutoClearMode as unknown as ReturnType<typeof vi.fn>;
const compactMock = setSmartCompactToggle as unknown as ReturnType<typeof vi.fn>;
const clearCfgMock = setSmartClearConfig as unknown as ReturnType<typeof vi.fn>;

function renderWithQuery(ui: React.ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  autoClearMock.mockReset();
  autoClearMock.mockResolvedValue({ ok: true, mode: "live" });
  compactMock.mockClear();
  clearCfgMock.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("SmartCompactPanel", () => {
  it("renders all three mode buttons", async () => {
    renderWithQuery(<SmartCompactPanel />);
    expect(
      await screen.findByTestId("smart-compact-mode-off"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("smart-compact-mode-shadow"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("smart-compact-mode-live")).toBeInTheDocument();
  });

  it("marks the daemon-returned mode active", async () => {
    renderWithQuery(<SmartCompactPanel />);
    const shadow = await screen.findByTestId("smart-compact-mode-shadow");
    await waitFor(() => {
      expect(shadow).toHaveAttribute("aria-checked", "true");
    });
    expect(
      screen.getByTestId("smart-compact-mode-off"),
    ).toHaveAttribute("aria-checked", "false");
    expect(
      screen.getByTestId("smart-compact-mode-live"),
    ).toHaveAttribute("aria-checked", "false");
  });

  it("clicking a different mode posts the one auto-clear route and nothing else", async () => {
    renderWithQuery(<SmartCompactPanel />);
    const live = await screen.findByTestId("smart-compact-mode-live");
    await waitFor(() => {
      expect(live).not.toBeDisabled();
    });
    fireEvent.click(live);
    await waitFor(() => {
      expect(setAutoClearMode).toHaveBeenCalledWith("live");
    });
    /* Give the mutation a tick to settle before asserting the negatives. */
    await new Promise((r) => setTimeout(r, 10));
    expect(setSmartCompactToggle).not.toHaveBeenCalled();
    expect(setSmartClearConfig).not.toHaveBeenCalled();
  });

  it("falls back to the two older endpoints when the auto-clear route is not deployed (404)", async () => {
    autoClearMock.mockRejectedValue({
      name: "DaemonError",
      status: 404,
      message: "daemon 404 on /lex/auto-clear/mode",
    });
    renderWithQuery(<SmartCompactPanel />);
    const live = await screen.findByTestId("smart-compact-mode-live");
    await waitFor(() => {
      expect(live).not.toBeDisabled();
    });
    fireEvent.click(live);
    await waitFor(() => {
      expect(setSmartCompactToggle).toHaveBeenCalledWith("live");
      expect(setSmartClearConfig).toHaveBeenCalledWith({ mode: "live" });
    });
    expect(setAutoClearMode).toHaveBeenCalledWith("live");
  });

  it("does not fall back on any other failure and reverts the optimistic flip", async () => {
    autoClearMock.mockRejectedValue({
      name: "DaemonError",
      status: 500,
      message: "daemon 500 on /lex/auto-clear/mode",
    });
    renderWithQuery(<SmartCompactPanel />);
    const live = await screen.findByTestId("smart-compact-mode-live");
    const shadow = screen.getByTestId("smart-compact-mode-shadow");
    await waitFor(() => {
      expect(live).not.toBeDisabled();
    });
    fireEvent.click(live);
    await waitFor(() => {
      expect(setAutoClearMode).toHaveBeenCalledWith("live");
    });
    await waitFor(() => {
      expect(shadow).toHaveAttribute("aria-checked", "true");
    });
    expect(setSmartCompactToggle).not.toHaveBeenCalled();
    expect(setSmartClearConfig).not.toHaveBeenCalled();
  });

  it("clicking the already-active mode does NOT fire the mutation", async () => {
    renderWithQuery(<SmartCompactPanel />);
    const shadow = await screen.findByTestId("smart-compact-mode-shadow");
    await waitFor(() => {
      expect(shadow).toHaveAttribute("aria-checked", "true");
    });
    fireEvent.click(shadow);
    /* Give react-query a tick to settle anything queued. */
    await new Promise((r) => setTimeout(r, 10));
    expect(setAutoClearMode).not.toHaveBeenCalled();
    expect(setSmartCompactToggle).not.toHaveBeenCalled();
  });

  /* 2026-07-16 operator audit: the card was headed "Auto-reset for
   * stuck workers" (reads as a different feature than the auto-clear
   * it actually is). 2026-09-22: it is now the ONE Auto-clear switch
   * over both smart-compact and smart-clear, so the heading drops the
   * "worker" qualifier too. */
  it("is headed as the single Auto-clear switch", async () => {
    renderWithQuery(<SmartCompactPanel />);
    expect(
      await screen.findByRole("heading", { name: /^auto-clear$/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText(/auto-reset for stuck workers/i)).toBeNull();
    expect(screen.getByRole("radiogroup")).toHaveAttribute(
      "aria-label",
      "Auto-clear mode",
    );
  });

  it("explains the effective mode in plain English instead of raw runtime/env dumps", async () => {
    renderWithQuery(<SmartCompactPanel />);
    /* runtime + env both unset in the mock: built-in default wins.
     * waitFor: the line renders "…" until the toggle query resolves. */
    await waitFor(() => {
      const line = screen.getByTestId("smart-compact-effective-mode");
      expect(line.textContent).toMatch(/effective mode: shadow/i);
      expect(line.textContent).toMatch(/built-in default/i);
    });
    expect(
      screen.queryByText(/DEVNEURAL_SMART_COMPACT_ENABLED=/),
    ).toBeNull();
  });
});
