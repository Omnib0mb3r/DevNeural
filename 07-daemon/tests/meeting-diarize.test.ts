/**
 * Post-session meeting diarization (2026-07-15). Covers:
 *   - parseDiarizedSrt against a fixture matching diarize.py's real
 *     <stem>_diarized.srt output shape (verified by reading
 *     C:/dev/Projects/transcribe/diarize.py, not guessed).
 *   - parseAttendees / mapSpeakerToAttendee / hasHfToken units.
 *   - runMeetingDiarization gating: session kind, consent, WAV
 *     presence, HF token, all checked before any process is spawned.
 *   - runMeetingDiarization contract against a faked spawnFn: no real
 *     python process is ever launched by this suite.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import type { Store } from '../src/store/index.js';
import {
  runMeetingDiarization,
  parseDiarizedSrt,
  parseAttendees,
  mapSpeakerToAttendee,
  hasHfToken,
  type SpawnFn,
  type DiarizeChildProcess,
} from '../src/lex/meeting-diarize.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

/* Matches diarize.py's real srt writer exactly (see module header):
 *   fsrt.write(f"{idx}\n{ts(start)} --> {ts(end)}\n[{spk}] {text}\n\n")
 */
const FIXTURE_SRT = [
  '1',
  '00:00:00,120 --> 00:00:03,450',
  '[SPEAKER_00] Hello everyone, thanks for joining.',
  '',
  '2',
  '00:00:03,600 --> 00:00:05,020',
  '[SPEAKER_01] Happy to be here.',
  '',
  '3',
  '00:00:05,300 --> 00:00:09,800',
  "[SPEAKER_00] Let's get started with the agenda.",
  '',
].join('\n');

let tmpDir: string;
let dbFile: string;
let db: IndexDb;
let store: Store;
let priorRoot: string | undefined;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-diarize-'));
  dbFile = path.join(tmpDir, 'index.db');
  priorRoot = process.env.DEVNEURAL_DATA_ROOT;
  process.env.DEVNEURAL_DATA_ROOT = tmpDir;
  const seed = new IndexDb(dbFile);
  seed.close();
  await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
  db = new IndexDb(dbFile);
  store = { db } as unknown as Store;
});

afterEach(() => {
  db.close();
  if (priorRoot === undefined) delete process.env.DEVNEURAL_DATA_ROOT;
  else process.env.DEVNEURAL_DATA_ROOT = priorRoot;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function seedSession(opts: {
  kind?: 'brainstorm' | 'meeting';
  consent_acked?: 0 | 1;
  audio_path?: string | null;
  attendees?: string | null;
}): string {
  const id = randomUUID();
  db.insertBrainstorm({
    id,
    claude_session_id: null,
    pty_id: null,
    cwd: '/tmp/brainstorm',
    user_label: null,
    derived_label: null,
    mode: 'notes',
    status: 'ended',
    started_ms: Date.now() - 60_000,
    ended_ms: Date.now(),
    turn_count: 0,
    topic_tags_json: '[]',
    artifacts_json: '{}',
    last_summary: null,
    last_summary_ms: null,
  });
  db.setBrainstormPhaseTwo(id, {
    kind: opts.kind ?? 'meeting',
    consent_acked: opts.consent_acked ?? 1,
    audio_path: opts.audio_path ?? null,
    attendees: opts.attendees ?? null,
  });
  return id;
}

function writeFakeWav(): string {
  const wavPath = path.join(tmpDir, `${randomUUID()}.wav`);
  fs.writeFileSync(wavPath, Buffer.from([0, 0, 0, 0]));
  return wavPath.replace(/\\/g, '/');
}

/* Fake child process matching DiarizeChildProcess. emit.close/error
 * are deferred via setImmediate by callers so listeners registered
 * AFTER spawnFn returns (as runDiarizeProcess does) are attached
 * before the event fires -- mirrors the real ordering. */
function fakeChild(): {
  child: DiarizeChildProcess;
  emit: {
    close: (code: number | null) => void;
    error: (err: NodeJS.ErrnoException) => void;
    stderr: (chunk: string) => void;
  };
} {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const ee = new EventEmitter();
  const child: DiarizeChildProcess = {
    stdout,
    stderr,
    on: ee.on.bind(ee) as DiarizeChildProcess['on'],
    kill: () => undefined,
  };
  return {
    child,
    emit: {
      close: (code) => ee.emit('close', code),
      error: (err) => ee.emit('error', err),
      stderr: (chunk) => stderr.emit('data', Buffer.from(chunk)),
    },
  };
}

describe('parseDiarizedSrt', () => {
  it('parses diarize.py fixture output into ordered segments', () => {
    const segs = parseDiarizedSrt(FIXTURE_SRT);
    expect(segs).toHaveLength(3);
    expect(segs[0]).toEqual({
      startMs: 120,
      endMs: 3450,
      speaker: 'SPEAKER_00',
      text: 'Hello everyone, thanks for joining.',
    });
    expect(segs[1]).toEqual({
      startMs: 3600,
      endMs: 5020,
      speaker: 'SPEAKER_01',
      text: 'Happy to be here.',
    });
    expect(segs[2]!.startMs).toBe(5300);
    expect(segs[2]!.speaker).toBe('SPEAKER_00');
  });

  it('tolerates CRLF line endings', () => {
    const crlf = FIXTURE_SRT.replace(/\n/g, '\r\n');
    expect(parseDiarizedSrt(crlf)).toHaveLength(3);
  });

  it('skips blocks with no timing line instead of throwing', () => {
    const malformed = 'garbage\nblock\nwith no timing\n\n' + FIXTURE_SRT;
    expect(parseDiarizedSrt(malformed)).toHaveLength(3);
  });

  it('skips blocks with an unparseable timestamp', () => {
    const bad = '1\nNOT --> A TIMESTAMP\n[SPEAKER_00] hi\n\n' + FIXTURE_SRT;
    expect(parseDiarizedSrt(bad)).toHaveLength(3);
  });

  it('falls back to speaker UNKNOWN when the [SPEAKER] tag is missing', () => {
    const noTag = '1\n00:00:00,000 --> 00:00:01,000\njust text, no tag\n\n';
    const segs = parseDiarizedSrt(noTag);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.speaker).toBe('UNKNOWN');
    expect(segs[0]!.text).toBe('just text, no tag');
  });

  it('returns empty array for empty or whitespace-only input', () => {
    expect(parseDiarizedSrt('')).toEqual([]);
    expect(parseDiarizedSrt('   \n\n  ')).toEqual([]);
  });
});

describe('parseAttendees / mapSpeakerToAttendee', () => {
  it('splits and trims a comma-separated attendees field', () => {
    expect(parseAttendees('Alice, Bob , Carol')).toEqual(['Alice', 'Bob', 'Carol']);
  });

  it('returns [] for null/empty attendees', () => {
    expect(parseAttendees(null)).toEqual([]);
    expect(parseAttendees(undefined)).toEqual([]);
    expect(parseAttendees('')).toEqual([]);
    expect(parseAttendees('   ')).toEqual([]);
  });

  it('maps SPEAKER_XX to attendees by index order as a starting guess', () => {
    const attendees = ['Alice', 'Bob'];
    expect(mapSpeakerToAttendee('SPEAKER_00', attendees)).toBe('Alice');
    expect(mapSpeakerToAttendee('SPEAKER_01', attendees)).toBe('Bob');
  });

  it('returns null when the speaker index runs past the attendees list', () => {
    expect(mapSpeakerToAttendee('SPEAKER_02', ['Alice', 'Bob'])).toBeNull();
    expect(mapSpeakerToAttendee('SPEAKER_00', [])).toBeNull();
  });

  it('returns null for non-standard speaker labels', () => {
    expect(mapSpeakerToAttendee('UNKNOWN', ['Alice'])).toBeNull();
  });
});

describe('hasHfToken', () => {
  it('is true when HF_TOKEN is set', () => {
    expect(hasHfToken({ HF_TOKEN: 'abc' })).toBe(true);
  });
  it('is true when only HUGGINGFACE_TOKEN is set', () => {
    expect(hasHfToken({ HUGGINGFACE_TOKEN: 'xyz' })).toBe(true);
  });
  it('is false when neither is set', () => {
    expect(hasHfToken({})).toBe(false);
  });
  it('is false for whitespace-only values', () => {
    expect(hasHfToken({ HF_TOKEN: '   ' })).toBe(false);
  });
});

describe('runMeetingDiarization gating (no process ever spawned)', () => {
  it('skips with session_not_found when the session row does not exist', async () => {
    const calls: unknown[] = [];
    const spawnFn: SpawnFn = (...args) => {
      calls.push(args);
      return fakeChild().child;
    };
    const res = await runMeetingDiarization(randomUUID(), {
      store,
      spawnFn,
      env: { HF_TOKEN: 'x' },
    });
    expect(res).toEqual({ ok: false, skipped: 'session_not_found' });
    expect(calls).toHaveLength(0);
  });

  it('skips with not_meeting for a brainstorm-kind session', async () => {
    const id = seedSession({ kind: 'brainstorm' });
    const calls: unknown[] = [];
    const spawnFn: SpawnFn = (...args) => {
      calls.push(args);
      return fakeChild().child;
    };
    const res = await runMeetingDiarization(id, { store, spawnFn, env: { HF_TOKEN: 'x' } });
    expect(res).toEqual({ ok: false, skipped: 'not_meeting' });
    expect(calls).toHaveLength(0);
  });

  it('skips with no_consent when consent_acked=0', async () => {
    const id = seedSession({ kind: 'meeting', consent_acked: 0 });
    const calls: unknown[] = [];
    const spawnFn: SpawnFn = (...args) => {
      calls.push(args);
      return fakeChild().child;
    };
    const res = await runMeetingDiarization(id, { store, spawnFn, env: { HF_TOKEN: 'x' } });
    expect(res).toEqual({ ok: false, skipped: 'no_consent' });
    expect(calls).toHaveLength(0);
  });

  it('skips with no_wav when audio_path is null', async () => {
    const id = seedSession({ kind: 'meeting', consent_acked: 1, audio_path: null });
    const calls: unknown[] = [];
    const spawnFn: SpawnFn = (...args) => {
      calls.push(args);
      return fakeChild().child;
    };
    const res = await runMeetingDiarization(id, { store, spawnFn, env: { HF_TOKEN: 'x' } });
    expect(res).toEqual({ ok: false, skipped: 'no_wav' });
    expect(calls).toHaveLength(0);
  });

  it('skips with no_wav when audio_path points at a file that does not exist on disk', async () => {
    const id = seedSession({
      kind: 'meeting',
      consent_acked: 1,
      audio_path: path.join(tmpDir, 'nonexistent.wav'),
    });
    const calls: unknown[] = [];
    const spawnFn: SpawnFn = (...args) => {
      calls.push(args);
      return fakeChild().child;
    };
    const res = await runMeetingDiarization(id, { store, spawnFn, env: { HF_TOKEN: 'x' } });
    expect(res).toEqual({ ok: false, skipped: 'no_wav' });
    expect(calls).toHaveLength(0);
  });

  it('skips with no_hf_token when neither HF_TOKEN nor HUGGINGFACE_TOKEN is set, without spawning', async () => {
    const wavPath = writeFakeWav();
    const id = seedSession({ kind: 'meeting', consent_acked: 1, audio_path: wavPath });
    const calls: unknown[] = [];
    const spawnFn: SpawnFn = (...args) => {
      calls.push(args);
      return fakeChild().child;
    };
    const res = await runMeetingDiarization(id, { store, spawnFn, env: {} });
    expect(res).toEqual({ ok: false, skipped: 'no_hf_token' });
    expect(calls).toHaveLength(0);
  });
});

describe('runMeetingDiarization contract (faked python spawn)', () => {
  it('spawns python with the real diarize.py CLI contract, windowsHide:true, and persists segments', async () => {
    const wavPath = writeFakeWav();
    const id = seedSession({
      kind: 'meeting',
      consent_acked: 1,
      audio_path: wavPath,
      attendees: 'Alice, Bob',
    });

    const calls: Array<{ cmd: string; args: readonly string[]; options: Record<string, unknown> }> = [];
    const spawnFn: SpawnFn = (cmd, args, options) => {
      calls.push({ cmd, args, options });
      const outDir = args[2]!;
      const stem = path.posix.basename(args[1]!).replace(/\.[^./]+$/, '');
      const srtPath = path.posix.join(outDir, `${stem}_diarized.srt`);
      fs.writeFileSync(srtPath, FIXTURE_SRT, 'utf-8');
      const { child, emit } = fakeChild();
      setImmediate(() => emit.close(0));
      return child;
    };

    const res = await runMeetingDiarization(id, {
      store,
      spawnFn,
      env: { HF_TOKEN: 'hf_abc123' },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe('python');
    expect(calls[0]!.args[0]).toBe('C:/dev/Projects/transcribe/diarize.py');
    expect(calls[0]!.args[1]).toBe(wavPath);
    expect(calls[0]!.options.windowsHide).toBe(true);

    expect(res.ok).toBe(true);
    expect(res.storedCount).toBe(3);
    expect(res.segments).toHaveLength(3);
    expect(res.segments![0]!.speaker).toBe('SPEAKER_00');
    expect(res.segments![0]!.speakerGuess).toBe('Alice');
    expect(res.segments![1]!.speaker).toBe('SPEAKER_01');
    expect(res.segments![1]!.speakerGuess).toBe('Bob');

    const persisted = db.listMeetingDiarization(id);
    expect(persisted).toHaveLength(3);
    expect(persisted[0]!.text).toBe('Hello everyone, thanks for joining.');
    expect(persisted[0]!.speaker_guess).toBe('Alice');
  });

  it('honors DEVNEURAL_DIARIZE_PY and DEVNEURAL_DIARIZE_SCRIPT overrides', async () => {
    const wavPath = writeFakeWav();
    const id = seedSession({ kind: 'meeting', consent_acked: 1, audio_path: wavPath });

    const calls: Array<{ cmd: string; args: readonly string[] }> = [];
    const spawnFn: SpawnFn = (cmd, args) => {
      calls.push({ cmd, args });
      const outDir = args[2]!;
      const stem = path.posix.basename(args[1]!).replace(/\.[^./]+$/, '');
      fs.writeFileSync(path.posix.join(outDir, `${stem}_diarized.srt`), FIXTURE_SRT, 'utf-8');
      const { child, emit } = fakeChild();
      setImmediate(() => emit.close(0));
      return child;
    };

    const res = await runMeetingDiarization(id, {
      store,
      spawnFn,
      env: {
        HF_TOKEN: 'hf_abc123',
        DEVNEURAL_DIARIZE_PY: 'C:/py311/python.exe',
        DEVNEURAL_DIARIZE_SCRIPT: 'C:/custom/diarize.py',
      },
    });

    expect(res.ok).toBe(true);
    expect(calls[0]!.cmd).toBe('C:/py311/python.exe');
    expect(calls[0]!.args[0]).toBe('C:/custom/diarize.py');
  });

  it('returns nonzero_exit with stderr detail when the process exits non-zero', async () => {
    const wavPath = writeFakeWav();
    const id = seedSession({ kind: 'meeting', consent_acked: 1, audio_path: wavPath });

    const spawnFn: SpawnFn = () => {
      const { child, emit } = fakeChild();
      setImmediate(() => {
        emit.stderr('Traceback: torch.cuda.OutOfMemoryError\n');
        emit.close(1);
      });
      return child;
    };

    const res = await runMeetingDiarization(id, { store, spawnFn, env: { HF_TOKEN: 'x' } });
    expect(res.ok).toBe(false);
    expect(res.skipped).toBe('nonzero_exit');
    expect(res.error).toContain('exit 1');
    expect(res.error).toContain('OutOfMemoryError');
    expect(db.listMeetingDiarization(id)).toHaveLength(0);
  });

  it('returns no_hf_token when the child process itself exits with diarize.py exit code 2 (defensive backstop)', async () => {
    const wavPath = writeFakeWav();
    const id = seedSession({ kind: 'meeting', consent_acked: 1, audio_path: wavPath });

    const spawnFn: SpawnFn = () => {
      const { child, emit } = fakeChild();
      setImmediate(() => {
        emit.stderr('ERROR: no HF_TOKEN/HUGGINGFACE_TOKEN in environment\n');
        emit.close(2);
      });
      return child;
    };

    const res = await runMeetingDiarization(id, { store, spawnFn, env: { HF_TOKEN: 'x' } });
    expect(res).toMatchObject({ ok: false, skipped: 'no_hf_token' });
  });

  it('returns spawn_error when spawnFn throws synchronously (e.g. python not on PATH)', async () => {
    const wavPath = writeFakeWav();
    const id = seedSession({ kind: 'meeting', consent_acked: 1, audio_path: wavPath });

    const spawnFn: SpawnFn = () => {
      throw new Error('spawn python ENOENT');
    };

    const res = await runMeetingDiarization(id, { store, spawnFn, env: { HF_TOKEN: 'x' } });
    expect(res.ok).toBe(false);
    expect(res.skipped).toBe('spawn_error');
    expect(res.error).toContain('ENOENT');
  });

  it('returns spawn_error when the child emits an async error event', async () => {
    const wavPath = writeFakeWav();
    const id = seedSession({ kind: 'meeting', consent_acked: 1, audio_path: wavPath });

    const spawnFn: SpawnFn = () => {
      const { child, emit } = fakeChild();
      setImmediate(() => emit.error(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })));
      return child;
    };

    const res = await runMeetingDiarization(id, { store, spawnFn, env: { HF_TOKEN: 'x' } });
    expect(res.ok).toBe(false);
    expect(res.skipped).toBe('spawn_error');
  });

  it('returns timeout and never resolves the segments when the process hangs past the bound', async () => {
    const wavPath = writeFakeWav();
    const id = seedSession({ kind: 'meeting', consent_acked: 1, audio_path: wavPath });

    const spawnFn: SpawnFn = () => fakeChild().child; // never emits close/error

    const res = await runMeetingDiarization(id, {
      store,
      spawnFn,
      env: { HF_TOKEN: 'x', DEVNEURAL_DIARIZE_TIMEOUT_MS: '10' },
    });
    expect(res.ok).toBe(false);
    expect(res.skipped).toBe('timeout');
  }, 2000);

  it('returns no_output when the process exits 0 but no srt file was written', async () => {
    const wavPath = writeFakeWav();
    const id = seedSession({ kind: 'meeting', consent_acked: 1, audio_path: wavPath });

    const spawnFn: SpawnFn = () => {
      const { child, emit } = fakeChild();
      setImmediate(() => emit.close(0));
      return child;
    };

    const res = await runMeetingDiarization(id, { store, spawnFn, env: { HF_TOKEN: 'x' } });
    expect(res.ok).toBe(false);
    expect(res.skipped).toBe('no_output');
  });

  it('returns no_segments when the srt file exists but has no parseable entries', async () => {
    const wavPath = writeFakeWav();
    const id = seedSession({ kind: 'meeting', consent_acked: 1, audio_path: wavPath });

    const spawnFn: SpawnFn = (_cmd, args) => {
      const outDir = args[2]!;
      const stem = path.posix.basename(args[1]!).replace(/\.[^./]+$/, '');
      fs.writeFileSync(path.posix.join(outDir, `${stem}_diarized.srt`), '   \n\n  ', 'utf-8');
      const { child, emit } = fakeChild();
      setImmediate(() => emit.close(0));
      return child;
    };

    const res = await runMeetingDiarization(id, { store, spawnFn, env: { HF_TOKEN: 'x' } });
    expect(res.ok).toBe(false);
    expect(res.skipped).toBe('no_segments');
  });
});
