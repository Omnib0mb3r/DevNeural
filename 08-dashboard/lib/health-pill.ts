/**
 * TopBar system-status pill state.
 *
 * The pill used to fall back to "ok" whenever the health query had no
 * data yet, including when the query had actually errored (daemon
 * unreachable). That painted a green "all systems online" pill over a
 * dead daemon, which is worse than showing nothing: it actively tells
 * the operator the opposite of what is true. Extracted as a pure
 * function so the isError-wins-over-stale-rollup rule is unit-tested
 * directly instead of only reachable by killing a real daemon.
 */

export type Rollup = "ok" | "warn" | "fail";

export interface HealthPillState {
  label: string;
  tone: "ok" | "warn" | "err";
  dotStatus: "ok" | "warn" | "fail";
  pulse: boolean;
}

/**
 * `isError` always wins over `rollup`, even if `rollup` is a stale
 * "ok" left over in the query cache from before the daemon went away:
 * TanStack Query keeps the last successful `data` around during an
 * error, so `health.data?.rollup` alone cannot tell "ok" apart from
 * "haven't heard from the daemon in a while".
 */
export function resolveHealthPill(rollup: Rollup, isError: boolean): HealthPillState {
  if (isError) {
    return { label: "unreachable", tone: "err", dotStatus: "fail", pulse: false };
  }
  if (rollup === "warn") {
    return { label: "degraded", tone: "warn", dotStatus: "warn", pulse: false };
  }
  if (rollup === "fail") {
    return { label: "failure", tone: "err", dotStatus: "fail", pulse: false };
  }
  return { label: "all systems online", tone: "ok", dotStatus: "ok", pulse: true };
}
