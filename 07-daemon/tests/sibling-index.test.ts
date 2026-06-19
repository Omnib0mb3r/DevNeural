/**
 * Sibling index helper.
 *
 * Covers the four contracts the helper promises:
 *   1. Empty label / no matches returns an empty string (so the
 *      caller can safely concat without conditional rendering).
 *   2. Case-insensitive label match, whitespace tolerant.
 *   3. excludeId drops the newly-created session.
 *   4. Each line carries id8, label in quotes, ISO started, optional
 *      10-word distillation pulled from last_summary.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IndexDb } from '../src/store/index-db.js';
import { runMigrations } from '../src/db/migrate.js';
import { buildSiblingIndex } from '../src/lex/sibling-index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(HERE, '..', 'scripts', 'migrations');

let tmpDir: string;
let db: IndexDb;

function insertBs(opts: {
  id: string;
  user_label: string | null;
  derived_label?: string | null;
  started_ms: number;
  last_summary?: string | null;
}): void {
  db.insertBrainstorm({
    id: opts.id,
    claude_session_id: null,
    pty_id: null,
    cwd: 'C:/p/lex',
    user_label: opts.user_label,
    derived_label: opts.derived_label ?? null,
    mode: 'conversation',
    status: 'active',
    started_ms: opts.started_ms,
    ended_ms: null,
    turn_count: 0,
    topic_tags_json: '[]',
    artifacts_json: '{}',
    last_summary: opts.last_summary ?? null,
    last_summary_ms: null,
  });
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devneural-sibling-index-'));
  const dbFile = path.join(tmpDir, 'index.db');
  fs.mkdirSync(path.join(tmpDir, 'home', '.claude', 'projects'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(tmpDir, 'Projects'), { recursive: true });
  process.env.DEVNEURAL_DATA_ROOT = tmpDir;
  process.env.DEVNEURAL_PROJECTS_ROOT = path.join(tmpDir, 'Projects');
  process.env.USERPROFILE = path.join(tmpDir, 'home');
  process.env.HOME = path.join(tmpDir, 'home');
  const idx = new IndexDb(dbFile);
  idx.close();
  await runMigrations({ dbPath: dbFile, migrationsDir: MIGRATIONS_DIR });
  db = new IndexDb(dbFile);
});

afterEach(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('buildSiblingIndex - empty cases', () => {
  it('returns empty string when label is null', () => {
    expect(buildSiblingIndex({ db, label: null })).toBe('');
  });

  it('returns empty string when label is empty / whitespace', () => {
    expect(buildSiblingIndex({ db, label: '   ' })).toBe('');
  });

  it('returns empty string when no brainstorms match the label', () => {
    insertBs({
      id: 'aaaaaaaa-1111',
      user_label: 'Different Topic',
      started_ms: 1_000,
    });
    expect(buildSiblingIndex({ db, label: 'No Match' })).toBe('');
  });
});

describe('buildSiblingIndex - label matching', () => {
  it('matches case-insensitively and trims whitespace', () => {
    insertBs({
      id: 'bbbbbbbb-2222',
      user_label: 'Smart Compact Rollout',
      started_ms: 1_000,
    });
    const out = buildSiblingIndex({ db, label: '  smart compact rollout  ' });
    expect(out).toMatch(/bbbbbbbb/);
    expect(out).toMatch(/Smart Compact Rollout/);
  });

  it('excludes the newly-created session when excludeId is provided', () => {
    insertBs({
      id: 'self-id-00000000',
      user_label: 'DevNeural Testing',
      started_ms: 2_000,
    });
    insertBs({
      id: 'sibling-id-1111',
      user_label: 'DevNeural Testing',
      started_ms: 1_000,
    });
    const out = buildSiblingIndex({
      db,
      label: 'DevNeural Testing',
      excludeId: 'self-id-00000000',
    });
    expect(out).toMatch(/sibling-/);
    expect(out).not.toMatch(/self-id/);
  });

  it('returns empty when only the excluded row matches', () => {
    insertBs({
      id: 'only-self-0000',
      user_label: 'Solo Topic',
      started_ms: 3_000,
    });
    expect(
      buildSiblingIndex({
        db,
        label: 'Solo Topic',
        excludeId: 'only-self-0000',
      }),
    ).toBe('');
  });

  it('caps the visible list at the supplied limit', () => {
    for (let i = 0; i < 12; i++) {
      insertBs({
        id: `mass-${i}`.padEnd(8, '0'),
        user_label: 'Mass Topic',
        started_ms: 1_000 + i,
      });
    }
    const out = buildSiblingIndex({
      db,
      label: 'Mass Topic',
      limit: 3,
    });
    const bulletLines = out.split('\n').filter((l) => l.startsWith('- '));
    expect(bulletLines.length).toBe(3);
  });
});

describe('buildSiblingIndex - line format', () => {
  it('formats id8 + quoted label + ISO started + distillation tail', () => {
    insertBs({
      id: 'cccccccc-3333',
      user_label: 'Format Check',
      started_ms: Date.UTC(2026, 4, 12, 8, 30, 0),
      last_summary:
        'wrote sibling index helper covers label match exclude id format truncation tests',
    });
    const out = buildSiblingIndex({ db, label: 'Format Check' });
    /* id8 = first 8 chars; label in quotes; ISO ts; tail dash. */
    expect(out).toMatch(/- cccccccc "Format Check" started 2026-05-12T08:30:00\.000Z — /);
  });

  it('truncates the distillation to 10 words by default', () => {
    insertBs({
      id: 'dddddddd-4444',
      user_label: 'Truncation Check',
      started_ms: 1_000,
      last_summary:
        'one two three four five six seven eight nine ten eleven twelve thirteen fourteen',
    });
    const out = buildSiblingIndex({ db, label: 'Truncation Check' });
    expect(out).toMatch(/one two three four five six seven eight nine ten\.\.\./);
    expect(out).not.toMatch(/eleven/);
  });

  it('omits the distillation tail when last_summary is null', () => {
    insertBs({
      id: 'eeeeeeee-5555',
      user_label: 'No Summary',
      started_ms: 1_000,
      last_summary: null,
    });
    const out = buildSiblingIndex({ db, label: 'No Summary' });
    expect(out).toMatch(/- eeeeeeee "No Summary" started \d{4}-\d{2}-\d{2}T/);
    expect(out).not.toMatch(/ — /);
  });

  it('falls back to derived_label when user_label is null', () => {
    insertBs({
      id: 'ffffffff-6666',
      user_label: null,
      derived_label: 'Auto Label',
      started_ms: 1_000,
    });
    /* Caller passes the new session's label as the match key; even
     * when the match row has a null user_label, the formatter still
     * needs a friendly display name. Match must be case-insensitive
     * on whatever the caller supplied, so a null user_label row only
     * surfaces when the caller's label matches its (also null) value
     * - which we treat as no match. This test guards that we do not
     * accidentally show derived-label rows for an unrelated label. */
    expect(buildSiblingIndex({ db, label: 'Auto Label' })).toBe('');
  });
});

describe('buildSiblingIndex - header block', () => {
  it('opens with the canonical header and includes the user label', () => {
    insertBs({
      id: 'gggggggg-7777',
      user_label: 'Header Check',
      started_ms: 1_000,
    });
    const out = buildSiblingIndex({ db, label: 'Header Check' });
    expect(out.startsWith('# Sibling sessions (same label "Header Check")')).toBe(
      true,
    );
    expect(out).toMatch(/Prior brainstorms the user named the same way/);
  });
});

describe('buildSiblingIndex - anchor transcript_refs path (TODO bug 2026-05-13)', () => {
  function insertLexSession(id: string): void {
    /* lex_session is the durable anchor; brainstorm.id == lex_session.id
     * per the spec, but the foreign-key constraint on
     * lex_transcript_ref requires the row to actually exist before
     * inserts are accepted. */
    db.insertLexSession({
      id,
      created_ms: 1_000,
      title: null,
      derived_title: null,
      status: 'dormant',
      current_pty_id: null,
      cwd: 'C:/p/lex',
    });
  }

  function insertRef(opts: {
    anchorId: string;
    cc: string;
    transcriptPath: string;
    ordering: number;
    startedMs: number;
    endedMs?: number | null;
  }): void {
    db.insertLexTranscriptRef({
      lex_session_id: opts.anchorId,
      cc_session_id: opts.cc,
      transcript_path: opts.transcriptPath,
      started_ms: opts.startedMs,
      ended_ms: opts.endedMs ?? null,
      ordering: opts.ordering,
    });
  }

  it('renders prior session blocks from listLexTranscriptRefs (no label match required)', () => {
    insertLexSession('anchor-1');
    insertBs({
      id: 'anchor-1',
      user_label: 'DevNeural Testing',
      started_ms: 1_000,
      last_summary: 'first thing we decided / second open item',
    });
    insertRef({
      anchorId: 'anchor-1',
      cc: 'cc-old',
      transcriptPath: '/fake/old.jsonl',
      ordering: 0,
      startedMs: Date.now() - 7_200_000,
      endedMs: Date.now() - 7_200_000,
    });
    insertRef({
      anchorId: 'anchor-1',
      cc: 'cc-current',
      transcriptPath: '/fake/current.jsonl',
      ordering: 1,
      startedMs: Date.now() - 60_000,
    });
    const out = buildSiblingIndex({
      db,
      label: 'DevNeural Testing',
      anchorId: 'anchor-1',
      currentCcSessionId: 'cc-current',
      readTranscript: (p) => {
        if (p === '/fake/old.jsonl') {
          return [
            JSON.stringify({
              type: 'user',
              message: { role: 'user', content: 'do the bracketed paste fix' },
            }),
            JSON.stringify({
              type: 'assistant',
              message: {
                role: 'assistant',
                content: [
                  { type: 'text', text: 'landed in commit b943f10' },
                ],
              },
            }),
          ].join('\n');
        }
        return null;
      },
    });
    expect(out).toMatch(/^# Prior Lex sessions on this anchor/);
    expect(out).toMatch(/## Prior session 1/);
    expect(out).toMatch(/Summary: first thing we decided/);
    expect(out).toMatch(/- user: do the bracketed paste fix/);
    expect(out).toMatch(/- assistant: landed in commit b943f10/);
    /* Current session must not appear */
    expect(out).not.toMatch(/cc-current/);
  });

  it('returns nothing from anchor-path when the anchor has only the current ref (1 ref total)', () => {
    insertLexSession('anchor-solo');
    insertBs({
      id: 'anchor-solo',
      user_label: null,
      started_ms: 1_000,
    });
    insertRef({
      anchorId: 'anchor-solo',
      cc: 'cc-only',
      transcriptPath: '/fake/only.jsonl',
      ordering: 0,
      startedMs: Date.now(),
    });
    const out = buildSiblingIndex({
      db,
      label: null,
      anchorId: 'anchor-solo',
      currentCcSessionId: 'cc-only',
      readTranscript: () => 'irrelevant',
    });
    expect(out).toBe('');
  });

  it('skips refs whose transcript file is missing without crashing', () => {
    insertLexSession('anchor-missing');
    insertBs({
      id: 'anchor-missing',
      user_label: null,
      started_ms: 1_000,
    });
    insertRef({
      anchorId: 'anchor-missing',
      cc: 'cc-missing',
      transcriptPath: '/fake/does-not-exist.jsonl',
      ordering: 0,
      startedMs: Date.now() - 3_600_000,
    });
    insertRef({
      anchorId: 'anchor-missing',
      cc: 'cc-now',
      transcriptPath: '/fake/current.jsonl',
      ordering: 1,
      startedMs: Date.now(),
    });
    /* readTranscript returns null for the missing file and there is
     * no distillation in last_summary, so renderPriorRefSection skips
     * the entry entirely. With no other prior refs, the anchor-path
     * yields nothing and the helper falls back to label-match (which
     * also yields nothing without a label). */
    const out = buildSiblingIndex({
      db,
      label: null,
      anchorId: 'anchor-missing',
      currentCcSessionId: 'cc-now',
      readTranscript: () => null,
    });
    expect(out).toBe('');
  });

  it('falls back to legacy label-match when the anchor has zero prior refs', () => {
    insertLexSession('anchor-new');
    insertBs({
      id: 'anchor-new',
      user_label: 'Shared Topic',
      started_ms: 5_000,
    });
    insertBs({
      id: 'anchor-other',
      user_label: 'Shared Topic',
      started_ms: 1_000,
      last_summary: 'earlier brainstorm notes',
    });
    /* No transcript refs registered for anchor-new → buildAnchorTranscriptBlock
     * returns ''. The label-match fallback should still pick up
     * anchor-other. */
    const out = buildSiblingIndex({
      db,
      label: 'Shared Topic',
      anchorId: 'anchor-new',
      excludeId: 'anchor-new',
    });
    expect(out).toMatch(/^# Sibling sessions \(same label "Shared Topic"\)/);
    expect(out).toMatch(/- anchor-o/);
  });

  it('strictScope blocks the label-match fallback when the anchor has zero refs (no cross-project bleed)', () => {
    insertLexSession('anchor-new');
    insertBs({
      id: 'anchor-new',
      user_label: 'Shared Topic',
      started_ms: 5_000,
    });
    insertBs({
      id: 'anchor-other',
      user_label: 'Shared Topic',
      started_ms: 1_000,
      last_summary: 'earlier brainstorm notes from a DIFFERENT project',
    });
    /* Same zero-refs setup as the legacy fallback test, but strictScope
     * forbids dropping to label-match. An LPCC session sharing a name
     * with a DevNeural brainstorm must surface nothing, not the other
     * project's notes. */
    const out = buildSiblingIndex({
      db,
      label: 'Shared Topic',
      anchorId: 'anchor-new',
      excludeId: 'anchor-new',
      strictScope: true,
    });
    expect(out).toBe('');
  });

  it('strictScope still renders the anchor block when the anchor HAS refs', () => {
    insertLexSession('anchor-strict');
    insertBs({
      id: 'anchor-strict',
      user_label: 'Strict Anchor',
      started_ms: 1_000,
      last_summary: 'a real decision / a real open item',
    });
    insertRef({
      anchorId: 'anchor-strict',
      cc: 'cc-prior',
      transcriptPath: '/fake/strict-prior.jsonl',
      ordering: 0,
      startedMs: Date.now() - 7_200_000,
      endedMs: Date.now() - 7_200_000,
    });
    insertRef({
      anchorId: 'anchor-strict',
      cc: 'cc-live',
      transcriptPath: '/fake/strict-live.jsonl',
      ordering: 1,
      startedMs: Date.now() - 60_000,
    });
    /* strictScope must NOT break the happy path: an anchor with real
     * refs still renders its own scoped block. */
    const out = buildSiblingIndex({
      db,
      label: 'Strict Anchor',
      anchorId: 'anchor-strict',
      currentCcSessionId: 'cc-live',
      strictScope: true,
      readTranscript: (p) =>
        p === '/fake/strict-prior.jsonl'
          ? JSON.stringify({
              type: 'assistant',
              message: { role: 'assistant', content: 'prior turn body' },
            })
          : null,
    });
    expect(out).not.toBe('');
  });
});

/* Codex item 12a (Fix 49) parallel scope swap for buildLabelMatchBlock.
 * preloadSiblingDistillations already prefers project_scope_id over
 * user_label when both the active anchor and the candidate row carry
 * non-null scope; the sibling-index label-match block now mirrors that
 * predicate. The same insertBs helper above does not stamp
 * project_scope_id, so this block uses a thicker fixture that writes
 * the column on the row. */
function insertBsWithScope(opts: {
  id: string;
  user_label: string | null;
  started_ms: number;
  project_scope_id: string | null;
  last_summary?: string | null;
}): void {
  db.insertBrainstorm({
    id: opts.id,
    claude_session_id: null,
    pty_id: null,
    cwd: 'C:/p/lex',
    user_label: opts.user_label,
    derived_label: null,
    mode: 'conversation',
    status: 'active',
    started_ms: opts.started_ms,
    ended_ms: null,
    turn_count: 0,
    topic_tags_json: '[]',
    artifacts_json: '{}',
    last_summary: opts.last_summary ?? null,
    last_summary_ms: null,
    project_scope_id: opts.project_scope_id,
  });
}

describe('buildSiblingIndex - project_scope_id parallel swap (codex 12a)', () => {
  it('groups by scope when both active and candidate carry non-null scope, ignoring label divergence', () => {
    insertBsWithScope({
      id: 'anchor-active',
      user_label: 'Active Label',
      started_ms: 5_000,
      project_scope_id: 'proj-A',
    });
    insertBsWithScope({
      id: 'anchor-sib-1',
      user_label: 'Different Label',
      started_ms: 4_000,
      project_scope_id: 'proj-A',
      last_summary: 'sibling one',
    });
    insertBsWithScope({
      id: 'anchor-noise',
      user_label: 'Active Label',
      started_ms: 3_000,
      project_scope_id: 'proj-B',
      last_summary: 'noise',
    });
    const out = buildSiblingIndex({
      db,
      label: 'Active Label',
      anchorId: 'anchor-active',
      excludeId: 'anchor-active',
      projectScopeId: 'proj-A',
    });
    expect(out).toMatch(/^# Sibling sessions \(same project scope proj-A\)/);
    expect(out).toMatch(/- anchor-s/);
    expect(out).not.toMatch(/- anchor-n/);
  });

  it('falls back to label match when the candidate has no scope but labels align (legacy compat)', () => {
    insertBsWithScope({
      id: 'anchor-active2',
      user_label: 'Legacy Label',
      started_ms: 5_000,
      project_scope_id: 'proj-A',
    });
    insertBsWithScope({
      id: 'anchor-legacy',
      user_label: 'Legacy Label',
      started_ms: 4_000,
      project_scope_id: null,
      last_summary: 'pre-scope brainstorm',
    });
    const out = buildSiblingIndex({
      db,
      label: 'Legacy Label',
      anchorId: 'anchor-active2',
      excludeId: 'anchor-active2',
      projectScopeId: 'proj-A',
    });
    /* Legacy row has null scope -> the row falls through to the
     * label-match branch and still surfaces. Header reports the
     * scope-grouping because the active anchor carries one. */
    expect(out).toMatch(/^# Sibling sessions \(same project scope proj-A\)/);
    expect(out).toMatch(/- anchor-l/);
  });

  it('keeps label match for two siblings with different scopes but the same label (kill-label deferred)', () => {
    /* Until the 2026-06-25 kill-label calendar, two rows that
     * differ on scope but agree on label still surface via the
     * label branch when the active anchor has no scope set. */
    insertBsWithScope({
      id: 'anchor-no-scope',
      user_label: 'Common Label',
      started_ms: 5_000,
      project_scope_id: null,
    });
    insertBsWithScope({
      id: 'anchor-x',
      user_label: 'Common Label',
      started_ms: 4_000,
      project_scope_id: 'scope-x',
      last_summary: 'x notes',
    });
    insertBsWithScope({
      id: 'anchor-y',
      user_label: 'Common Label',
      started_ms: 3_000,
      project_scope_id: 'scope-y',
      last_summary: 'y notes',
    });
    const out = buildSiblingIndex({
      db,
      label: 'Common Label',
      anchorId: 'anchor-no-scope',
      excludeId: 'anchor-no-scope',
      projectScopeId: null,
    });
    expect(out).toMatch(/^# Sibling sessions \(same label "Common Label"\)/);
    expect(out).toMatch(/- anchor-x/);
    expect(out).toMatch(/- anchor-y/);
  });
});
