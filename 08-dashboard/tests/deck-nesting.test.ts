/**
 * Stream Deck worker-under-brainstorm nesting (BUG-001).
 *
 * The deck nests a supervised worker under its brainstorm by matching
 * the tile's supervised_worker_session_id against the session groups —
 * NOT by slug. The tile-side project_slug is a short name ("DevNeural")
 * while the session-side group slug is the mangled ~/.claude/projects
 * dir ("c--dev-Projects-DevNeural"); those two formats never string-
 * match, which is exactly the bug. These pins lock the session-id match
 * so a slug-format drift can never silently un-nest the worker again.
 */
import { describe, expect, it } from "vitest";
import { supervisedGroupFor, isGroupSupervised } from "../lib/deck-nesting";

const group = {
  // session-side slug: the real CC projects dir, a DIFFERENT format
  // from the tile-side short project_slug.
  slug: "c--dev-Projects-DevNeural",
  sessions: [{ session_id: "worker-2994e119" }, { session_id: "worker-other" }],
};
const otherGroup = {
  slug: "c--dev-Projects-bridger-base-camp",
  sessions: [{ session_id: "worker-bridger" }],
};

describe("supervisedGroupFor", () => {
  it("nests by session id even though the slugs differ (the BUG-001 case)", () => {
    const tile = {
      supervised_project_slug: "DevNeural", // short name, never === group.slug
      supervised_worker_session_id: "worker-2994e119",
    };
    expect(supervisedGroupFor(tile, [group, otherGroup])).toBe(group);
  });

  it("returns undefined when the tile has no resolved worker session", () => {
    const tile = {
      supervised_project_slug: "DevNeural",
      supervised_worker_session_id: null,
    };
    expect(supervisedGroupFor(tile, [group, otherGroup])).toBeUndefined();
  });

  it("returns undefined when no group contains the worker session", () => {
    const tile = {
      supervised_project_slug: "DevNeural",
      supervised_worker_session_id: "worker-missing",
    };
    expect(supervisedGroupFor(tile, [group, otherGroup])).toBeUndefined();
  });

  it("picks the group that actually contains the id among many", () => {
    const tile = {
      supervised_project_slug: null,
      supervised_worker_session_id: "worker-bridger",
    };
    expect(supervisedGroupFor(tile, [group, otherGroup])).toBe(otherGroup);
  });
});

describe("isGroupSupervised", () => {
  it("true when a tile supervises a session in the group", () => {
    const tiles = [
      { supervised_project_slug: "DevNeural", supervised_worker_session_id: "worker-2994e119" },
    ];
    expect(isGroupSupervised(group, tiles)).toBe(true);
  });

  it("false (orphan) when no tile supervises any session in the group", () => {
    const tiles = [
      { supervised_project_slug: "bridger", supervised_worker_session_id: "worker-bridger" },
    ];
    expect(isGroupSupervised(group, tiles)).toBe(false);
  });

  it("a null supervised_worker_session_id never marks a group supervised", () => {
    const tiles = [
      { supervised_project_slug: "DevNeural", supervised_worker_session_id: null },
    ];
    expect(isGroupSupervised(group, tiles)).toBe(false);
  });
});
