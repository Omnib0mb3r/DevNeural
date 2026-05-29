/**
 * LEX-AUTONOMY codex 10c (Fix 47 step 3): voice start-project matcher.
 *
 * Pins the matcher contract for the new "lex start project <name>"
 * command. The lex-voice-ws handler dispatches the captured name into
 * the dashboard /projects/:id/start-claude endpoint via internal
 * fetch; this test stays inside the matcher so the contract is
 * deterministic without a WS boot.
 */
import { describe, expect, it } from 'vitest';
import { matchVoiceCommand } from '../src/voice/lex-voice-commands.js';

describe('matchVoiceCommand start_project (codex 10c)', () => {
  it('captures a single-word project name', () => {
    const m = matchVoiceCommand('Lex start project DevNeural');
    expect(m).not.toBeNull();
    expect(m!.kind).toBe('start_project');
    if (m && m.kind === 'start_project') {
      expect(m.project_name).toBe('devneural');
    }
  });

  it('captures a multi-word project name and collapses whitespace', () => {
    const m = matchVoiceCommand('lex start project   stream   deck  ');
    expect(m).not.toBeNull();
    expect(m!.kind).toBe('start_project');
    if (m && m.kind === 'start_project') {
      expect(m.project_name).toBe('stream deck');
    }
  });

  it('returns null when the project name is missing', () => {
    const m = matchVoiceCommand('lex start project');
    expect(m).toBeNull();
  });
});
