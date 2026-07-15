import { describe, it, expect } from "vitest";
import { resolveHealthPill } from "@/lib/health-pill";

describe("resolveHealthPill", () => {
  it("renders unreachable on isError, regardless of a stale ok rollup", () => {
    expect(resolveHealthPill("ok", true)).toEqual({
      label: "unreachable",
      tone: "err",
      dotStatus: "fail",
      pulse: false,
    });
  });

  it("isError wins even over a stale warn or fail rollup", () => {
    expect(resolveHealthPill("warn", true).label).toBe("unreachable");
    expect(resolveHealthPill("fail", true).label).toBe("unreachable");
  });

  it("renders the ok pill when rollup is ok and there is no error", () => {
    expect(resolveHealthPill("ok", false)).toEqual({
      label: "all systems online",
      tone: "ok",
      dotStatus: "ok",
      pulse: true,
    });
  });

  it("renders the warn pill", () => {
    expect(resolveHealthPill("warn", false)).toEqual({
      label: "degraded",
      tone: "warn",
      dotStatus: "warn",
      pulse: false,
    });
  });

  it("renders the fail pill", () => {
    expect(resolveHealthPill("fail", false)).toEqual({
      label: "failure",
      tone: "err",
      dotStatus: "fail",
      pulse: false,
    });
  });
});
