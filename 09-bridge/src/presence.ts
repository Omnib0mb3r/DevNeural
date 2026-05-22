/**
 * Bridge presence file writer (PROJECT-ANCHORS.md step 2 of 6).
 *
 * Pure helpers used by the VS Code extension's tick loop to write one
 * presence file per top-level workspace folder under
 * <dataRoot>/session-bridge/.bridge-presence/. The daemon polls this
 * directory and flips the matching project_session anchor to live.
 *
 * Kept free of vscode imports so it can be unit-tested without the
 * extension host.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface WorkspaceFolderLike {
  fsPath: string;
}

export interface BuildPayloadOptions {
  workspace: string;
  bridgeId: string;
  ccSessionId?: string;
  now: Date;
  /* Per-UUID deliverability map: true means this bridge instance owns
   * a VS Code terminal whose process tree contains the claude.exe for
   * the given cc_session_id. Daemon routes injects ONLY to presence
   * files where the flag is true for the target UUID. Absent or false
   * means "this bridge claims the UUID but cannot deliver to it
   * right now"; the daemon will surface a structured no-deliverable
   * -bridge instead of dropping the prompt into a sinkhole. */
  hasTerminalForUuid?: Record<string, boolean>;
}

export interface PresencePayload {
  workspace: string;
  cwd: string;
  bridge_id: string;
  updated_at: string;
  cc_session_ids?: string[];
  /* See BuildPayloadOptions.hasTerminalForUuid. Optional for
   * backwards-compat: presence files written by older bridges will
   * not include this field, and the daemon must treat absence as
   * "unknown" rather than false to avoid breaking the migration
   * window. */
  has_terminal_for_uuid?: Record<string, boolean>;
}

export interface WritePresenceOptions {
  presenceDir: string;
  folders: WorkspaceFolderLike[];
  bridgeId: string;
  now: Date;
  /** Optional: returns the active CC session id for a given cwd. */
  ccSessionLookup?: (cwd: string) => string | undefined;
  /** Optional: returns the deliverability flag for a given (cwd, uuid). */
  hasTerminalForUuidLookup?: (cwd: string, uuid: string) => boolean;
}

/* Presence filename layout:
 *   <cwd-key>__<bridge-id>.json     (current, multi-window safe)
 *   <cwd-key>.json                  (legacy, pre-2026-05-22)
 *
 * Multi-window-same-cwd otherwise clobbered (last writer wins, every
 * 750ms) and the daemon could not tell which window's bridge actually
 * has a deliverable terminal. The bridge_id suffix keeps every
 * window's record distinct; the daemon enumerates the whole dir and
 * groups by the cwd field inside the payload, not by filename. */
export function presenceFilename(cwd: string, bridgeId?: string): string {
  const cwdKey = cwd.replace(/[\\/:*?"<>|]/g, '_') || 'no-workspace';
  if (!bridgeId) return cwdKey;
  return `${cwdKey}__${bridgeId}`;
}

/* Legacy filename emitted by bridges < 2026-05-22. Kept so a fresh
 * bridge can scrub the old single-file-per-cwd entry on activate /
 * deactivate without leaving stale presence in the directory. */
export function legacyPresenceFilename(cwd: string): string {
  return cwd.replace(/[\\/:*?"<>|]/g, '_') || 'no-workspace';
}

function normalizeCwd(s: string): string {
  return s.replace(/\\/g, '/');
}

export function buildPresencePayload(
  opts: BuildPayloadOptions,
): PresencePayload {
  const cwd = normalizeCwd(opts.workspace);
  const payload: PresencePayload = {
    workspace: cwd,
    cwd,
    bridge_id: opts.bridgeId,
    updated_at: opts.now.toISOString(),
  };
  if (opts.ccSessionId) {
    payload.cc_session_ids = [opts.ccSessionId];
  }
  if (opts.hasTerminalForUuid && Object.keys(opts.hasTerminalForUuid).length > 0) {
    payload.has_terminal_for_uuid = opts.hasTerminalForUuid;
  }
  return payload;
}

/* Returns the absolute paths of every presence file written. Best
 * effort: directory creation failures and write failures are swallowed
 * so the tick loop doesn't crash on a transient fs hiccup, but tests
 * can still verify success by inspecting the returned list. */
export function writePresenceFiles(opts: WritePresenceOptions): string[] {
  if (opts.folders.length === 0) return [];
  if (!fs.existsSync(opts.presenceDir)) {
    try {
      fs.mkdirSync(opts.presenceDir, { recursive: true });
    } catch {
      return [];
    }
  }
  const written: string[] = [];
  for (const folder of opts.folders) {
    const cwd = normalizeCwd(folder.fsPath);
    const filename = `${presenceFilename(cwd, opts.bridgeId)}.json`;
    const file = path.posix.join(opts.presenceDir.replace(/\\/g, '/'), filename);
    const ccSessionId = opts.ccSessionLookup?.(cwd);
    let hasTerminalForUuid: Record<string, boolean> | undefined;
    if (ccSessionId && opts.hasTerminalForUuidLookup) {
      hasTerminalForUuid = {
        [ccSessionId]: opts.hasTerminalForUuidLookup(cwd, ccSessionId),
      };
    }
    const payload = buildPresencePayload({
      workspace: cwd,
      bridgeId: opts.bridgeId,
      ccSessionId,
      now: opts.now,
      hasTerminalForUuid,
    });
    try {
      fs.writeFileSync(file, JSON.stringify(payload), 'utf-8');
      written.push(file);
    } catch {
      /* ignore individual file failures */
    }
  }
  return written;
}
