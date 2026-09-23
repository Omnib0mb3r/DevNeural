/**
 * Phase C (2026-09-22): frame files on disk, browsing newest first, the
 * archive roll-up. In-memory fs; no real disk.
 */
import { describe, expect, it } from 'vitest';
import {
  archiveOldHandovers,
  listHandovers,
  readHandover,
  writeFrameHandover,
} from '../src/lex/handover-writer.js';
import type { HandoverFrame } from '../src/lex/handover-frame.js';

function memFs(): {
  files: Map<string, string>;
  dirs: Set<string>;
  deps: {
    rootDir: string;
    readdir: (d: string) => string[];
    readFile: (p: string) => string;
    writeFile: (p: string, c: string) => void;
    rename: (a: string, b: string) => void;
    mkdir: (d: string) => void;
    exists: (p: string) => boolean;
  };
} {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  const rootDir = 'C:/mem/brainstorms';
  return {
    files,
    dirs,
    deps: {
      rootDir,
      readdir: (d) => {
        const out = new Set<string>();
        for (const p of files.keys()) {
          if (p.startsWith(`${d}/`)) out.add(p.slice(d.length + 1).split('/')[0]!);
        }
        for (const s of dirs) {
          if (s.startsWith(`${d}/`)) out.add(s.slice(d.length + 1).split('/')[0]!);
        }
        return [...out];
      },
      readFile: (p) => {
        const c = files.get(p);
        if (c === undefined) throw new Error(`ENOENT ${p}`);
        return c;
      },
      writeFile: (p, c) => {
        files.set(p, c);
      },
      rename: (a, b) => {
        const c = files.get(a);
        if (c === undefined) throw new Error(`ENOENT ${a}`);
        files.delete(a);
        files.set(b, c);
      },
      mkdir: (d) => {
        dirs.add(d);
      },
      exists: (p) => files.has(p) || dirs.has(p) || [...files.keys()].some((k) => k.startsWith(`${p}/`)),
    },
  };
}

function frame(createdAt: string, over: Partial<HandoverFrame> = {}): HandoverFrame {
  return {
    anchorId: 'anchor-a',
    kind: 'auto-clear',
    createdAt,
    worker: {
      author: { role: 'worker', sessionId: 'w1', at: createdAt },
      verifiedState: 'clean',
      whatIWasDoing: `step at ${createdAt}`,
      decisionsInForce: '',
      stoppingPoint: 'committed',
    },
    lex: {
      author: { role: 'lex', sessionId: 'l1', at: createdAt },
      corrections: [],
      nextSteps: 'next',
      planReference: 'plan',
      verdict: 'approved',
    },
    unvetted: false,
    ...over,
  };
}

describe('frame files', () => {
  it('writes, lists newest first with kind, verdict and unvetted, and reads back', () => {
    const m = memFs();
    writeFrameHandover(frame('2026-09-22T10:00:00.000Z'), m.deps);
    writeFrameHandover(frame('2026-09-22T12:00:00.000Z', { lex: null, unvetted: true, kind: 'session-end' }), m.deps);
    writeFrameHandover(frame('2026-09-22T11:00:00.000Z'), m.deps);
    const list = listHandovers('anchor-a', m.deps);
    expect(list.map((e) => e.createdAt)).toEqual([
      '2026-09-22T12:00:00.000Z',
      '2026-09-22T11:00:00.000Z',
      '2026-09-22T10:00:00.000Z',
    ]);
    expect(list[0]).toMatchObject({ kind: 'session-end', unvetted: true, verdict: null, legacy: false });
    expect(list[1]).toMatchObject({ kind: 'auto-clear', unvetted: false, verdict: 'approved' });
    const body = readHandover('anchor-a', list[1]!.file, m.deps);
    expect(body).toMatch(/## Lex review \(approved/);
  });
  it('another anchor sees nothing (scope), and a bad file name reads nothing', () => {
    const m = memFs();
    writeFrameHandover(frame('2026-09-22T10:00:00.000Z'), m.deps);
    expect(listHandovers('anchor-b', m.deps)).toEqual([]);
    expect(readHandover('anchor-a', '../anchor-b/HANDOVER-x.md', m.deps)).toBeNull();
    expect(readHandover('anchor-a', 'notes.md', m.deps)).toBeNull();
  });
  it('lists the pre-Phase-C grooming format as legacy', () => {
    const m = memFs();
    m.deps.mkdir('C:/mem/brainstorms/anchor-a');
    m.deps.writeFile(
      'C:/mem/brainstorms/anchor-a/HANDOVER-2026-07-01_00-00-00-000Z.md',
      '# Brainstorm handover anchor-a\n\nGenerated: 2026-07-01T00:00:00.000Z\n',
    );
    const list = listHandovers('anchor-a', m.deps);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ legacy: true, kind: null, createdAt: null });
  });
});

describe('archiveOldHandovers', () => {
  it('keeps the newest N, moves the rest to archive/, and writes the index', () => {
    const m = memFs();
    for (let h = 0; h < 13; h++) {
      writeFrameHandover(frame(`2026-09-22T${String(h).padStart(2, '0')}:00:00.000Z`), m.deps);
    }
    const r = archiveOldHandovers('anchor-a', 10, m.deps);
    expect(r.archived).toHaveLength(3);
    expect(listHandovers('anchor-a', m.deps)).toHaveLength(10);
    const index = m.files.get('C:/mem/brainstorms/anchor-a/HANDOVER-INDEX.md') ?? '';
    expect(index).toMatch(/^# Archived handovers/m);
    expect(index).toMatch(/^- archive\/HANDOVER-2026-09-22_00-00-00-000Z\.md: auto-clear, 2026-09-22T00:00:00\.000Z, step at/m);
    expect(m.files.has('C:/mem/brainstorms/anchor-a/archive/HANDOVER-2026-09-22_02-00-00-000Z.md')).toBe(true);
    expect(archiveOldHandovers('anchor-a', 10, m.deps).archived).toEqual([]);
  });
});
