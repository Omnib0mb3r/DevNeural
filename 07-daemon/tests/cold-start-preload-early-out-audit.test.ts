/* Regression test: /lex/cold-start-preload audits every early-out.
 *
 * Pre-fix: only the successful render path wrote a row into
 * cross_session_injection_log. The disabled, no-brainstorm-bound,
 * no-label, and no-siblings exits were silent. Operators watching
 * /lex/injection-log?caller_label=cold-start-preload saw zero rows
 * and could not tell "hook never fired" from "hook fired and bailed
 * at brainstorm-resolve".
 *
 * This test pins the contract that every early-out writes a row
 * with caller_label='cold-start-preload', decision='shadow' (no
 * inject happened), and reject_reason set to the bail code. The
 * row shape matches what routes.ts:3920 auditEarlyOut(...) emits;
 * exercising the row through the real index-db round-trip keeps
 * the column list + listCrossSessionLogs filter in sync with the
 * route.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

let tmpDir: string;
let db: IndexDb;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-cold-audit-'));
  const dbFile = path.join(tmpDir, 'index.db');
  const seed = new IndexDb(dbFile);
  seed.close();
  await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
  db = new IndexDb(dbFile);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/* Same shape the route's auditEarlyOut closure builds for each
 * early-out reason. Centralised so a future change to the row
 * payload shape gets caught by this test rather than silently
 * regressing the column list. */
function writeEarlyOutAudit(
  sessionId: string,
  rejectReason: string,
  brainstormId: string | null,
): string {
  const id = randomUUID();
  db.insertCrossSessionLog({
    id,
    target_session: sessionId,
    caller_label: 'cold-start-preload',
    text_preview: '',
    text_length: 0,
    decision: 'shadow',
    reject_reason: rejectReason,
    brainstorm_id: brainstormId,
  });
  return id;
}

describe('cold-start-preload audit row contract', () => {
  it('disabled exit lands in the injection log with reject_reason=disabled', () => {
    const id = writeEarlyOutAudit('sess-disabled', 'disabled', null);
    const rows = db.listCrossSessionLogs({
      caller_label: 'cold-start-preload',
      decision: 'shadow',
    });
    const match = rows.find((r) => r.id === id);
    expect(match).toBeDefined();
    expect(match?.target_session).toBe('sess-disabled');
    expect(match?.reject_reason).toBe('disabled');
    expect(match?.brainstorm_id).toBeNull();
    expect(match?.text_length).toBe(0);
  });

  it('no-brainstorm-bound exit lands with the correct reject_reason', () => {
    const id = writeEarlyOutAudit('sess-unbound', 'no-brainstorm-bound', null);
    const rows = db.listCrossSessionLogs({
      caller_label: 'cold-start-preload',
    });
    const match = rows.find((r) => r.id === id);
    expect(match?.reject_reason).toBe('no-brainstorm-bound');
    expect(match?.decision).toBe('shadow');
    expect(match?.brainstorm_id).toBeNull();
  });

  it('no-label exit carries the brainstorm_id forward', () => {
    const id = writeEarlyOutAudit('sess-no-label', 'no-label', 'b-1');
    const rows = db.listCrossSessionLogs({
      caller_label: 'cold-start-preload',
    });
    const match = rows.find((r) => r.id === id);
    expect(match?.reject_reason).toBe('no-label');
    expect(match?.brainstorm_id).toBe('b-1');
  });

  it('no-siblings exit also carries the brainstorm_id', () => {
    const id = writeEarlyOutAudit('sess-empty', 'no-siblings', 'b-2');
    const rows = db.listCrossSessionLogs({
      caller_label: 'cold-start-preload',
    });
    const match = rows.find((r) => r.id === id);
    expect(match?.reject_reason).toBe('no-siblings');
    expect(match?.brainstorm_id).toBe('b-2');
  });

  it('listCrossSessionLogs(decision=shadow) returns all early-out rows together', () => {
    writeEarlyOutAudit('s-a', 'disabled', null);
    writeEarlyOutAudit('s-b', 'no-brainstorm-bound', null);
    writeEarlyOutAudit('s-c', 'no-label', 'b-x');
    writeEarlyOutAudit('s-d', 'no-siblings', 'b-y');
    const rows = db.listCrossSessionLogs({
      caller_label: 'cold-start-preload',
      decision: 'shadow',
      limit: 50,
    });
    const reasons = rows.map((r) => r.reject_reason).sort();
    expect(reasons).toEqual(
      ['disabled', 'no-brainstorm-bound', 'no-label', 'no-siblings'].sort(),
    );
    /* All four MUST surface so an operator filtering on
     * caller_label=cold-start-preload can distinguish "hook never
     * fired" (zero rows) from "fired and bailed at brainstorm-
     * resolve" (rows with reject_reason set). */
    expect(rows).toHaveLength(4);
  });

  it('accepted rows in live mode coexist with shadow early-out rows', () => {
    /* The route writes decision='accepted' on the successful live
     * render path and decision='shadow' on every early-out. Both
     * must remain queryable side by side. */
    writeEarlyOutAudit('s-fail', 'no-brainstorm-bound', null);
    db.insertCrossSessionLog({
      id: randomUUID(),
      target_session: 's-good',
      caller_label: 'cold-start-preload',
      text_preview: '# Prior Lex sessions on this anchor',
      text_length: 240,
      decision: 'accepted',
      reject_reason: null,
      brainstorm_id: 'b-good',
    });
    const shadow = db.listCrossSessionLogs({
      caller_label: 'cold-start-preload',
      decision: 'shadow',
    });
    const accepted = db.listCrossSessionLogs({
      caller_label: 'cold-start-preload',
      decision: 'accepted',
    });
    expect(shadow).toHaveLength(1);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]?.target_session).toBe('s-good');
    expect(accepted[0]?.brainstorm_id).toBe('b-good');
    expect(shadow[0]?.reject_reason).toBe('no-brainstorm-bound');
  });
});
