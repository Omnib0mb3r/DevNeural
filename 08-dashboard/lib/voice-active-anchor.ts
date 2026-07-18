/**
 * Active-voice-anchor pin + persistence (SESSIONS-VIEW read-only,
 * 2026-07-18, defect 2).
 *
 * The live voice bind is pinned to the ACTIVE brainstorm and decoupled
 * from whatever session the operator is merely VIEWING. Opening a
 * session is LOOKING, not SWITCHING: it must never repoint or blip the
 * live voice. So the VoiceClient resolves its bound anchor as "the URL
 * ?brainstorm= when present, else the last persisted active brainstorm"
 * - a session view carries no ?brainstorm=, so voice stays on the
 * brainstorm it was already on instead of snapping to the newest PTY.
 *
 * Persisting the active brainstorm + the enabled flag lets voice
 * restore itself across a remount / hard reload within the tab
 * (sessionStorage: survives reloads, clears on tab close, so a brand-new
 * tab still starts with voice off). Everything is storage-injectable and
 * failure-safe so the contract pins in tests and never throws in private
 * mode.
 */

const ACTIVE_ANCHOR_KEY = "devneural.voice.activeBrainstorm";
const ENABLED_KEY = "devneural.voice.enabled";

export interface PersistedVoiceState {
  activeBrainstorm: string | null;
  enabled: boolean;
}

/** The anchor the live voice should bind to: the explicit URL selection
 * wins (a Lex context or an explicit switch), else the last persisted
 * active brainstorm (so viewing a session keeps voice put). Null means
 * neither is set - a cold visit - and the caller falls back to the
 * newest brainstorm PTY. */
export function resolveActiveBrainstormId(
  urlBrainstormId: string | null,
  persisted: string | null,
): string | null {
  return urlBrainstormId ?? persisted ?? null;
}

function defaultStorage(): Storage | undefined {
  return typeof window !== "undefined" ? window.sessionStorage : undefined;
}

export function readPersistedVoiceState(
  storage: Storage | undefined = defaultStorage(),
): PersistedVoiceState {
  if (!storage) return { activeBrainstorm: null, enabled: false };
  try {
    const anchor = storage.getItem(ACTIVE_ANCHOR_KEY);
    const enabled = storage.getItem(ENABLED_KEY) === "1";
    return { activeBrainstorm: anchor && anchor.length > 0 ? anchor : null, enabled };
  } catch {
    return { activeBrainstorm: null, enabled: false };
  }
}

export function writePersistedActiveBrainstorm(
  id: string | null,
  storage: Storage | undefined = defaultStorage(),
): void {
  if (!storage) return;
  try {
    if (id && id.length > 0) storage.setItem(ACTIVE_ANCHOR_KEY, id);
    else storage.removeItem(ACTIVE_ANCHOR_KEY);
  } catch {
    /* private mode / quota - persistence is best-effort */
  }
}

export function writePersistedVoiceEnabled(
  enabled: boolean,
  storage: Storage | undefined = defaultStorage(),
): void {
  if (!storage) return;
  try {
    if (enabled) storage.setItem(ENABLED_KEY, "1");
    else storage.setItem(ENABLED_KEY, "0");
  } catch {
    /* best-effort */
  }
}

/** Explicit stop / disable: wipe both keys so voice does not resurrect
 * on the next remount. */
export function clearPersistedVoiceState(
  storage: Storage | undefined = defaultStorage(),
): void {
  if (!storage) return;
  try {
    storage.removeItem(ACTIVE_ANCHOR_KEY);
    storage.removeItem(ENABLED_KEY);
  } catch {
    /* best-effort */
  }
}
