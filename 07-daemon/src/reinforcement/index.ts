/**
 * Reinforcement loop.
 *
 * After /curate produces an injection for a session, we record
 * (sessionId → {pageId, prompt, timestamp}) in a pending-injection
 * tracker. When the transcript watcher sees the next assistant turn
 * for that session, we measure whether the reply leaned on the
 * injected page (cosine over reply vs page summary). When the next
 * user prompt arrives, we look for correction language.
 *
 * Outcomes:
 *   - HIT: weight ↑ (1 - w) * 0.05, hits++.
 *   - CORRECTION: weight ↓ w * 0.10, corrections++, blacklist for session.
 *   - NEITHER: slow decay weight *= 0.995.
 *
 * Promotion:
 *   - A pending page with a HIT (no correction within N turns) is
 *     promoted to canonical immediately. Useful retrieval is the
 *     empirical proof a page transfers.
 *   - A pending page with corrections >= 3 is archived.
 *
 * Coverage gap and bypass signals fire from the curator path when
 * raw chunks outrank or fill gaps that wiki pages do not cover.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { embedOne } from '../embedder/index.js';
import type { Store } from '../store/index.js';
import {
  parsePage,
  writePage,
  type PageFrontmatter,
} from '../wiki/schema.js';
import {
  wikiPagesDir,
  wikiPendingDir,
  wikiArchiveDir,
  DATA_ROOT,
  ensureDir,
} from '../paths.js';
import { appendLog, commitWiki } from '../wiki/scaffolding.js';
import { blacklistPageForSession } from '../curation/curator.js';

const HIT_COSINE = Number(process.env.DEVNEURAL_HIT_COSINE ?? 0.65);
const HIT_WEIGHT_GAIN = 0.05;
const CORRECTION_WEIGHT_LOSS = 0.10;
const DECAY_PER_SESSION = 0.995;
const ARCHIVE_FLOOR = 0.15;
const PENDING_TTL_MS = 10 * 60 * 1000; // 10 min — stale pending discarded

const CORRECTION_PATTERNS = [
  /\bno\b/i,
  /\bactually\b/i,
  /\bwrong\b/i,
  /\bincorrect\b/i,
  /\bnot what i\b/i,
  /\bthat['’]s not\b/i,
  /\binstead\b/i,
  /\brevert\b/i,
  /\bundo\b/i,
];

/* `kind: 'wiki'` is the original path: a wiki page was injected, on a
 * hit we bump its weight and on three corrections we archive it.
 *
 * `kind: 'raw'` covers the bestRaw fallback that fires when no canonical
 * wiki page covers the prompt. There is no page to weight, so on a hit
 * we instead schedule a wiki distillation pass with the chunk text as
 * source material. The next time a similar prompt arrives the wiki
 * version should win and reinforcement collapses back to the wiki path.
 * Without this, transcript-only matches never produced reinforcement
 * events and the wiki could not grow from real conversation evidence. */
interface Pending {
  sessionId: string;
  kind: 'wiki' | 'raw';
  pageId: string;
  pagePath: string;
  injectedAt: number;
  summary: string;
  // raw-only:
  projectId?: string;
  rawText?: string;
}

const pending = new Map<string, Pending>();

const reinforcementLog = path.posix.join(DATA_ROOT, 'reinforcement.log.jsonl');

function appendReinforcementLog(entry: Record<string, unknown>): void {
  ensureDir(DATA_ROOT);
  try {
    fs.appendFileSync(
      reinforcementLog,
      JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n',
      'utf-8',
    );
  } catch (err) {
    // Surface I/O failures to the daemon log instead of swallowing them.
    // A silent reinforcement.log.jsonl write failure was indistinguishable
    // from "no events fired yet" in the dashboard digest, which made
    // diagnosing a dead reinforcement loop impossible.
    process.stderr.write(
      `[reinforcement] append failed: ${(err as Error).message}\n`,
    );
  }
  // Mirror the high-signal kinds into the dashboard notification feed so
  // the user sees the brain learning in real time. Lazy import so the
  // reinforcement loop stays loadable even when the dashboard module
  // fails to initialize (e.g. during smoke tests). All notifications
  // are info-level except corrections (warn), which the user typically
  // wants to look at sooner.
  void (async () => {
    try {
      const kind = entry.kind as string | undefined;
      if (!kind) return;
      const { emitNotification } = await import('../dashboard/notifications.js');
      const page = (entry.page as string | undefined) ?? '';
      const session = (entry.session as string | undefined) ?? '';
      const link = page
        ? `/wiki?page=${encodeURIComponent(page)}`
        : session
          ? `/sessions/detail?id=${encodeURIComponent(session)}`
          : undefined;
      switch (kind) {
        case 'injection': {
          // Fired the moment the curator decides to inject. Visibility
          // matters: injection is invisible to the user inside the CC
          // terminal (it goes in as additional context, not chat
          // output), so the dashboard rail is the only place to spot
          // bad recommendations before they steer Claude. Click takes
          // the user to the wiki page so they can vet it.
          const source = (entry.source as string | undefined) ?? 'wiki';
          const target = (entry.chunk as string | undefined) ?? page;
          const targetLink =
            source === 'wiki' && page
              ? `/wiki?page=${encodeURIComponent(page)}`
              : link;
          emitNotification({
            severity: 'info',
            source: 'curator',
            title: `Lex injected ${source}: ${target || '(unknown)'}`,
            body: `Lex pulled this into the next prompt as additional context. Click to inspect; if it looks wrong, ignore it in your reply and the reinforcement loop will demote it on its own.`,
            ...(targetLink ? { link: targetLink } : {}),
          });
          break;
        }
        case 'promote':
          emitNotification({
            severity: 'info',
            source: 'reinforcement',
            title: `Wiki promoted: ${page || '(unknown)'}`,
            body: `Pending page reinforced into canonical (cosine ${(entry.cosine as number | undefined)?.toFixed(2) ?? '?'}).`,
            ...(link ? { link } : {}),
          });
          break;
        case 'hit':
          emitNotification({
            severity: 'info',
            source: 'reinforcement',
            title: `Wiki reinforced: ${page || '(unknown)'}`,
            body: `Page weight raised on retrieval hit (cosine ${(entry.cosine as number | undefined)?.toFixed(2) ?? '?'}).`,
            ...(link ? { link } : {}),
          });
          break;
        case 'raw-hit':
          emitNotification({
            severity: 'info',
            source: 'reinforcement',
            title: `Transcript chunk reinforced`,
            body: `Raw transcript hit queued for wiki distillation (cosine ${(entry.cosine as number | undefined)?.toFixed(2) ?? '?'}).`,
            ...(link ? { link } : {}),
          });
          break;
        case 'correction':
          emitNotification({
            severity: 'warn',
            source: 'reinforcement',
            title: `Page demoted: ${page || '(unknown)'}`,
            body: `User correction signal lowered the page weight.`,
            ...(link ? { link } : {}),
          });
          break;
      }
    } catch {
      /* notification emission is best-effort */
    }
  })();
}

export function recordInjection(
  sessionId: string,
  pageId: string,
  pagePath: string,
  summary: string,
): void {
  pending.set(sessionId, {
    sessionId,
    kind: 'wiki',
    pageId,
    pagePath,
    injectedAt: Date.now(),
    summary,
  });
  // Also write a visible "injection" event so the dashboard can surface
  // what the curator decided to send. Without this, the only way to
  // know an injection fired was to read the daemon log or wait for the
  // hit/correction outcome — opaque to the user.
  appendReinforcementLog({
    kind: 'injection',
    session: sessionId,
    page: pageId,
    source: 'wiki',
  });
}

export function recordRawInjection(
  sessionId: string,
  chunkId: string,
  rawText: string,
  projectId: string,
): void {
  pending.set(sessionId, {
    sessionId,
    kind: 'raw',
    pageId: chunkId,
    pagePath: '',
    injectedAt: Date.now(),
    summary: rawText,
    projectId,
    rawText,
  });
  appendReinforcementLog({
    kind: 'injection',
    session: sessionId,
    chunk: chunkId,
    project: projectId,
    source: 'raw',
  });
}

export function clearPending(sessionId: string): void {
  pending.delete(sessionId);
}

export function getPending(sessionId: string): Pending | null {
  const p = pending.get(sessionId);
  if (!p) return null;
  if (Date.now() - p.injectedAt > PENDING_TTL_MS) {
    pending.delete(sessionId);
    return null;
  }
  return p;
}

export interface PageOnDisk {
  filePath: string;
  raw: string;
  frontmatter: PageFrontmatter;
  body: string;
}

function findPageFile(pageId: string): string | null {
  for (const dir of [wikiPagesDir(), wikiPendingDir(), wikiArchiveDir()]) {
    const file = path.posix.join(dir, `${pageId}.md`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

export function loadPage(pageId: string): PageOnDisk | null {
  const filePath = findPageFile(pageId);
  if (!filePath) return null;
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = parsePage(raw);
  return {
    filePath,
    raw,
    frontmatter: parsed.frontmatter,
    body: raw,
  };
}

export function rewritePageFrontmatter(
  page: PageOnDisk,
  fm: PageFrontmatter,
): void {
  // Preserve body (everything after the second `---`); rewrite only frontmatter.
  const parsed = parsePage(page.raw);
  const dir = path.dirname(page.filePath).replace(/\\/g, '/');
  writePage(dir, { frontmatter: fm, sections: parsed.sections });
}

export function moveTo(page: PageOnDisk, targetDir: string): string {
  const fileName = path.basename(page.filePath);
  const target = path.posix.join(targetDir, fileName);
  ensureDir(targetDir);
  fs.copyFileSync(page.filePath, target);
  fs.unlinkSync(page.filePath);
  return target;
}

/* Fire-and-forget wiki distillation triggered by a raw-injection hit.
 * Pulls projectName from the registry so runIngest has the metadata it
 * needs; if the project is missing or the chunk text is too short, log
 * the skip reason and bail. Any throw during ingest surfaces to stderr
 * via appendReinforcementLog's diagnostic path — we never let the
 * reinforcement evaluator throw to the transcript watcher. */
async function scheduleRawHitIngest(
  store: Store,
  p: Pending,
  log: (msg: string) => void,
): Promise<void> {
  try {
    const text = (p.rawText ?? p.summary ?? '').trim();
    if (text.length < 40) {
      log(`[reinforce] raw-hit ingest skipped: text too short (${text.length}b)`);
      return;
    }
    if (!p.projectId) {
      log(`[reinforce] raw-hit ingest skipped: no projectId on pending`);
      return;
    }
    const { getProject } = await import('../identity/registry.js');
    const project = getProject(p.projectId);
    const projectName = project?.name ?? p.projectId;
    const { runIngest } = await import('../wiki/ingest.js');
    const result = await runIngest(
      store,
      {
        source: `raw-hit:${p.pageId}`,
        projectId: p.projectId,
        projectName,
        newContent: text,
        evidenceHints: [
          `raw transcript chunk ${p.pageId} matched assistant reply at hit cosine`,
        ],
      },
      log,
    );
    appendReinforcementLog({
      kind: 'raw-hit-ingest',
      session: p.sessionId,
      chunk: p.pageId,
      project: p.projectId,
      pages_created: result.pages_created.length,
      pages_updated: result.pages_updated.length,
      skipped_reason: result.skipped_reason,
    });
    log(
      `[reinforce] raw-hit ingest done: created=${result.pages_created.length} updated=${result.pages_updated.length}${result.skipped_reason ? ' skip=' + result.skipped_reason : ''}`,
    );
  } catch (err) {
    process.stderr.write(
      `[reinforcement] raw-hit ingest failed: ${(err as Error).message}\n`,
    );
  }
}

export async function reindexPage(store: Store, page: PageOnDisk): Promise<void> {
  const fm = page.frontmatter;
  const tsMs = Date.now();
  store.db.upsertWikiPage(
    {
      id: fm.id,
      title: fm.title,
      trigger: fm.trigger,
      insight: fm.insight,
      status: fm.status,
      weight: fm.weight,
      hits: fm.hits,
      corrections: fm.corrections,
      created_ms: new Date(fm.created).getTime() || tsMs,
      last_touched_ms: tsMs,
      projects_json: JSON.stringify(fm.projects),
      human_edited: fm.human_edited ? 1 : 0,
    },
    parsePage(page.raw).sections.pattern,
  );
  const embedText = `${fm.title}\n${fm.summary}\n${parsePage(page.raw).sections.pattern.slice(0, 2000)}`;
  const vec = await embedOne(embedText);
  await store.wikiPages.add({
    id: fm.id,
    vector: vec,
    metadata: {
      status: fm.status,
      weight: fm.weight,
      trigger: fm.trigger,
      insight: fm.insight,
      title: fm.title,
    },
  });
}

export async function evaluateAssistantReply(
  store: Store,
  sessionId: string,
  replyText: string,
  log: (msg: string) => void = () => undefined,
): Promise<void> {
  const p = getPending(sessionId);
  if (!p) return;
  if (replyText.trim().length < 80) return; // skip empty / trivial

  let cosine = 0;
  try {
    const replyVec = await embedOne(replyText.slice(0, 4000));
    const summaryVec = await embedOne(p.summary.slice(0, 4000));
    cosine = dot(replyVec, summaryVec);
  } catch {
    return;
  }

  if (cosine < HIT_COSINE) {
    appendReinforcementLog({
      kind: p.kind === 'raw' ? 'raw-no-hit' : 'no-hit',
      session: sessionId,
      page: p.pageId,
      cosine,
    });
    // Drop the pending after the FIRST assistant turn so subsequent
    // turns in the same session don't re-evaluate the same injection
    // and emit a duplicate no-hit (or a stale false hit when the
    // conversation later happens to mention the page).
    pending.delete(sessionId);
    return;
  }

  // HIT path. Raw injections do not have a page to weight; instead we
  // schedule a wiki ingest pass so the chunk can crystallize into a
  // page. Future identical prompts will then match the wiki and
  // reinforcement collapses back to the canonical wiki path.
  if (p.kind === 'raw') {
    appendReinforcementLog({
      kind: 'raw-hit',
      session: sessionId,
      chunk: p.pageId,
      project: p.projectId,
      cosine,
    });
    log(`[reinforce] raw-hit on chunk ${p.pageId} (cosine ${cosine.toFixed(2)}); scheduling wiki ingest`);
    pending.delete(sessionId);
    void scheduleRawHitIngest(store, p, log);
    return;
  }

  const page = loadPage(p.pageId);
  if (!page) return;
  const fm = { ...page.frontmatter };
  fm.hits = (fm.hits ?? 0) + 1;
  fm.weight = Math.min(1, fm.weight + (1 - fm.weight) * HIT_WEIGHT_GAIN);
  const wasPending = fm.status === 'pending';
  if (wasPending) {
    fm.status = 'canonical';
  }
  rewritePageFrontmatter(page, fm);
  if (wasPending) {
    const newPath = moveTo({ ...page, frontmatter: fm }, wikiPagesDir());
    log(`[reinforce] promoted ${p.pageId} to canonical (hit cosine ${cosine.toFixed(2)})`);
    appendReinforcementLog({
      kind: 'promote',
      session: sessionId,
      page: p.pageId,
      cosine,
    });
    appendLog(`reinforce: promoted ${p.pageId} to canonical (hit cosine ${cosine.toFixed(2)})`);
    void reindexPage(store, {
      ...page,
      filePath: newPath,
      frontmatter: fm,
    });
  } else {
    appendReinforcementLog({
      kind: 'hit',
      session: sessionId,
      page: p.pageId,
      cosine,
      weight: fm.weight,
    });
    void reindexPage(store, { ...page, frontmatter: fm });
  }
  // Hit consumed: drop pending so the same injection can't be
  // reinforced twice from later assistant turns in this session.
  pending.delete(sessionId);
  commitWiki(`reinforce hit ${p.pageId}`);
}

/**
 * Direct, session-less correction. Used by the dashboard's "this was
 * wrong" button on a curator-injection notification: the user has no
 * pending session context (they may not even be in a Claude session),
 * they just want to flag the page as bad recall. Same weight-loss and
 * archive-on-3 semantics as evaluateCorrection's wiki branch, minus
 * the session pending lookup and blacklist.
 */
export async function correctWikiPageById(
  store: Store,
  pageId: string,
  log: (msg: string) => void = () => undefined,
): Promise<{ ok: true; weight: number; corrections: number; archived: boolean } | { ok: false; error: string }> {
  const page = loadPage(pageId);
  if (!page) return { ok: false, error: `wiki page ${pageId} not found` };
  const fm = { ...page.frontmatter };
  fm.corrections = (fm.corrections ?? 0) + 1;
  fm.weight = Math.max(0, fm.weight - fm.weight * CORRECTION_WEIGHT_LOSS);
  rewritePageFrontmatter(page, fm);
  appendReinforcementLog({
    kind: 'correction',
    session: 'manual',
    page: pageId,
    weight: fm.weight,
  });
  log(`[reinforce] manual correction on ${pageId}: weight=${fm.weight.toFixed(2)}`);
  appendLog(`reinforce: manual correction on ${pageId} (weight ${fm.weight.toFixed(2)})`);
  let archived = false;
  let final = { ...page, frontmatter: fm };
  if (fm.corrections >= 3 && fm.weight < ARCHIVE_FLOOR) {
    const archivedPath = moveTo(final, wikiArchiveDir());
    final = { ...final, filePath: archivedPath };
    archived = true;
    appendReinforcementLog({
      kind: 'archive',
      session: 'manual',
      page: pageId,
      reason: 'corrections>=3',
    });
    log(`[reinforce] archived ${pageId} after 3+ corrections`);
    appendLog(`reinforce: archived ${pageId} after corrections=3`);
  }
  await reindexPage(store, final);
  await store.wikiPages.flush();
  commitWiki(`reinforce manual correction ${pageId}`);
  return { ok: true, weight: fm.weight, corrections: fm.corrections, archived };
}

export function evaluateCorrection(
  store: Store,
  sessionId: string,
  userText: string,
  log: (msg: string) => void = () => undefined,
): void {
  const p = getPending(sessionId);
  if (!p) return;
  const looksLikeCorrection = CORRECTION_PATTERNS.some((re) => re.test(userText));
  if (!looksLikeCorrection) return;

  // Raw injections have no page; record a soft-correction event and drop
  // the pending so the chunk does not get distilled into a wiki page on
  // a follow-up hit (user just told us the match was wrong).
  if (p.kind === 'raw') {
    appendReinforcementLog({
      kind: 'raw-correction',
      session: sessionId,
      chunk: p.pageId,
      project: p.projectId,
    });
    pending.delete(sessionId);
    return;
  }

  const page = loadPage(p.pageId);
  if (!page) return;
  const fm = { ...page.frontmatter };
  fm.corrections = (fm.corrections ?? 0) + 1;
  fm.weight = Math.max(0, fm.weight - fm.weight * CORRECTION_WEIGHT_LOSS);
  rewritePageFrontmatter(page, fm);
  blacklistPageForSession(sessionId, p.pageId);
  pending.delete(sessionId);

  appendReinforcementLog({
    kind: 'correction',
    session: sessionId,
    page: p.pageId,
    weight: fm.weight,
  });
  log(`[reinforce] correction on ${p.pageId}: weight=${fm.weight.toFixed(2)}`);
  appendLog(`reinforce: correction on ${p.pageId} (weight ${fm.weight.toFixed(2)})`);

  if (fm.corrections >= 3 && fm.weight < ARCHIVE_FLOOR) {
    moveTo({ ...page, frontmatter: fm }, wikiArchiveDir());
    appendReinforcementLog({
      kind: 'archive',
      session: sessionId,
      page: p.pageId,
      reason: 'corrections>=3',
    });
    log(`[reinforce] archived ${p.pageId} after 3+ corrections`);
    appendLog(`reinforce: archived ${p.pageId} after corrections=3`);
  }
  void reindexPage(store, { ...page, frontmatter: fm });
  commitWiki(`reinforce correction ${p.pageId}`);
}

/* WI-5 pause mode. Reads DEVNEURAL_PAUSE_MODE on every call so the
 * env var can be flipped at runtime without daemon restart.
 *   on   - decay always frozen
 *   off  - decay always runs
 *   auto - decay runs unless the daemon has seen no activity for
 *          DEVNEURAL_PAUSE_INACTIVITY_DAYS days. Activity is defined
 *          as any reinforcement-log line in that window.
 *
 * The auto branch falls back to "not paused" when the activity
 * timestamp file is missing or unreadable so a fresh install never
 * silently freezes its own decay loop. */
function isPauseModeActive(): boolean {
  const mode = (process.env.DEVNEURAL_PAUSE_MODE ?? 'auto').toLowerCase();
  if (mode === 'on') return true;
  if (mode === 'off') return false;
  // auto
  const days = Number(process.env.DEVNEURAL_PAUSE_INACTIVITY_DAYS ?? 21);
  if (!Number.isFinite(days) || days <= 0) return false;
  try {
    if (!fs.existsSync(reinforcementLog)) return false;
    const stat = fs.statSync(reinforcementLog);
    const ageMs = Date.now() - stat.mtimeMs;
    return ageMs > days * 24 * 60 * 60 * 1000;
  } catch {
    return false;
  }
}

export async function decayInactivePages(
  store: Store,
  log: (msg: string) => void = () => undefined,
): Promise<{ decayed: number; archived: number }> {
  if (isPauseModeActive()) {
    log('[reinforce] pause mode active; decay skipped');
    return { decayed: 0, archived: 0 };
  }
  let decayed = 0;
  let archived = 0;
  const dirs = [wikiPagesDir(), wikiPendingDir()];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.md')) continue;
      const filePath = path.posix.join(dir, file);
      let parsed;
      try {
        parsed = parsePage(fs.readFileSync(filePath, 'utf-8'));
      } catch {
        continue;
      }
      /* WI-2 / BF-2: frozen pages are user-locked. Decay must skip
       * them; ingest also skips them in the wiki ingest write path
       * (see wiki/ingest.ts). User edits to frozen pages survive
       * across decay cycles unchanged. */
      if (parsed.frontmatter.frozen === true) continue;
      const fm = { ...parsed.frontmatter };
      const newWeight = fm.weight * DECAY_PER_SESSION;
      fm.weight = newWeight;
      writePage(dir, { frontmatter: fm, sections: parsed.sections });
      decayed++;

      if (newWeight < ARCHIVE_FLOOR && fm.status !== 'archived') {
        const fileName = path.basename(filePath);
        const target = path.posix.join(wikiArchiveDir(), fileName);
        ensureDir(wikiArchiveDir());
        fs.renameSync(filePath, target);
        fm.status = 'archived';
        const targetParsed = parsePage(fs.readFileSync(target, 'utf-8'));
        writePage(wikiArchiveDir(), {
          frontmatter: fm,
          sections: targetParsed.sections,
        });
        archived++;
        appendReinforcementLog({
          kind: 'decay-archive',
          page: fm.id,
          weight: fm.weight,
        });
      }
    }
  }
  if (decayed > 0) log(`[reinforce] decayed ${decayed} pages, archived ${archived}`);
  return { decayed, archived };
}

function dot(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] ?? 0) * (b[i] ?? 0);
  return s;
}
