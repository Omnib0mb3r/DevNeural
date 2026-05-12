/**
 * Project anchor model (docs/spec/PROJECT-ANCHORS.md, step 1 of 6).
 *
 * Mirrors the lex_session anchor pattern shipped in migration 018.
 * Introduces a durable per-project identity that survives daemon
 * restarts and Claude Code process exits, decoupled from any
 * individual CC session UUID.
 *
 * project_session  (durable anchor, daemon-owned identity)
 *   id                  TEXT PK             uuid; canonical project anchor id
 *   project_slug        TEXT UNIQUE         folder basename
 *   cwd                 TEXT UNIQUE         absolute path, join key for bridge binding
 *   title               TEXT                display name (defaults to slug, user-editable)
 *   status              TEXT NOT NULL       'live' | 'dormant'
 *   current_session_id  TEXT                CC session UUID bound while live
 *   current_bridge_id   TEXT                bridge connection id while live
 *   current_pty_id      TEXT                daemon-owned PTY id (NULL for externally launched)
 *   created_ms          INTEGER NOT NULL    first-seen timestamp
 *   last_seen_ms        INTEGER NOT NULL    most recent live->dormant transition
 *
 * project_transcript_ref  (ordered list of CC transcripts per anchor)
 *   id           TEXT PK             uuid
 *   anchor_id    TEXT NOT NULL FK -> project_session(id) ON DELETE CASCADE
 *   cc_session_id TEXT UNIQUE        claude session uuid for this jsonl
 *   jsonl_path   TEXT NOT NULL       absolute path to the jsonl, resolved at insert time
 *   opened_ms    INTEGER NOT NULL    when session attached to anchor
 *   closed_ms    INTEGER             NULL while open
 *
 * Backfill: walks ~/.claude/projects/<slug>/*.jsonl, reads the first
 * line of each to extract its cwd, groups by cwd, creates one anchor
 * per distinct cwd, and inserts one transcript_ref per jsonl. All
 * backfilled anchors start as 'dormant' (no bridge connections at
 * boot); the bridge wire-up in step 2 of the migration plan will flip
 * them live on handshake. Backfilled transcript_refs get closed_ms =
 * mtime so they don't show as perpetually open. jsonls with no cwd
 * line are skipped (orphan).
 *
 * Seeding: every top-level subdirectory of DEVNEURAL_PROJECTS_ROOT
 * (default C:/dev/Projects) that doesn't already have an anchor gets
 * one inserted as dormant with no transcript_refs. Folders removed
 * from disk are NOT auto-deleted from the anchor table; explicit user
 * delete is the only removal path.
 *
 * Idempotency: filename guards repeated runs at the migration-runner
 * level. Inserts use INSERT OR IGNORE so a manual partial replay is
 * also safe.
 */
import type Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

interface TranscriptLine {
  cwd?: string;
  sessionId?: string;
  session_id?: string;
  timestamp?: string;
}

function projectsRoot(): string {
  return (
    process.env.DEVNEURAL_PROJECTS_ROOT ?? 'C:/dev/Projects'
  ).replace(/\\/g, '/');
}

function claudeProjectsDir(): string {
  return path.posix.join(
    os.homedir().replace(/\\/g, '/'),
    '.claude',
    'projects',
  );
}

function normalizeCwd(cwd: string): string {
  return cwd.replace(/\\/g, '/').replace(/\/+$/, '');
}

function basenameOf(cwd: string): string {
  const norm = normalizeCwd(cwd);
  const i = norm.lastIndexOf('/');
  return i >= 0 ? norm.slice(i + 1) : norm;
}

function readFirstJsonLine(file: string): TranscriptLine | null {
  /* Read up to 64KB; first complete line is enough to extract cwd.
   * Avoids loading multi-MB transcripts during a backfill that may
   * see hundreds of jsonls. */
  let fd: number | null = null;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(64 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const text = buf.slice(0, n).toString('utf-8');
    const nl = text.indexOf('\n');
    const firstLine = nl >= 0 ? text.slice(0, nl) : text;
    if (!firstLine.trim()) return null;
    return JSON.parse(firstLine) as TranscriptLine;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

function parseTimestampMs(ts: string | undefined, fallback: number): number {
  if (!ts) return fallback;
  const n = Date.parse(ts);
  return Number.isFinite(n) ? n : fallback;
}

interface JsonlInfo {
  ccSessionId: string;
  jsonlPath: string;
  cwd: string;
  openedMs: number;
  closedMs: number;
}

function collectJsonls(): JsonlInfo[] {
  const root = claudeProjectsDir();
  if (!fs.existsSync(root)) return [];
  const out: JsonlInfo[] = [];
  let slugs: string[];
  try {
    slugs = fs.readdirSync(root);
  } catch {
    return [];
  }
  for (const slug of slugs) {
    const slugDir = path.posix.join(root, slug);
    let entries: string[];
    try {
      const stat = fs.statSync(slugDir);
      if (!stat.isDirectory()) continue;
      entries = fs.readdirSync(slugDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;
      const jsonl = path.posix.join(slugDir, entry);
      let mtime = Date.now();
      try {
        mtime = fs.statSync(jsonl).mtimeMs;
      } catch {
        /* ignore */
      }
      const first = readFirstJsonLine(jsonl);
      if (!first || typeof first.cwd !== 'string') continue;
      const cwd = normalizeCwd(first.cwd);
      const ccSessionId =
        (typeof first.sessionId === 'string' && first.sessionId) ||
        (typeof first.session_id === 'string' && first.session_id) ||
        entry.replace(/\.jsonl$/, '');
      const openedMs = parseTimestampMs(first.timestamp, mtime);
      out.push({
        ccSessionId,
        jsonlPath: jsonl,
        cwd,
        openedMs,
        closedMs: mtime,
      });
    }
  }
  return out;
}

export default function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_session (
      id                  TEXT PRIMARY KEY,
      project_slug        TEXT NOT NULL UNIQUE,
      cwd                 TEXT NOT NULL UNIQUE,
      title               TEXT,
      status              TEXT NOT NULL DEFAULT 'dormant'
                            CHECK (status IN ('live','dormant')),
      current_session_id  TEXT,
      current_bridge_id   TEXT,
      current_pty_id      TEXT,
      created_ms          INTEGER NOT NULL,
      last_seen_ms        INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_project_session_status
      ON project_session (status, last_seen_ms DESC);
    CREATE INDEX IF NOT EXISTS idx_project_session_cwd
      ON project_session (cwd);

    CREATE TABLE IF NOT EXISTS project_transcript_ref (
      id             TEXT PRIMARY KEY,
      anchor_id      TEXT NOT NULL,
      cc_session_id  TEXT NOT NULL UNIQUE,
      jsonl_path     TEXT NOT NULL,
      opened_ms      INTEGER NOT NULL,
      closed_ms      INTEGER,
      FOREIGN KEY (anchor_id) REFERENCES project_session(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_project_transcript_ref_anchor
      ON project_transcript_ref (anchor_id, opened_ms);
  `);

  const insertAnchor = db.prepare(`
    INSERT OR IGNORE INTO project_session
      (id, project_slug, cwd, title, status, current_session_id,
       current_bridge_id, current_pty_id, created_ms, last_seen_ms)
    VALUES (?, ?, ?, ?, 'dormant', NULL, NULL, NULL, ?, ?)
  `);
  const insertRef = db.prepare(`
    INSERT OR IGNORE INTO project_transcript_ref
      (id, anchor_id, cc_session_id, jsonl_path, opened_ms, closed_ms)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const findAnchorByCwd = db.prepare(
    `SELECT id, created_ms, last_seen_ms FROM project_session WHERE cwd = ?`,
  );
  const updateAnchorTimestamps = db.prepare(
    `UPDATE project_session
       SET created_ms = MIN(created_ms, ?),
           last_seen_ms = MAX(last_seen_ms, ?)
     WHERE id = ?`,
  );

  /* Slug collision handling: two distinct cwds can share a folder
   * basename (e.g. C:/dev/Projects/foo and D:/foo). project_slug is
   * UNIQUE per spec, so disambiguate by appending a short cwd hash
   * when the slug would collide with an existing row. */
  const slugInUse = db.prepare(
    `SELECT 1 FROM project_session WHERE project_slug = ? AND cwd != ?`,
  );

  function resolveSlug(cwd: string): string {
    const base = basenameOf(cwd) || cwd;
    if (!slugInUse.get(base, cwd)) return base;
    const hash = Buffer.from(cwd).toString('hex').slice(0, 6);
    return `${base}-${hash}`;
  }

  /* Step A: backfill from existing CC jsonls. */
  const jsonls = collectJsonls();
  const byCwd = new Map<string, JsonlInfo[]>();
  for (const j of jsonls) {
    const list = byCwd.get(j.cwd);
    if (list) list.push(j);
    else byCwd.set(j.cwd, [j]);
  }

  let anchors = 0;
  let refs = 0;
  for (const [cwd, list] of byCwd) {
    const minOpened = list.reduce(
      (m, j) => Math.min(m, j.openedMs),
      Number.POSITIVE_INFINITY,
    );
    const maxClosed = list.reduce((m, j) => Math.max(m, j.closedMs), 0);
    const existing = findAnchorByCwd.get(cwd) as
      | { id: string; created_ms: number; last_seen_ms: number }
      | undefined;
    let anchorId: string;
    if (existing) {
      anchorId = existing.id;
      updateAnchorTimestamps.run(minOpened, maxClosed, anchorId);
    } else {
      anchorId = randomUUID();
      const slug = resolveSlug(cwd);
      insertAnchor.run(anchorId, slug, cwd, slug, minOpened, maxClosed);
      anchors += 1;
    }
    for (const j of list) {
      insertRef.run(
        randomUUID(),
        anchorId,
        j.ccSessionId,
        j.jsonlPath,
        j.openedMs,
        j.closedMs,
      );
      refs += 1;
    }
  }

  /* Step B: seed any C:/dev/Projects/* subdirectory that doesn't yet
   * have an anchor. Dormant, no transcript_refs. */
  let seeded = 0;
  const projects = projectsRoot();
  if (fs.existsSync(projects)) {
    let entries: string[];
    try {
      entries = fs.readdirSync(projects);
    } catch {
      entries = [];
    }
    const now = Date.now();
    for (const entry of entries) {
      const full = path.posix.join(projects, entry);
      let isDir = false;
      try {
        isDir = fs.statSync(full).isDirectory();
      } catch {
        /* ignore */
      }
      if (!isDir) continue;
      const cwd = normalizeCwd(full);
      if (findAnchorByCwd.get(cwd)) continue;
      const anchorId = randomUUID();
      const slug = resolveSlug(cwd);
      insertAnchor.run(anchorId, slug, cwd, slug, now, now);
      seeded += 1;
    }
  }

  process.stderr.write(
    `[019-project-anchors] backfilled anchors=${anchors} refs=${refs} seeded_dormant=${seeded}\n`,
  );
}
