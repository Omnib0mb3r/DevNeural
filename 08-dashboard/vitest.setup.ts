import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

/* next/navigation is not available under jsdom (no Next router runtime).
 * Components that call useRouter / usePathname / useSearchParams (the
 * Lex page + LexSessionList after the SESSIONS-VIEW soft-nav change)
 * would throw on render otherwise. A benign stub is enough for
 * render-only tests; specs that assert navigation can spy on push. */
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    refresh: vi.fn(),
  }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));
