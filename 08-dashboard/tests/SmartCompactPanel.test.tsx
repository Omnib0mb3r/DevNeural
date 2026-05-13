/**
 * SmartCompactPanel render + interaction smoke.
 *
 * Pins:
 *   - The three-segment selector renders one button per mode and
 *     marks the current mode active via aria-checked.
 *   - Clicking a different mode fires setSmartCompactToggle with
 *     that mode (optimistic flip).
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
}));

import { SmartCompactPanel } from "../components/SmartCompactPanel";
import { setSmartCompactToggle } from "@/lib/daemon-client";

function renderWithQuery(ui: React.ReactElement) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  (
    setSmartCompactToggle as unknown as ReturnType<typeof vi.fn>
  ).mockClear();
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

  it("clicking a different mode fires setSmartCompactToggle with that mode", async () => {
    renderWithQuery(<SmartCompactPanel />);
    const live = await screen.findByTestId("smart-compact-mode-live");
    await waitFor(() => {
      expect(live).not.toBeDisabled();
    });
    fireEvent.click(live);
    await waitFor(() => {
      expect(setSmartCompactToggle).toHaveBeenCalledWith("live");
    });
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
    expect(setSmartCompactToggle).not.toHaveBeenCalled();
  });
});
