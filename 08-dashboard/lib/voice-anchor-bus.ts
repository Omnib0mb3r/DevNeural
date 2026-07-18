/**
 * Voice active-anchor switch bus (SESSIONS-VIEW read-only, 2026-07-18,
 * defect 2 switch path).
 *
 * Switching the live voice to another brainstorm used to be a full-page
 * reload (`window.location.href`), which remounts the globally-mounted
 * VoiceClient and blips voice (WS close + ORT VAD destroy). The reframe
 * requires voice to never blip on view OR switch. So the switch is now a
 * soft in-app signal: the nav site `router.push`es the URL (for
 * deep-linking / back-button) AND emits this event; VoiceClient and the
 * Lex page subscribe and re-pin the bind on the LIVE socket (re-hello),
 * never tearing it down.
 *
 * A null id clears the selection (deselect / return to the newest PTY).
 * Same window-CustomEvent pattern as transcript-bus / voice-settings-bus.
 */

const SWITCH_EVENT = "lex:voice-anchor-switch";

export function emitVoiceAnchorSwitch(brainstormId: string | null): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<string | null>(SWITCH_EVENT, { detail: brainstormId }),
  );
}

export function onVoiceAnchorSwitch(
  cb: (brainstormId: string | null) => void,
): () => void {
  if (typeof window === "undefined") return () => undefined;
  const handler = (e: Event): void => {
    const ce = e as CustomEvent<string | null>;
    cb(ce.detail ?? null);
  };
  window.addEventListener(SWITCH_EVENT, handler);
  return () => window.removeEventListener(SWITCH_EVENT, handler);
}
