/**
 * Handover writer (Phase 2 of LEX-STANDALONE-SUPERVISION).
 *
 * Pins the disk-write contract: filename slug is sortable by ISO
 * timestamp, render shape is stable, findLatestHandover picks the
 * lexicographically-latest entry.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  buildHandoverFilename,
  findLatestHandover,
  renderHandover,
  writeHandover,
  type HandoverPayload,
} from '../src/lex/handover-writer.js';

function basePayload(overrides: Partial<HandoverPayload> = {}): HandoverPayload {
  return {
    brainstormId: 'bs-handover-1',
    userLabel: 'DevNeural Testing',
    derivedLabel: null,
    mode: 'conversation',
    generatedAt: '2026-05-24T01:23:45.678Z',
    activeArcs: ['idle-watcher escalation rules', 'handover render shape'],
    parkedDecisions: ['voice spontaneous speech policy'],
    plantedMarkers: ['mention to user at morning brief'],
    recentTurns: [
      { role: 'user', text: 'walk me through the cold pass' },
      { role: 'lex', text: 'cold pass writes the handover doc' },
    ],
    rollingSummary: 'short rolling summary text',
    ...overrides,
  };
}

describe('buildHandoverFilename', () => {
  it('strips colons and dots so the slug is filesystem-safe', () => {
    const f = buildHandoverFilename('2026-05-24T01:23:45.678Z');
    expect(f).toBe('HANDOVER-2026-05-24_01-23-45-678Z.md');
    expect(f).not.toContain(':');
    expect(f).not.toContain('.md.md');
  });

  it('keeps lexicographic order matching wall-clock order', () => {
    const a = buildHandoverFilename('2026-05-24T01:00:00.000Z');
    const b = buildHandoverFilename('2026-05-24T02:00:00.000Z');
    const c = buildHandoverFilename('2026-05-25T01:00:00.000Z');
    expect([c, b, a].sort()).toEqual([a, b, c]);
  });
});

describe('renderHandover', () => {
  it('emits the required sections in order', () => {
    const md = renderHandover(basePayload());
    const headerIdx = md.indexOf('# Brainstorm handover');
    const arcsIdx = md.indexOf('## Active arcs');
    const parkedIdx = md.indexOf('## Parked decisions');
    const plantedIdx = md.indexOf('## Planted markers');
    const turnsIdx = md.indexOf('## Recent turns');
    expect(headerIdx).toBeGreaterThanOrEqual(0);
    expect(arcsIdx).toBeGreaterThan(headerIdx);
    expect(parkedIdx).toBeGreaterThan(arcsIdx);
    expect(plantedIdx).toBeGreaterThan(parkedIdx);
    expect(turnsIdx).toBeGreaterThan(plantedIdx);
  });

  it('renders bullets for active arcs and recent turns', () => {
    const md = renderHandover(basePayload());
    expect(md).toContain('- idle-watcher escalation rules');
    expect(md).toContain('- **USER:** walk me through the cold pass');
    expect(md).toContain('- **LEX:** cold pass writes the handover doc');
  });

  it('renders "_None._" placeholders when arrays are empty', () => {
    const md = renderHandover(
      basePayload({
        activeArcs: [],
        parkedDecisions: [],
        plantedMarkers: [],
      }),
    );
    expect(md).toMatch(/## Active arcs\n\n_None\._/);
    expect(md).toMatch(/## Parked decisions\n\n_None\._/);
    expect(md).toMatch(/## Planted markers\n\n_None\._/);
  });
});

describe('writeHandover + findLatestHandover', () => {
  function tmpRoot(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-handover-'));
  }

  it('writes the file under <root>/<brainstormId>/HANDOVER-<slug>.md and returns the path + bytes', () => {
    const root = tmpRoot();
    try {
      const result = writeHandover(basePayload(), { rootDir: root });
      expect(result.filePath).toContain('bs-handover-1');
      expect(result.filePath).toMatch(/HANDOVER-.+\.md$/);
      expect(fs.existsSync(result.filePath)).toBe(true);
      expect(result.bytes).toBeGreaterThan(0);
      const onDisk = fs.readFileSync(result.filePath, 'utf-8');
      expect(onDisk).toContain('# Brainstorm handover bs-handover-1');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('findLatestHandover returns the lexicographically-latest handover (= newest ISO ts)', () => {
    const root = tmpRoot();
    try {
      writeHandover(
        basePayload({ generatedAt: '2026-05-24T01:00:00.000Z' }),
        { rootDir: root },
      );
      writeHandover(
        basePayload({ generatedAt: '2026-05-24T02:00:00.000Z' }),
        { rootDir: root },
      );
      writeHandover(
        basePayload({ generatedAt: '2026-05-23T23:59:00.000Z' }),
        { rootDir: root },
      );
      const latest = findLatestHandover('bs-handover-1', { rootDir: root });
      expect(latest).not.toBeNull();
      expect(latest!.filename).toBe(
        buildHandoverFilename('2026-05-24T02:00:00.000Z'),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('findLatestHandover returns null when no handover exists for the brainstorm', () => {
    const root = tmpRoot();
    try {
      expect(findLatestHandover('bs-never-groomed', { rootDir: root })).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
