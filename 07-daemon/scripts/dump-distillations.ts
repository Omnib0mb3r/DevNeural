/**
 * Distillation dump-to-markdown helper (Fix 60).
 *
 * Walks recent brainstorm distillations from index.db and writes a
 * single markdown file the operator can scan without standing up the
 * dashboard. Usage:
 *
 *   npm run dump-distillations -- --limit 20 --out C:/tmp/distillations-2026-06-01.md
 *
 * Defaults: latest 20 distillations, output to
 * C:/tmp/distillations-<YYYY-MM-DD>.md.
 *
 * Read-only against the live DB. Honours DEVNEURAL_DATA_ROOT for the
 * canonical sqlite path.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

interface BrainstormRow {
  id: string;
  user_label: string | null;
  derived_label: string | null;
  status: string;
  last_summary: string | null;
  last_summary_ms: number | null;
  ended_ms: number | null;
}

function fmtTimestamp(ms: number | null): string {
  if (!ms) return 'unknown';
  try {
    return new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  } catch {
    return String(ms);
  }
}

function todayDateString(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let limit = 20;
  let outPath = '';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = args[i + 1] ?? '';
    if (a === '--limit') {
      limit = Math.max(1, Math.floor(Number(next) || 20));
      i++;
    } else if (a === '--out') {
      outPath = next;
      i++;
    }
  }
  if (!outPath) {
    outPath = `C:/tmp/distillations-${todayDateString()}.md`;
  }

  const dataRoot = (process.env.DEVNEURAL_DATA_ROOT ?? 'C:/dev/data/skill-connections')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
  const dbFile = `${dataRoot}/index.db`;
  if (!fs.existsSync(dbFile)) {
    console.error(`dump-distillations: db not found at ${dbFile}`);
    process.exit(2);
  }

  const { default: Database } = await import('better-sqlite3');
  const db = new Database(dbFile, { readonly: true });
  const rows = db
    .prepare(
      `SELECT id, user_label, derived_label, status, last_summary,
              last_summary_ms, ended_ms
         FROM brainstorm_sessions
         WHERE last_summary IS NOT NULL AND length(trim(last_summary)) > 0
         ORDER BY last_summary_ms DESC
         LIMIT ?`,
    )
    .all(limit) as BrainstormRow[];
  db.close();

  const outDir = path.dirname(outPath);
  if (outDir && !fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  const lines: string[] = [];
  lines.push(`# Distillations dump`);
  lines.push('');
  lines.push(`Generated ${new Date().toISOString()}`);
  lines.push(`Source: ${dbFile}`);
  lines.push(`Limit: ${limit}; ${rows.length} row${rows.length === 1 ? '' : 's'} surfaced.`);
  lines.push('');
  if (rows.length === 0) {
    lines.push('_No distillations found. Either the daemon has not run a backfill tick yet or every row was filtered out by the non-empty-summary guard._');
  }
  for (const r of rows) {
    const label = (r.user_label ?? r.derived_label ?? '(unlabeled)').trim() || '(unlabeled)';
    lines.push(`## ${label}`);
    lines.push('');
    lines.push(`- id: ${r.id}`);
    lines.push(`- status: ${r.status}`);
    lines.push(`- ended_ms: ${fmtTimestamp(r.ended_ms)}`);
    lines.push(`- last_summary_ms: ${fmtTimestamp(r.last_summary_ms)}`);
    lines.push('');
    lines.push((r.last_summary ?? '').trim());
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  fs.writeFileSync(outPath, lines.join('\n'), 'utf-8');
  console.log(`dump-distillations: wrote ${rows.length} row${rows.length === 1 ? '' : 's'} to ${outPath}`);
}

void main();
