/**
 * Jsonl-tail event detection
 * (EVENT-DRIVEN-SUPERVISION.md producer side).
 *
 * Covers parseJsonlTail (line-shape extraction) and deriveEvents
 * (state-carrying detector orchestrator) without spinning chokidar
 * up. Every input is a raw bytes blob; the chokidar wrapper that
 * eventually reads it is a thin runtime layer.
 */
import { describe, expect, it } from 'vitest';
import {
  deriveEvents,
  newAnchorTailState,
  parseJsonlTail,
  type AnchorTailState,
} from '../src/dashboard/worker-event-detect.js';
import type { ProjectSessionRow } from '../src/store/index-db.js';

const NOW = 5_000_000;
const ASSISTANT_TS = new Date(NOW - 2 * 60 * 1000).toISOString();
const OLD_ASSISTANT_TS = new Date(NOW - 30 * 60 * 1000).toISOString();
const TOOL_TS = new Date(NOW - 1 * 60 * 1000).toISOString();

function anchor(over: Partial<ProjectSessionRow> = {}): ProjectSessionRow {
  return {
    id: 'anchor-A',
    project_slug: 'proj-a',
    cwd: 'C:/p/a',
    title: 'proj-a',
    status: 'live',
    current_session_id: 'cc-A',
    current_bridge_id: 'b-A',
    current_pty_id: 'pty-A',
    created_ms: 1,
    last_seen_ms: 1,
    ...over,
  };
}

describe('parseJsonlTail', () => {
  it('extracts the newest assistant timestamp', () => {
    const older = new Date(NOW - 5 * 60 * 1000).toISOString();
    const newer = new Date(NOW - 1 * 60 * 1000).toISOString();
    const tail =
      JSON.stringify({ role: 'assistant', timestamp: older }) +
      '\n' +
      JSON.stringify({ role: 'user', timestamp: newer }) +
      '\n' +
      JSON.stringify({ role: 'assistant', timestamp: newer });
    const r = parseJsonlTail(tail);
    expect(r.newestAssistantMs).toBe(Date.parse(newer));
  });

  it('flags trailingToolUse when the final tool line is tool_use', () => {
    const tail =
      JSON.stringify({
        type: 'tool_use',
        timestamp: TOOL_TS,
        tool_use_id: 'a',
      }) + '\n';
    const r = parseJsonlTail(tail);
    expect(r.trailingToolUse).toBe(true);
    expect(r.newestToolMs).toBe(Date.parse(TOOL_TS));
  });

  it('clears trailingToolUse once a tool_result follows', () => {
    const tail =
      JSON.stringify({
        type: 'tool_use',
        timestamp: TOOL_TS,
        tool_use_id: 'a',
      }) +
      '\n' +
      JSON.stringify({ type: 'tool_result', is_error: false });
    const r = parseJsonlTail(tail);
    expect(r.trailingToolUse).toBe(false);
  });

  it('returns the trailing slice when tail is larger than snippetMaxBytes', () => {
    const big = 'x'.repeat(5_000);
    const r = parseJsonlTail(big, 1_000);
    expect(r.snippet.length).toBe(1_000);
  });

  it('skips malformed JSON lines without throwing', () => {
    const tail =
      '{not valid\n' +
      JSON.stringify({ role: 'assistant', timestamp: ASSISTANT_TS });
    const r = parseJsonlTail(tail);
    expect(r.newestAssistantMs).toBe(Date.parse(ASSISTANT_TS));
  });
});

describe('deriveEvents', () => {
  function basePrev(): AnchorTailState {
    return newAnchorTailState();
  }

  it('returns no events when the tail signature matches prev', () => {
    const prev: AnchorTailState = {
      ...basePrev(),
      lastTailSig: 'sig-1',
    };
    const parsed = parseJsonlTail('');
    const r = deriveEvents(parsed, prev, anchor(), NOW, 'sig-1');
    expect(r.events).toEqual([]);
  });

  it('fires permission_denied when the tail contains the canonical phrase', () => {
    const parsed = parseJsonlTail(
      JSON.stringify({
        type: 'tool_result',
        is_error: true,
        content: 'Permission to use Bash has been denied',
      }),
    );
    const r = deriveEvents(parsed, basePrev(), anchor(), NOW, 'sig-x');
    expect(r.events.map((e) => e.type)).toContain('permission_denied');
    const e = r.events.find((x) => x.type === 'permission_denied')!;
    expect(e.anchor_id).toBe('anchor-A');
    expect(e.worker_session_id).toBe('cc-A');
    /* Fix 34d.1 addendum: snippet is per-event-type extraction, not
     * raw bytes. permission_denied output leads with denied_tool: <name>. */
    expect(e.snippet).toMatch(/denied_tool:\s*Bash/);
  });

  it('fires idle when last assistant ms is older than the threshold and no tool pending', () => {
    const parsed = parseJsonlTail(
      JSON.stringify({ role: 'assistant', timestamp: OLD_ASSISTANT_TS }),
    );
    const r = deriveEvents(parsed, basePrev(), anchor(), NOW, 'sig-y');
    expect(r.events.map((e) => e.type)).toContain('idle');
  });

  it('does not fire idle while pendingToolUse is true', () => {
    const tail =
      JSON.stringify({ role: 'assistant', timestamp: OLD_ASSISTANT_TS }) +
      '\n' +
      JSON.stringify({
        type: 'tool_use',
        timestamp: TOOL_TS,
        tool_use_id: 'a',
      });
    const parsed = parseJsonlTail(tail);
    const r = deriveEvents(parsed, basePrev(), anchor(), NOW, 'sig-z');
    expect(r.events.map((e) => e.type)).not.toContain('idle');
  });

  it('debounces consecutive permission_denied fires within perTypeMinFireGapMs', () => {
    const tail = JSON.stringify({
      content: 'Permission to use Bash has been denied',
    });
    const parsed = parseJsonlTail(tail);
    const after1 = deriveEvents(parsed, basePrev(), anchor(), NOW, 'sig-1');
    expect(after1.events.map((e) => e.type)).toContain('permission_denied');
    /* same line still in the tail, signature changes but the
     * detector should debounce within the per-type gap. */
    const after2 = deriveEvents(
      parsed,
      after1.nextState,
      anchor(),
      NOW + 5_000,
      'sig-2',
      { perTypeMinFireGapMs: 30_000 },
    );
    expect(after2.events.map((e) => e.type)).not.toContain(
      'permission_denied',
    );
  });

  it('re-fires the same type after the per-type gap elapses', () => {
    const tail = JSON.stringify({
      content: 'Permission to use Bash has been denied',
    });
    const parsed = parseJsonlTail(tail);
    const after1 = deriveEvents(parsed, basePrev(), anchor(), NOW, 'sig-1', {
      perTypeMinFireGapMs: 10_000,
    });
    const after2 = deriveEvents(
      parsed,
      after1.nextState,
      anchor(),
      NOW + 20_000,
      'sig-2',
      { perTypeMinFireGapMs: 10_000 },
    );
    expect(after2.events.map((e) => e.type)).toContain('permission_denied');
  });

  it('carries lastAssistantMs forward across empty ticks', () => {
    const seed = parseJsonlTail(
      JSON.stringify({ role: 'assistant', timestamp: ASSISTANT_TS }),
    );
    const first = deriveEvents(seed, basePrev(), anchor(), NOW, 'sig-1');
    const empty = parseJsonlTail('');
    const second = deriveEvents(
      empty,
      first.nextState,
      anchor(),
      NOW + 1_000,
      'sig-2',
    );
    expect(second.nextState.lastAssistantMs).toBe(Date.parse(ASSISTANT_TS));
  });

  it('emits multiple event types from one tail when each detector fires', () => {
    const tail =
      JSON.stringify({
        content: 'Permission to use Bash has been denied',
      }) +
      '\n' +
      JSON.stringify({
        content: '[master abc1234] feat: stuff\n 3 files changed, 9 insertions',
      });
    const parsed = parseJsonlTail(tail);
    const r = deriveEvents(parsed, basePrev(), anchor(), NOW, 'sig-multi');
    const types = r.events.map((e) => e.type).sort();
    expect(types).toContain('permission_denied');
    expect(types).toContain('commit');
  });
});

describe('deriveEvents — narrated_success_no_commit (Fix 34d.2)', () => {
  function claimAssistant(text: string, tsMs: number): string {
    return JSON.stringify({
      type: 'assistant',
      uuid: `a-${tsMs}`,
      timestamp: new Date(tsMs).toISOString(),
      message: {
        role: 'assistant',
        content: [{ type: 'text', text }],
        stop_reason: 'end_turn',
      },
    });
  }
  function basePrev() {
    return newAnchorTailState();
  }

  it('fires when worker claims shipped but HEAD has not advanced after 60s', () => {
    const claimMs = NOW - 60_000;
    const parsed = parseJsonlTail(claimAssistant('Bundle shipped.', claimMs));
    const seeded = deriveEvents(parsed, basePrev(), anchor(), claimMs, 'sig-1', {
      currentHeadSha: 'sha-A',
      recentCommits: [{ sha: 'sha-A', subject: 'prior commit' }],
    });
    /* Initial observation: seed pending claim, do not fire yet — */
    expect(seeded.events.map((e) => e.type)).not.toContain(
      'narrated_success_no_commit',
    );
    expect(seeded.nextState.pendingSuccessClaim?.headShaAtClaim).toBe('sha-A');
    /* Tick 60 s later with HEAD unchanged. */
    const after = deriveEvents(
      parseJsonlTail(''),
      seeded.nextState,
      anchor(),
      NOW + 1_000,
      'sig-2',
      {
        currentHeadSha: 'sha-A',
        recentCommits: [{ sha: 'sha-A', subject: 'prior commit' }],
      },
    );
    expect(after.events.map((e) => e.type)).toContain(
      'narrated_success_no_commit',
    );
    const ev = after.events.find(
      (e) => e.type === 'narrated_success_no_commit',
    )!;
    expect(ev.snippet).toMatch(/claim: Bundle shipped\./);
    expect(ev.snippet).toMatch(/git HEAD did not advance/);
    expect(ev.snippet).toMatch(/sha_at_claim: sha-A/);
    expect(ev.snippet).toMatch(/recent_commits:/);
    expect(after.nextState.pendingSuccessClaim?.fired).toBe(true);
  });

  it('does NOT fire when HEAD advanced after the claim (commit landed)', () => {
    const claimMs = NOW - 90_000;
    const parsed = parseJsonlTail(claimAssistant('All done.', claimMs));
    const seeded = deriveEvents(parsed, basePrev(), anchor(), claimMs, 'sig-3', {
      currentHeadSha: 'sha-pre',
    });
    expect(seeded.nextState.pendingSuccessClaim?.headShaAtClaim).toBe(
      'sha-pre',
    );
    /* A commit landed between seed and the next tick: HEAD moved. */
    const after = deriveEvents(
      parseJsonlTail(''),
      seeded.nextState,
      anchor(),
      NOW,
      'sig-4',
      { currentHeadSha: 'sha-post' },
    );
    expect(after.events.map((e) => e.type)).not.toContain(
      'narrated_success_no_commit',
    );
    /* Pending claim cleared because HEAD advanced. */
    expect(after.nextState.pendingSuccessClaim).toBeNull();
  });

  it('does NOT re-fire for an earlier claim once a commit landed; tracks per-claim', () => {
    /* Step 1: seed claim A at HEAD=sha-A. */
    const t1 = NOW - 200_000;
    const seedA = deriveEvents(
      parseJsonlTail(claimAssistant('Shipped first thing.', t1)),
      newAnchorTailState(),
      anchor(),
      t1,
      'sig-a1',
      { currentHeadSha: 'sha-A' },
    );
    /* Step 2: commit lands; HEAD moves to sha-B. Claim A cleared. */
    const afterCommit = deriveEvents(
      parseJsonlTail(''),
      seedA.nextState,
      anchor(),
      t1 + 30_000,
      'sig-a2',
      { currentHeadSha: 'sha-B' },
    );
    expect(afterCommit.nextState.pendingSuccessClaim).toBeNull();
    expect(afterCommit.events.map((e) => e.type)).not.toContain(
      'narrated_success_no_commit',
    );
    /* Step 3: a NEW claim arrives, but it is for the work that just
     * landed. Per the spec, the earlier claim must not retroactively
     * fire just because a follow-up claim happened without a fresh
     * commit. We confirm by checking that no narrated_success_no_commit
     * event fires here AND that the newly-tracked claim is keyed on
     * the post-commit HEAD (sha-B), not the pre-commit sha-A. */
    const t3 = t1 + 60_000;
    const newClaim = deriveEvents(
      parseJsonlTail(claimAssistant('Patch landed cleanly.', t3)),
      afterCommit.nextState,
      anchor(),
      t3,
      'sig-a3',
      { currentHeadSha: 'sha-B' },
    );
    expect(newClaim.events.map((e) => e.type)).not.toContain(
      'narrated_success_no_commit',
    );
    /* The NEW claim is seeded against the post-commit HEAD; the
     * earlier (sha-A) claim is gone and cannot retroactively fire. */
    expect(newClaim.nextState.pendingSuccessClaim?.headShaAtClaim).toBe(
      'sha-B',
    );
    expect(newClaim.nextState.pendingSuccessClaim?.text).toBe(
      'Patch landed cleanly.',
    );
  });
});
