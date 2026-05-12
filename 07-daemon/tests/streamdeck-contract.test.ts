/**
 * StreamDeck.App contract surface tests
 * (STREAMDECK-DEVNEURAL-ALIGNMENT.md "Risk and rollback").
 *
 * Locks the shapes of the four filesystem artifacts the deck tray app
 * either produces or consumes:
 *   1. workspace-inject markers (DevNeural writes, deck consumes)
 *   2. virtual-input writes (DevNeural writes, deck consumes)
 *   3. streamdeck liveness (deck writes .heartbeat/app.log, daemon reads)
 *   4. identity files (deck writes, daemon reads for editor-detection)
 *
 * If the deck-app refactor drifts away from these shapes, these tests
 * fail loudly. Paths are resolved via DEVNEURAL_DATA_ROOT +
 * LOCALAPPDATA so the test runs against a tmp tree, not the user's
 * real %LOCALAPPDATA%\stream-deck.
 *
 * vi.hoisted runs before module imports so the path constants in
 * sessions.ts and projects-new.ts that close over DATA_ROOT /
 * LOCALAPPDATA see the tmp paths from the very first evaluation.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const env = vi.hoisted(() => {
  const realFs = require('node:fs') as typeof import('node:fs');
  const realPath = require('node:path') as typeof import('node:path');
  const realOs = require('node:os') as typeof import('node:os');
  const tmpRoot = realFs.mkdtempSync(
    realPath.join(realOs.tmpdir(), 'devneural-streamdeck-'),
  );
  const localAppData = realPath.join(tmpRoot, 'LocalAppData');
  realFs.mkdirSync(localAppData, { recursive: true });
  process.env.DEVNEURAL_DATA_ROOT = tmpRoot.replace(/\\/g, '/');
  process.env.LOCALAPPDATA = localAppData.replace(/\\/g, '/');
  return { tmpRoot, localAppData };
});

const { queueProjectBootstrap } = await import(
  '../src/dashboard/projects-new.js'
);
const {
  queueSessionFocus,
  queueSessionKey,
  readIdentityFileWindowMap,
} = await import('../src/dashboard/sessions.js');

const WORKSPACE_INJECT_DIR = path.posix.join(
  env.tmpRoot.replace(/\\/g, '/'),
  'session-bridge',
  '.workspace-inject',
);
const STREAMDECK_BASE = path.posix.join(
  env.localAppData.replace(/\\/g, '/'),
  'stream-deck',
);
const VIRTUAL_INPUT_DIR = path.posix.join(STREAMDECK_BASE, 'virtual-input');
const IDENTITY_DIR = path.posix.join(STREAMDECK_BASE, 'identity');
const HEARTBEAT_FILE = path.posix.join(STREAMDECK_BASE, '.heartbeat');
const LOG_FILE = path.posix.join(STREAMDECK_BASE, 'app.log');

function rmIfExists(p: string): void {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

beforeEach(() => {
  /* Each test gets a fresh tray-app surface. */
  fs.mkdirSync(STREAMDECK_BASE, { recursive: true });
  /* Tray must look alive for writeVirtualInput to accept writes. */
  fs.writeFileSync(HEARTBEAT_FILE, String(Date.now()), 'utf-8');
});

afterEach(() => {
  rmIfExists(WORKSPACE_INJECT_DIR);
  rmIfExists(VIRTUAL_INPUT_DIR);
  rmIfExists(IDENTITY_DIR);
  rmIfExists(HEARTBEAT_FILE);
  rmIfExists(LOG_FILE);
});

afterAll(() => {
  rmIfExists(env.tmpRoot);
});

describe('workspace-inject marker contract (queueProjectBootstrap)', () => {
  it('writes a single .json marker at <dataRoot>/session-bridge/.workspace-inject/', () => {
    queueProjectBootstrap('C:/dev/Projects/contract-test', 'claude');
    const entries = fs.readdirSync(WORKSPACE_INJECT_DIR);
    const jsonFiles = entries.filter((e) => e.endsWith('.json'));
    expect(jsonFiles.length).toBe(1);
    /* Atomic rename should leave no .tmp residue. */
    expect(entries.find((e) => e.endsWith('.tmp'))).toBeUndefined();
  });

  it('marker payload carries the exact fields the deck/bridge expect', () => {
    queueProjectBootstrap('C:/dev/Projects/contract-test', 'claude');
    const [file] = fs
      .readdirSync(WORKSPACE_INJECT_DIR)
      .filter((e) => e.endsWith('.json'));
    const parsed = JSON.parse(
      fs.readFileSync(path.posix.join(WORKSPACE_INJECT_DIR, file!), 'utf-8'),
    ) as Record<string, unknown>;
    expect(parsed.workspace).toBe('C:/dev/Projects/contract-test');
    expect(parsed.command).toBe('claude');
    expect(typeof parsed.queued_at).toBe('string');
    /* queued_at is ISO-8601; Date.parse must round-trip. */
    expect(Number.isFinite(Date.parse(parsed.queued_at as string))).toBe(true);
  });

  it('distinct workspaces produce distinct marker filenames', () => {
    queueProjectBootstrap('C:/dev/Projects/a', 'claude');
    queueProjectBootstrap('C:/dev/Projects/b', 'claude');
    const files = fs
      .readdirSync(WORKSPACE_INJECT_DIR)
      .filter((e) => e.endsWith('.json'));
    expect(new Set(files).size).toBe(2);
  });
});

describe('virtual-input contract (queueSessionFocus / queueSessionKey)', () => {
  it('queueSessionFocus appends {queued_at, action:"focus"} to <sid>.in', () => {
    const sid = '11111111-1111-1111-1111-111111111111';
    const r = queueSessionFocus(sid);
    expect(r.ok).toBe(true);
    const file = path.posix.join(VIRTUAL_INPUT_DIR, `${sid}.in`);
    expect(fs.existsSync(file)).toBe(true);
    const lines = fs
      .readFileSync(file, 'utf-8')
      .split('\n')
      .filter((l) => l.trim());
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(parsed.action).toBe('focus');
    expect(typeof parsed.queued_at).toBe('string');
  });

  it('queueSessionKey appends {queued_at, action:"key", key} to <sid>.in', () => {
    const sid = '22222222-2222-2222-2222-222222222222';
    const r = queueSessionKey(sid, 'enter');
    expect(r.ok).toBe(true);
    const file = path.posix.join(VIRTUAL_INPUT_DIR, `${sid}.in`);
    const lines = fs
      .readFileSync(file, 'utf-8')
      .split('\n')
      .filter((l) => l.trim());
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(parsed.action).toBe('key');
    expect(parsed.key).toBe('enter');
  });

  it('multiple writes per session append, do not overwrite', () => {
    const sid = '33333333-3333-3333-3333-333333333333';
    queueSessionFocus(sid);
    queueSessionKey(sid, 'down');
    queueSessionKey(sid, 'enter');
    const file = path.posix.join(VIRTUAL_INPUT_DIR, `${sid}.in`);
    const lines = fs
      .readFileSync(file, 'utf-8')
      .split('\n')
      .filter((l) => l.trim());
    expect(lines.length).toBe(3);
  });
});

describe('streamdeck liveness contract', () => {
  it('fresh .heartbeat keeps the tray accepting virtual-input writes', () => {
    fs.writeFileSync(HEARTBEAT_FILE, String(Date.now()), 'utf-8');
    const r = queueSessionFocus('44444444-4444-4444-4444-444444444444');
    expect(r.ok).toBe(true);
  });

  it('stale .heartbeat with no app.log returns "streamdeck app offline"', () => {
    rmIfExists(HEARTBEAT_FILE);
    rmIfExists(LOG_FILE);
    /* Recreate heartbeat with a stale mtime (older than 60s). */
    fs.writeFileSync(HEARTBEAT_FILE, '0', 'utf-8');
    const stale = new Date(Date.now() - 120_000);
    fs.utimesSync(HEARTBEAT_FILE, stale, stale);
    const r = queueSessionFocus('55555555-5555-5555-5555-555555555555');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/streamdeck app offline/);
    }
  });

  it('app.log mtime is honoured as a fallback liveness signal', () => {
    rmIfExists(HEARTBEAT_FILE);
    fs.writeFileSync(LOG_FILE, 'startup', 'utf-8');
    const r = queueSessionFocus('66666666-6666-6666-6666-666666666666');
    expect(r.ok).toBe(true);
  });
});

describe('identity-file editor-detection contract', () => {
  it('returns sessionId -> Cwd from fresh identity JSON', () => {
    fs.mkdirSync(IDENTITY_DIR, { recursive: true });
    const sid = '77777777-7777-7777-7777-777777777777';
    const cwd = 'C:/dev/Projects/identity-fresh';
    fs.writeFileSync(
      path.posix.join(IDENTITY_DIR, `${sid}.json`),
      JSON.stringify({ Cwd: cwd }),
      'utf-8',
    );
    const map = readIdentityFileWindowMap();
    expect(map.get(sid)).toBe(cwd);
  });

  it('skips stale identity files (mtime past IDENTITY_FRESH_MS)', async () => {
    fs.mkdirSync(IDENTITY_DIR, { recursive: true });
    const sid = '88888888-8888-8888-8888-888888888888';
    const file = path.posix.join(IDENTITY_DIR, `${sid}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify({ Cwd: 'C:/dev/Projects/old' }),
      'utf-8',
    );
    /* Force a mtime 1 day in the past so the freshness window can
     * never accept it regardless of env-tunable default. */
    const stale = new Date(Date.now() - 24 * 60 * 60 * 1000);
    fs.utimesSync(file, stale, stale);
    const map = readIdentityFileWindowMap();
    expect(map.has(sid)).toBe(false);
  });

  it('returns an empty map when the identity directory is missing', () => {
    rmIfExists(IDENTITY_DIR);
    const map = readIdentityFileWindowMap();
    expect(map.size).toBe(0);
  });

  it('skips identity files with malformed JSON without throwing', () => {
    fs.mkdirSync(IDENTITY_DIR, { recursive: true });
    const sid = '99999999-9999-9999-9999-999999999999';
    fs.writeFileSync(
      path.posix.join(IDENTITY_DIR, `${sid}.json`),
      '{not valid json',
      'utf-8',
    );
    /* Should not throw and should return without the bad sid. */
    const map = readIdentityFileWindowMap();
    expect(map.has(sid)).toBe(false);
  });
});
