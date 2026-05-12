/**
 * Persistence helpers for the Lex transcript history collapse toggle.
 *
 * Kept separate from the React component so render tests can verify
 * the storage contract without mounting a full provider tree.
 */

const STORAGE_KEY = "devneural.lex.transcript.collapsed";

export function readCollapsedState(
  storage: Pick<Storage, "getItem"> | undefined = typeof window !==
  "undefined"
    ? window.localStorage
    : undefined,
): boolean {
  if (!storage) return false;
  try {
    return storage.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeCollapsedState(
  collapsed: boolean,
  storage: Pick<Storage, "setItem" | "removeItem"> | undefined = typeof window !==
  "undefined"
    ? window.localStorage
    : undefined,
): void {
  if (!storage) return;
  try {
    if (collapsed) storage.setItem(STORAGE_KEY, "1");
    else storage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore (private browsing / quota) */
  }
}

export const COLLAPSED_STORAGE_KEY = STORAGE_KEY;
