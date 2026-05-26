/**
 * Smart-compact shared types.
 *
 * Stage 2 split moved `evaluateTrigger` + `WRAP_AND_COMMIT_PROMPT`
 * into smart-compact-policy.ts but the mechanical helpers in
 * smart-compact.ts still need the same Phase / EvalAction / EvalReason
 * unions. Hoisting the types here keeps both modules small and avoids
 * a re-export cycle.
 */

export type Phase =
  | 'thinking'
  | 'tool'
  | 'permission'
  | 'idle'
  | 'unknown';

export type EvalAction = 'fire' | 'wrap' | 'wait';

export type EvalReason =
  | 'window-open'
  | 'forced-no-stop'
  | 'hard-ceiling'
  | 'below-window'
  | 'no-stop';
