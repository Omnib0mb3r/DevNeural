/* default_supervision_mode runtime_config key.
 *
 * Pins the contracts:
 *   1. parseSupervisionModeValue tolerates whitespace + any case;
 *      invalid strings return null so the caller can fall back.
 *   2. getDefaultSupervisionMode returns 'event' when the
 *      runtime_config row is absent (operator directive 2026-07-16:
 *      event-driven supervision is the default everywhere; polling
 *      is the legacy opt-in).
 *   3. Setting runtime_config to 'polling'/'off' flips the default.
 *   4. Invalid runtime_config values fall through to the
 *      hard-coded 'event' default (a bad write cannot ever
 *      flip the daemon into an undefined mode).
 *   5. project_session insert without an explicit supervision_mode
 *      honors the runtime default.
 *   6. toAnchorView with no row.supervision_mode renders the
 *      defaultSupervisionMode arg, not a hard-coded literal.
 *
 * Uses tmp DB per test so the production runtime_config row is
 * never touched.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_SUPERVISION_MODE_CONFIG_KEY,
  IndexDb,
  parseSupervisionModeValue,
  type SupervisionMode,
} from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import { toAnchorView } from '../src/dashboard/projects-routes.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

let tmpDir: string;
let db: IndexDb;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-default-mode-'));
  const dbFile = path.join(tmpDir, 'index.db');
  const seed = new IndexDb(dbFile);
  seed.close();
  await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
  db = new IndexDb(dbFile);
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* ignore */
  }
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('parseSupervisionModeValue', () => {
  it('returns the canonical SupervisionMode for valid inputs', () => {
    expect(parseSupervisionModeValue('polling')).toBe('polling');
    expect(parseSupervisionModeValue('event')).toBe('event');
    expect(parseSupervisionModeValue('off')).toBe('off');
  });

  it('tolerates whitespace + any case', () => {
    expect(parseSupervisionModeValue('  EVENT  ')).toBe('event');
    expect(parseSupervisionModeValue('Polling')).toBe('polling');
    expect(parseSupervisionModeValue('OFF\n')).toBe('off');
  });

  it('returns null for null / empty / unknown strings', () => {
    expect(parseSupervisionModeValue(null)).toBeNull();
    expect(parseSupervisionModeValue('')).toBeNull();
    expect(parseSupervisionModeValue('   ')).toBeNull();
    expect(parseSupervisionModeValue('garbage')).toBeNull();
    expect(parseSupervisionModeValue('events')).toBeNull();
  });
});

describe('IndexDb.getDefaultSupervisionMode', () => {
  it('defaults to event when the runtime_config row is absent (2026-07-16 operator directive)', () => {
    expect(db.getDefaultSupervisionMode()).toBe('event');
  });

  it('returns the runtime_config value when set to polling', () => {
    db.setRuntimeConfig(DEFAULT_SUPERVISION_MODE_CONFIG_KEY, 'polling', 'test');
    expect(db.getDefaultSupervisionMode()).toBe('polling');
  });

  it('returns the runtime_config value when set to off', () => {
    db.setRuntimeConfig(DEFAULT_SUPERVISION_MODE_CONFIG_KEY, 'off', 'test');
    expect(db.getDefaultSupervisionMode()).toBe('off');
  });

  it('falls back to event for unparseable runtime_config values', () => {
    db.setRuntimeConfig(DEFAULT_SUPERVISION_MODE_CONFIG_KEY, 'garbage', 'test');
    expect(db.getDefaultSupervisionMode()).toBe('event');
  });

  it('tolerates whitespace + uppercase in the stored value', () => {
    db.setRuntimeConfig(DEFAULT_SUPERVISION_MODE_CONFIG_KEY, '  EVENT  ', 'test');
    expect(db.getDefaultSupervisionMode()).toBe('event');
  });
});

describe('insertProjectSession default', () => {
  it('uses the runtime default when supervision_mode is omitted', () => {
    db.setRuntimeConfig(DEFAULT_SUPERVISION_MODE_CONFIG_KEY, 'event', 'test');
    const id = 'test-anchor-event';
    db.insertProjectSession({
      id,
      project_slug: 'devneural',
      cwd: `c:/tmp/test-${Math.random().toString(36).slice(2, 10)}`,
      title: null,
      status: 'dormant',
      current_session_id: null,
      current_bridge_id: null,
      current_pty_id: null,
      created_ms: Date.now(),
      last_seen_ms: Date.now(),
    } as unknown as Parameters<typeof db.insertProjectSession>[0]);
    const row = db.getProjectSession(id);
    expect(row?.supervision_mode).toBe('event');
  });

  it('falls back to event when the runtime row is unset', () => {
    const id = 'test-anchor-default';
    db.insertProjectSession({
      id,
      project_slug: 'devneural',
      cwd: `c:/tmp/test-${Math.random().toString(36).slice(2, 10)}`,
      title: null,
      status: 'dormant',
      current_session_id: null,
      current_bridge_id: null,
      current_pty_id: null,
      created_ms: Date.now(),
      last_seen_ms: Date.now(),
    } as unknown as Parameters<typeof db.insertProjectSession>[0]);
    const row = db.getProjectSession(id);
    expect(row?.supervision_mode).toBe('event');
  });

  it('still honours an explicit supervision_mode in the insert', () => {
    db.setRuntimeConfig(DEFAULT_SUPERVISION_MODE_CONFIG_KEY, 'event', 'test');
    const id = 'test-anchor-explicit';
    db.insertProjectSession({
      id,
      project_slug: 'devneural',
      cwd: `c:/tmp/test-${Math.random().toString(36).slice(2, 10)}`,
      title: null,
      status: 'dormant',
      current_session_id: null,
      current_bridge_id: null,
      current_pty_id: null,
      created_ms: Date.now(),
      last_seen_ms: Date.now(),
      supervision_mode: 'off' as SupervisionMode,
    } as unknown as Parameters<typeof db.insertProjectSession>[0]);
    const row = db.getProjectSession(id);
    expect(row?.supervision_mode).toBe('off');
  });
});

describe('toAnchorView default', () => {
  it('renders the supplied default when the row has no supervision_mode', () => {
    const row = {
      id: 'a',
      project_slug: 'p',
      cwd: `c:/tmp/test-${Math.random().toString(36).slice(2, 10)}`,
      title: null,
      status: 'dormant' as const,
      current_session_id: null,
      current_bridge_id: null,
      current_pty_id: null,
      created_ms: 0,
      last_seen_ms: 0,
      supervision_mode: null,
    };
    const v1 = toAnchorView(
      row as unknown as Parameters<typeof toAnchorView>[0],
    );
    expect(v1.supervision_mode).toBe('event');
    const v2 = toAnchorView(
      row as unknown as Parameters<typeof toAnchorView>[0],
      'polling',
    );
    expect(v2.supervision_mode).toBe('polling');
  });
});
