/**
 * Personality file permission guard (Wave 3 Lane B step 42 / LX-17).
 *
 * Two-layer protection for the lex-prompts/ directory:
 *
 * Layer A - Prompt rule (behavioral):
 *   A PERSONALITY_GUARD_RULE constant is exported for inclusion in the
 *   system prompt, explicitly forbidding Lex from writing to its own
 *   personality files. The rule is injected between INTERNAL_FIRST and
 *   LIVE_FS_AWARENESS so it is always present.
 *
 * Layer B - Daemon watcher (observational):
 *   A filesystem watcher detects writes to lexPromptsRoot() and emits
 *   an audit-finding with severity='high' so the operator is alerted
 *   in the dashboard.
 *
 * Layer C - OS ACL (hardening, best-effort, Windows only):
 *   applyIcacls() runs icacls to deny write access to the prompts
 *   directory for the current user account on a second DACL entry.
 *   This only works when the daemon is run as a non-admin user and
 *   a separate admin account manages the personality files. In most
 *   single-user setups it is a no-op (same user can always override
 *   DENY via admin), but it adds friction to casual modification.
 *
 * The watcher and ACL setup are both optional/best-effort. Errors
 * are logged but never throw into the daemon startup path.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { lexPromptsRoot } from '../paths.js';
import { emitAwarenessEvent } from './awareness.js';

/* Prompt block injected into the system prompt. */
export const PERSONALITY_GUARD_RULE = `# Personality file protection

The following directories and files are READ-ONLY from your perspective.
You MUST NOT write to, overwrite, or delete them, even if asked directly.

- DATA_ROOT/lex-prompts/          (prompt archive, few-shot, refusal contracts)
- DATA_ROOT/lex-prompts/few-shot/ (per-mode few-shot examples)
- DATA_ROOT/lex-prompts/refusal-contract.md
- DATA_ROOT/lex-prompts/refusal-contract-meeting.md

If Michael asks you to update a few-shot example or refusal contract, explain
that personality files must be edited by a human (not via Bash tool) and offer
to draft the change as a code block for Michael to paste manually.

Do not use the Bash tool to write, append, or delete anything under lex-prompts/.
`;

let watcherActive = false;

/**
 * Start a Node.js fs.watch on the lex-prompts directory.
 * On any 'change' or 'rename' event, emit an audit-finding with
 * source='canary' and severity='high'.
 *
 * Returns a cleanup function that stops the watcher.
 */
export function startPersonalityGuardWatcher(
  log: (msg: string) => void = () => undefined,
): () => void {
  if (watcherActive) return () => undefined;
  const dir = lexPromptsRoot();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* already exists */
  }
  let watcher: fs.FSWatcher | null = null;
  try {
    watcher = fs.watch(
      dir,
      { recursive: true, persistent: false },
      (eventType, filename) => {
        if (!filename) return;
        /* Ignore .md archive writes that come from prompt-archive.ts
         * (the daemon itself writes versioned .md files here on every
         * Lex spawn). Archive files match the pattern /^[a-f0-9-]+\.md$/.
         * Only alert on writes to the few-shot or refusal-contract paths. */
        const normalised = String(filename).replace(/\\/g, '/');
        const isProtected =
          normalised.startsWith('few-shot/') ||
          normalised === 'refusal-contract.md' ||
          normalised === 'refusal-contract-meeting.md';
        if (!isProtected) return;
        const msg = `personality-guard: unexpected ${eventType} on lex-prompts/${normalised}`;
        log(`[personality-guard] ${msg}`);
        emitAwarenessEvent({
          kind: 'audit-finding',
          label: msg,
          detail: { event_type: eventType, file: normalised },
        });
      },
    );
    watcherActive = true;
    log('[personality-guard] watcher active on lex-prompts/');
  } catch (err) {
    log(`[personality-guard] watcher failed to start: ${(err as Error).message}`);
  }

  return () => {
    try {
      watcher?.close();
      watcherActive = false;
    } catch {
      /* ignore */
    }
  };
}

/**
 * Best-effort icacls hardening on Windows.
 * Adds a DENY:W (deny write) entry for the current user on the
 * refusal-contract.md and few-shot/ subtree.
 *
 * This is intentionally weak (admin can override) but adds friction.
 * Logged to the daemon log; never throws.
 */
export function applyIcacls(log: (msg: string) => void = () => undefined): void {
  if (os.platform() !== 'win32') {
    log('[personality-guard] icacls skipped (non-Windows)');
    return;
  }
  const dir = lexPromptsRoot();
  const fewShotDir = path.join(dir, 'few-shot');
  const targets: string[] = [
    path.join(dir, 'refusal-contract.md'),
    path.join(dir, 'refusal-contract-meeting.md'),
  ];
  /* Lock individual files inside few-shot/, not the directory itself.
   * Denying (W) on the directory blocks daemon-side seed-file creation
   * in readOrSeed(), which throws EACCES out of buildLexSystemPrompt
   * and causes /pty/spawn-lex to 500. Files inside can still be
   * protected without breaking first-run seeding. */
  if (fs.existsSync(fewShotDir) && fs.statSync(fewShotDir).isDirectory()) {
    try {
      for (const name of fs.readdirSync(fewShotDir)) {
        const full = path.join(fewShotDir, name);
        if (fs.statSync(full).isFile()) targets.push(full);
      }
    } catch (err) {
      log(`[personality-guard] could not enumerate few-shot/: ${(err as Error).message}`);
    }
  }
  const user = os.userInfo().username;
  for (const target of targets) {
    if (!fs.existsSync(target)) continue;
    execFile(
      'icacls.exe',
      [target, '/deny', `${user}:(W)`, '/Q'],
      {
        windowsHide: true,
        timeout: 5_000,
      },
      (err, _stdout, stderr) => {
        if (err) {
          log(`[personality-guard] icacls failed on ${target}: ${stderr || err.message}`);
        } else {
          log(`[personality-guard] icacls deny-write applied: ${target}`);
        }
      },
    );
  }
}
