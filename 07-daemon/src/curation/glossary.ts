/**
 * Per-project glossary.
 *
 * Maintains wiki/glossary/<project_id>.md as a tight terminology
 * dictionary inferred from session content. Each entry maps a term
 * (often a shorthand the user uses) to the concrete thing it refers
 * to in the project.
 *
 * Format:
 *   ---
 *   project_id: ...
 *   project_name: ...
 *   updated: ...
 *   ---
 *   - "the orb" = the /orb route in the dashboard, the graph visualization
 *   - "the daemon" = 07-daemon, the brain
 *
 * Updated incrementally: existing entries are preserved unless the
 * LLM finds new evidence that contradicts them.
 */
import * as fs from 'node:fs';
import {
  wikiGlossaryDir,
  wikiGlossaryFile,
  ensureDir,
} from '../paths.js';
import {
  pickProvider,
  callValidated,
  type LlmProvider,
} from '../llm/index.js';
import type { Validator } from '../llm/validator.js';

export interface GlossaryEntry {
  term: string;
  definition: string;
}

interface GlossaryShape {
  add: GlossaryEntry[];
  update: GlossaryEntry[];
  remove: string[];
}

const validateGlossary: Validator<GlossaryShape> = (raw) => {
  if (!raw || typeof raw !== 'object')
    return { ok: false, errors: ['response not object'] };
  const obj = raw as Record<string, unknown>;
  const cleaned: GlossaryShape = { add: [], update: [], remove: [] };
  for (const key of ['add', 'update'] as const) {
    const arr = obj[key];
    if (Array.isArray(arr)) {
      for (const item of arr) {
        if (!item || typeof item !== 'object') continue;
        const it = item as Record<string, unknown>;
        const term = typeof it.term === 'string' ? it.term.trim() : '';
        const definition =
          typeof it.definition === 'string' ? it.definition.trim() : '';
        if (term && definition && term.length <= 80 && definition.length <= 240) {
          cleaned[key].push({ term, definition });
        }
      }
    }
  }
  const removeArr = obj.remove;
  if (Array.isArray(removeArr)) {
    for (const t of removeArr) {
      if (typeof t === 'string') cleaned.remove.push(t.trim());
    }
  }
  return { ok: true, value: cleaned, errors: [] };
};

export interface GlossaryUpdate {
  projectId: string;
  projectName: string;
  recentText: string;
}

export interface GlossaryResult {
  written: boolean;
  added: number;
  updated: number;
  removed: number;
  reason?: string;
}

export function readGlossary(projectId: string): GlossaryEntry[] {
  const file = wikiGlossaryFile(projectId);
  if (!fs.existsSync(file)) return [];
  try {
    const content = fs.readFileSync(file, 'utf-8');
    return parseGlossary(content);
  } catch {
    return [];
  }
}

export function writeGlossary(
  projectId: string,
  projectName: string,
  entries: GlossaryEntry[],
): void {
  ensureDir(wikiGlossaryDir());
  const lines: string[] = [];
  lines.push('---');
  lines.push(`project_id: ${projectId}`);
  lines.push(`project_name: ${projectName}`);
  lines.push(`updated: ${new Date().toISOString()}`);
  lines.push('---');
  lines.push('');
  lines.push(`# Glossary: ${projectName}`);
  lines.push('');
  for (const e of entries) {
    lines.push(`- "${e.term}" = ${e.definition}`);
  }
  fs.writeFileSync(wikiGlossaryFile(projectId), lines.join('\n') + '\n', 'utf-8');
}

export function parseGlossary(content: string): GlossaryEntry[] {
  const entries: GlossaryEntry[] = [];
  for (const line of content.split('\n')) {
    const m = line.match(/^\s*-\s+"([^"]+)"\s*=\s*(.+)$/);
    if (m) {
      entries.push({
        term: (m[1] ?? '').trim(),
        definition: (m[2] ?? '').trim(),
      });
    }
  }
  return entries;
}

export async function updateGlossary(
  update: GlossaryUpdate,
  log: (msg: string) => void = () => undefined,
): Promise<GlossaryResult> {
  const provider = pickProvider();
  if (!provider || !provider.isConfigured()) {
    return {
      written: false,
      added: 0,
      updated: 0,
      removed: 0,
      reason: 'LLM not configured',
    };
  }

  if (update.recentText.trim().length < 200) {
    return {
      written: false,
      added: 0,
      updated: 0,
      removed: 0,
      reason: 'not enough new content',
    };
  }

  const existing = readGlossary(update.projectId);
  const result = await runGlossary(
    provider,
    update.projectName,
    existing,
    update.recentText,
    log,
  );
  if (!result.value) {
    return {
      written: false,
      added: 0,
      updated: 0,
      removed: 0,
      reason: `glossary call failed: ${result.errors.join('; ')}`,
    };
  }

  const merged = mergeGlossary(existing, result.value);
  writeGlossary(update.projectId, update.projectName, merged);
  return {
    written: true,
    added: result.value.add.length,
    updated: result.value.update.length,
    removed: result.value.remove.length,
  };
}

function mergeGlossary(
  existing: GlossaryEntry[],
  diff: GlossaryShape,
): GlossaryEntry[] {
  const map = new Map<string, GlossaryEntry>();
  for (const e of existing) map.set(e.term.toLowerCase(), e);
  for (const e of diff.update) map.set(e.term.toLowerCase(), e);
  for (const e of diff.add) {
    if (!map.has(e.term.toLowerCase())) map.set(e.term.toLowerCase(), e);
  }
  for (const t of diff.remove) {
    map.delete(t.toLowerCase());
  }
  return Array.from(map.values()).sort((a, b) =>
    a.term.localeCompare(b.term),
  );
}

async function runGlossary(
  provider: LlmProvider,
  projectName: string,
  existing: GlossaryEntry[],
  recentText: string,
  log: (msg: string) => void,
): Promise<{
  value: GlossaryShape | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  errors: string[];
}> {
  const system = `You maintain a glossary of project-specific shorthand terms used by a developer.

A glossary entry maps a SHORTHAND ("the orb", "the daemon") to a CONCRETE referent ("the /orb route in the dashboard, the graph visualization") within ONE project.

Output strictly this JSON shape:
{
  "add": [{"term": "shorthand", "definition": "concrete referent"}],
  "update": [{"term": "existing-term", "definition": "new definition"}],
  "remove": ["term-to-drop"]
}

Hard rules:
- Terms are 1-3 words. Definitions are <= 200 chars.
- Only entries that are ACTUAL shorthand. Skip generic English. Skip commands.
- Do not invent terms. Only add if the recent content uses it as shorthand.
- Update only if recent evidence contradicts existing.
- Remove only if a term is clearly obsolete or wrong.
- Empty arrays are fine. Conservative is better than verbose.`;

  const existingText =
    existing.length > 0
      ? existing.map((e) => `- "${e.term}" = ${e.definition}`).join('\n')
      : '(empty)';

  const user = `Project: ${projectName}

Existing glossary:
${existingText}

Recent session content:
${recentText.slice(0, 8000)}

Respond with JSON only.`;

  return callValidated(
    provider,
    {
      role: 'self_query',
      systemBlocks: [{ text: system, cache: true }],
      user,
      maxTokens: 800,
    },
    validateGlossary,
    log,
  );
}

/**
 * Find glossary entries whose term appears in the prompt. Returns up
 * to `limit` matches, ordered by term length (longest first to prefer
 * specific over generic).
 */
export function matchTerms(
  entries: GlossaryEntry[],
  prompt: string,
  limit = 3,
): GlossaryEntry[] {
  const lower = prompt.toLowerCase();
  const hits = entries.filter((e) => lower.includes(e.term.toLowerCase()));
  hits.sort((a, b) => b.term.length - a.term.length);
  return hits.slice(0, limit);
}
