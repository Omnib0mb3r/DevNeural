/**
 * CLI for the wiki index/disk reconciler (src/wiki/reconcile-index.ts).
 *
 * Dry-run by default: scans wiki/{pages,pending,archive}/ against
 * wiki_pages_meta, prints every action it WOULD take, and writes
 * nothing. Pass --apply to actually write.
 *
 * Usage:
 *   tsx scripts/reconcile-wiki-index.ts             # dry run
 *   tsx scripts/reconcile-wiki-index.ts --apply      # apply fixes
 *
 * Reads DEVNEURAL_DATA_ROOT the same way the daemon does (src/paths.js,
 * default C:/dev/data/skill-connections). This tool opens its own
 * IndexDb handle directly against <dataRoot>/index.db -- it does not
 * need the embedder or vector store, since it only reconciles the SQL
 * meta table against disk. Every write goes through IndexDb's existing
 * upsertWikiPage/deleteWikiPage methods, each already wrapped in its
 * own short transaction, so this is safe to run against the live data
 * root while the daemon is up (no long-held lock, no schema change).
 *
 * ALWAYS back up wiki/ and index.db before running --apply against a
 * live data root. This script does not take the backup for you.
 */
import * as path from 'node:path';
import { IndexDb } from '../src/store/index-db.js';
import {
  runReconcile,
  type ReconcilePlan,
} from '../src/wiki/reconcile-index.js';
import {
  wikiPagesDir,
  wikiPendingDir,
  wikiArchiveDir,
  wikiRoot,
  DATA_ROOT,
} from '../src/paths.js';

function summarizeByKind(plan: ReconcilePlan): Record<string, number> {
  const byKind: Record<string, number> = {};
  for (const a of plan.actions) byKind[a.kind] = (byKind[a.kind] ?? 0) + 1;
  return byKind;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');

  console.log(`[reconcile-wiki-index] data root: ${DATA_ROOT}`);
  console.log(`[reconcile-wiki-index] mode: ${apply ? 'APPLY' : 'DRY RUN'}`);

  const db = new IndexDb();
  try {
    const dirs = {
      pages: wikiPagesDir(),
      pending: wikiPendingDir(),
      archive: wikiArchiveDir(),
    };
    const quarantineDir = path.posix.join(wikiRoot(), 'quarantine');

    const { disk, plan, applied } = runReconcile({
      db,
      dirs,
      quarantineDir,
      apply,
    });

    console.log(
      `[reconcile-wiki-index] scanned_disk=${plan.scanned_disk} scanned_meta=${plan.scanned_meta} unparseable=${disk.unparseable.length}`,
    );
    console.log(
      '[reconcile-wiki-index] action counts:',
      JSON.stringify(summarizeByKind(plan), null, 2),
    );

    if (plan.actions.length === 0) {
      console.log('[reconcile-wiki-index] no actions; disk and SQL are in sync.');
    } else {
      for (const a of plan.actions) {
        const loc = a.location ? `[${a.location}] ` : '';
        console.log(`  ${loc}${a.kind} ${a.id}: ${a.detail}`);
      }
    }

    if (applied) {
      console.log(
        '[reconcile-wiki-index] apply result:',
        JSON.stringify(applied, null, 2),
      );
    } else {
      console.log(
        '[reconcile-wiki-index] dry run only; pass --apply to write changes.',
      );
    }
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error('[reconcile-wiki-index] fatal:', err);
  process.exit(1);
});
