/**
 * Cold-start preload toggle runtime-config persistence.
 *
 * Mirrors the smart-compact three-state runtime toggle test block so
 * the dashboard's Lex Cold Start Preload selector has the same pin
 * on its consumer chain: a runtime_config write through
 * setRuntimeConfig must be the value coldStartPreloadMode returns on
 * the next read. The user reported the toggle "did nothing on click";
 * the round-trip click → daemon-client POST → route → setRuntimeConfig
 * → consumer read needs a regression test so a future change to
 * either side cannot quietly revert to the old hardcoded-default
 * shape.
 *
 * The /lex/cold-start-preload POST consumer reads runtime_config
 * through coldStartPreloadMode(store.db) at routes.ts:3850; this test
 * exercises that same function against an in-memory IndexDb.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import {
  COLD_START_PRELOAD_CONFIG_KEY,
  coldStartPreloadMode,
  parseColdStartPreloadValue,
} from '../src/dashboard/routes.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

let tmpDir: string;
let db: IndexDb;
let priorEnv: string | undefined;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-cold-start-'));
  const dbFile = path.join(tmpDir, 'index.db');
  const idx = new IndexDb(dbFile);
  idx.close();
  await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
  db = new IndexDb(dbFile);
  priorEnv = process.env.DEVNEURAL_LEX_COLD_START_PRELOAD_ENABLED;
  delete process.env.DEVNEURAL_LEX_COLD_START_PRELOAD_ENABLED;
});

afterEach(() => {
  db.close();
  if (priorEnv === undefined) {
    delete process.env.DEVNEURAL_LEX_COLD_START_PRELOAD_ENABLED;
  } else {
    process.env.DEVNEURAL_LEX_COLD_START_PRELOAD_ENABLED = priorEnv;
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('parseColdStartPreloadValue', () => {
  it('maps the three canonical spellings', () => {
    expect(parseColdStartPreloadValue('off')).toBe('off');
    expect(parseColdStartPreloadValue('shadow')).toBe('shadow');
    expect(parseColdStartPreloadValue('live')).toBe('live');
  });

  it('maps legacy truthy spellings to live', () => {
    expect(parseColdStartPreloadValue('on')).toBe('live');
    expect(parseColdStartPreloadValue('true')).toBe('live');
    expect(parseColdStartPreloadValue('1')).toBe('live');
  });

  it('maps legacy falsey spellings to off', () => {
    expect(parseColdStartPreloadValue('false')).toBe('off');
    expect(parseColdStartPreloadValue('0')).toBe('off');
  });

  it('returns null on unrecognised input so callers can fall through', () => {
    expect(parseColdStartPreloadValue('garbage')).toBeNull();
    expect(parseColdStartPreloadValue('')).toBeNull();
    expect(parseColdStartPreloadValue(undefined)).toBeNull();
    expect(parseColdStartPreloadValue(null)).toBeNull();
  });
});

describe('coldStartPreloadMode resolution order', () => {
  it('defaults to shadow when both runtime_config and env are unset', () => {
    expect(coldStartPreloadMode(db)).toBe('shadow');
  });

  it('runtime_config wins over env', () => {
    process.env.DEVNEURAL_LEX_COLD_START_PRELOAD_ENABLED = 'off';
    db.setRuntimeConfig(COLD_START_PRELOAD_CONFIG_KEY, 'live', 'test');
    expect(coldStartPreloadMode(db)).toBe('live');
  });

  it('env fills in when runtime_config is unset', () => {
    process.env.DEVNEURAL_LEX_COLD_START_PRELOAD_ENABLED = 'live';
    expect(coldStartPreloadMode(db)).toBe('live');
  });

  it('a runtime_config write observably flips the consumer-visible mode (toggle regression pin)', () => {
    /* This is the regression that the user reported: the dashboard
     * toggle appeared to do nothing. With the POST body fix in place
     * (ad7291b), a click should land as a setRuntimeConfig write,
     * and the next coldStartPreloadMode read MUST return the new
     * value. Anything that re-introduces a hardcoded default would
     * fail this test. */
    expect(coldStartPreloadMode(db)).toBe('shadow');
    db.setRuntimeConfig(COLD_START_PRELOAD_CONFIG_KEY, 'live', 'dashboard');
    expect(coldStartPreloadMode(db)).toBe('live');
    db.setRuntimeConfig(COLD_START_PRELOAD_CONFIG_KEY, 'off', 'dashboard');
    expect(coldStartPreloadMode(db)).toBe('off');
    db.setRuntimeConfig(COLD_START_PRELOAD_CONFIG_KEY, 'shadow', 'dashboard');
    expect(coldStartPreloadMode(db)).toBe('shadow');
  });
});
