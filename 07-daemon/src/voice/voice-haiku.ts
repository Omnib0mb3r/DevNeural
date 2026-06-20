/* Haiku voice talk-layer scaffold (pillar 3, sliver V1).
 *
 * The voice tier is a separate fast model (Haiku) that owns the mouth
 * and the front desk: single mouth, two lanes, deny-by-default
 * whitelist, control channel, renderer-not-rethinker. This module is the
 * flag + model config every later slice of the pillar builds on. It does
 * NOT make model calls yet (V1 is single-mouth ownership + scaffold); the
 * lane/classifier/renderer slices fill in the client.
 *
 * Default OFF: with DEVNEURAL_VOICE_HAIKU unset the current voice path is
 * untouched. Nothing in this pillar changes runtime behavior until the
 * flag is flipped (a separate Michael step that needs a daemon restart).
 */

/** True when the haiku voice tier owns the mouth + front desk. */
export function useVoiceHaiku(): boolean {
  return process.env.DEVNEURAL_VOICE_HAIKU === '1';
}

/* Talk-layer model. Default: Anthropic Haiku (latency-optimal; the plan
 * names Haiku for the voice tier - voice lives or dies on latency).
 *
 * BF-4 posture (documented for the lane/classifier slices): the haiku
 * layer never receives raw brainstorm transcripts. By the deny-by-default
 * whitelist it only ever handles (a) pure conversational glue with no
 * project content, or (b) Lex's already-synthesized user-facing reply to
 * RENDER for speech - text already destined for the user's ears. Any
 * project/code/state fact queues to Opus-Lex instead, so brainstorm
 * content is never reasoned about by this model. */
export const VOICE_HAIKU_MODEL =
  process.env.DEVNEURAL_VOICE_HAIKU_MODEL ?? 'claude-haiku-4-5-20251001';

export interface VoiceHaikuConfig {
  enabled: boolean;
  model: string;
}

export function voiceHaikuConfig(): VoiceHaikuConfig {
  return { enabled: useVoiceHaiku(), model: VOICE_HAIKU_MODEL };
}
