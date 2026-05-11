import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/* Wave 3 fixup (bug: 2026-05-10-state-tracker-loses-live-sessions).
 * The IDENTITY_FRESH_MS constant in dashboard/sessions.ts is now read
 * from DEVNEURAL_IDENTITY_FRESH_MS at module load. Resetting modules
 * between cases lets each it() exercise its own env value. */
let prior: string | undefined;

beforeEach(() => {
  prior = process.env.DEVNEURAL_IDENTITY_FRESH_MS;
  vi.resetModules();
});

afterEach(() => {
  if (prior === undefined) delete process.env.DEVNEURAL_IDENTITY_FRESH_MS;
  else process.env.DEVNEURAL_IDENTITY_FRESH_MS = prior;
  vi.resetModules();
});

async function loadConst(): Promise<number> {
  vi.resetModules();
  /* The constant is module-private. Read the source as text and pluck
   * the runtime value out via a thin probe; we are checking that the
   * env override changes the resolved value, not the public API. */
  const mod = (await import('../src/dashboard/sessions.js')) as Record<
    string,
    unknown
  >;
  /* Re-export of the resolved constant. If sessions.ts ever stops
   * exporting it, this test fails fast and the bug-fix commit can be
   * audited. */
  return (mod as { __IDENTITY_FRESH_MS_FOR_TEST?: number })
    .__IDENTITY_FRESH_MS_FOR_TEST as number;
}

describe('DEVNEURAL_IDENTITY_FRESH_MS env override', () => {
  it('falls back to default when unset', async () => {
    delete process.env.DEVNEURAL_IDENTITY_FRESH_MS;
    const v = await loadConst();
    /* Default tightened from 60min -> 2min on 2026-05-11 to kill
     * ghost tiles within two deck heartbeats of VS Code window
     * close (bug: 2026-05-11-ghost-session-tiles). */
    expect(v).toBe(2 * 60 * 1000);
  });

  it('honors an in-range integer (15s)', async () => {
    process.env.DEVNEURAL_IDENTITY_FRESH_MS = '15000';
    const v = await loadConst();
    expect(v).toBe(15000);
  });

  it('rejects values under the floor', async () => {
    process.env.DEVNEURAL_IDENTITY_FRESH_MS = '500';
    const v = await loadConst();
    expect(v).toBe(2 * 60 * 1000);
  });

  it('rejects values over the ceiling (>24h)', async () => {
    process.env.DEVNEURAL_IDENTITY_FRESH_MS = String(48 * 60 * 60 * 1000);
    const v = await loadConst();
    expect(v).toBe(2 * 60 * 1000);
  });

  it('rejects non-numeric input', async () => {
    process.env.DEVNEURAL_IDENTITY_FRESH_MS = 'forever';
    const v = await loadConst();
    expect(v).toBe(2 * 60 * 1000);
  });
});
