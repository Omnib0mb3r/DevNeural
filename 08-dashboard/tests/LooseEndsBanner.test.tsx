/**
 * LEX-AUTONOMY codex 10c (Fix 47 step 3): LooseEndsBanner pins.
 *
 * Three pins:
 *   1. Banner renders one row per loose end with the human-friendly
 *      class label and severity pill.
 *   2. Banner color tracks the highest severity present (alert >
 *      warn > info) so the operator can tell at a glance that a
 *      blocker is active.
 *   3. Dismiss writes a 5-min mute entry to localStorage and
 *      isLooseEndsBannerDismissed returns true for the same anchor
 *      until the TTL elapses.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  LooseEndsBanner,
  dismissLooseEndsBanner,
  isLooseEndsBannerDismissed,
  type LooseEndsReportShape,
} from "../components/LooseEndsBanner";

const ANCHOR = "anchor-12345678-xxxx-xxxx";

function buildReport(
  ends: LooseEndsReportShape["ends"],
): LooseEndsReportShape {
  return {
    anchor_id: ANCHOR,
    ends,
    has_blocker: ends.some((e) => e.disposition === "operator"),
    has_auto: ends.some((e) => e.disposition === "auto"),
    generated_ms: 1_000,
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("LooseEndsBanner", () => {
  it("pin 1: renders one row per loose end with severity pill + class label", () => {
    const report = buildReport([
      {
        class: "dirty_worktree",
        disposition: "operator",
        severity: "alert",
        detail: " M src/file.ts",
      },
      {
        class: "undistilled_ref",
        disposition: "auto",
        severity: "warn",
        detail: "ref ended without ref_summary",
      },
    ]);
    render(<LooseEndsBanner report={report} />);
    const rows = screen.getAllByTestId("loose-ends-banner-row");
    expect(rows.length).toBe(2);
    expect(screen.getByText("Dirty Worktree")).toBeDefined();
    expect(screen.getByText("Undistilled Ref")).toBeDefined();
    /* severity pills */
    expect(screen.getAllByText(/alert/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/warn/i).length).toBeGreaterThanOrEqual(1);
  });

  it("pin 2: banner color tracks the highest severity (alert when any end is alert)", () => {
    const report = buildReport([
      {
        class: "grooming_gap",
        disposition: "informational",
        severity: "info",
        detail: "artifact ahead",
      },
      {
        class: "dirty_worktree",
        disposition: "operator",
        severity: "alert",
        detail: "uncommitted",
      },
    ]);
    render(<LooseEndsBanner report={report} />);
    const banner = screen.getByTestId("loose-ends-banner");
    /* alert palette -> rose backdrop */
    expect(banner.className).toMatch(/rose/);
    expect(banner.className).not.toMatch(/sky-/);
  });

  it("pin 3: dismiss button writes a 5-min mute and isLooseEndsBannerDismissed returns true", () => {
    const report = buildReport([
      {
        class: "dirty_worktree",
        disposition: "operator",
        severity: "alert",
        detail: "uncommitted",
      },
    ]);
    expect(isLooseEndsBannerDismissed(ANCHOR)).toBe(false);
    render(<LooseEndsBanner report={report} />);
    const btn = screen.getByTestId("loose-ends-banner-dismiss");
    fireEvent.click(btn);
    /* Banner unmounts itself + localStorage entry persists */
    expect(screen.queryByTestId("loose-ends-banner")).toBeNull();
    expect(isLooseEndsBannerDismissed(ANCHOR)).toBe(true);
    /* Direct dismiss helper round-trips for the same anchor */
    dismissLooseEndsBanner("another-anchor");
    expect(isLooseEndsBannerDismissed("another-anchor")).toBe(true);
  });
});
