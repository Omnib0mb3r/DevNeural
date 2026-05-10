/**
 * Minimal versioned migration runner for the DevNeural index DB.
 *
 * Reads `07-daemon/scripts/migrations/*.{sql,ts}` in lexicographic order,
 * applies each inside a transaction if it has not been applied before,
 * and records applied filenames in a `_migrations` table.
 *
 * Designed to coexist with the legacy `IndexDb.migrate()` inline DDL
 * which still creates the original tables on first boot. New Phase Two
 * tables and column additions live as files in the migrations directory.
 *
 * Files:
 *   - `*.sql`: executed via `db.exec()` inside a single BEGIN/COMMIT.
 *   - `*.ts`:  dynamically imported; the module must default-export a
 *     function `(db: Database.Database) => void` that runs synchronously
 *     and is wrapped by the runner in BEGIN/COMMIT.
 *
 * Idempotency: filename is the natural key. Re-running with no new files
 * is a no-op.
 *
 * Wire point: called from `daemon.ts` at boot, after env load and after
 * the legacy `IndexDb` constructor has created its tables, but before
 * HTTP bind. CLI usage: `tsx 07-daemon/src/db/migrate.ts [dbPath] [migrationsDir]`.
 */
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

export interface MigrationRecord {
  filename: string;
  checksum: string;
  applied_at: string;
}

export interface RunMigrationsOptions {
  /** Path to the SQLite file. Default: `<DATA_ROOT>/index.db`. */
  dbPath?: string;
  /** Directory containing migration files. Default: repo `07-daemon/scripts/migrations`. */
  migrationsDir?: string;
  /** If true, log each applied migration to stderr. Default false. */
  verbose?: boolean;
}

export interface RunMigrationsResult {
  applied: string[];
  skipped: string[];
  totalAppliedAfter: number;
}

const DEFAULT_MIGRATIONS_DIR = path.posix.join(
  process.cwd().replace(/\\/g, '/'),
  '07-daemon',
  'scripts',
  'migrations',
);

function ensureMigrationsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename   TEXT PRIMARY KEY,
      checksum   TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
  `);
}

function listMigrationFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql') || f.endsWith('.ts'))
    .filter((f) => !f.endsWith('.down.sql'))
    .filter((f) => !f.endsWith('.test.ts'))
    .sort();
}

function checksum(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

async function applyOne(
  db: Database.Database,
  dir: string,
  filename: string,
): Promise<void> {
  const full = path.posix.join(dir, filename);
  const content = fs.readFileSync(full, 'utf8');
  const sum = checksum(content);

  const exec = db.transaction(() => {
    if (filename.endsWith('.sql')) {
      db.exec(content);
    }
    db.prepare(
      `INSERT INTO _migrations (filename, checksum) VALUES (?, ?)`,
    ).run(filename, sum);
  });

  if (filename.endsWith('.ts')) {
    const url = pathToFileURL(full).href;
    const mod = (await import(url)) as {
      default?: (db: Database.Database) => void;
    };
    if (typeof mod.default !== 'function') {
      throw new Error(
        `migration ${filename}: TS module must default-export (db) => void`,
      );
    }
    const tsExec = db.transaction(() => {
      mod.default!(db);
      db.prepare(
        `INSERT INTO _migrations (filename, checksum) VALUES (?, ?)`,
      ).run(filename, sum);
    });
    tsExec();
    return;
  }

  exec();
}

export async function runMigrations(
  opts: RunMigrationsOptions = {},
): Promise<RunMigrationsResult> {
  const dbPath =
    opts.dbPath ??
    path.posix.join(
      (process.env.DEVNEURAL_DATA_ROOT?.replace(/\\/g, '/') ??
        'C:/dev/data/skill-connections'),
      'index.db',
    );
  const dir = opts.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;
  const verbose = opts.verbose ?? false;

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  try {
    ensureMigrationsTable(db);

    const all = listMigrationFiles(dir);
    const appliedSet = new Set(
      (db.prepare(`SELECT filename FROM _migrations`).all() as {
        filename: string;
      }[]).map((r) => r.filename),
    );

    const applied: string[] = [];
    const skipped: string[] = [];

    for (const filename of all) {
      if (appliedSet.has(filename)) {
        skipped.push(filename);
        continue;
      }
      if (verbose) process.stderr.write(`[migrate] applying ${filename}\n`);
      await applyOne(db, dir, filename);
      applied.push(filename);
    }

    const total = (db.prepare(`SELECT COUNT(*) AS n FROM _migrations`).get() as {
      n: number;
    }).n;

    return { applied, skipped, totalAppliedAfter: total };
  } finally {
    db.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const dbArg = process.argv[2];
  const dirArg = process.argv[3];
  runMigrations({
    dbPath: dbArg,
    migrationsDir: dirArg,
    verbose: true,
  })
    .then((r) => {
      process.stdout.write(
        JSON.stringify(
          {
            applied: r.applied,
            skipped_count: r.skipped.length,
            total_after: r.totalAppliedAfter,
          },
          null,
          2,
        ) + '\n',
      );
      process.exit(0);
    })
    .catch((e) => {
      process.stderr.write(`[migrate] FAILED: ${(e as Error).message}\n`);
      process.exit(1);
    });
}
