/**
 * Bridge presence-file write unit test (PROJECT-ANCHORS.md step 2).
 *
 * Proves the bridge writes one presence file per workspace folder under
 * the configured presence dir with the payload shape the daemon's
 * reconcileBridgePresence expects (workspace, cwd, bridge_id,
 * updated_at, optional cc_session_ids).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  presenceFilename,
  buildPresencePayload,
  writePresenceFiles,
  type WorkspaceFolderLike,
} from '../src/presence.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-bridge-presence-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('presenceFilename', () => {
  it('replaces path separators and reserved chars with underscores', () => {
    expect(presenceFilename('C:/dev/Projects/DevNeural')).toBe(
      'C__dev_Projects_DevNeural',
    );
  });

  it('falls back to a sentinel when input is empty', () => {
    expect(presenceFilename('')).toBe('no-workspace');
  });
});

describe('buildPresencePayload', () => {
  it('writes workspace, cwd, bridge_id, updated_at', () => {
    const payload = buildPresencePayload({
      workspace: 'C:/dev/Projects/DevNeural',
      bridgeId: 'bridge-abc',
      now: new Date('2026-05-12T00:00:00.000Z'),
    });
    expect(payload).toEqual({
      workspace: 'C:/dev/Projects/DevNeural',
      cwd: 'C:/dev/Projects/DevNeural',
      bridge_id: 'bridge-abc',
      updated_at: '2026-05-12T00:00:00.000Z',
    });
  });

  it('includes cc_session_ids when ccSessionId provided', () => {
    const payload = buildPresencePayload({
      workspace: 'C:/dev/Projects/DevNeural',
      bridgeId: 'bridge-abc',
      ccSessionId: 'cc-uuid-1',
      now: new Date('2026-05-12T00:00:00.000Z'),
    });
    expect(payload.cc_session_ids).toEqual(['cc-uuid-1']);
  });

  it('normalises backslashes in cwd to forward slashes', () => {
    const payload = buildPresencePayload({
      workspace: 'C:\\dev\\Projects\\DevNeural',
      bridgeId: 'bridge-abc',
      now: new Date('2026-05-12T00:00:00.000Z'),
    });
    expect(payload.cwd).toBe('C:/dev/Projects/DevNeural');
  });
});

describe('writePresenceFiles', () => {
  it('writes one file per workspace folder with parseable JSON payload', () => {
    const folders: WorkspaceFolderLike[] = [
      { fsPath: 'C:/dev/Projects/DevNeural' },
      { fsPath: 'C:/dev/Projects/other' },
    ];
    const written = writePresenceFiles({
      presenceDir: tmpDir,
      folders,
      bridgeId: 'bridge-1',
      now: new Date('2026-05-12T00:00:00.000Z'),
    });

    expect(written.length).toBe(2);
    for (const file of written) {
      expect(fs.existsSync(file)).toBe(true);
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Record<
        string,
        unknown
      >;
      expect(typeof parsed.workspace).toBe('string');
      expect(typeof parsed.cwd).toBe('string');
      expect(parsed.bridge_id).toBe('bridge-1');
      expect(typeof parsed.updated_at).toBe('string');
    }
  });

  it('creates the presence dir if missing', () => {
    const nested = path.join(tmpDir, 'session-bridge', '.bridge-presence');
    expect(fs.existsSync(nested)).toBe(false);
    writePresenceFiles({
      presenceDir: nested,
      folders: [{ fsPath: 'C:/dev/Projects/DevNeural' }],
      bridgeId: 'bridge-1',
      now: new Date('2026-05-12T00:00:00.000Z'),
    });
    expect(fs.existsSync(nested)).toBe(true);
  });

  it('embeds cc_session_ids via the lookup hook', () => {
    const ccLookup = (cwd: string): string | undefined => {
      if (cwd === 'C:/dev/Projects/DevNeural') return 'cc-uuid-1';
      return undefined;
    };
    const [file] = writePresenceFiles({
      presenceDir: tmpDir,
      folders: [{ fsPath: 'C:/dev/Projects/DevNeural' }],
      bridgeId: 'bridge-1',
      now: new Date('2026-05-12T00:00:00.000Z'),
      ccSessionLookup: ccLookup,
    });
    const parsed = JSON.parse(fs.readFileSync(file!, 'utf-8')) as Record<
      string,
      unknown
    >;
    expect(parsed.cc_session_ids).toEqual(['cc-uuid-1']);
  });

  it('returns empty when no folders given', () => {
    const written = writePresenceFiles({
      presenceDir: tmpDir,
      folders: [],
      bridgeId: 'bridge-1',
      now: new Date(),
    });
    expect(written).toEqual([]);
  });
});
