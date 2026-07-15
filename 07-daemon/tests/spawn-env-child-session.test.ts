import { describe, expect, it } from 'vitest';
import {
  sanitizeClaudeSpawnEnv,
  CHILD_SESSION_ENV_MARKERS,
} from '../src/dashboard/pty-host.js';

/**
 * Regression: 2026-07-09 Lex went silent (voice "stuck thinking",
 * terminal mirror blank, injects apparently ignored).
 *
 * Root cause: the daemon had been launched from inside a Claude Code
 * session, so CLAUDE_CODE_CHILD_SESSION=1 lived in its process.env.
 * spawnLex passed the full env through, so every Lex PTY inherited the
 * flag and ran in child-session mode - which writes NO transcript
 * jsonl and no ~/.claude/sessions/<pid>.json pidfile. The voice +
 * mirror pipeline tails that jsonl for assistant turns, so Lex replied
 * only inside its own PTY and the daemon never saw the turn.
 *
 * Fix: sanitizeClaudeSpawnEnv strips the parent's child-session
 * identity markers before the PTY spawn, so a top-level Lex always
 * persists its transcript no matter how the daemon was launched.
 * Verified by direct PTY repro: stripping CLAUDE_CODE_CHILD_SESSION
 * alone restored both the transcript jsonl and the pidfile.
 */
describe('sanitizeClaudeSpawnEnv (child-session persistence fix)', () => {
  it('strips the persistence-killing CLAUDE_CODE_CHILD_SESSION marker', () => {
    const out = sanitizeClaudeSpawnEnv({
      CLAUDE_CODE_CHILD_SESSION: '1',
      PATH: '/usr/bin',
    });
    expect(out.CLAUDE_CODE_CHILD_SESSION).toBeUndefined();
    expect(out.PATH).toBe('/usr/bin');
  });

  it('strips every declared parent-session identity marker', () => {
    const base: Record<string, string> = { KEEP: 'yes' };
    for (const k of CHILD_SESSION_ENV_MARKERS) base[k] = 'parent-value';
    const out = sanitizeClaudeSpawnEnv(base);
    for (const k of CHILD_SESSION_ENV_MARKERS) {
      expect(out[k]).toBeUndefined();
    }
    expect(out.KEEP).toBe('yes');
  });

  it('preserves config-scope + daemon vars that a fresh session needs', () => {
    const out = sanitizeClaudeSpawnEnv({
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CONFIG_DIR: 'C:/Users/x/.claude',
      DEVNEURAL_VOICE_HAIKU: '1',
      HOME: 'C:/Users/x',
    });
    expect(out.CLAUDE_CONFIG_DIR).toBe('C:/Users/x/.claude');
    expect(out.DEVNEURAL_VOICE_HAIKU).toBe('1');
    expect(out.HOME).toBe('C:/Users/x');
    expect(out.CLAUDE_CODE_CHILD_SESSION).toBeUndefined();
  });

  it('strips ANTHROPIC_API_KEY so Lex stays on Claude Max, not API billing', () => {
    /* The daemon sets ANTHROPIC_API_KEY for its own voice-haiku SDK, but
     * a spawned Opus Lex must NOT inherit it (that would flip the session
     * from Max/OAuth to per-token API billing). */
    const out = sanitizeClaudeSpawnEnv({
      ANTHROPIC_API_KEY: 'sk-ant-should-not-reach-claude',
      HOME: 'C:/Users/x',
    });
    expect(out.ANTHROPIC_API_KEY).toBeUndefined();
    expect(out.HOME).toBe('C:/Users/x');
  });

  it('drops undefined values (NodeJS.ProcessEnv holes) without crashing', () => {
    const base: NodeJS.ProcessEnv = { A: 'x', B: undefined };
    const out = sanitizeClaudeSpawnEnv(base);
    expect(out.A).toBe('x');
    expect('B' in out).toBe(false);
  });

  it('keeps CLAUDE_CODE_CHILD_SESSION in the marker list (the critical one)', () => {
    expect(CHILD_SESSION_ENV_MARKERS).toContain('CLAUDE_CODE_CHILD_SESSION');
  });
});
