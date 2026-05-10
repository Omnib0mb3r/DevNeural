/**
 * CLI bootstrap for `npm run backfill-brainstorms`.
 *
 * Opens the live Store, runs the backfill, prints a one-line summary,
 * and exits. Safe to run while the daemon is up only when no other
 * write path is active (vector store is single-writer); the daemon's
 * own startup will run wiki vector flushes on next boot if anything
 * is left dirty.
 */
import { Store } from '../src/store/index.js';

async function main(): Promise<void> {
  const log = (m: string) => console.log(m);
  const { runBackfillBrainstorms } = await import('../src/wiki/backfill-brainstorms.js');
  const store = await Store.open(log);
  try {
    const r = await runBackfillBrainstorms(store, log);
    console.log(JSON.stringify(r, null, 2));
  } finally {
    await store.close();
  }
}

main().catch((err) => {
  console.error('[backfill-brainstorms] fatal:', err);
  process.exit(1);
});
