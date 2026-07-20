import { describe, expect, it } from 'vitest';
import {
  shouldNotifyPendingPrompt,
  pendingPromptNotifyClass,
  IDLE_PROMPT_DEBOUNCE_MS,
} from '../src/dashboard/pending-prompt-notify.js';

/**
 * DRIVE-QUEUE rider (2026-07-17): the bell carries action-required
 * items only. "Claude waiting on you (idle_prompt)" fired on every CC
 * idle moment - four bell rows (warn + web push each) in four minutes
 * of live voice conversation (03:12:32, 03:13:51, 03:15:58, 03:16:09Z)
 * while the operator was mid-sentence. Idle prompts are rhythm during
 * conversation, an ask only when they PERSIST: debounce per session.
 * Real permission/elicitation prompts block Claude and stay instant.
 */
describe('pendingPromptNotifyClass: bell only for real asks (2026-07-20)', () => {
  it('idle_prompt is a signal (activity rail only, off the bell)', () => {
    expect(pendingPromptNotifyClass('idle_prompt')).toBe('signal');
  });

  it('a real permission / elicitation prompt is a followup (bells)', () => {
    expect(pendingPromptNotifyClass('permission')).toBe('followup');
    expect(pendingPromptNotifyClass('elicitation')).toBe('followup');
    expect(pendingPromptNotifyClass('notification')).toBe('followup');
  });
});

describe('shouldNotifyPendingPrompt: idle rhythm vs real asks', () => {
  it('permission prompts always notify', () => {
    expect(
      shouldNotifyPendingPrompt('permission', 1_000, 2_000),
    ).toBe(true);
  });

  it('elicitation and unknown kinds always notify', () => {
    expect(shouldNotifyPendingPrompt('elicitation', 1_000, 2_000)).toBe(true);
    expect(shouldNotifyPendingPrompt('notification', 1_000, 2_000)).toBe(true);
  });

  it('the FIRST idle_prompt for a session notifies', () => {
    expect(shouldNotifyPendingPrompt('idle_prompt', null, 5_000)).toBe(true);
  });

  it('an idle_prompt inside the debounce window is silent', () => {
    expect(
      shouldNotifyPendingPrompt('idle_prompt', 5_000, 5_000 + 60_000),
    ).toBe(false);
  });

  it('a PERSISTING idle_prompt past the window notifies again', () => {
    expect(
      shouldNotifyPendingPrompt(
        'idle_prompt',
        5_000,
        5_000 + IDLE_PROMPT_DEBOUNCE_MS + 1,
      ),
    ).toBe(true);
  });

  it('the debounce window is 10 minutes', () => {
    expect(IDLE_PROMPT_DEBOUNCE_MS).toBe(10 * 60 * 1000);
  });
});
