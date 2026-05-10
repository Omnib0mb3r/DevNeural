/**
 * Wiki page schema: parser, writer, validator.
 *
 * Pages are markdown files with YAML frontmatter. Body has fixed sections
 * (Pattern, Cross-references, Evidence, Open questions, Log). Hard rules
 * from DEVNEURAL.md:
 *
 *   - title format `[trigger] → [insight]`
 *   - summary required, ≤ 80 tokens (here: ≤ 600 chars as a coarse proxy)
 *   - body ≤ 800 tokens (≤ 6000 chars proxy)
 *   - cross_refs ≤ 8
 *   - evidence ≤ 20
 *   - filename matches frontmatter id
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export type PageStatus = 'pending' | 'canonical' | 'archived';

export interface PageFrontmatter {
  id: string;
  title: string;
  trigger: string;
  insight: string;
  summary: string;
  status: PageStatus;
  weight: number;
  hits: number;
  corrections: number;
  created: string;
  last_touched: string;
  projects: string[];
  human_edited: boolean;
  human_edited_at?: string;
  flag_for_review?: boolean;
  /* Phase Two frontmatter (WI-1, WI-2, WI-3, WI-4, plus the
   * meeting-source mirror fields landed in CODEX-002 adoption).
   * All optional in the type so legacy pages that pre-date migration
   * 009 still parse; the migration sweep adds defaults to disk and
   * future writes carry them forward via renderFrontmatter. */
  schema_version?: number;
  last_verified?: string | null;
  frozen?: boolean;
  source_brainstorms?: string[];
  source_meetings?: string[];
  derived_from_brainstorm?: boolean;
  derived_from_meeting?: boolean;
}

export interface PageSections {
  pattern: string;
  crossRefs: string[]; // resolved page ids (filename without .md)
  crossRefsRaw: { label: string; href: string }[];
  evidence: string[];
  openQuestions: string[];
  log: string[];
}

export interface ParsedPage {
  frontmatter: PageFrontmatter;
  sections: PageSections;
  raw: string;
}

const SUMMARY_MAX_CHARS = 600;
const BODY_MAX_CHARS = 6000;
const CROSS_REF_MAX = 8;
const EVIDENCE_MAX = 20;

export class PageValidationError extends Error {
  constructor(
    message: string,
    public readonly issues: string[],
  ) {
    super(message);
  }
}

export function parsePage(raw: string): ParsedPage {
  const fm = parseFrontmatter(raw);
  const body = stripFrontmatter(raw);
  const sections = parseSections(body);
  return { frontmatter: fm, sections, raw };
}

export function readPage(file: string): ParsedPage {
  const raw = fs.readFileSync(file, 'utf-8');
  return parsePage(raw);
}

export function writePage(
  dir: string,
  page: { frontmatter: PageFrontmatter; sections: PageSections },
): string {
  const issues = validatePage(page);
  if (issues.length > 0) {
    throw new PageValidationError(
      `page ${page.frontmatter.id} failed validation`,
      issues,
    );
  }
  const file = path.posix.join(dir, `${page.frontmatter.id}.md`);
  const raw = renderPage(page);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, raw, 'utf-8');
  return file;
}

export function renderPage(page: {
  frontmatter: PageFrontmatter;
  sections: PageSections;
}): string {
  const fm = page.frontmatter;
  const fmYaml = renderFrontmatter(fm);

  const crossRefs =
    page.sections.crossRefsRaw.length > 0
      ? page.sections.crossRefsRaw
          .map((r) => `- [${r.label}](${r.href})`)
          .join('\n')
      : '_(none)_';

  const evidence =
    page.sections.evidence.length > 0
      ? page.sections.evidence.map((e) => `- ${e}`).join('\n')
      : '_(pending evidence)_';

  const openQ =
    page.sections.openQuestions.length > 0
      ? page.sections.openQuestions.map((q) => `- ${q}`).join('\n')
      : '_(none)_';

  const log =
    page.sections.log.length > 0
      ? page.sections.log.map((l) => `- ${l}`).join('\n')
      : '_(none)_';

  return `---
${fmYaml}---

# ${fm.title}

## Pattern
${page.sections.pattern.trim()}

## Cross-references
${crossRefs}

## Evidence
${evidence}

## Open questions
${openQ}

## Log
${log}
`;
}

export function validatePage(page: {
  frontmatter: PageFrontmatter;
  sections: PageSections;
}): string[] {
  const issues: string[] = [];
  const fm = page.frontmatter;

  if (!fm.id || !/^[a-z0-9][a-z0-9-]+$/.test(fm.id)) {
    issues.push(`invalid id: ${fm.id}`);
  }
  if (!fm.title) issues.push('missing title');
  if (!fm.title.includes('→')) {
    issues.push(`title missing "→" separator: ${fm.title}`);
  }
  if (!fm.trigger) issues.push('missing trigger');
  if (!fm.insight) issues.push('missing insight');
  if (!fm.summary) issues.push('missing summary');
  if (fm.summary && fm.summary.length > SUMMARY_MAX_CHARS) {
    issues.push(
      `summary too long: ${fm.summary.length} > ${SUMMARY_MAX_CHARS} chars`,
    );
  }
  if (!['pending', 'canonical', 'archived'].includes(fm.status)) {
    issues.push(`invalid status: ${fm.status}`);
  }
  if (typeof fm.weight !== 'number' || fm.weight < 0 || fm.weight > 1) {
    issues.push(`invalid weight: ${fm.weight}`);
  }
  if (!fm.created) issues.push('missing created');
  if (!fm.last_touched) issues.push('missing last_touched');
  if (!Array.isArray(fm.projects)) issues.push('projects must be array');

  if (page.sections.pattern.length > BODY_MAX_CHARS) {
    issues.push(
      `pattern body too long: ${page.sections.pattern.length} > ${BODY_MAX_CHARS} chars`,
    );
  }
  if (page.sections.crossRefsRaw.length > CROSS_REF_MAX) {
    issues.push(
      `too many cross_refs: ${page.sections.crossRefsRaw.length} > ${CROSS_REF_MAX}`,
    );
  }
  if (page.sections.evidence.length > EVIDENCE_MAX) {
    issues.push(
      `too many evidence entries: ${page.sections.evidence.length} > ${EVIDENCE_MAX}`,
    );
  }

  return issues;
}

function parseFrontmatter(raw: string): PageFrontmatter {
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    throw new Error('page missing frontmatter delimiters');
  }
  const yamlBody = match[1] ?? '';
  const obj = parseSimpleYaml(yamlBody);
  return normalizeFrontmatter(obj);
}

function stripFrontmatter(raw: string): string {
  return raw.replace(/^---\n[\s\S]*?\n---\n*/, '');
}

interface RawObj {
  [key: string]: unknown;
}

function parseSimpleYaml(yaml: string): RawObj {
  const result: RawObj = {};
  const lines = yaml.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (!line.trim() || line.trim().startsWith('#')) {
      i++;
      continue;
    }
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) {
      i++;
      continue;
    }
    const key = line.slice(0, colonIdx).trim();
    const rest = line.slice(colonIdx + 1).trim();

    if (rest === '|' || rest === '|-' || rest === '>' || rest === '>-') {
      // Block scalar
      const scalar: string[] = [];
      i++;
      while (i < lines.length) {
        const next = lines[i] ?? '';
        if (next.length === 0 || next.startsWith('  ')) {
          scalar.push(next.replace(/^ {2}/, ''));
          i++;
          continue;
        }
        break;
      }
      result[key] = scalar.join('\n').trim();
      continue;
    }

    if (rest === '' || rest === null) {
      // Inline list might follow with `- ` indented lines
      const list: unknown[] = [];
      i++;
      while (i < lines.length) {
        const next = lines[i] ?? '';
        const trimmed = next.trim();
        if (trimmed.startsWith('- ')) {
          list.push(parseScalar(trimmed.slice(2).trim()));
          i++;
          continue;
        }
        if (next === '' || next.match(/^\s/)) {
          i++;
          continue;
        }
        break;
      }
      result[key] = list;
      continue;
    }

    // Inline list?
    if (rest.startsWith('[') && rest.endsWith(']')) {
      const inner = rest.slice(1, -1).trim();
      if (inner.length === 0) {
        result[key] = [];
      } else {
        result[key] = inner
          .split(',')
          .map((item) => parseScalar(item.trim()));
      }
      i++;
      continue;
    }

    result[key] = parseScalar(rest);
    i++;
  }
  return result;
}

function parseScalar(value: string): unknown {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '~') return null;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function normalizeFrontmatter(obj: RawObj): PageFrontmatter {
  const stringArray = (v: unknown): string[] =>
    Array.isArray(v) ? (v as unknown[]).map((p) => String(p)) : [];

  return {
    id: String(obj.id ?? ''),
    title: String(obj.title ?? ''),
    trigger: String(obj.trigger ?? ''),
    insight: String(obj.insight ?? ''),
    summary: String(obj.summary ?? ''),
    status: (obj.status as PageStatus) ?? 'pending',
    weight: typeof obj.weight === 'number' ? obj.weight : 0.3,
    hits: typeof obj.hits === 'number' ? obj.hits : 0,
    corrections: typeof obj.corrections === 'number' ? obj.corrections : 0,
    created: String(obj.created ?? new Date().toISOString().slice(0, 10)),
    last_touched: String(
      obj.last_touched ?? new Date().toISOString().slice(0, 10),
    ),
    projects: stringArray(obj.projects),
    human_edited: obj.human_edited === true,
    ...(obj.human_edited_at
      ? { human_edited_at: String(obj.human_edited_at) }
      : {}),
    ...(obj.flag_for_review === true ? { flag_for_review: true } : {}),
    /* Phase Two fields. Default to nothing rather than spec defaults
     * here; the migration 009 sweep is the source of defaults on
     * disk. Reading a page that pre-dates the sweep returns undefined
     * and the consumer applies its own fallback. */
    ...(typeof obj.schema_version === 'number'
      ? { schema_version: obj.schema_version }
      : {}),
    ...(obj.last_verified === null || typeof obj.last_verified === 'string'
      ? { last_verified: obj.last_verified as string | null }
      : {}),
    ...(typeof obj.frozen === 'boolean' ? { frozen: obj.frozen } : {}),
    ...(Array.isArray(obj.source_brainstorms)
      ? { source_brainstorms: stringArray(obj.source_brainstorms) }
      : {}),
    ...(Array.isArray(obj.source_meetings)
      ? { source_meetings: stringArray(obj.source_meetings) }
      : {}),
    ...(obj.derived_from_brainstorm === true
      ? { derived_from_brainstorm: true }
      : {}),
    ...(obj.derived_from_meeting === true
      ? { derived_from_meeting: true }
      : {}),
  };
}

function renderFrontmatter(fm: PageFrontmatter): string {
  const lines: string[] = [];
  lines.push(`id: ${fm.id}`);
  lines.push(`title: ${escapeScalar(fm.title)}`);
  lines.push(`trigger: ${escapeScalar(fm.trigger)}`);
  lines.push(`insight: ${escapeScalar(fm.insight)}`);
  lines.push(`summary: |`);
  for (const line of fm.summary.split('\n')) {
    lines.push(`  ${line}`);
  }
  lines.push(`status: ${fm.status}`);
  lines.push(`weight: ${fm.weight}`);
  lines.push(`hits: ${fm.hits}`);
  lines.push(`corrections: ${fm.corrections}`);
  lines.push(`created: ${fm.created}`);
  lines.push(`last_touched: ${fm.last_touched}`);
  if (fm.projects.length === 0) {
    lines.push(`projects: []`);
  } else {
    lines.push(`projects: [${fm.projects.map((p) => escapeScalar(p)).join(', ')}]`);
  }
  lines.push(`human_edited: ${fm.human_edited}`);
  if (fm.human_edited_at) lines.push(`human_edited_at: ${fm.human_edited_at}`);
  if (fm.flag_for_review) lines.push(`flag_for_review: true`);
  /* Phase Two frontmatter persists on every save so we never strip
   * fields that migration 009 added. Defaults follow spec section 3.8:
   * schema_version=2, last_verified=null, frozen=false,
   * source_brainstorms=[], source_meetings=[], derived_from_brainstorm
   * and derived_from_meeting=false. The defaults render only when the
   * field is undefined; explicit user values pass through verbatim. */
  lines.push(`schema_version: ${fm.schema_version ?? 2}`);
  if (fm.last_verified === undefined || fm.last_verified === null) {
    lines.push(`last_verified: null`);
  } else {
    lines.push(`last_verified: ${escapeScalar(fm.last_verified)}`);
  }
  lines.push(`frozen: ${fm.frozen ?? false}`);
  const sb = fm.source_brainstorms ?? [];
  lines.push(
    sb.length === 0
      ? `source_brainstorms: []`
      : `source_brainstorms: [${sb.map((p) => escapeScalar(p)).join(', ')}]`,
  );
  const sm = fm.source_meetings ?? [];
  lines.push(
    sm.length === 0
      ? `source_meetings: []`
      : `source_meetings: [${sm.map((p) => escapeScalar(p)).join(', ')}]`,
  );
  lines.push(`derived_from_brainstorm: ${fm.derived_from_brainstorm ?? false}`);
  lines.push(`derived_from_meeting: ${fm.derived_from_meeting ?? false}`);
  return lines.join('\n') + '\n';
}

function escapeScalar(value: string): string {
  if (
    value.includes(':') ||
    value.includes('"') ||
    value.includes("'") ||
    value.startsWith('-') ||
    value.includes('#')
  ) {
    return `'${value.replace(/'/g, "''")}'`;
  }
  return value;
}

const SECTION_RE = /^## (.+)$/m;

function parseSections(body: string): PageSections {
  const sections: Record<string, string> = {};
  const titleStripped = body.replace(/^# .+\n+/, '');
  const parts = titleStripped.split(/^## /m);
  // First part is empty / pre-header content
  parts.shift();
  for (const part of parts) {
    const newlineIdx = part.indexOf('\n');
    const heading = newlineIdx === -1 ? part : part.slice(0, newlineIdx);
    const content = newlineIdx === -1 ? '' : part.slice(newlineIdx + 1);
    sections[heading.trim().toLowerCase()] = content.trim();
  }

  const pattern = sections['pattern'] ?? '';
  const rawRefs = parseCrossRefs(sections['cross-references'] ?? '');
  // Rebuild crossRefsRaw from the cleaned ids so a parse + write
  // roundtrip normalises any historical garbage (e.g. ./name.md.md from
  // qwen3:8b drift) into the canonical ./id.md form. Dedup as well.
  const seen = new Set<string>();
  const crossRefs: string[] = [];
  const crossRefsRaw: { label: string; href: string }[] = [];
  for (const r of rawRefs) {
    const id = extractIdFromHref(r.href);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    crossRefs.push(id);
    crossRefsRaw.push({ label: id.replace(/-/g, ' '), href: `./${id}.md` });
  }
  const evidence = parseList(sections['evidence'] ?? '');
  const openQuestions = parseList(sections['open questions'] ?? '');
  const log = parseList(sections['log'] ?? '');
  return { pattern, crossRefs, crossRefsRaw, evidence, openQuestions, log };
}

function parseCrossRefs(text: string): { label: string; href: string }[] {
  const lines = text.split('\n');
  const result: { label: string; href: string }[] = [];
  for (const line of lines) {
    const m = line.match(/^\s*-\s+\[([^\]]+)\]\(([^)]+)\)/);
    if (m) {
      result.push({ label: m[1] ?? '', href: m[2] ?? '' });
    }
  }
  return result;
}

function extractIdFromHref(href: string): string {
  // The local LLM (qwen3:8b) routinely emits malformed cross-ref hrefs:
  //   ./page-name.md.md            (double extension)
  //   ./././page-name.md           (extra ./ prefixes)
  //   page name.md                 (spaces instead of hyphens, sometimes)
  //   #anchor / ?query             (fragments / queries on local refs)
  // Be lenient: strip any leading ./ chunks, drop fragment/query, take the
  // basename, strip ALL trailing .md, and slugify whitespace. The page id
  // on disk is always lowercase-kebab so we lower + replace spaces with -.
  let s = href.trim();
  s = s.replace(/[#?].*$/, '');
  s = s.replace(/^(?:\.\/+)+/, '');
  s = s.split('/').pop() ?? s;
  while (s.toLowerCase().endsWith('.md')) {
    s = s.slice(0, -3);
  }
  s = s.toLowerCase().trim().replace(/\s+/g, '-');
  return s;
}

function parseList(text: string): string[] {
  const result: string[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*-\s+(.+)$/);
    if (m) result.push(m[1]?.trim() ?? '');
  }
  return result;
}

void SECTION_RE; // referenced for clarity
