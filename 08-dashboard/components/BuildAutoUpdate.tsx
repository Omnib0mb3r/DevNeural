"use client";

import { useEffect } from "react";

/**
 * Build auto-update.
 *
 * iOS standalone (home-screen PWA) and long-lived tabs keep an old JS
 * bundle alive in memory, and a manual refresh does not reliably
 * re-fetch it. The result: a shipped fix can look broken for hours
 * because the client is still running yesterday's code against today's
 * server. This polls a deploy-stamped version marker and, when it
 * changes while the page is open, reloads once to pull the new bundle.
 *
 * The first version seen at mount is the baseline; after the reload the
 * fresh page re-seeds that baseline to the new value, so there is no
 * reload loop. version.json is written by scripts/postbuild-sw-version.mjs
 * on every build and served statically from out/.
 */
const POLL_MS = 60_000;

export function BuildAutoUpdate(): null {
  useEffect(() => {
    if (typeof window === "undefined") return;
    let baseline: string | null = null;
    let cancelled = false;

    async function check(): Promise<void> {
      try {
        const res = await fetch("/version.json", { cache: "no-store" });
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { v?: string };
        const v = typeof data.v === "string" ? data.v : null;
        if (!v || cancelled) return;
        if (baseline === null) {
          baseline = v;
          return;
        }
        if (v !== baseline) {
          /* A newer build shipped while this page was open. Pull it. */
          window.location.reload();
        }
      } catch {
        /* offline, or dev with no version.json — ignore and retry later */
      }
    }

    void check();
    const id = window.setInterval(check, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);
  return null;
}
