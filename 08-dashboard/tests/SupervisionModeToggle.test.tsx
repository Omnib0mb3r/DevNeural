/**
 * SupervisionModeToggle render tests.
 *
 * Covers the three-mode contract:
 *   - renders three buttons (polling / event / off).
 *   - aria-pressed and visual treatment track the current mode.
 *   - event-mode shows the subtle indicator dot.
 *   - off-mode dims the parent wrapper.
 *   - click flips the local state immediately (optimistic) and
 *     rolls back on patcher rejection.
 *   - onChange fires on success only.
 *   - disabled prop suppresses interaction.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SupervisionModeToggle } from "../components/SupervisionModeToggle";

afterEach(() => {
  cleanup();
});

describe("SupervisionModeToggle - render", () => {
  it("renders the three modes with aria-pressed tracking the initial value", () => {
    render(
      <SupervisionModeToggle anchorId="a" initialMode="polling" />,
    );
    const polling = screen.getByTestId("supervision-mode-polling");
    const event = screen.getByTestId("supervision-mode-event");
    const off = screen.getByTestId("supervision-mode-off");
    expect(polling).toHaveAttribute("aria-pressed", "true");
    expect(event).toHaveAttribute("aria-pressed", "false");
    expect(off).toHaveAttribute("aria-pressed", "false");
  });

  it("event mode renders the subtle indicator dot", () => {
    render(<SupervisionModeToggle anchorId="a" initialMode="event" />);
    expect(
      screen.getByTestId("supervision-event-indicator"),
    ).toBeInTheDocument();
  });

  it("indicator is absent when not in event mode", () => {
    render(<SupervisionModeToggle anchorId="a" initialMode="polling" />);
    expect(
      screen.queryByTestId("supervision-event-indicator"),
    ).not.toBeInTheDocument();
  });

  it("off mode marks the wrapper as dim", () => {
    render(<SupervisionModeToggle anchorId="a" initialMode="off" />);
    const wrapper = screen.getByTestId("supervision-mode-toggle");
    expect(wrapper).toHaveAttribute("data-dim", "1");
    expect(wrapper.className).toMatch(/opacity-60/);
  });

  it("polling and event modes do not dim", () => {
    const { rerender } = render(
      <SupervisionModeToggle anchorId="a" initialMode="polling" />,
    );
    expect(screen.getByTestId("supervision-mode-toggle")).toHaveAttribute(
      "data-dim",
      "0",
    );
    rerender(<SupervisionModeToggle anchorId="a" initialMode="event" />);
    expect(screen.getByTestId("supervision-mode-toggle")).toHaveAttribute(
      "data-dim",
      "0",
    );
  });
});

describe("SupervisionModeToggle - optimistic update + rollback", () => {
  it("flips state immediately on click and confirms with patcher success", async () => {
    const patcher = vi
      .fn()
      .mockResolvedValue({ ok: true, anchor: { supervision_mode: "event" } });
    const onChange = vi.fn();
    render(
      <SupervisionModeToggle
        anchorId="anchor-A"
        initialMode="polling"
        patcher={patcher}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId("supervision-mode-event"));
    /* Optimistic: aria-pressed flips before the await resolves. */
    expect(
      screen.getByTestId("supervision-mode-event"),
    ).toHaveAttribute("aria-pressed", "true");
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("event"));
    expect(patcher).toHaveBeenCalledWith("anchor-A", {
      supervision_mode: "event",
    });
  });

  it("rolls back the local mode when the patcher returns ok:false", async () => {
    const patcher = vi.fn().mockResolvedValue({ ok: false, error: "nope" });
    const onChange = vi.fn();
    render(
      <SupervisionModeToggle
        anchorId="a"
        initialMode="polling"
        patcher={patcher}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByTestId("supervision-mode-off"));
    await waitFor(() =>
      expect(
        screen.getByTestId("supervision-mode-polling"),
      ).toHaveAttribute("aria-pressed", "true"),
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it("rolls back on a thrown network error", async () => {
    const patcher = vi.fn().mockRejectedValue(new Error("offline"));
    render(
      <SupervisionModeToggle
        anchorId="a"
        initialMode="event"
        patcher={patcher}
      />,
    );
    fireEvent.click(screen.getByTestId("supervision-mode-off"));
    await waitFor(() =>
      expect(
        screen.getByTestId("supervision-mode-event"),
      ).toHaveAttribute("aria-pressed", "true"),
    );
  });

  it("ignores clicks on the current mode (no patcher call)", () => {
    const patcher = vi.fn();
    render(
      <SupervisionModeToggle
        anchorId="a"
        initialMode="polling"
        patcher={patcher}
      />,
    );
    fireEvent.click(screen.getByTestId("supervision-mode-polling"));
    expect(patcher).not.toHaveBeenCalled();
  });

  it("disables every button while a request is in-flight", async () => {
    let resolve: (v: { ok: true }) => void = () => undefined;
    const patcher = vi.fn(
      () => new Promise<{ ok: true }>((r) => (resolve = r)),
    );
    render(
      <SupervisionModeToggle
        anchorId="a"
        initialMode="polling"
        patcher={patcher}
      />,
    );
    fireEvent.click(screen.getByTestId("supervision-mode-event"));
    expect(
      screen.getByTestId("supervision-mode-toggle"),
    ).toHaveAttribute("data-pending", "1");
    expect(
      screen.getByTestId("supervision-mode-polling"),
    ).toBeDisabled();
    resolve({ ok: true });
    await waitFor(() =>
      expect(
        screen.getByTestId("supervision-mode-toggle"),
      ).toHaveAttribute("data-pending", "0"),
    );
  });

  it("respects the disabled prop (no patcher call, buttons stay enabled but inert via data attr)", () => {
    const patcher = vi.fn();
    render(
      <SupervisionModeToggle
        anchorId="a"
        initialMode="polling"
        patcher={patcher}
        disabled
      />,
    );
    fireEvent.click(screen.getByTestId("supervision-mode-event"));
    expect(patcher).not.toHaveBeenCalled();
    expect(
      screen.getByTestId("supervision-mode-polling"),
    ).toBeDisabled();
  });
});
