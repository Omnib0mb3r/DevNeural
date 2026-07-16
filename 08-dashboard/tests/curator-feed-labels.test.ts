/**
 * Curator feed + terminal mirror labeling pins (2026-07-16 operator
 * audit: clicking a feed item dropped him into a terminal mirror with
 * no clue what it was, which project it watched, or that it is
 * read-only; the feed also needed a clear-all).
 */
import { describe, expect, it } from "vitest";
import { feedDestinationLabel } from "../components/RightRail";
import { mirrorWatchLabel } from "../components/TerminalMirror";

describe("feedDestinationLabel", () => {
  it("names wiki links, terminal links, and generic links", () => {
    expect(feedDestinationLabel("/wiki?page=abc")).toBe("opens wiki page");
    expect(feedDestinationLabel("/lex")).toBe("opens live terminal");
    expect(feedDestinationLabel("/sessions/detail?session=x")).toBe(
      "opens live terminal",
    );
    expect(feedDestinationLabel("/somewhere")).toBe("opens link");
  });

  it("returns null for non-clickable rows", () => {
    expect(feedDestinationLabel(undefined)).toBeNull();
    expect(feedDestinationLabel("")).toBeNull();
  });
});

describe("mirrorWatchLabel", () => {
  it("names the watched project, short session id, and read-only nature", () => {
    expect(mirrorWatchLabel("devneural", "c765a850-06fb-438a")).toBe(
      "watching devneural · session c765a850 · read-only",
    );
  });

  it("degrades honestly when project or session are unknown", () => {
    expect(mirrorWatchLabel(null, "")).toBe(
      "watching unknown project · session unbound · read-only",
    );
    expect(mirrorWatchLabel("  ", "abc12345")).toBe(
      "watching unknown project · session abc12345 · read-only",
    );
  });
});
