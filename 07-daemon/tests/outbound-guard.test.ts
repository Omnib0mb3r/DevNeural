import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import { OutboundRefused, outboundCall } from '../src/db/outbound-guard.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

let tmpDir: string;
let dbFile: string;
let db: IndexDb;
let priorRoot: string | undefined;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-out-'));
  dbFile = path.join(tmpDir, 'index.db');
  fs.mkdirSync(path.join(tmpDir, 'wiki'), { recursive: true });
  priorRoot = process.env.DEVNEURAL_DATA_ROOT;
  process.env.DEVNEURAL_DATA_ROOT = tmpDir;
  db = new IndexDb(dbFile);
  db.close();
  await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
  db = new IndexDb(dbFile);
});

afterEach(() => {
  db.close();
  if (priorRoot === undefined) delete process.env.DEVNEURAL_DATA_ROOT;
  else process.env.DEVNEURAL_DATA_ROOT = priorRoot;
  delete process.env.DEVNEURAL_OUTBOUND_DAILY_CAP_CALLS;
  delete process.env.DEVNEURAL_OUTBOUND_DAILY_CAP_BYTES;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('outboundCall (PB-2 + BF-4)', () => {
  it('refuses brainstorm-* payload class before any network call', async () => {
    await expect(
      outboundCall(db, {
        destination: 'api.anthropic.com',
        purpose: 'pass2-fallback',
        payloadClass: 'brainstorm-summary',
        payloadBytes: 100,
        containsVoiceSessionSource: false,
        thunk: async () => ({ status: 200 }),
      }),
    ).rejects.toBeInstanceOf(OutboundRefused);
  });

  it('refuses meeting-* payload class', async () => {
    await expect(
      outboundCall(db, {
        destination: 'api.anthropic.com',
        purpose: 'pass2-fallback',
        payloadClass: 'meeting-summary',
        payloadBytes: 100,
        containsVoiceSessionSource: false,
        thunk: async () => ({ status: 200 }),
      }),
    ).rejects.toBeInstanceOf(OutboundRefused);
  });

  it('refuses containsVoiceSessionSource=true regardless of payload class', async () => {
    await expect(
      outboundCall(db, {
        destination: 'api.anthropic.com',
        purpose: 'cross-project-verifier',
        payloadClass: 'wiki-page-candidate',
        payloadBytes: 100,
        containsVoiceSessionSource: true,
        thunk: async () => ({ status: 200 }),
      }),
    ).rejects.toBeInstanceOf(OutboundRefused);
  });

  it('allows non-voice payload and finalizes with response status', async () => {
    let called = false;
    const result = await outboundCall<{ status: number; body: string }>(db, {
      destination: 'api.anthropic.com',
      purpose: 'cross-project-verifier',
      payloadClass: 'wiki-page-candidate',
      payloadBytes: 100,
      containsVoiceSessionSource: false,
      thunk: async () => {
        called = true;
        return { status: 200, body: 'ok' };
      },
    });
    expect(called).toBe(true);
    expect(result.status).toBe(200);
    const usage = db.outboundTodayUsage();
    expect(usage.calls).toBe(1);
    expect(usage.bytes).toBe(100);
  });

  it('respects DEVNEURAL_OUTBOUND_DAILY_CAP_CALLS', async () => {
    process.env.DEVNEURAL_OUTBOUND_DAILY_CAP_CALLS = '2';
    for (let i = 0; i < 2; i++) {
      await outboundCall(db, {
        destination: 'api.anthropic.com',
        purpose: 'pass2-fallback',
        payloadClass: 'pass2-fallback',
        payloadBytes: 10,
        containsVoiceSessionSource: false,
        thunk: async () => ({ status: 200 }),
      });
    }
    await expect(
      outboundCall(db, {
        destination: 'api.anthropic.com',
        purpose: 'pass2-fallback',
        payloadClass: 'pass2-fallback',
        payloadBytes: 10,
        containsVoiceSessionSource: false,
        thunk: async () => ({ status: 200 }),
      }),
    ).rejects.toMatchObject({ failureCode: 'daily-cap-calls' });
  });

  it('respects DEVNEURAL_OUTBOUND_DAILY_CAP_BYTES', async () => {
    process.env.DEVNEURAL_OUTBOUND_DAILY_CAP_BYTES = '500';
    await outboundCall(db, {
      destination: 'api.anthropic.com',
      purpose: 'pass2-fallback',
      payloadClass: 'pass2-fallback',
      payloadBytes: 400,
      containsVoiceSessionSource: false,
      thunk: async () => ({ status: 200 }),
    });
    await expect(
      outboundCall(db, {
        destination: 'api.anthropic.com',
        purpose: 'pass2-fallback',
        payloadClass: 'pass2-fallback',
        payloadBytes: 200,
        containsVoiceSessionSource: false,
        thunk: async () => ({ status: 200 }),
      }),
    ).rejects.toMatchObject({ failureCode: 'daily-cap-bytes' });
  });

  it('records thrown thunk errors in outbound_log', async () => {
    await expect(
      outboundCall(db, {
        destination: 'api.anthropic.com',
        purpose: 'pass2-fallback',
        payloadClass: 'pass2-fallback',
        payloadBytes: 100,
        containsVoiceSessionSource: false,
        thunk: async () => {
          throw new Error('network down');
        },
      }),
    ).rejects.toThrow('network down');
    const usage = db.outboundTodayUsage();
    expect(usage.calls).toBe(1);
  });
});
