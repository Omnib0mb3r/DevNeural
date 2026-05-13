"use client";

/**
 * Top-level auth guard (2026-05-13 Task D).
 *
 * The dashboard is statically exported, so there is no Next
 * middleware enforcing auth on navigation. Until this guard
 * landed, the only gate was the per-request 401 detector inside
 * lib/daemon-client.ts:request(), which redirects to /unlock on
 * any 401 response. That covers the common case (an API call
 * fires, gets 401, page redirects) but leaks in three live failure
 * modes the operator hit on 2026-05-13:
 *
 *   1. A cached static page renders zombie data on cold load and
 *      no API call fires until the operator clicks something, so
 *      /unlock never appears.
 *   2. The daemon restarts mid-session; the page lingers showing
 *      stale data with no indication the session is dead.
 *   3. The cookie expires on a quiet tab and the operator gets
 *      surprise-redirected on the next mutation.
 *
 * Fix: mount this component at app/layout.tsx so every route is
 * protected. On mount and on every visibility / focus event the
 * guard hits GET /auth/status. The endpoint returns `{ pin_set,
 * locked }`; locked=true OR a 401 (caught inside the request
 * helper, which also redirects in-flight) drives an immediate
 * router.replace('/unlock'). A TanStack-Query 30s tick keeps the
 * authority signal fresh.
 *
 * When the daemon flips from locked=false to locked=true mid
 * session (e.g. daemon restart, manual lock, cookie expiry) the
 * guard surfaces a top-of-page yellow stripe with a click target
 * to /unlock so the operator sees the state change without F5.
 *
 * The /unlock and /set-pin routes opt out of the guard so the
 * unlock flow cannot self-loop. Same posture as the existing 401
 * redirect inside request().
 */
import { useEffect } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { authStatus } from "@/lib/daemon-client";

export const AUTH_QKEY = ["auth", "status"] as const;
/* Routes that render without the guard. Keep this list small —
 * anything that needs to display a UI before unlock-completion
 * belongs here. */
const UNGUARDED_PATHS = ["/unlock", "/set-pin"];

function isUnguardedPath(path: string | null): boolean {
  if (!path) return false;
  return UNGUARDED_PATHS.some((p) => path === p || path.startsWith(`${p}/`));
}

interface Props {
  children: React.ReactNode;
}

export function AuthGuard({ children }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const qc = useQueryClient();
  const guarded = !isUnguardedPath(pathname);

  const q = useQuery({
    queryKey: AUTH_QKEY,
    queryFn: authStatus,
    refetchInterval: 30_000,
    /* Skip the query entirely on the unlock / set-pin routes;
     * those pages drive their own auth flow and a parallel
     * 401 from this query would spam redirects. */
    enabled: guarded,
    retry: false,
  });

  /* Redirect on locked=true. Runs on mount, on every refetch,
   * and whenever the pathname changes (guard re-enables after
   * unlock completes and the operator navigates back into a
   * guarded route). */
  useEffect(() => {
    if (!guarded) return;
    if (q.isLoading) return;
    if (q.data?.locked) {
      const here = pathname ?? "/";
      router.replace(`/unlock?from=${encodeURIComponent(here)}`);
    }
  }, [guarded, q.data?.locked, q.isLoading, pathname, router]);

  /* Hard-refresh trigger on visibility + focus. The TanStack
   * pollInterval is 30s; without these listeners a daemon
   * restart could go unnoticed until the next tick. Both events
   * are cheap (single auth/status round-trip). */
  useEffect(() => {
    if (!guarded) return;
    const refetch = () => {
      qc.invalidateQueries({ queryKey: AUTH_QKEY });
    };
    const onVisibility = () => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        refetch();
      }
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibility);
    }
    if (typeof window !== "undefined") {
      window.addEventListener("focus", refetch);
    }
    return () => {
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibility);
      }
      if (typeof window !== "undefined") {
        window.removeEventListener("focus", refetch);
      }
    };
  }, [guarded, qc]);

  /* Session-expired banner. Fires when the guard is enabled, the
   * query has settled, and the daemon reports locked=true. The
   * redirect effect above eventually moves the user to /unlock,
   * but rendering the banner first gives the operator visible
   * confirmation that the state change was detected (vs a silent
   * 401 race during navigation). */
  const showBanner = guarded && q.data?.locked === true;

  return (
    <>
      {showBanner && (
        <div
          data-testid="auth-guard-banner"
          role="alert"
          className="sticky top-0 z-50 bg-warn/15 text-warn ring-1 ring-warn/30 hairline text-xs px-4 py-2 text-center cursor-pointer"
          onClick={() => router.replace("/unlock")}
        >
          Session expired — click to unlock.
        </div>
      )}
      {children}
    </>
  );
}
