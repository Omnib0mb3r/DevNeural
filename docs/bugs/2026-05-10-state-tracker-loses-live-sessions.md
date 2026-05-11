# Bug: state-tracker loses live sessions

**Status:** Deferred to Wave 4 (env override + troubleshooting doc)

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

## Deferred

**Wave 4 carry-over.** The fix is low-risk but requires observing the deck
identity directory behavior on the live host. The workaround is to set
`IDENTITY_FRESH_MS` to 15s (3x the current default) via env override
`DEVNEURAL_IDENTITY_FRESH_MS=15000`. This makes the liveness window robust to
Windows stat-cache lag and the deck re-registration window after daemon restart.

Target: implement the env override for `IDENTITY_FRESH_MS` and document it in
`docs/install/07-troubleshooting.md`.

---

## Verification plan

1. Set `DEVNEURAL_IDENTITY_FRESH_MS=15000`.
2. Restart daemon while deck tray is running.
3. Observe: sessions remain active in dashboard during the deck re-registration window.
4. After 15s without deck writes, sessions flip to mtime fallback correctly.
