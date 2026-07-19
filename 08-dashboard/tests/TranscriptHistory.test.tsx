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

describe("TranscriptHistory - three-way layer labels", () => {
  it("labels operator and voice (top) as the two-party conversation", () => {
    render(
      <TranscriptHistory
        turns={[
          { id: "o", role: "user", layer: "operator", text: "start the build" },
          { id: "t", role: "assistant", layer: "top", text: "on it, handing to Lex" },
          { id: "m", role: "assistant", layer: "mid", text: "build kicked off" },
        ]}
      />,
    );
    const turns = screen.getAllByTestId("lex-turn");
    /* P4: only operator + voice are conversation rows; the deep (mid)
     * turn is NOT a top-level bubble. */
    expect(turns).toHaveLength(2);
    expect(turns[0]).toHaveAttribute("data-layer", "operator");
    expect(turns[0]).toHaveTextContent(/you:/);
    expect(turns[1]).toHaveAttribute("data-layer", "top");
    expect(turns[1]).toHaveTextContent(/voice/i);
  });

  it("brain (mid) replies do not consume conversation slots in the last-N window", () => {
    const turns = [
      { id: "o", role: "user" as const, layer: "operator" as const, text: "the real question" },
      { id: "t", role: "assistant" as const, layer: "top" as const, text: "voice answer" },
      /* A burst of brain replies (like a long investigation). These fold
       * under the voice line and must NOT evict the you <-> voice pair from
       * the last-N window. Regression for the "brain replies eat the slots"
       * bug: slicing raw turns before grouping dropped the conversation. */
      ...Array.from({ length: 12 }, (_, i) => ({
        id: `m${i}`,
        role: "assistant" as const,
        layer: "mid" as const,
        text: `brain step ${i}`,
      })),
    ];
    render(<TranscriptHistory turns={turns} maxTurns={5} />);
    const rows = screen.getAllByTestId("lex-turn");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent(/you:/);
    expect(rows[1]).toHaveTextContent(/voice/i);
  });

  it("falls back to role labels when no layer is set (back-compat)", () => {
    render(
      <TranscriptHistory
        turns={[
          { id: "u", role: "user", text: "hi" },
          { id: "a", role: "assistant", text: "hello" },
        ]}
      />,
    );
    const [u, a] = screen.getAllByTestId("lex-turn");
    expect(u).toHaveTextContent(/you:/);
    expect(u).not.toHaveAttribute("data-layer");
    expect(a).toHaveTextContent(/lex:/);
  });
});

describe("TranscriptHistory - P4 deep collapse", () => {
  const exchange = [
    { id: "o", role: "user" as const, layer: "operator" as const, text: "start the build" },
    { id: "t", role: "assistant" as const, layer: "top" as const, text: "on it, handing to Lex" },
    { id: "m", role: "assistant" as const, layer: "mid" as const, text: "build kicked off, running now" },
  ];

  it("collapses the deep reply under the voice line by default (no content shown)", () => {
    render(<TranscriptHistory turns={exchange} />);
    /* Deep is a thin collapsed step-down node, not a bubble. */
    const toggle = screen.getByTestId("lex-deep-toggle");
    expect(toggle).toHaveTextContent(/brain replied/i);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    /* The deep TEXT is not rendered anywhere until expanded. */
    expect(screen.queryByText(/build kicked off/)).not.toBeInTheDocument();
  });

  it("never renders the deep reply as an operator-addressed bubble", () => {
    render(<TranscriptHistory turns={exchange} />);
    const turns = screen.getAllByTestId("lex-turn");
    expect(turns).toHaveLength(2);
    for (const t of turns) {
      expect(t).not.toHaveAttribute("data-layer", "mid");
      expect(t).not.toHaveTextContent(/build kicked off/);
    }
  });

  it("reveals the deep text on expand and hides it again on collapse", () => {
    render(<TranscriptHistory turns={exchange} />);
    const toggle = screen.getByTestId("lex-deep-toggle");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("lex-deep-body")).toHaveTextContent(
      /build kicked off, running now/,
    );
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("lex-deep-body")).not.toBeInTheDocument();
  });

  it("shows no deep node for a conversational (top-only) turn", () => {
    render(
      <TranscriptHistory
        turns={[
          { id: "o", role: "user", layer: "operator", text: "good morning" },
          { id: "t", role: "assistant", layer: "top", text: "morning boss" },
        ]}
      />,
    );
    expect(screen.queryByTestId("lex-deep-toggle")).not.toBeInTheDocument();
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
