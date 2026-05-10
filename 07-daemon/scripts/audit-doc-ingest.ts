/**
 * CLI bootstrap for `npm run audit-doc-ingest`. Mostly intended as a
 * one-shot manual trigger; the daemon will run this on a daily
 * schedule once the scheduler grows an audit-doc-ingest entry.
 */
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store/index.js';

async function main(): Promise<void> {
  const log = (m: string) => console.log(m);
  const { runAuditDocIngest } = await import('../src/wiki/audit-doc-ingest.js');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(here, '..', '..').replace(/\\/g, '/');
  const store = await Store.open(log);
  try {
    const r = await runAuditDocIngest(store, repoRoot, log);
    console.log(JSON.stringify(r, null, 2));
  } finally {
    await store.close();
  }
}

main().catch((err) => {
  console.error('[audit-doc-ingest] fatal:', err);
  process.exit(1);
});
