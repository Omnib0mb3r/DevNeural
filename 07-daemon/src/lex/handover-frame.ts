/**
 * The handover frame (AUTO-CLEAR T5, Phase C, 2026-09-22).
 *
 * The one who did the work writes the first half; the one who holds the
 * plan reviews it and writes the second. Both halves stay visible in the
 * persisted file, labelled with author and time, so the operator can
 * see what the worker said and what Lex changed (operator, 2026-09-22:
 * "in a way that I can see, in the handover maybe").
 *
 * Pure: render, parse, vet, and the reseed text. No disk, no db, no
 * model. handover-writer.ts owns the files.
 */

export type HandoverKind = 'auto-clear' | 'session-end' | 'crash-recovery' | 'lex-self-clear';
export type HandoverVerdict = 'approved' | 'revised' | 'rejected';

export interface HandoverAuthor {
  role: 'worker' | 'daemon-trail' | 'lex';
  sessionId: string | null;
  /** ISO time. */
  at: string;
}

export interface HandoverWorkerHalf {
  author: HandoverAuthor;
  verifiedState: string;
  whatIWasDoing: string;
  decisionsInForce: string;
  stoppingPoint: string;
}

export interface HandoverLexHalf {
  author: HandoverAuthor;
  corrections: string[];
  nextSteps: string;
  planReference: string;
  verdict: HandoverVerdict;
}

export interface HandoverFrame {
  anchorId: string;
  kind: HandoverKind;
  /** ISO time; also the file's timestamp. */
  createdAt: string;
  worker: HandoverWorkerHalf;
  lex: HandoverLexHalf | null;
  /** True until a review lands (session-end and crash frames start so). */
  unvetted: boolean;
}

export const HANDOVER_KINDS: ReadonlyArray<HandoverKind> = [
  'auto-clear',
  'session-end',
  'crash-recovery',
  'lex-self-clear',
];

const SLOT_HEADINGS = {
  verifiedState: 'Verified state',
  whatIWasDoing: 'What I was doing',
  decisionsInForce: 'Decisions in force',
  stoppingPoint: 'Stopping point',
  corrections: 'Corrections',
  nextSteps: 'Next steps',
  planReference: 'Plan reference',
} as const;

function short(id: string | null): string {
  return id ? id.slice(0, 8) : 'none';
}

/* Headings carry the full session id so the file round-trips exactly. */
function full(id: string | null): string {
  return id ?? 'none';
}

function block(text: string): string {
  const t = text.trim();
  return t.length > 0 ? t : '_None._';
}

export function renderHandoverFrame(f: HandoverFrame): string {
  const lines: string[] = [];
  lines.push(`# Handover ${short(f.anchorId)} (${f.kind})`);
  lines.push('');
  lines.push(`Created: ${f.createdAt}`);
  lines.push(`Anchor: ${f.anchorId}`);
  lines.push(`Kind: ${f.kind}`);
  lines.push(`Unvetted: ${f.unvetted ? 'yes' : 'no'}`);
  lines.push('');
  if (f.unvetted) {
    lines.push(
      f.kind === 'crash-recovery'
        ? '> Recovered from the jsonl trail after a crash. Unvetted.'
        : '> Unvetted: nobody has reviewed this half yet.',
    );
    lines.push('');
  }
  const w = f.worker;
  lines.push(
    `## Worker draft (${w.author.role} session ${full(w.author.sessionId)}, ${w.author.at})`,
  );
  lines.push('');
  lines.push(`### ${SLOT_HEADINGS.verifiedState}`);
  lines.push('');
  lines.push(block(w.verifiedState));
  lines.push('');
  lines.push(`### ${SLOT_HEADINGS.whatIWasDoing}`);
  lines.push('');
  lines.push(block(w.whatIWasDoing));
  lines.push('');
  lines.push(`### ${SLOT_HEADINGS.decisionsInForce}`);
  lines.push('');
  lines.push(block(w.decisionsInForce));
  lines.push('');
  lines.push(`### ${SLOT_HEADINGS.stoppingPoint}`);
  lines.push('');
  lines.push(block(w.stoppingPoint));
  lines.push('');
  if (f.lex) {
    const l = f.lex;
    lines.push(
      `## Lex review (${l.verdict}, session ${full(l.author.sessionId)}, ${l.author.at})`,
    );
    lines.push('');
    lines.push(`### ${SLOT_HEADINGS.corrections}`);
    lines.push('');
    if (l.corrections.length === 0) lines.push('_None._');
    else for (const c of l.corrections) lines.push(`- ${c.replace(/\s+/g, ' ').trim()}`);
    lines.push('');
    lines.push(`### ${SLOT_HEADINGS.nextSteps}`);
    lines.push('');
    lines.push(block(l.nextSteps));
    lines.push('');
    lines.push(`### ${SLOT_HEADINGS.planReference}`);
    lines.push('');
    lines.push(block(l.planReference));
    lines.push('');
  }
  return lines.join('\n');
}

/* "## Worker draft (worker session <id>, <at>)" and
 * "## Lex review (approved, session <id>, <at>)". */
const HALF_RE = /^## (Worker draft|Lex review) \((\S+?),? session (\S+), ([^)]+)\)\s*$/;
const SLOT_RE = /^### (.+?)\s*$/;

function unblock(text: string): string {
  const t = text.trim();
  return t === '_None._' ? '' : t;
}

export function parseHandoverFrame(md: string): HandoverFrame | null {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const head: Record<string, string> = {};
  let i = 0;
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith('## ')) break;
    const m = line.match(/^(Created|Anchor|Kind|Unvetted): (.*)$/);
    if (m) head[m[1]!] = m[2]!.trim();
  }
  const kind = head.Kind as HandoverKind | undefined;
  if (!head.Anchor || !head.Created || !kind || !HANDOVER_KINDS.includes(kind)) return null;

  let worker: HandoverWorkerHalf | null = null;
  let lex: HandoverLexHalf | null = null;
  let current: { half: 'worker' | 'lex'; author: HandoverAuthor; verdict?: HandoverVerdict } | null =
    null;
  let slot: string | null = null;
  const slots: Record<string, string[]> = {};
  const flush = (): void => {
    if (!current) return;
    if (current.half === 'worker') {
      worker = {
        author: current.author,
        verifiedState: unblock((slots[SLOT_HEADINGS.verifiedState] ?? []).join('\n')),
        whatIWasDoing: unblock((slots[SLOT_HEADINGS.whatIWasDoing] ?? []).join('\n')),
        decisionsInForce: unblock((slots[SLOT_HEADINGS.decisionsInForce] ?? []).join('\n')),
        stoppingPoint: unblock((slots[SLOT_HEADINGS.stoppingPoint] ?? []).join('\n')),
      };
    } else {
      const corr = unblock((slots[SLOT_HEADINGS.corrections] ?? []).join('\n'));
      lex = {
        author: current.author,
        verdict: current.verdict ?? 'approved',
        corrections: corr
          ? corr
              .split('\n')
              .map((l) => l.replace(/^- /, '').trim())
              .filter((l) => l.length > 0)
          : [],
        nextSteps: unblock((slots[SLOT_HEADINGS.nextSteps] ?? []).join('\n')),
        planReference: unblock((slots[SLOT_HEADINGS.planReference] ?? []).join('\n')),
      };
    }
  };
  for (; i < lines.length; i++) {
    const line = lines[i]!;
    const h = line.match(HALF_RE);
    if (h) {
      flush();
      for (const k of Object.keys(slots)) delete slots[k];
      slot = null;
      const sessionId = h[3] === 'none' ? null : h[3]!;
      if (h[1] === 'Worker draft') {
        current = {
          half: 'worker',
          author: { role: h[2] as HandoverAuthor['role'], sessionId, at: h[4]! },
        };
      } else {
        current = {
          half: 'lex',
          author: { role: 'lex', sessionId, at: h[4]! },
          verdict: h[2] as HandoverVerdict,
        };
      }
      continue;
    }
    const s = line.match(SLOT_RE);
    if (s && current) {
      slot = s[1]!;
      slots[slot] = [];
      continue;
    }
    if (slot && current) (slots[slot] ??= []).push(line);
  }
  flush();
  if (!worker) return null;
  return {
    anchorId: head.Anchor,
    kind,
    createdAt: head.Created,
    worker,
    lex,
    unvetted: head.Unvetted === 'yes',
  };
}

/* Structural vet (T3 step 4): slots filled, not a transcript dump, sane.
 * Cheap; runs before Lex (or the operator) looks. */
export const VET_MAX_CHARS = 6_000;

export function vetHandoverFrame(f: HandoverFrame): { ok: boolean; issues: string[] } {
  const issues: string[] = [];
  const w = f.worker;
  if (!w.verifiedState.trim()) issues.push('verified state is empty');
  if (!w.whatIWasDoing.trim()) issues.push('what I was doing is empty');
  if (!w.stoppingPoint.trim()) issues.push('stopping point is empty');
  const all = [w.verifiedState, w.whatIWasDoing, w.decisionsInForce, w.stoppingPoint].join('\n');
  if (all.length > VET_MAX_CHARS) issues.push(`worker half is ${all.length} chars, over ${VET_MAX_CHARS}`);
  const ls = all.split('\n').filter((l) => l.trim().length > 0);
  const dumpish = ls.filter((l) => /^(user|assistant|human|ai)\s*:/i.test(l.trim())).length;
  if (ls.length >= 5 && dumpish / ls.length > 0.4) issues.push('reads like a transcript dump');
  if (f.lex) {
    if (!f.lex.nextSteps.trim()) issues.push('Lex review has no next steps');
    if (f.lex.verdict === 'rejected') issues.push('rejected by Lex');
  }
  return { ok: issues.length === 0, issues };
}

/* The text pasted into the fresh session after /clear. Plain prose, no
 * headings, under RESEED_MAX_CHARS. */
export const RESEED_MAX_CHARS = 2_400;

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return `${sp > max * 0.6 ? cut.slice(0, sp) : cut}...`;
}

export function reseedFromFrame(f: HandoverFrame): string {
  const build = (slotMax: number): string => {
    const lines: string[] = [];
    const who = f.lex ? `reviewed by Lex, ${f.lex.verdict}` : 'unvetted';
    lines.push(`Resume from the ${f.kind} handover of ${f.createdAt} (${who}).`);
    lines.push(`Verified state: ${clip(f.worker.verifiedState, slotMax)}`);
    lines.push(`Was doing: ${clip(f.worker.whatIWasDoing, slotMax)}`);
    if (f.worker.decisionsInForce.trim()) {
      lines.push(`Decisions in force: ${clip(f.worker.decisionsInForce, slotMax)}`);
    }
    lines.push(`Stopping point: ${clip(f.worker.stoppingPoint, slotMax)}`);
    if (f.lex) {
      if (f.lex.corrections.length > 0) {
        lines.push(`Corrections from Lex: ${clip(f.lex.corrections.join('; '), slotMax)}`);
      }
      lines.push(`Next steps: ${clip(f.lex.nextSteps, slotMax)}`);
      if (f.lex.planReference.trim()) lines.push(`Plan: ${clip(f.lex.planReference, slotMax)}`);
    }
    return lines.join('\n');
  };
  let text = build(900);
  if (text.length > RESEED_MAX_CHARS) text = build(400);
  if (text.length > RESEED_MAX_CHARS) text = build(220);
  if (text.length > RESEED_MAX_CHARS) text = `${text.slice(0, RESEED_MAX_CHARS - 3)}...`;
  return text;
}
