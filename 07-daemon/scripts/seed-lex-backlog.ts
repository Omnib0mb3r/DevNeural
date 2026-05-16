/**
 * One-shot seeder for the lex_backlog_items table.
 *
 * Reads the legacy file-CAS queue at c:/tmp/lex-backlog-queue.json
 * (or a custom path via DEVNEURAL_LEX_BACKLOG_PATH) and upserts each
 * entry into the sqlite-backed canonical store introduced by
 * migration 026. Idempotent: re-running the seeder updates existing
 * rows in place rather than failing on the PRIMARY KEY collision.
 *
 * Run via:
 *   cd 07-daemon && npx tsx scripts/seed-lex-backlog.ts
 *
 * Once seeded, the production write path is the REST surface in
 * dashboard/routes.ts -> lex/backlog-store.ts; the legacy JSON file
 * is read-only history at that point.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { IndexDb } from '../src/store/index-db.js';
import type { BacklogItemInsert } from '../src/store/index-db.js';
import { DATA_ROOT } from '../src/paths.js';

interface LegacyEntry {
  id?: string;
  title?: string;
  status?: string;
  priority?: string;
  added_at?: string;
  injected_at?: string;
  done_at?: string;
  commit_shas?: string[];
  resolution?: string;
  notes?: string;
}

const DEFAULT_LEGACY_PATH = 'c:/tmp/lex-backlog-queue.json';

function normaliseStatus(raw: string | undefined): BacklogItemInsert['status'] {
  const s = (raw ?? '').toLowerCase();
  if (s === 'done') return 'done';
  if (s === 'in-flight' || s === 'in_flight') return 'in-flight';
  if (s === 'parked') return 'parked';
  return 'queued';
}

function fallbackAddedAt(entry: LegacyEntry): string {
  /* Legacy queue lacked added_at for some early entries; fall back
   * to injected_at, done_at, or now() in that order so the seeder
   * never inserts a NULL into the NOT NULL column. */
  return (
    entry.added_at ??
    entry.injected_at ??
    entry.done_at ??
    new Date().toISOString()
  );
}

function entryToRow(entry: LegacyEntry): BacklogItemInsert | null {
  if (!entry.id || typeof entry.id !== 'string') return null;
  if (!entry.title || typeof entry.title !== 'string') return null;
  return {
    id: entry.id,
    title: entry.title,
    status: normaliseStatus(entry.status),
    priority: entry.priority ?? 'polish',
    added_at: fallbackAddedAt(entry),
    injected_at: entry.injected_at ?? null,
    done_at: entry.done_at ?? null,
    commit_shas: Array.isArray(entry.commit_shas)
      ? JSON.stringify(entry.commit_shas)
      : null,
    notes: entry.resolution ?? entry.notes ?? null,
  };
}

async function main(): Promise<void> {
  const legacyPath =
    process.env.DEVNEURAL_LEX_BACKLOG_PATH ?? DEFAULT_LEGACY_PATH;
  if (!fs.existsSync(legacyPath)) {
    console.log(`[seed-lex-backlog] legacy file not found at ${legacyPath}; nothing to seed`);
    return;
  }
  const raw = fs.readFileSync(legacyPath, 'utf-8');
  let entries: LegacyEntry[] = [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) entries = parsed as LegacyEntry[];
  } catch (err) {
    console.error(
      `[seed-lex-backlog] failed to parse ${legacyPath}: ${(err as Error).message}`,
    );
    process.exit(1);
  }
  if (entries.length === 0) {
    console.log(`[seed-lex-backlog] ${legacyPath} is empty; nothing to seed`);
    return;
  }
  const dbFile = path.posix.join(DATA_ROOT, 'index.db');
  const db = new IndexDb(dbFile);
  let inserted = 0;
  let skipped = 0;
  for (const entry of entries) {
    const row = entryToRow(entry);
    if (!row) {
      skipped += 1;
      continue;
    }
    try {
      db.upsertBacklogItem(row);
      inserted += 1;
    } catch (err) {
      console.error(
        `[seed-lex-backlog] upsert failed for id=${row.id}: ${(err as Error).message}`,
      );
      skipped += 1;
    }
  }
  db.close();
  console.log(
    `[seed-lex-backlog] upserted ${inserted} entries from ${legacyPath} (${skipped} skipped)`,
  );
}

main().catch((err) => {
  console.error(`[seed-lex-backlog] unhandled: ${(err as Error).stack ?? err}`);
  process.exit(1);
});
