/**
 * Shared persona (LAYER-1-CONTROL.md, "Personality: one Lex, two mouths").
 *
 * One identity feeds both layers: L2 (the brain) keeps the written style,
 * L1 (the voice) owns every spoken-behavior rule. Neither prompt carries
 * the other's rules, and the identity/persona text is byte-identical in
 * both compositions.
 */
import { describe, expect, it } from 'vitest';
import {
  LEX_IDENTITY,
  LEX_PERSONA,
  LEX_SPOKEN_RULES,
  LEX_TEXT_STYLE,
  composeBrainIdentity,
  composeVoiceIdentity,
} from '../src/lex/persona.js';
import { buildLexSystemPromptStable } from '../src/lex/system-prompt.js';

describe('persona: one Lex, two mouths', () => {
  it('both compositions share the identity and persona verbatim', () => {
    const brain = composeBrainIdentity();
    const voice = composeVoiceIdentity();
    for (const block of [LEX_IDENTITY, LEX_PERSONA]) {
      expect(brain).toContain(block);
      expect(voice).toContain(block);
    }
    expect(LEX_IDENTITY).toContain('# You are Lex.');
    expect(LEX_PERSONA).toContain('Dry British wit');
  });

  it('the brain keeps the written style and never the spoken rules', () => {
    const brain = composeBrainIdentity();
    expect(brain).toContain(LEX_TEXT_STYLE);
    expect(brain).not.toContain('Voice mode (TTS)');
    expect(brain).not.toContain(LEX_SPOKEN_RULES);
  });

  it('the voice gets the spoken rules and not the written-style block', () => {
    const voice = composeVoiceIdentity();
    expect(voice).toContain(LEX_SPOKEN_RULES);
    expect(voice).not.toContain(LEX_TEXT_STYLE);
    expect(LEX_SPOKEN_RULES).toMatch(/no markdown/i);
    expect(LEX_SPOKEN_RULES).toMatch(/UUID/);
    expect(LEX_SPOKEN_RULES).not.toMatch(/—|–/);
  });

  it('the L2 system prompt is built from the shared blocks', () => {
    const prompt = buildLexSystemPromptStable('conversation');
    expect(prompt).toContain(LEX_IDENTITY);
    expect(prompt).toContain(LEX_PERSONA);
    expect(prompt).toContain(LEX_TEXT_STYLE);
    expect(prompt).not.toContain('Voice mode (TTS)');
    /* The rest of the identity layer (seed protocol, live_state rules)
     * still follows the shared blocks. */
    expect(prompt).toContain('## First-turn seed protocol');
  });
});
