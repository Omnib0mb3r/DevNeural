/**
 * Smart-clear trigger + config (DRIVE-QUEUE 4 piece A). Pins the early
 * threshold / ceiling verdict and the settings-adjustable config (mode,
 * threshold, ceiling) round-tripping through runtime_config.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import {
  evaluateSmartClearTrigger,
  smartClearConfig,
  parseSmartClearMode,
  SMART_CLEAR_MODE_KEY,
  SMART_CLEAR_THRESHOLD_KEY,
  SMART_CLEAR_CEILING_KEY,
  DEFAULT_THRESHOLD_PCT,
  DEFAULT_CEILING_PCT,
} from '../src/lex/smart-clear.js';

describe('evaluateSmartClearTrigger', () => {
  const base = { thresholdPct: 40, ceilingPct: 60 };

  it('idle below the threshold', () => {
    const r = evaluateSmartClearTrigger({ ctxPct: 25, ...base });
    expect(r.stage).toBe('idle');
    expect(r.windDown).toBe(false);
    expect(r.forceStop).toBe(false);
  });

  it('winds down at/over the early threshold', () => {
    const r = evaluateSmartClearTrigger({ ctxPct: 40, ...base });
    expect(r.stage).toBe('wind-down');
    expect(r.windDown).toBe(true);
    expect(r.forceStop).toBe(false);
  });

  it('force-stops at/over the ceiling', () => {
    const r = evaluateSmartClearTrigger({ ctxPct: 62, ...base });
    expect(r.stage).toBe('force-stop');
    expect(r.windDown).toBe(true);
    expect(r.forceStop).toBe(true);
  });

  it('idle when ctx is unknown', () => {
    expect(evaluateSmartClearTrigger({ ctxPct: null, ...base }).stage).toBe('idle');
  });

  it('parseSmartClearMode normalizes spellings', () => {
    expect(parseSmartClearMode('LIVE')).toBe('live');
    expect(parseSmartClearMode('1')).toBe('live');
    expect(parseSmartClearMode('off')).toBe('off');
    expect(parseSmartClearMode('shadow')).toBe('shadow');
    expect(parseSmartClearMode('nonsense')).toBeNull();
  });
});

describe('smartClearConfig (settings)', () => {
  let tmpDir: string;
  let db: IndexDb;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-sclear-'));
    const dbFile = path.join(tmpDir, 'index.db');
    const seed = new IndexDb(dbFile);
    seed.close();
    const HERE = path.dirname(fileURLToPath(import.meta.url));
    await runMigrations({
      dbPath: dbFile,
      migrationsDir: path.resolve(HERE, '..', 'scripts', 'migrations'),
    });
    db = new IndexDb(dbFile);
  });
  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('defaults to off / 40 / 60', () => {
    const cfg = smartClearConfig(db);
    expect(cfg.mode).toBe('off');
    expect(cfg.thresholdPct).toBe(DEFAULT_THRESHOLD_PCT);
    expect(cfg.ceilingPct).toBe(DEFAULT_CEILING_PCT);
  });

  it('reads adjusted values from runtime_config', () => {
    db.setRuntimeConfig(SMART_CLEAR_MODE_KEY, 'live');
    db.setRuntimeConfig(SMART_CLEAR_THRESHOLD_KEY, '35');
    db.setRuntimeConfig(SMART_CLEAR_CEILING_KEY, '55');
    const cfg = smartClearConfig(db);
    expect(cfg.mode).toBe('live');
    expect(cfg.thresholdPct).toBe(35);
    expect(cfg.ceilingPct).toBe(55);
  });

  it('forces the ceiling above the threshold when a bad config inverts them', () => {
    db.setRuntimeConfig(SMART_CLEAR_THRESHOLD_KEY, '50');
    db.setRuntimeConfig(SMART_CLEAR_CEILING_KEY, '40'); // below threshold
    const cfg = smartClearConfig(db);
    expect(cfg.ceilingPct).toBeGreaterThan(cfg.thresholdPct);
  });
});
