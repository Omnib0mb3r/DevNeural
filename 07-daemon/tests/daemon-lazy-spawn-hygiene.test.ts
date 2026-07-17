import { describe, expect, it } from 'vitest';
import {
  daemonPackageRoot,
  sanitizeDaemonEnv,
} from '../src/lifecycle/spawn.js';

/**
 * Regression: 2026-07-17. During an /admin/daemon/restart window a
 * hook-fired lazy spawn (ensureDaemonRunning) won the race against the
 * DevNeural-Daemon-Restart scheduled task. The spawn passed no cwd and
 * the raw hook process.env, so the daemon ran rooted at the REPO root
 * with a live Claude Code session's env (CLAUDECODE, CLAUDE_CODE_*,
 * VSCODE_*, ELECTRON_RUN_AS_NODE) for a full day. The wrong cwd moved
 * the voice-brain spawn cwd + transcript slug; the leaked env is the
 * same class of hazard the 2026-07-09 child-session fix guards at the
 * daemon -> Lex hop.
 */
describe('daemon lazy-spawn hygiene (2026-07-17 restart-race fix)', () => {
  it('daemonPackageRoot resolves to the 07-daemon package root', () => {
    expect(daemonPackageRoot().replace(/\\/g, '/')).toMatch(/\/07-daemon$/);
  });

  it('strips the launching session identity + IDE-host markers', () => {
    const out = sanitizeDaemonEnv({
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'claude-vscode',
      CLAUDE_CODE_CHILD_SESSION: '1',
      CLAUDE_CODE_SESSION_ID: 'abc',
      CLAUDE_TRANSCRIPT_PATH: 'C:/x.jsonl',
      CLAUDE_AGENT_SDK_VERSION: '0.3.210',
      CLAUDE_EFFORT: 'xhigh',
      VSCODE_PID: '47116',
      VSCODE_IPC_HOOK: 'pipe',
      ELECTRON_RUN_AS_NODE: '1',
      PATH: 'C:/bin',
    });
    for (const k of [
      'CLAUDECODE',
      'CLAUDE_CODE_ENTRYPOINT',
      'CLAUDE_CODE_CHILD_SESSION',
      'CLAUDE_CODE_SESSION_ID',
      'CLAUDE_TRANSCRIPT_PATH',
      'CLAUDE_AGENT_SDK_VERSION',
      'CLAUDE_EFFORT',
      'VSCODE_PID',
      'VSCODE_IPC_HOOK',
      'ELECTRON_RUN_AS_NODE',
    ]) {
      expect(out[k]).toBeUndefined();
    }
    expect(out.PATH).toBe('C:/bin');
  });

  it('preserves config-scope + daemon vars', () => {
    const out = sanitizeDaemonEnv({
      CLAUDE_CONFIG_DIR: 'C:/Users/x/.claude',
      DEVNEURAL_VOICE_HAIKU: '1',
      BRIDGER_ANTHROPIC_API: 'key',
      HOME: 'C:/Users/x',
      CLAUDECODE: '1',
    });
    expect(out.CLAUDE_CONFIG_DIR).toBe('C:/Users/x/.claude');
    expect(out.DEVNEURAL_VOICE_HAIKU).toBe('1');
    expect(out.BRIDGER_ANTHROPIC_API).toBe('key');
    expect(out.HOME).toBe('C:/Users/x');
    expect(out.CLAUDECODE).toBeUndefined();
  });

  it('drops undefined values without crashing', () => {
    const out = sanitizeDaemonEnv({ A: 'x', B: undefined });
    expect(out.A).toBe('x');
    expect('B' in out).toBe(false);
  });
});
