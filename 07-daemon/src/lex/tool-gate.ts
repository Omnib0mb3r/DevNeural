/**
 * Wave 3 Lane B step 33 (LX-11b). Tool gate middleware.
 *
 * Intercepts WebSearch tool invocations before injection into the Lex PTY
 * when the user's query contains a term from the known-internal vocabulary.
 *
 * Internal vocabulary is auto-generated from the project registry (project
 * names, tags, leaf path segments) plus a static list of DevNeural-specific
 * terms. When a match is found, the gate blocks external search and emits
 * an awareness event so the dashboard can show what Lex pulled.
 *
 * The gate is NOT a hard block: it returns a structured decision object.
 * The caller (voice WS inject path or text inject path) decides what to
 * do with it. The recommended action is to prepend a note to the injected
 * text telling Lex to check internal sources first.
 *
 * This module is stateless and has no side effects beyond calling
 * emitAwarenessEvent (which is itself a no-op when the budget is exhausted).
 */
import { listProjects } from '../identity/registry.js';
import { emitAwarenessEvent } from './awareness.js';

/* Static DevNeural-specific terms that are always in the internal vocab.
 * These are terms that have meaning within this project's knowledge base
 * and are unlikely to benefit from external search. */
const STATIC_VOCAB = new Set([
  'devneural',
  'brainstorm',
  'lex',
  'wiki',
  'daemon',
  'curator',
  'session',
  'piper',
  'whisper',
  'tailscale',
  'stream deck',
  'streamdeck',
  'audit finding',
  'audit-finding',
  'raw chunk',
  'raw-chunk',
  'wiki draft',
  'wiki-draft',
  'distillation',
  'backfill',
  'lineage',
  'brainstorm chunk',
  'brainstorm-chunk',
  'reminder',
  'live_state',
  'snapshot',
  'pty',
  'heartbeat',
  'awareness',
]);

/* Build dynamic vocabulary from the project registry. Extracts:
 * - project name (lowercased, split by non-word chars)
 * - leaf path segment from root
 * Cache is cleared on every call since registry changes during runtime. */
function buildDynamicVocab(): Set<string> {
  const vocab = new Set<string>();
  try {
    const projects = listProjects();
    for (const p of projects) {
      /* project name terms */
      const nameTerms = p.name
        .toLowerCase()
        .split(/[\s\-_./\\]+/)
        .filter((t) => t.length > 2);
      for (const t of nameTerms) vocab.add(t);
      /* leaf path segment from root */
      if (p.root) {
        const segments = p.root.replace(/\\/g, '/').split('/');
        const leaf = segments[segments.length - 1];
        if (leaf && leaf.length > 2) vocab.add(leaf.toLowerCase());
      }
    }
  } catch {
    /* registry unreadable; use static vocab only */
  }
  return vocab;
}

export interface GateDecision {
  /* True when the gate matched a term and recommends blocking external. */
  blocked: boolean;
  /* The matched term, if any. */
  matched_term: string | null;
  /* Human-readable note to prepend to the inject (summarises the block). */
  note: string | null;
}

/* Check whether a query contains a known-internal term. Returns a decision
 * object. The caller uses this to conditionally prepend a note to the
 * injected text before it reaches the Lex PTY. */
export function checkToolGate(query: string): GateDecision {
  const lower = query.toLowerCase();
  const dynamicVocab = buildDynamicVocab();

  /* Check static vocab first (faster, no registry read). */
  for (const term of STATIC_VOCAB) {
    if (lower.includes(term)) {
      const note = buildBlockNote(term, 'static');
      emitAwarenessEvent({
        kind: 'manual',
        label: `tool-gate: web-search blocked (static vocab: "${term}")`,
        detail: { query, matched_term: term, vocab_kind: 'static' },
      });
      return { blocked: true, matched_term: term, note };
    }
  }

  /* Check dynamic project vocab. */
  for (const term of dynamicVocab) {
    if (lower.includes(term)) {
      const note = buildBlockNote(term, 'project');
      emitAwarenessEvent({
        kind: 'manual',
        label: `tool-gate: web-search blocked (project vocab: "${term}")`,
        detail: { query, matched_term: term, vocab_kind: 'project' },
      });
      return { blocked: true, matched_term: term, note };
    }
  }

  return { blocked: false, matched_term: null, note: null };
}

function buildBlockNote(term: string, vocabKind: string): string {
  return (
    `[tool-gate] Internal vocabulary match: "${term}" (${vocabKind}). ` +
    `Check internal sources before WebSearch:\n` +
    `1. POST /lex/chunk-search { "q": "<your query>" }\n` +
    `2. POST /lex/recall { "q": "<your query>" }\n` +
    `3. Grep local filesystem\n` +
    `Only fall through to WebSearch if internal retrieval is weak (top cosine < 0.25).`
  );
}

/**
 * Emit an awareness event when the voice WS detects that Lex returned
 * a large filesystem read (grep output exceeding the line threshold).
 * Called from lex-voice-ws.ts after receiving a Lex turn containing
 * a large-fs-read artifact tag or raw grep output over the limit.
 *
 * Threshold: 30+ lines of grep output or a file read of 500+ lines.
 * Detection is heuristic (line count of the injected text) since the
 * PTY output is not structured.
 */
export function notifyLargeFsRead(opts: {
  pattern: string;
  line_count: number;
  brainstorm_id?: string | null;
}): void {
  emitAwarenessEvent({
    kind: 'capture',
    label: `large-fs-read: "${opts.pattern}" (${opts.line_count} lines)`,
    detail: {
      pattern: opts.pattern,
      line_count: opts.line_count,
    },
    brainstorm_id: opts.brainstorm_id ?? null,
  });
}

/** Threshold above which a Bash result is considered a "large read". */
export const LARGE_FS_READ_LINE_THRESHOLD = 30;

/* Export for use in tests and route handlers. */
export { buildDynamicVocab };
