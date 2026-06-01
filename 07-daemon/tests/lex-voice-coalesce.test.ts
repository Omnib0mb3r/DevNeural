/**
 * Coalesce-utterance-queue helpers (Fix 35 Phase A).
 *
 * Pure unit pins for the queue drain formatter and the contradiction
 * detector. The WS state machine that calls these helpers is
 * exercised indirectly via the existing lex-voice-ws regression
 * tests; this file pins the two rules independently so a regression
 * surfaces at the helper boundary.
 */
import { describe, expect, it } from 'vitest';
import {
  classifyUtterance,
  detectContradiction,
  detectRuleConflict,
  formatQueueDrain,
  formatQueueDrainV2,
} from '../src/voice/lex-voice-coalesce.js';

describe('formatQueueDrain', () => {
  it('returns null for an empty queue', () => {
    expect(formatQueueDrain([])).toBeNull();
  });

  it('returns the lone utterance unchanged when the queue has one item', () => {
    const r = formatQueueDrain(['fix the build']);
    expect(r).not.toBeNull();
    expect(r!.text).toBe('fix the build');
    expect(r!.count).toBe(1);
  });

  it('wraps a multi-utterance batch in a structured numbered preamble', () => {
    const r = formatQueueDrain([
      'add the snippet picker',
      'also bump the FIXES row',
      'commit when done',
    ]);
    expect(r).not.toBeNull();
    expect(r!.count).toBe(3);
    expect(r!.text).toMatch(/queued-utterances \(3\)/);
    expect(r!.text).toMatch(/Compose ONE reply addressing all of them/);
    expect(r!.text).toMatch(/1\. add the snippet picker/);
    expect(r!.text).toMatch(/2\. also bump the FIXES row/);
    expect(r!.text).toMatch(/3\. commit when done/);
  });

  it('preserves order so latest-utterance contradiction logic stays meaningful', () => {
    const r = formatQueueDrain(['ship it', 'wait no, cancel that']);
    expect(r!.text.indexOf('1. ship it')).toBeLessThan(
      r!.text.indexOf('2. wait no'),
    );
  });
});

describe('detectContradiction', () => {
  it('returns true for canonical cancel phrasings', () => {
    expect(detectContradiction('cancel that')).toBe(true);
    expect(detectContradiction('cancel it')).toBe(true);
    expect(detectContradiction('never mind')).toBe(true);
    expect(detectContradiction('nevermind')).toBe(true);
    expect(detectContradiction('forget it')).toBe(true);
    expect(detectContradiction('forget that')).toBe(true);
    expect(detectContradiction('stop it')).toBe(true);
    expect(detectContradiction('stop now please')).toBe(true);
    expect(detectContradiction('abort that')).toBe(true);
    expect(detectContradiction('drop it')).toBe(true);
    expect(detectContradiction('hold up')).toBe(true);
    expect(detectContradiction('hold on')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(detectContradiction('NEVER MIND')).toBe(true);
    expect(detectContradiction('Cancel That')).toBe(true);
  });

  it('does NOT false-fire on word-boundary collisions', () => {
    expect(detectContradiction('stopwatch behaviour was correct')).toBe(false);
    expect(detectContradiction('the cancellation policy looks fine')).toBe(
      false,
    );
    expect(detectContradiction('hold the door open')).toBe(false);
    expect(detectContradiction('I cannot stop thinking about it')).toBe(false);
  });

  it('returns false for empty / whitespace input', () => {
    expect(detectContradiction('')).toBe(false);
    expect(detectContradiction('   ')).toBe(false);
  });
});

describe('classifyUtterance (Phase B)', () => {
  it('tags blank / whitespace as noise', () => {
    expect(classifyUtterance('').kind).toBe('noise');
    expect(classifyUtterance('   ').kind).toBe('noise');
  });

  it('tags hesitation fillers as noise', () => {
    expect(classifyUtterance('um').kind).toBe('noise');
    expect(classifyUtterance('uhhh').kind).toBe('noise');
    expect(classifyUtterance('okay').kind).toBe('noise');
    expect(classifyUtterance('got it').kind).toBe('noise');
  });

  it('tags cancel intents as cancel (mirrors detectContradiction)', () => {
    expect(classifyUtterance('cancel that').kind).toBe('cancel');
    expect(classifyUtterance('never mind').kind).toBe('cancel');
  });

  it('tags lead-in connectors as follow-up', () => {
    expect(classifyUtterance('and also bump the version').kind).toBe('follow-up');
    expect(classifyUtterance('oh and tag the commit').kind).toBe('follow-up');
    expect(classifyUtterance('actually, switch the renderer').kind).toBe('follow-up');
    expect(classifyUtterance('add a smoke test for it').kind).toBe('follow-up');
  });

  it('tags shared-token overlap with prior queue as follow-up', () => {
    const r = classifyUtterance('and patch the migration script', {
      prior: ['rerun the migration for the schema bump'],
    });
    expect(r.kind).toBe('follow-up');
  });

  it('tags topic switches with no overlap as new', () => {
    const r = classifyUtterance('check the daemon logs for distillation errors', {
      prior: ['rename the dashboard panel header'],
    });
    expect(r.kind).toBe('new');
  });
});

describe('detectRuleConflict (Phase B)', () => {
  it('returns hit:false on empty input or empty rule set', () => {
    expect(detectRuleConflict('', [{ label: 'r', match: /x/ }]).hit).toBe(false);
    expect(detectRuleConflict('something', []).hit).toBe(false);
  });

  it('flags the first matching rule', () => {
    const rules = [
      { label: 'use Settings reset button', match: /\bhard\s*reload\b/i },
      { label: 'never push --force', match: /push\s+--force/i },
    ];
    const r = detectRuleConflict('Please force a hard reload of the panel', rules);
    expect(r.hit).toBe(true);
    expect(r.rule).toBe('use Settings reset button');
  });

  it('returns hit:false when no rule matches', () => {
    const r = detectRuleConflict('innocuous statement', [
      { label: 'no foo', match: /\bfoo\b/i },
    ]);
    expect(r.hit).toBe(false);
  });
});

describe('formatQueueDrainV2 (Phase B)', () => {
  it('returns null when the queue is empty after dropping noise', () => {
    expect(formatQueueDrainV2([])).toBeNull();
    expect(formatQueueDrainV2([{ text: 'um', kind: 'noise' }])).toBeNull();
  });

  it('emits a lone-text payload when one non-noise item remains', () => {
    const r = formatQueueDrainV2([
      { text: 'rebuild the dashboard', kind: 'new' },
    ]);
    expect(r).not.toBeNull();
    expect(r!.text).toBe('rebuild the dashboard');
    expect(r!.count).toBe(1);
  });

  it('short-circuits to the latest cancel when one is present', () => {
    const r = formatQueueDrainV2([
      { text: 'add the snippet picker', kind: 'new' },
      { text: 'and the FIXES row', kind: 'follow-up' },
      { text: 'never mind', kind: 'cancel' },
    ]);
    expect(r).not.toBeNull();
    expect(r!.text).toBe('never mind');
    expect(r!.count).toBe(1);
  });

  it('renders kind tags + numbered list when no cancel and no conflict', () => {
    const r = formatQueueDrainV2([
      { text: 'add the snippet picker', kind: 'new' },
      { text: 'and the FIXES row', kind: 'follow-up' },
    ]);
    expect(r).not.toBeNull();
    expect(r!.count).toBe(2);
    expect(r!.text).toMatch(/queued-utterances \(2\)/);
    expect(r!.text).toMatch(/1\. \[new\] add the snippet picker/);
    expect(r!.text).toMatch(/2\. \[follow-up\] and the FIXES row/);
    expect(r!.text).not.toMatch(/conflict/);
  });

  it('prepends a conflict block when an item matches a passed rule', () => {
    const r = formatQueueDrainV2(
      [
        { text: 'just force a hard reload, ignore the policy', kind: 'new' },
      ],
      {
        conflictRules: [
          {
            label: 'use Settings reset button',
            match: /\bhard\s*reload\b/i,
          },
        ],
      },
    );
    expect(r).not.toBeNull();
    expect(r!.text).toMatch(/\[voice-context: conflict\]/);
    expect(r!.text).toMatch(/use Settings reset button/);
    expect(r!.text).toMatch(/Push back before applying/);
  });

  it('dedupes repeated conflict rule hits across items', () => {
    const r = formatQueueDrainV2(
      [
        { text: 'do a hard reload', kind: 'new' },
        { text: 'no really do the hard reload', kind: 'follow-up' },
      ],
      {
        conflictRules: [
          { label: 'use Settings reset button', match: /\bhard\s*reload\b/i },
        ],
      },
    );
    const matches = r!.text.match(/use Settings reset button/g) ?? [];
    expect(matches.length).toBe(1);
  });
});
