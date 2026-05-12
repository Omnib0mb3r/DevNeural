/**
 * Persistence helpers for collapse-toggle panels (Lex transcript
 * history, Past Sessions list, future surfaces). Each panel owns its
 * own localStorage key; createCollapseStore wraps the read / write
 * pair around the key so callers do not handle storage directly.
 *
 * Kept separate from the React component so render tests can verify
 * the storage contract without mounting a full provider tree.
 */

export interface CollapseStore {
  read: (
    storage?: Pick<Storage, "getItem"> | undefined,
  ) => boolean;
  write: (
    collapsed: boolean,
    storage?: Pick<Storage, "setItem" | "removeItem"> | undefined,
  ) => void;
  key: string;
}

function defaultStorage(): Storage | undefined {
  return typeof window !== "undefined" ? window.localStorage : undefined;
}

export function createCollapseStore(key: string): CollapseStore {
  return {
    key,
    read(storage = defaultStorage()) {
      if (!storage) return false;
      try {
        return storage.getItem(key) === "1";
      } catch {
        return false;
      }
    },
    write(collapsed, storage = defaultStorage()) {
      if (!storage) return;
      try {
        if (collapsed) storage.setItem(key, "1");
        else storage.removeItem(key);
      } catch {
        /* ignore (private browsing / quota) */
      }
    },
  };
}

/* Backwards-compat re-exports for TranscriptHistory. The
 * transcript-collapsed key is the original consumer; the same store
 * factory now serves any panel that wants the pattern. */
const TRANSCRIPT_KEY = "devneural.lex.transcript.collapsed";
const transcriptStore = createCollapseStore(TRANSCRIPT_KEY);

export const COLLAPSED_STORAGE_KEY = TRANSCRIPT_KEY;
export const readCollapsedState = transcriptStore.read;
export const writeCollapsedState = transcriptStore.write;
