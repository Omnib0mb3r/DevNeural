#!/usr/bin/env node
/**
 * install-hooks.
 *
 * Idempotently registers the four DevNeural hook entries in
 * ~/.claude/settings.json. Safe to re-run.
 *
 * Each registration is keyed by a stable marker (`devneural:hook-runner:<phase>`)
 * embedded in a leading comment-style command string fragment. We detect
 * existing DevNeural entries by command path and replace them.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json').replace(/\\/g, '/');

const HOOK_RUNNER_DIST = path
  .resolve(__dirname, '..', '..', '..', 'dist', 'capture', 'hooks', 'hook-runner.js')
  .replace(/\\/g, '/');

const SEVEN_DAEMON_ROOT = path.resolve(__dirname, '..', '..', '..');

/**
 * R1 fix: hooks must run silently (no console flash) AND still receive
 * Claude Code's JSON payload on stdin.
 *
 * The original silencing attempt wrapped every phase in wscript.exe +
 * a generated VBScript shim (WshShell.Run). That hides the window, but
 * WshShell.Run does NOT pipe stdin to the child process, so every hook
 * phase wrapped this way received an empty payload: user_prompt
 * observations landed with prompt='' and session='unknown', tool
 * payloads landed empty. Only SessionStart's live entry was hand-patched
 * around this (via scripts/silence-all-hooks.ps1) to route through
 * silent-shim.exe instead, which is a native console app
 * (scripts/silent-shim/Program.cs) that hides its window via
 * CreateNoWindow=true *and* pumps stdin/stdout/stderr through
 * (RedirectStandardInput/Output/Error=true). That is the only wrapper
 * that is both silent and payload-preserving. Every phase must route
 * through it, not just SessionStart.
 *
 * silent-shim.exe is a compiled .NET artifact (dotnet publish), not a
 * TypeScript build output, so it is not produced by `npm run build`
 * and its bin/ directory is gitignored. We resolve it the same way
 * scripts/silence-all-hooks.ps1 / repair-double-wrapped-hooks.ps1 do:
 * an optional env override, then the framework-dependent publish
 * output, then the self-contained win-x64 publish output.
 */
function silentShimCandidates(): string[] {
  const candidates = [
    process.env.DEVNEURAL_SILENT_SHIM,
    path.resolve(SEVEN_DAEMON_ROOT, 'scripts', 'silent-shim', 'bin', 'silent-shim.exe'),
    path.resolve(
      SEVEN_DAEMON_ROOT,
      'scripts',
      'silent-shim',
      'bin',
      'Release',
      'net8.0',
      'win-x64',
      'silent-shim.exe',
    ),
  ];
  return candidates.filter((p): p is string => Boolean(p));
}

function resolveSilentShim(): string | null {
  for (const candidate of silentShimCandidates()) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

interface HookCommandEntry {
  type: 'command';
  command: string;
  timeout?: number;
}

interface HookGroup {
  matcher?: string;
  hooks: HookCommandEntry[];
}

interface SettingsFile {
  hooks?: Record<string, HookGroup[] | undefined> | HookGroup[] | undefined;
  // settings.json may have other keys; preserve them.
  [key: string]: unknown;
}

export const HOOK_PHASES: Array<{ event: string; phase: string; matcher?: string }> = [
  { event: 'PreToolUse', phase: 'pre' },
  { event: 'PostToolUse', phase: 'post' },
  { event: 'UserPromptSubmit', phase: 'prompt' },
  { event: 'Stop', phase: 'stop' },
  // Notification fires when Claude is waiting on a permission/elicitation
  // answer from the user. We capture the prompt message + matcher so the
  // dashboard can surface the question with answer buttons; without this
  // entry the dashboard sees nothing when CC asks "1) yes 2) no" and the
  // user has to tab back to the VS Code window to reply.
  { event: 'Notification', phase: 'notification' },
  // SessionStart fires on every session boot. We care about source=clear
  // so the daemon can mark the previous session in this workspace as
  // superseded; without this, /clear leaves a phantom tile in the Stream
  // Deck rail until the old jsonl's mtime ages past ACTIVE_THRESHOLD_MS.
  { event: 'SessionStart', phase: 'session_start' },
];

/**
 * Build the hook command for one phase, wrapped in silent-shim.exe exactly
 * the way the (previously hand-patched) working SessionStart entry is:
 *   "<shim>" "node \"<hook-runner-dist>\" <phase>"
 *
 * The inner command is a single quoted argument (silent-shim.exe splits on
 * the first whitespace to find its own exe, then forwards the remainder
 * verbatim as ProcessStartInfo.Arguments — see Program.cs). Embedded
 * double-quotes are backslash-escaped rather than cmd-style doubled ("")
 * because Claude Code on Windows invokes hook commands through Git Bash,
 * which treats `""` inside a `"..."` string as empty-string concatenation
 * and collapses the whole inner command into a single mis-split argv[0].
 * Backslash `\"` is honored by both bash and CommandLineToArgvW, so it
 * survives either invocation path (see scripts/reescape-hook-args.ps1,
 * which fixed the same bug for the manually-patched entries).
 *
 * shimPath is passed in rather than read from a module constant so this
 * function stays a pure string formatter, independently testable without
 * depending on whether silent-shim.exe has been built on the machine
 * running the tests.
 */
export function buildCommand(phase: string, shimPath: string): string {
  const shim = shimPath.replace(/\//g, '\\');
  const inner = `node "${HOOK_RUNNER_DIST}" ${phase}`;
  const escapedInner = inner.replace(/"/g, '\\"');
  return `"${shim}" "${escapedInner}"`;
}

const V1_PATHS = [
  '01-data-layer/dist/hook-runner.js',
  '01-data-layer\\dist\\hook-runner.js',
  '04-session-intelligence/dist/session-start.js',
  '04-session-intelligence\\dist\\session-start.js',
];

function isV1Entry(entry: HookCommandEntry): boolean {
  if (!entry || entry.type !== 'command') return false;
  if (typeof entry.command !== 'string') return false;
  for (const p of V1_PATHS) if (entry.command.includes(p)) return true;
  return false;
}

/* Matches both the current silent-shim.exe-wrapped shape and the old
 * broken wscript+VBS shape (R1). The hook-runner.js path substring
 * survives inside the shim wrapper untouched (only its surrounding
 * quotes get backslash-escaped — see buildCommand), so the same
 * `.includes()` check recognizes both; the silent-runner.vbs checks
 * stay so re-running install-hooks replaces old broken entries instead
 * of leaving them alongside the fixed one. */
function isV2Entry(entry: HookCommandEntry): boolean {
  if (!entry || entry.type !== 'command') return false;
  if (typeof entry.command !== 'string') return false;
  return (
    entry.command.includes('07-daemon/dist/capture/hooks/hook-runner.js') ||
    entry.command.includes('07-daemon\\dist\\capture\\hooks\\hook-runner.js') ||
    entry.command.includes('07-daemon/dist/capture/hooks/silent-runner.vbs') ||
    entry.command.includes('07-daemon\\dist\\capture\\hooks\\silent-runner.vbs')
  );
}

export function isDevNeuralEntry(entry: HookCommandEntry): boolean {
  return isV1Entry(entry) || isV2Entry(entry);
}

function loadSettings(): SettingsFile {
  if (!fs.existsSync(SETTINGS_PATH)) return {};
  try {
    let raw = fs.readFileSync(SETTINGS_PATH, 'utf-8');
    // Strip UTF-8 BOM. PowerShell 5.1's Set-Content -Encoding UTF8 prepends
    // one and breaks JSON.parse; tolerate it on read so we don't fight other
    // tools that may have written the file.
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    return JSON.parse(raw) as SettingsFile;
  } catch (err) {
    throw new Error(
      `failed to parse ${SETTINGS_PATH}: ${(err as Error).message}`,
    );
  }
}

function saveSettings(settings: SettingsFile): void {
  const backup = SETTINGS_PATH + '.devneural.bak';
  if (fs.existsSync(SETTINGS_PATH)) {
    fs.copyFileSync(SETTINGS_PATH, backup);
  }
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf-8');
}

function ensureHooksObject(settings: SettingsFile): Record<string, HookGroup[]> {
  if (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
    settings.hooks = {};
  }
  return settings.hooks as Record<string, HookGroup[]>;
}

function addHook(
  hooks: Record<string, HookGroup[]>,
  event: string,
  command: string,
  matcher?: string,
): void {
  const groups = hooks[event] ?? [];

  // Strip any existing devneural entries from this event.
  const cleaned: HookGroup[] = [];
  for (const group of groups) {
    const remaining = (group.hooks ?? []).filter((h) => !isDevNeuralEntry(h));
    if (remaining.length > 0) {
      cleaned.push({ ...group, hooks: remaining });
    } else if (group.matcher && group.matcher !== matcher) {
      // empty group with a different matcher: keep so user's other config isn't dropped
      cleaned.push({ ...group, hooks: [] });
    }
  }

  cleaned.push({
    ...(matcher !== undefined ? { matcher } : {}),
    hooks: [{ type: 'command', command }],
  });

  hooks[event] = cleaned;
}

/**
 * Walk every hook event in the settings and strip any v1 DevNeural entries.
 * The four HOOK_PHASES events get explicit re-installation by addHook; this
 * pass cleans up v1 entries that landed under events we no longer claim
 * (e.g. v1 SessionStart entries that v2 doesn't replace because v2 absorbs
 * startup-context loading into the daemon's polling).
 */
function purgeOrphanedV1Entries(hooks: Record<string, HookGroup[]>): number {
  let purged = 0;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const cleaned: HookGroup[] = [];
    for (const group of groups) {
      const before = (group.hooks ?? []).length;
      const remaining = (group.hooks ?? []).filter((h) => !isV1Entry(h));
      purged += before - remaining.length;
      if (remaining.length > 0) {
        cleaned.push({ ...group, hooks: remaining });
      } else if (group.matcher) {
        // preserve empty matcher-bearing group so other tools' future entries land cleanly
        cleaned.push({ ...group, hooks: [] });
      }
    }
    hooks[event] = cleaned;
  }
  return purged;
}

function main(): void {
  if (!fs.existsSync(HOOK_RUNNER_DIST)) {
    console.error(
      `[install-hooks] hook runner not built. Run \`npm run build\` first.\n  expected: ${HOOK_RUNNER_DIST}`,
    );
    process.exit(1);
  }

  const shimPath = resolveSilentShim();
  if (!shimPath) {
    console.error(
      `[install-hooks] silent-shim.exe not built. It is a .NET binary, not a\n` +
        `TypeScript build output, so \`npm run build\` does not produce it. Build it with:\n` +
        `  cd 07-daemon/scripts/silent-shim && dotnet publish -c Release -r win-x64\n` +
        `expected one of:\n` +
        silentShimCandidates()
          .map((c) => `  ${c}`)
          .join('\n'),
    );
    process.exit(1);
  }

  const settings = loadSettings();
  const hooks = ensureHooksObject(settings);

  const purged = purgeOrphanedV1Entries(hooks);
  if (purged > 0) {
    console.log(`[install-hooks] purged ${purged} orphaned v1 entr${purged === 1 ? 'y' : 'ies'}`);
  }

  for (const { event, phase, matcher } of HOOK_PHASES) {
    const command = buildCommand(phase, shimPath);
    addHook(hooks, event, command, matcher ?? (event.endsWith('ToolUse') ? '*' : undefined));
  }

  saveSettings(settings);
  console.log(`[install-hooks] wrote ${SETTINGS_PATH}`);
  console.log(`[install-hooks] hook runner: ${HOOK_RUNNER_DIST}`);
  console.log(`[install-hooks] silent shim: ${shimPath}`);
}

/* Guard the CLI entrypoint so the module is import-safe for tests. When
 * run as `node install-hooks.js`, import.meta.url matches the resolved
 * argv[1] file URL and main() fires; when imported by a test file the
 * guard is false and only the exported functions become available.
 * Without this guard, importing this module for its buildCommand /
 * isDevNeuralEntry exports would fire main() inside the test worker and
 * overwrite the real ~/.claude/settings.json. */
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main();
}
