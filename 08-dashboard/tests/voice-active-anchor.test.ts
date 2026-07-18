import { describe, it, expect } from "vitest";
import {
  resolveActiveBrainstormId,
  readPersistedVoiceState,
  writePersistedActiveBrainstorm,
  writePersistedVoiceEnabled,
  clearPersistedVoiceState,
} from "../lib/voice-active-anchor";

/**
 * SESSIONS-VIEW read-only (2026-07-18) defect 2: the live voice bind is
 * pinned to the ACTIVE brainstorm and decoupled from whatever session
 * the operator is merely VIEWING. Viewing is looking, not switching:
 * navigating to a session (which carries no ?brainstorm=) must keep
 * voice on the brainstorm it was already on, never repoint it to the
 * "newest PTY" and never blip.
 *
 * resolveActiveBrainstormId is the pure decision the VoiceClient uses to
 * pick the bound anchor; the persistence helpers survive a remount/reload
 * so voice restores itself.
 */
describe("resolveActiveBrainstormId (defect 2 pin-the-bind)", () => {
  it("uses the URL ?brainstorm= when present (explicit Lex context / switch)", () => {
    expect(resolveActiveBrainstormId("bs-url", "bs-persisted")).toBe("bs-url");
  });

  it("falls back to the persisted active brainstorm when the URL has none (viewing a session)", () => {
    expect(resolveActiveBrainstormId(null, "bs-persisted")).toBe("bs-persisted");
  });

  it("returns null on a cold visit with neither (caller then uses newest-PTY)", () => {
    expect(resolveActiveBrainstormId(null, null)).toBeNull();
  });

  it("URL wins even when it differs from persisted (an explicit switch updates the pin)", () => {
    expect(resolveActiveBrainstormId("bs-new", "bs-old")).toBe("bs-new");
  });
});

/* Fake Storage so the persistence contract pins without a real
 * sessionStorage. */
function fakeStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    key: (i: number) => Array.from(m.keys())[i] ?? null,
    removeItem: (k: string) => void m.delete(k),
    setItem: (k: string, v: string) => void m.set(k, v),
  };
}

describe("voice-active-anchor persistence (defect 2 restore-on-remount)", () => {
  it("round-trips the active brainstorm and enabled flag", () => {
    const s = fakeStorage();
    writePersistedActiveBrainstorm("bs-1", s);
    writePersistedVoiceEnabled(true, s);
    const state = readPersistedVoiceState(s);
    expect(state.activeBrainstorm).toBe("bs-1");
    expect(state.enabled).toBe(true);
  });

  it("defaults to no anchor and disabled when nothing is persisted", () => {
    const state = readPersistedVoiceState(fakeStorage());
    expect(state.activeBrainstorm).toBeNull();
    expect(state.enabled).toBe(false);
  });

  it("clearing wipes both keys (explicit stop must not resurrect voice)", () => {
    const s = fakeStorage();
    writePersistedActiveBrainstorm("bs-1", s);
    writePersistedVoiceEnabled(true, s);
    clearPersistedVoiceState(s);
    const state = readPersistedVoiceState(s);
    expect(state.activeBrainstorm).toBeNull();
    expect(state.enabled).toBe(false);
  });

  it("writing enabled=false persists the OFF state (not a clear)", () => {
    const s = fakeStorage();
    writePersistedActiveBrainstorm("bs-1", s);
    writePersistedVoiceEnabled(false, s);
    const state = readPersistedVoiceState(s);
    /* anchor stays pinned; only enabled flipped off */
    expect(state.activeBrainstorm).toBe("bs-1");
    expect(state.enabled).toBe(false);
  });

  it("never throws on a storage that rejects (private mode / quota)", () => {
    const throwing: Storage = {
      length: 0,
      clear: () => {
        throw new Error("nope");
      },
      getItem: () => {
        throw new Error("nope");
      },
      key: () => null,
      removeItem: () => {
        throw new Error("nope");
      },
      setItem: () => {
        throw new Error("nope");
      },
    };
    expect(() => writePersistedActiveBrainstorm("x", throwing)).not.toThrow();
    expect(() => writePersistedVoiceEnabled(true, throwing)).not.toThrow();
    expect(() => clearPersistedVoiceState(throwing)).not.toThrow();
    const state = readPersistedVoiceState(throwing);
    expect(state.activeBrainstorm).toBeNull();
    expect(state.enabled).toBe(false);
  });
});
