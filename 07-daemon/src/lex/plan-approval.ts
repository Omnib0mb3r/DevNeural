/**
 * Plan approval by voice (LAYER-1-CONTROL, Phase B).
 *
 * The headless stall
 *
 *   The brain (L2) is a headless Claude Code session that may run in
 *   `--permission-mode plan`. When it finishes a plan it calls the
 *   ExitPlanMode tool. In the TUI that tool raises a permission prompt
 *   ("Would you like to proceed?") and blocks until someone answers it.
 *   Headless, nobody is looking at that terminal, so the session sits on
 *   the prompt forever: no plan is executed, no error is raised, the
 *   jsonl simply stops growing after the tool_use record.
 *
 *   Claude Code's Notification hook fires for that prompt and posts
 *   `{message, kind}` to the daemon, where `kind` is the hook's
 *   notification_type ('permission_prompt' today, bare 'permission' on
 *   older builds) and `message` reads "Claude needs your permission to
 *   use ExitPlanMode". That post is the detection point. The plan text
 *   itself never reaches the hook; it lives in the session jsonl as the
 *   `input.plan` of the ExitPlanMode tool_use block, and stays pending
 *   until a user record carries a tool_result for that tool_use id.
 *
 * The Enter / Escape TUI contract
 *
 *   The permission dialog is a menu with the accept option highlighted
 *   by default. A bare Enter (CR, no text) accepts the highlighted
 *   option, so approve = press Enter. Escape cancels the dialog: the
 *   tool call resolves as rejected and the model receives that
 *   rejection as its tool_result, staying in plan mode. Reject =
 *   press Escape, wait for the dialog to close, then type the
 *   operator's reason as the next prompt so the brain revises the plan
 *   instead of guessing why it was refused. The reason is delayed a
 *   beat because bytes typed while the dialog is still tearing down
 *   are swallowed by the menu, not the composer.
 *
 * This module is pure
 *
 *   Nothing here touches a PTY, a file, a timer or the database. The
 *   route owns the jsonl read (it hands the tail to extractPendingPlan),
 *   owns the PTY writes (it passes its inject / raw-write functions to
 *   approvePlan / rejectPlan) and owns scheduling (it passes the delay
 *   function). Keeping the decisions pure keeps every branch pinned in
 *   tests/plan-approval.test.ts without a live session.
 */

/** Delay between Escape and the typed rejection reason, in ms. Long
 * enough for the permission menu to close and hand focus back to the
 * composer; short enough that the brain does not start a fresh idle
 * cycle in between. */
const REJECT_REASON_DELAY_MS = 600;

/** Injector shape shared with the cross-session path: text plus a
 * commit flag that appends the submitting CR. */
export type PlanInjectFn = (
  ptyId: string,
  text: string,
  commit: boolean,
) => { ok: boolean };

/** Raw byte writer: sends control bytes (Escape) to the PTY with no
 * bracketed-paste wrapping and no trailing CR. */
export type PlanWriteRawFn = (ptyId: string, bytes: string) => void;

/** Scheduler seam (setTimeout in production, a manual queue in tests). */
export type PlanDelayFn = (fn: () => void, ms: number) => void;

/**
 * Is this Notification hook post the ExitPlanMode approval prompt?
 * Both conditions must hold: the kind is a permission prompt (any
 * spelling containing "permission", so 'permission_prompt' and the
 * older bare 'permission' both pass, while 'idle_prompt' and
 * 'elicitation_dialog' do not) and the message names ExitPlanMode
 * (a permission prompt for Bash or Edit is a different ask).
 */
export function isPlanApprovalPrompt(kind: string, message: string): boolean {
  return /permission/i.test(kind) && /ExitPlanMode/i.test(message);
}

interface ContentBlock {
  type?: unknown;
  id?: unknown;
  name?: unknown;
  input?: unknown;
  tool_use_id?: unknown;
}

/** Content blocks of a jsonl record's message, or [] when the message
 * is missing or its content is a plain string (no blocks to inspect). */
function contentBlocksOf(message: unknown): ContentBlock[] {
  if (!message || typeof message !== 'object') return [];
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  const blocks: ContentBlock[] = [];
  for (const b of content) {
    if (b && typeof b === 'object') blocks.push(b as ContentBlock);
  }
  return blocks;
}

/** Record role: the top-level `type` when it is user/assistant, else
 * message.role as a fallback for older jsonl shapes. */
function roleOf(rec: { type?: unknown; message?: unknown }): string | null {
  if (rec.type === 'assistant' || rec.type === 'user') return rec.type;
  const msg = rec.message;
  if (msg && typeof msg === 'object') {
    const role = (msg as { role?: unknown }).role;
    if (role === 'assistant' || role === 'user') return role;
  }
  return null;
}

/**
 * Scan a jsonl tail (newline separated records, blank and unparseable
 * lines skipped) for an ExitPlanMode call that has not been answered.
 *
 * Tracks the LAST assistant record carrying a
 * `{type:'tool_use', name:'ExitPlanMode', id, input:{plan}}` block:
 * remembers its plan (input.plan when a string, else '') and its tool_use
 * id. A later user record carrying `{type:'tool_result', tool_use_id}`
 * for that id means the prompt was answered (approved or refused), so
 * the pending plan is forgotten. A tool_use without an id can never be
 * matched to its result, so it is not tracked: surfacing it would risk
 * asking the operator about a plan that was already answered.
 *
 * message.content may be a plain string on either role; such records
 * carry no blocks and are ignored.
 */
export function extractPendingPlan(jsonlTail: string): string | null {
  let pending: { id: string; plan: string } | null = null;
  for (const rawLine of jsonlTail.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    const rec = parsed as { type?: unknown; message?: unknown };
    const role = roleOf(rec);
    if (!role) continue;
    const blocks = contentBlocksOf(rec.message);
    if (role === 'assistant') {
      for (const b of blocks) {
        if (b.type !== 'tool_use' || b.name !== 'ExitPlanMode') continue;
        if (typeof b.id !== 'string' || !b.id) continue;
        const input = b.input;
        const plan =
          input && typeof input === 'object'
            ? (input as { plan?: unknown }).plan
            : undefined;
        pending = { id: b.id, plan: typeof plan === 'string' ? plan : '' };
      }
    } else if (pending) {
      for (const b of blocks) {
        if (b.type === 'tool_result' && b.tool_use_id === pending.id) {
          pending = null;
          break;
        }
      }
    }
  }
  return pending ? pending.plan : null;
}

export interface PendingPlan {
  /** Lex anchor (brainstorm) whose brain raised the prompt. */
  anchorId: string;
  /** Claude Code session uuid of the brain session (jsonl owner). */
  ccSessionId: string;
  /** Daemon-owned PTY to answer on; null when the session has no PTY. */
  ptyId: string | null;
  /** Plan text as extracted from the jsonl ('' when the tool_use had
   * no string plan). */
  plan: string;
  /** Wall clock ms when the prompt was detected. */
  atMs: number;
}

/**
 * Parked plans awaiting the operator's voice answer, one per anchor.
 * A second ExitPlanMode on the same anchor (the brain revised and asked
 * again) replaces the first; the route clears the entry once it has
 * answered the prompt.
 */
export class PlanApprovalRegistry {
  private readonly byAnchor = new Map<string, PendingPlan>();

  set(p: PendingPlan): void {
    this.byAnchor.set(p.anchorId, p);
  }

  get(anchorId: string): PendingPlan | null {
    return this.byAnchor.get(anchorId) ?? null;
  }

  clear(anchorId: string): void {
    this.byAnchor.delete(anchorId);
  }

  size(): number {
    return this.byAnchor.size;
  }
}

/**
 * Approve: press Enter on the highlighted (accept) option. A bare CR
 * with commit=false so the injector does not append a second CR that
 * would land in the composer as an empty submit. Returns the
 * injector's ok flag.
 */
export function approvePlan(inject: PlanInjectFn, ptyId: string): boolean {
  return inject(ptyId, '\r', false).ok;
}

/** Build the prompt the brain receives after a refusal. */
function rejectionPrompt(reason: string): string {
  const why = reason.trim();
  return `[plan-rejected] The operator said no${why ? `: ${why}` : ''}. Keep planning and present a revised plan.`;
}

/**
 * Reject: Escape closes the permission dialog (the tool call resolves
 * as refused and the brain stays in plan mode), then, once the dialog
 * has had time to tear down, the operator's reason is typed and
 * committed as the next prompt so the brain revises instead of
 * guessing. The Escape is written raw (no paste wrapping, no CR); the
 * reason goes through the normal injector with commit=true.
 */
export function rejectPlan(
  writeRaw: PlanWriteRawFn,
  inject: PlanInjectFn,
  ptyId: string,
  reason: string,
  delay: PlanDelayFn,
): void {
  writeRaw(ptyId, '\x1b');
  const prompt = rejectionPrompt(reason);
  delay(() => {
    inject(ptyId, prompt, true);
  }, REJECT_REASON_DELAY_MS);
}
