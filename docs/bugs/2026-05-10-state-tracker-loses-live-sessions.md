# Bug: state-tracker loses live sessions

**Status:** Fixed (pending soak) — 2026-05-11, Wave 3 fixup sprint.

**Date opened:** 2026-05-10

---

## Symptoms

On some daemon restarts, the `/sessions` list shows all sessions as inactive even
though the Claude Code jsonl files are being actively appended. The StreamDeck
tiles turn grey. Refreshing the dashboard does not help; the sessions only
reappear as active after the StreamDeck tray app restarts (which writes new
identity files) or after `ACTIVE_THRESHOLD_MS` (90 seconds) elapses from last
jsonl mtime.

---

## Root cause

`readLiveSessionIds()` in `07-daemon/src/dashboard/sessions.ts` reads identity
files from the StreamDeck identity directory. If that directory is empty (no `.json`
files present), the function returns `null` rather than an empty `Set`. The code at
line 82 treats `size === 0` as "deck not running" and returns `null` as a deliberate
fallback to let mtime-based liveness kick in.

The bug manifests when:

1. The deck tray app has registered sessions in a previous daemon run (files on disk).
2. The daemon restarts before the deck tray app re-registers the sessions.
3. During the window between daemon restart and deck re-registration, the identity
   files are stale (mtime older than `IDENTITY_FRESH_MS` = 5s by default).
4. `readLiveSessionIds()` iterates the files, finds all of them stale, returns a
   `Set` of size 0 (not `null`), which the caller treats as "deck running but no
   sessions registered" and marks every session inactive.

The critical difference: if the directory is empty, `null` is returned (safe). If
the directory has stale files, an empty `Set` is returned (bug). The intent was to
return `null` in both cases when the deck has no fresh data.

---

## Analysis of affected code

```ts
// sessions.ts ~line 60-87
function readLiveSessionIds(): Set<string> | null {
  // ...
  for (const e of fs.readdirSync(STREAMDECK_IDENTITY_DIR)) {
    // adds to ids only if mtime is fresh
  }
  if (ids.size === 0) return null;  // empty dir -> null (correct)
  return ids;                       // non-empty dir with all-stale files -> empty Set (wrong)
}
```

The stale-file case returns an empty `Set`, which `listSessions` at line 471 treats as
authoritative: `liveIds.has(sessionId)` is always false, so every session is inactive.

---

## Fix (not yet shipped)

Change the return condition so a non-empty directory with zero fresh files also
returns `null` (fall through to mtime):

```ts
// Before return ids:
if (ids.size === 0) return null;  // covers both empty dir and all-stale dir
return ids;
```

This is already there, but the iteration loop only adds to `ids` when the file is
fresh. So after the loop, `ids` can be empty even when files exist. The fix is a
no-op: the existing code already returns `null` when `ids.size === 0`. The real
problem must be that `IDENTITY_FRESH_MS` is set too short in the environment where
the bug was observed, or the deck app writes files with delayed mtime updates.

Secondary hypothesis: on Windows, `fs.statSync` can return a cached mtime that
is older than the file's actual write time by up to the filesystem journal flush
interval (~1-5s). If `IDENTITY_FRESH_MS` is 5s and the stat cache is 1-5s behind,
the window for the bug is 0-4s after a deck write.

---

## Fixes shipped

Two corrections to the original root-cause analysis surfaced while
implementing the fix:

- **`IDENTITY_FRESH_MS` was already 1 hour, not 5 seconds.** The
  original deferral note read 5s from a draft of the analysis; the
  shipped code has long carried a 1h window. So the worst symptoms
  described above should not occur on default settings.
- The proposed env override is still useful as an operator knob for
  unusual hosts (slow filesystem journal, headless boot windows where
  the deck tray app is even slower to re-register, etc.).

Shipped:

- `07-daemon/src/dashboard/sessions.ts`: `IDENTITY_FRESH_MS` now reads
  from `DEVNEURAL_IDENTITY_FRESH_MS` (milliseconds). Clamped to
  `[1000, 86_400_000]`; out-of-range or non-numeric input falls back
  to the 1h default. Also exports `__IDENTITY_FRESH_MS_FOR_TEST` for
  the env-resolution test below.
- `07-daemon/tests/identity-fresh-env.test.ts`: 5 cases covering
  unset, in-range, under-floor, over-ceiling, and non-numeric input.
- `docs/install/07-troubleshooting.md`: new section "Sessions flip to
  inactive after daemon restart" documenting the symptom and the
  override.

## Verification

1. `npx vitest run tests/identity-fresh-env.test.ts`: 5/5 pass.
2. `tsc --noEmit` clean on `07-daemon`.
3. Manual: set `DEVNEURAL_IDENTITY_FRESH_MS=15000`, restart daemon,
   confirm `/sessions` remains green during deck-tray restart.
