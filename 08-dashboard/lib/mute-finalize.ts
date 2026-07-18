/**
 * Mute-finalize decision (P5, 2026-07-18 VOICE-TOP-LAYER-SMARTS-SPEC).
 *
 * Pressing mute mid-utterance must FINALIZE the in-progress utterance
 * (endpoint it) and SUBMIT what was captured, then go muted - it must
 * NOT discard. Real case: a loud room, the operator mutes the instant
 * he finishes speaking. A true cancel / "scrap that" is a separate
 * gesture, out of scope here.
 *
 * This pure decision gates the finalize + ship of the parallel-capture
 * buffer: yes only when we are MUTING (not unmuting) AND an utterance
 * is actively being captured. Kept separate from the VoiceClient refs
 * so the contract pins without mounting the component.
 */
export function shouldFinalizeUtteranceOnMute(args: {
  muting: boolean;
  capturing: boolean;
}): boolean {
  return args.muting && args.capturing;
}
