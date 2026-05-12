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
}

export interface PresencePayload {
  workspace: string;
  cwd: string;
  bridge_id: string;
  updated_at: string;
  cc_session_ids?: string[];
}

export interface WritePresenceOptions {
  presenceDir: string;
  folders: WorkspaceFolderLike[];
  bridgeId: string;
  now: Date;
  /** Optional: returns the active CC session id for a given cwd. */
  ccSessionLookup?: (cwd: string) => string | undefined;
}

export function presenceFilename(cwd: string): string {
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
    const filename = `${presenceFilename(cwd)}.json`;
    const file = path.posix.join(opts.presenceDir.replace(/\\/g, '/'), filename);
    const ccSessionId = opts.ccSessionLookup?.(cwd);
    const payload = buildPresencePayload({
      workspace: cwd,
      bridgeId: opts.bridgeId,
      ccSessionId,
      now: opts.now,
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
