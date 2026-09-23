/**
 * Hard constraint (operator, 2026-09-22): everything Lex-shaped runs on
 * the operator's Claude subscription through `claude` sessions. No
 * Anthropic API, no API key, no `--bare`. The BF-4 guard on the LLM
 * provider stays; this pin keeps the voice, handover, self-clear and
 * context-pack modules free of any API surface, and the L1 spawn on the
 * interactive CLI.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', 'src');

const GUARDED = [
  'voice/voice-top-layer.ts',
  'voice/lex-voice-ws.ts',
  'voice/lex-voice-speak-controller.ts',
  'lex/voice-brain-session.ts',
  'lex/handover-frame.ts',
  'lex/handover-writer.ts',
  'lex/handover-approval.ts',
  'lex/handover-from-trail.ts',
  'lex/lex-self-clear.ts',
  'lex/lex-context-pack.ts',
  'dashboard/handover-routes.ts',
  'dashboard/lex-self-clear-routes.ts',
  'dashboard/voice-layers-wire.ts',
  'dashboard/worker-event-detect.ts',
  'dashboard/worker-event-router.ts',
];

const FORBIDDEN = [
  /api\.anthropic\.com/,
  /ANTHROPIC_API_KEY/,
  /@anthropic-ai\/sdk/,
  /x-api-key/i,
  /messages\.create\(/,
];

describe('no Anthropic API on the Lex layers', () => {
  it('the voice, handover, self-clear and context-pack modules carry no API surface', () => {
    for (const rel of GUARDED) {
      const text = fs.readFileSync(path.join(SRC, rel), 'utf-8');
      for (const re of FORBIDDEN) {
        expect(text, `${rel} matches ${re}`).not.toMatch(re);
      }
    }
  });

  it('the judge session and the voice brain spawn the interactive CLI, never --bare or a key', () => {
    for (const rel of ['lex/judge-session.ts', 'lex/voice-brain-session.ts', 'dashboard/pty-host.ts']) {
      const text = fs.readFileSync(path.join(SRC, rel), 'utf-8');
      expect(text, `${rel} passes --bare`).not.toMatch(/['"]--bare['"]/);
      expect(text, `${rel} sets an API key`).not.toMatch(/ANTHROPIC_API_KEY\s*[:=]\s*['"`][^'"`]+/);
    }
  });
});
