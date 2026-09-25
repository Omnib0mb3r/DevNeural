/**
 * Typed-message channel from the Lex page to the live voice socket
 * (BUG-054).
 *
 * The "Talk to Lex" box on app/lex/page.tsx has two ways to reach Lex.
 * The good one is a `text-input` frame on the open voice WebSocket:
 * the daemon echoes the line back as a `transcript` frame (source
 * 'text-input'), injects it, suppresses speech for that turn and
 * streams the reply as `assistant-text`, so both rows land in the
 * transcript. The fallback is the plain HTTP POST /pty/:id/inject,
 * which has no echo and no reply row; the page emits the user row
 * itself and the reply only shows in the terminal mirror.
 *
 * The socket is owned by VoiceClient, mounted once at the app root, so
 * the page cannot reach wsRef directly. This is the same window
 * CustomEvent pattern as transcript-bus / voice-settings-bus, with one
 * twist: dispatchEvent runs its listeners synchronously, so the request
 * object carries a `sent` flag that the VoiceClient listener flips
 * after it put the frame on an OPEN socket, and sendTextInput returns
 * that flag. A false return means "no live socket, take the HTTP
 * path". Reading the flag off VoiceCtx instead would couple the Lex
 * page's render cadence to VoiceClient's (the reason transcript-bus
 * exists), so a bus it is.
 */

export interface VoiceTextInputRequest {
  text: string;
  /** Set to true by the subscriber that put the frame on the wire. */
  sent: boolean;
}

const EVENT_NAME = "lex:voice-text-input";

/**
 * Offer a typed message to the live voice socket. Returns true when a
 * subscriber sent it as a `text-input` frame on an open socket, false
 * when nothing is listening or the socket is not open (voice off,
 * still connecting, reconnecting). The caller falls back to the HTTP
 * inject on false.
 */
export function sendTextInput(text: string): boolean {
  if (typeof window === "undefined") return false;
  const detail: VoiceTextInputRequest = { text, sent: false };
  window.dispatchEvent(
    new CustomEvent<VoiceTextInputRequest>(EVENT_NAME, { detail }),
  );
  return detail.sent;
}

/**
 * Subscribe as the sender. The callback returns true when it actually
 * sent the text; the first subscriber to do so wins and later ones are
 * skipped, so two VoiceClient mounts could never double-send.
 */
export function onVoiceTextInput(
  cb: (text: string) => boolean,
): () => void {
  if (typeof window === "undefined") return () => undefined;
  const handler = (e: Event): void => {
    const ce = e as CustomEvent<VoiceTextInputRequest>;
    const req = ce.detail;
    if (!req || req.sent) return;
    if (cb(req.text)) req.sent = true;
  };
  window.addEventListener(EVENT_NAME, handler);
  return () => window.removeEventListener(EVENT_NAME, handler);
}
