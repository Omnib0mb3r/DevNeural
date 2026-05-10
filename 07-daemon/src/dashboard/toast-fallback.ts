/**
 * Native OS toast fallback (OP-2).
 *
 * When web push delivers zero notifications (no PWA subscribed,
 * all subscriptions stale, push server unreachable), fall back to
 * a Windows toast via the BurntToast PowerShell module. Reuses the
 * existing notification payload shape so the call site only flips
 * one branch.
 *
 * BurntToast availability: `Get-Module -ListAvailable BurntToast`.
 * Install with `Install-Module BurntToast -Scope CurrentUser`.
 * docs/install/NOTIFICATIONS.md is the user-facing guide.
 *
 * Fail-open: if PowerShell or BurntToast is missing, we log once
 * and skip silently. The notification is already in
 * notifications.jsonl so the dashboard surface still shows it.
 */
import { spawn } from 'node:child_process';

export interface ToastPayload {
  title: string;
  body?: string;
  url?: string;
}

export interface ToastFallbackOptions {
  /* Override for tests. Defaults to the real PowerShell spawn. */
  spawnImpl?: typeof spawn;
  log?: (msg: string) => void;
}

let burntToastAvailable: boolean | null = null;
let availabilityCheckLogged = false;

function buildScript(p: ToastPayload): string {
  /* Single-quoted PowerShell strings escape embedded single quotes
   * by doubling them. The body and title both pass through that
   * escape so the toast renders user content faithfully. */
  const esc = (s: string) => s.replace(/'/g, "''");
  const lines: string[] = [];
  lines.push(`Import-Module BurntToast -ErrorAction Stop`);
  const args = [`-Text '${esc(p.title)}'`];
  if (p.body) args.push(`'${esc(p.body)}'`);
  lines.push(`New-BurntToastNotification ${args.join(' ')}`);
  return lines.join('; ');
}

export async function showToast(
  payload: ToastPayload,
  opts: ToastFallbackOptions = {},
): Promise<'shown' | 'unavailable' | 'failed'> {
  const log = opts.log ?? (() => undefined);
  const spawner = opts.spawnImpl ?? spawn;
  if (burntToastAvailable === false) return 'unavailable';
  return new Promise((resolve) => {
    const proc = spawner(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        buildScript(payload),
      ],
      { windowsHide: true },
    );
    let stderr = '';
    proc.stderr?.on('data', (b: Buffer) => (stderr += b.toString()));
    proc.on('error', (err) => {
      burntToastAvailable = false;
      if (!availabilityCheckLogged) {
        log(`[toast] powershell unavailable: ${err.message}`);
        availabilityCheckLogged = true;
      }
      resolve('unavailable');
    });
    proc.on('close', (code) => {
      if (code === 0) {
        burntToastAvailable = true;
        resolve('shown');
        return;
      }
      /* Module-not-found surfaces as a non-zero exit with the
       * "Import-Module ... was not loaded" stderr. Mark unavailable
       * so subsequent calls short-circuit until the daemon restarts. */
      if (/BurntToast/i.test(stderr) && /not loaded|could not be loaded/i.test(stderr)) {
        burntToastAvailable = false;
        if (!availabilityCheckLogged) {
          log(`[toast] BurntToast module missing; install with: Install-Module BurntToast -Scope CurrentUser`);
          availabilityCheckLogged = true;
        }
        resolve('unavailable');
        return;
      }
      log(`[toast] showToast failed code=${code}: ${stderr.trim().slice(0, 200)}`);
      resolve('failed');
    });
  });
}

/* Test-only reset so the in-process availability cache does not
 * leak between cases. */
export function _resetToastAvailability(): void {
  burntToastAvailable = null;
  availabilityCheckLogged = false;
}
