/**
 * TranscriptHistory render-only tests.
 *
 * Covers the three contracts the dashboard UX patch promises:
 *   1. Renders the last N turns (capped) in order.
 *   2. Surfaces a "Lex is thinking..." placeholder when status='thinking'.
 *   3. Collapse toggle persists to localStorage and the panel respects
 *      the persisted value on remount.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { TranscriptHistory } from "../components/TranscriptHistory";
import { COLLAPSED_STORAGE_KEY } from "../lib/transcript-collapse";

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("TranscriptHistory - N turns rendering", () => {
  it("renders every turn when count is below the cap", () => {
    render(
      <TranscriptHistory
        turns={[
          { id: "u1", role: "user", text: "hello lex" },
          { id: "a1", role: "assistant", text: "hello back" },
        ]}
        maxTurns={10}
      />,
    );
    const turns = screen.getAllByTestId("lex-turn");
    expect(turns).toHaveLength(2);
    expect(turns[0]).toHaveTextContent("hello lex");
    expect(turns[1]).toHaveTextContent("hello back");
  });

  it("caps the rendered list at maxTurns, keeping the most recent", () => {
    const turns = Array.from({ length: 25 }, (_, i) => ({
      id: `t${i}`,
      role: (i % 2 === 0 ? "user" : "assistant") as "user" | "assistant",
      text: `turn ${i}`,
    }));
    render(<TranscriptHistory turns={turns} maxTurns={5} />);
    const rendered = screen.getAllByTestId("lex-turn");
    expect(rendered).toHaveLength(5);
    expect(rendered[0]).toHaveTextContent("turn 20");
    expect(rendered[4]).toHaveTextContent("turn 24");
  });

  it("preserves role -> label mapping", () => {
    render(
      <TranscriptHistory
        turns={[
          { id: "u", role: "user", text: "user line" },
          { id: "a", role: "assistant", text: "lex line" },
        ]}
      />,
    );
    const [first, second] = screen.getAllByTestId("lex-turn");
    expect(first).toHaveAttribute("data-role", "user");
    expect(first).toHaveTextContent(/you:/);
    expect(second).toHaveAttribute("data-role", "assistant");
    expect(second).toHaveTextContent(/lex:/);
  });

  it("shows an empty-state line when there are no turns and not thinking", () => {
    render(<TranscriptHistory turns={[]} />);
    expect(screen.getByText(/No transcript yet/)).toBeInTheDocument();
  });
});

describe("TranscriptHistory - thinking placeholder", () => {
  it("renders the placeholder when status='thinking'", () => {
    render(<TranscriptHistory turns={[]} status="thinking" />);
    expect(
      screen.getByTestId("lex-thinking-placeholder"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/No transcript yet/)).not.toBeInTheDocument();
  });

  it("does not render the placeholder for non-thinking status", () => {
    render(<TranscriptHistory turns={[]} status="ready" />);
    expect(
      screen.queryByTestId("lex-thinking-placeholder"),
    ).not.toBeInTheDocument();
  });

  it("renders the placeholder below the existing turns", () => {
    render(
      <TranscriptHistory
        turns={[{ id: "u", role: "user", text: "ping" }]}
        status="thinking"
      />,
    );
    const placeholder = screen.getByTestId("lex-thinking-placeholder");
    const turns = screen.getAllByTestId("lex-turn");
    expect(turns).toHaveLength(1);
    expect(placeholder).toBeInTheDocument();
    /* compareDocumentPosition: 4 = follows */
    expect(
      turns[0]!.compareDocumentPosition(placeholder) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

describe("TranscriptHistory - collapse toggle persistence", () => {
  it("hides the body when collapsed and exposes aria-expanded=false", () => {
    render(
      <TranscriptHistory
        turns={[{ id: "u", role: "user", text: "ping" }]}
        initialCollapsed
      />,
    );
    expect(screen.queryByTestId("lex-turn")).not.toBeInTheDocument();
    const toggle = screen.getByRole("button", { name: /expand/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
  });

  it("writes a '1' to localStorage on collapse and clears on expand", () => {
    render(
      <TranscriptHistory
        turns={[{ id: "u", role: "user", text: "ping" }]}
      />,
    );
    const collapseBtn = screen.getByRole("button", { name: /collapse/i });
    fireEvent.click(collapseBtn);
    expect(window.localStorage.getItem(COLLAPSED_STORAGE_KEY)).toBe("1");
    const expandBtn = screen.getByRole("button", { name: /expand/i });
    fireEvent.click(expandBtn);
    expect(window.localStorage.getItem(COLLAPSED_STORAGE_KEY)).toBeNull();
  });

  it("respects a pre-existing collapsed flag in localStorage on mount", () => {
    window.localStorage.setItem(COLLAPSED_STORAGE_KEY, "1");
    render(
      <TranscriptHistory
        turns={[{ id: "u", role: "user", text: "ping" }]}
      />,
    );
    /* After the mount effect runs, the panel reads the storage and
     * collapses. The turn should not be rendered. */
    expect(screen.queryByTestId("lex-turn")).not.toBeInTheDocument();
  });

  it("invokes onPersist with the new state on every toggle", () => {
    const calls: boolean[] = [];
    render(
      <TranscriptHistory
        turns={[{ id: "u", role: "user", text: "ping" }]}
        onPersist={(c) => calls.push(c)}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /collapse/i }));
    fireEvent.click(screen.getByRole("button", { name: /expand/i }));
    expect(calls).toEqual([true, false]);
  });
});
