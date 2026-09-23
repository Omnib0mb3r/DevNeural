/**
 * ContextGauge render pins (2026-09-22 plan, Task 10).
 *
 * One gauge shape on every session surface: a horizontal bar whose
 * fill sits at the context percent, two vertical marks at the
 * smart-clear threshold and ceiling, and a one-line reading. Colour
 * follows the trip marks: ok below the threshold, warn between, alarm
 * at or above the ceiling. A null percent reads "context unknown"
 * instead of drawing an empty bar as if the session were fresh.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ContextGauge } from "../components/ContextGauge";

afterEach(() => {
  cleanup();
});

describe("ContextGauge - geometry", () => {
  it("positions the fill and both marks by percent", () => {
    render(<ContextGauge pct={42} thresholdPct={40} ceilingPct={60} />);
    expect(screen.getByTestId("context-gauge-fill").style.width).toBe("42%");
    expect(screen.getByTestId("context-gauge-threshold").style.left).toBe(
      "40%",
    );
    expect(screen.getByTestId("context-gauge-ceiling").style.left).toBe("60%");
  });

  it("moves the marks with the configured trip points", () => {
    render(<ContextGauge pct={10} thresholdPct={35} ceilingPct={70} />);
    expect(screen.getByTestId("context-gauge-threshold").style.left).toBe(
      "35%",
    );
    expect(screen.getByTestId("context-gauge-ceiling").style.left).toBe("70%");
  });

  it("clamps the fill to the bar", () => {
    render(<ContextGauge pct={130} thresholdPct={40} ceilingPct={60} />);
    expect(screen.getByTestId("context-gauge-fill").style.width).toBe("100%");
  });

  it("exposes an accessible meter", () => {
    render(<ContextGauge pct={42} thresholdPct={40} ceilingPct={60} />);
    const meter = screen.getByRole("meter");
    expect(meter).toHaveAttribute("aria-valuenow", "42");
    expect(meter).toHaveAttribute("aria-valuemin", "0");
    expect(meter).toHaveAttribute("aria-valuemax", "100");
  });
});

describe("ContextGauge - colour follows the trip marks", () => {
  it("is gauge-ok below the threshold", () => {
    render(<ContextGauge pct={12} thresholdPct={40} ceilingPct={60} />);
    const gauge = screen.getByTestId("context-gauge");
    expect(gauge).toHaveClass("gauge-ok");
    expect(gauge).not.toHaveClass("gauge-warn");
    expect(gauge).not.toHaveClass("gauge-alarm");
    expect(gauge).toHaveAttribute("data-tone", "ok");
  });

  it("is gauge-warn from the threshold up to the ceiling", () => {
    render(<ContextGauge pct={40} thresholdPct={40} ceilingPct={60} />);
    expect(screen.getByTestId("context-gauge")).toHaveClass("gauge-warn");
    cleanup();
    render(<ContextGauge pct={59} thresholdPct={40} ceilingPct={60} />);
    const gauge = screen.getByTestId("context-gauge");
    expect(gauge).toHaveClass("gauge-warn");
    expect(gauge).not.toHaveClass("gauge-ok");
    expect(gauge).not.toHaveClass("gauge-alarm");
  });

  it("is gauge-alarm at or above the ceiling", () => {
    render(<ContextGauge pct={60} thresholdPct={40} ceilingPct={60} />);
    expect(screen.getByTestId("context-gauge")).toHaveClass("gauge-alarm");
    cleanup();
    render(<ContextGauge pct={95} thresholdPct={40} ceilingPct={60} />);
    const gauge = screen.getByTestId("context-gauge");
    expect(gauge).toHaveClass("gauge-alarm");
    expect(gauge).not.toHaveClass("gauge-warn");
    expect(gauge).not.toHaveClass("gauge-ok");
  });
});

describe("ContextGauge - reading", () => {
  it("prints the percent and the clear point", () => {
    render(<ContextGauge pct={42} thresholdPct={40} ceilingPct={60} />);
    expect(screen.getByTestId("context-gauge-text")).toHaveTextContent(
      "42% of context, clears at 40%",
    );
  });

  it("prefixes the label when one is given", () => {
    render(
      <ContextGauge pct={42} thresholdPct={40} ceilingPct={60} label="Lex" />,
    );
    expect(screen.getByTestId("context-gauge-text")).toHaveTextContent(
      "Lex: 42% of context, clears at 40%",
    );
    expect(screen.getByRole("meter")).toHaveAttribute(
      "aria-label",
      "Lex context",
    );
  });

  it("reads context unknown on a null percent, with no colour class and an empty fill", () => {
    render(<ContextGauge pct={null} thresholdPct={40} ceilingPct={60} />);
    expect(screen.getByTestId("context-gauge-text")).toHaveTextContent(
      "context unknown",
    );
    const gauge = screen.getByTestId("context-gauge");
    expect(gauge).toHaveClass("gauge-unknown");
    expect(gauge).not.toHaveClass("gauge-ok");
    expect(gauge).not.toHaveClass("gauge-warn");
    expect(gauge).not.toHaveClass("gauge-alarm");
    expect(screen.getByTestId("context-gauge-fill").style.width).toBe("0%");
    expect(screen.getByRole("meter")).not.toHaveAttribute("aria-valuenow");
    /* The marks still draw, so an unknown gauge shows where the trips sit. */
    expect(screen.getByTestId("context-gauge-threshold").style.left).toBe(
      "40%",
    );
  });

  it("marks the compact variant for the dense rows", () => {
    render(<ContextGauge pct={42} thresholdPct={40} ceilingPct={60} compact />);
    expect(screen.getByTestId("context-gauge")).toHaveAttribute(
      "data-compact",
      "1",
    );
  });
});
