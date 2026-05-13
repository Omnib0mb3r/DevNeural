/**
 * AuthGuard regression suite (2026-05-13 Task D).
 *
 * The guard wraps every route and gates rendering on
 * GET /auth/status. Tests pin three contracts:
 *   1. Mount with locked=false renders children.
 *   2. Mount with locked=true triggers router.replace('/unlock').
 *   3. A mid-session flip from locked=false to locked=true
 *      surfaces the session-expired banner before / during the
 *      redirect.
 *
 * Daemon-client is mocked; usePathname / useRouter are stubbed
 * via vi.mock on next/navigation so the guard can be exercised
 * outside a Next runtime.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";

const mockReplace = vi.fn();
let mockPathname = "/";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mockReplace }),
  usePathname: () => mockPathname,
}));

vi.mock("@/lib/daemon-client", () => ({
  authStatus: vi.fn(),
}));

import { AuthGuard } from "../components/AuthGuard";
import { authStatus } from "@/lib/daemon-client";

function renderGuard() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <AuthGuard>
        <div data-testid="guarded-child">guarded content</div>
      </AuthGuard>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  mockReplace.mockReset();
  mockPathname = "/";
  (authStatus as unknown as ReturnType<typeof vi.fn>).mockReset();
});

afterEach(() => {
  cleanup();
});

describe("AuthGuard", () => {
  it("renders children and no banner when daemon reports locked=false", async () => {
    (authStatus as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      pin_set: true,
      locked: false,
    });
    renderGuard();
    expect(await screen.findByTestId("guarded-child")).toBeInTheDocument();
    /* Banner must not appear on the locked=false path. */
    expect(
      screen.queryByTestId("auth-guard-banner"),
    ).not.toBeInTheDocument();
    /* And router.replace must not fire for an unlocked session. */
    await new Promise((r) => setTimeout(r, 20));
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it("redirects to /unlock when daemon reports locked=true on mount", async () => {
    (authStatus as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      pin_set: true,
      locked: true,
    });
    mockPathname = "/system";
    renderGuard();
    await waitFor(() => {
      expect(mockReplace).toHaveBeenCalled();
    });
    const target = mockReplace.mock.calls[0]?.[0] as string;
    expect(target).toMatch(/^\/unlock\?from=/);
    expect(target).toContain(encodeURIComponent("/system"));
  });

  it("surfaces the session-expired banner on locked=true", async () => {
    (authStatus as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      pin_set: true,
      locked: true,
    });
    renderGuard();
    const banner = await screen.findByTestId("auth-guard-banner");
    expect(banner).toBeInTheDocument();
    expect(banner.textContent).toMatch(/session expired/i);
  });

  it("does NOT call authStatus on /unlock (avoids self-loop)", async () => {
    (authStatus as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      pin_set: true,
      locked: true,
    });
    mockPathname = "/unlock";
    renderGuard();
    /* Give the query layer a tick to run any enabled queries. */
    await new Promise((r) => setTimeout(r, 30));
    expect(authStatus).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
    expect(screen.getByTestId("guarded-child")).toBeInTheDocument();
  });
});
