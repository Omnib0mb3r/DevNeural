/**
 * "+ New Project" flow.
 *
 * Clones github.com/Omnib0mb3r/dev-template into C:/dev/Projects/<name>,
 * fills devneural.jsonc, registers the project, optionally opens VS
 * Code on the host machine.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { resolveProjectIdentity } from '../identity/project-id.js';
import { recordIdentity } from '../identity/registry.js';
import { DATA_ROOT } from '../paths.js';

/* Drop a marker the bridge polls under <dataRoot>/session-bridge/
 * .workspace-inject/. The bridge in the VS Code window whose
 * workspaceFolders contain `workspace` claims the marker, opens (or
 * reuses) a terminal at that cwd, types `command`, presses Enter,
 * deletes the marker. Used by the new-project flow and by the
 * Start Claude buttons on the Sessions page for already-registered
 * projects that have no live session yet. */
const WORKSPACE_INJECT_DIR = path.posix.join(
  DATA_ROOT.replace(/\\/g, '/'),
  'session-bridge',
  '.workspace-inject',
);

/* Slug is the sanitized workspace path PLUS a short hash so two
 * projects with paths that collide after sanitization (e.g. one
 * truncated past 80 chars, or differing only on punctuation that we
 * strip) still get distinct marker filenames. Without the hash, a
 * second start-claude press could overwrite a first that hadn't been
 * claimed yet.
 *
 * Exported (not just inlined into queueProjectBootstrap) so
 * pollInjectResult below can derive the SAME result-file path the
 * bridge writes to (09-bridge/src/extension.ts derives its result
 * filename by string surgery on the claimed marker's own path, not by
 * recomputing this slug, so the two sides stay in lockstep as long as
 * this is the one place the slug is computed on the daemon side). */
export function injectSlug(workspace: string): string {
  const normalized = workspace.replace(/\\/g, '/');
  const sanitized = normalized
    .replace(/[^a-z0-9]+/gi, '_')
    .replace(/^_|_$/g, '')
    .toLowerCase()
    .slice(0, 60);
  const hash = createHash('sha1')
    .update(normalized.toLowerCase())
    .digest('hex')
    .slice(0, 8);
  return `${sanitized}_${hash}`;
}

/* WP-H (spawn delivery feedback): path of the result file the bridge
 * writes after it (attempts to) run the workspace-inject command,
 * e.g. .workspace-inject/<slug>.result.json next to the marker's own
 * .workspace-inject/<slug>.json. */
export function injectResultFile(workspace: string): string {
  return path.posix.join(WORKSPACE_INJECT_DIR, `${injectSlug(workspace)}.result.json`);
}

export function queueProjectBootstrap(workspace: string, command: string): void {
  fs.mkdirSync(WORKSPACE_INJECT_DIR, { recursive: true });
  const normalized = workspace.replace(/\\/g, '/');
  const slug = injectSlug(workspace);
  /* Write to .tmp first then rename onto the polled .json filename so
   * the bridge never reads a partial file. The bridge unlinks
   * malformed JSON, which would otherwise drop a request that
   * happened to be polled mid-write. */
  const finalFile = path.posix.join(WORKSPACE_INJECT_DIR, `${slug}.json`);
  const tmpFile = path.posix.join(WORKSPACE_INJECT_DIR, `${slug}.json.tmp`);
  fs.writeFileSync(
    tmpFile,
    JSON.stringify(
      {
        workspace: normalized,
        command,
        queued_at: new Date().toISOString(),
      },
      null,
      2,
    ),
    'utf-8',
  );
  fs.renameSync(tmpFile, finalFile);
}

/* WP-H: delivery confirmation for the workspace-inject flow.
 *
 * The bridge (09-bridge/src/extension.ts runWorkspaceInject) writes
 * .workspace-inject/<slug>.result.json = {ok, error?, at, workspace}
 * once it has claimed the marker and either run the command or hit an
 * error. This polls for that file so a route can tell the dashboard
 * whether the terminal inject actually happened instead of returning
 * an unconditional ok:true the moment the marker was queued.
 *
 * Callers: /projects/:id/start-claude in routes.ts. projects-routes.ts
 * (openProjectAnchor) also calls queueProjectBootstrap via the same
 * bootstrapQueue shape but is owned by a different work package; it
 * does not yet wire this poller in (see HANDOVER note). */
export interface InjectDeliveryResult {
  delivery: 'confirmed' | 'failed' | 'unconfirmed';
  error?: string;
}

export interface PollInjectResultOptions {
  /** Total time to keep polling before giving up. Default 12s. */
  timeoutMs?: number;
  /** Delay between polls. Default 250ms. */
  intervalMs?: number;
  /** Clock injection for tests. */
  now?: () => number;
  /** Sleep injection for tests (avoids real 12s waits in the suite). */
  sleep?: (ms: number) => Promise<void>;
  /** Result-file reader injection for tests. Returns null when the
   * file does not exist (or is unreadable), matching fs.readFileSync
   * ENOENT semantics without forcing tests to touch real disk. */
  readResultFile?: (file: string) => string | null;
}

function defaultReadResultFile(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch {
    return null;
  }
}

export async function pollInjectResult(
  workspace: string,
  opts: PollInjectResultOptions = {},
): Promise<InjectDeliveryResult> {
  const timeoutMs = opts.timeoutMs ?? 12_000;
  const intervalMs = opts.intervalMs ?? 250;
  const now = opts.now ?? Date.now;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const readResultFile = opts.readResultFile ?? defaultReadResultFile;
  const resultFile = injectResultFile(workspace);
  const deadline = now() + timeoutMs;

  for (;;) {
    const raw = readResultFile(resultFile);
    if (raw !== null) {
      try {
        const parsed = JSON.parse(raw) as { ok?: boolean; error?: string };
        if (parsed.ok === true) return { delivery: 'confirmed' };
        return {
          delivery: 'failed',
          error: parsed.error ?? 'bridge reported failure with no error detail',
        };
      } catch {
        /* Result file mid-write (bridge writes tmp-then-rename, so
         * this should be rare, but a torn read is possible on a slow
         * disk). Treat as not-yet-ready and keep polling rather than
         * failing the whole delivery check on a parse race. */
      }
    }
    if (now() >= deadline) return { delivery: 'unconfirmed' };
    await sleep(intervalMs);
  }
}

const TEMPLATE_REPO =
  process.env.DEVNEURAL_TEMPLATE_REPO ??
  'https://github.com/Omnib0mb3r/dev-template';
const PROJECTS_ROOT = (
  process.env.DEVNEURAL_PROJECTS_ROOT ?? 'C:/dev/Projects'
).replace(/\\/g, '/');

export interface NewProjectInput {
  name: string;
  stage?: 'alpha' | 'beta' | 'deployed' | 'archived';
  tags?: string[];
  description?: string;
  open_vscode?: boolean;
}

export interface NewProjectResult {
  ok: boolean;
  path?: string;
  error?: string;
  /* Non-fatal warnings the caller (dashboard) can surface so the user
   * knows when a step like "open VS Code" failed silently. The
   * project is still created and registered; only the side-effect
   * was skipped. */
  warnings?: string[];
}

const NAME_RE = /^[a-z0-9][a-z0-9-]+$/;

export async function createProject(
  input: NewProjectInput,
): Promise<NewProjectResult> {
  if (!input.name || !NAME_RE.test(input.name)) {
    return {
      ok: false,
      error:
        'name must be kebab-case (lowercase letters, digits, hyphens; cannot start with hyphen)',
    };
  }
  const target = path.posix.join(PROJECTS_ROOT, input.name);
  if (fs.existsSync(target)) {
    return { ok: false, error: `path already exists: ${target}` };
  }

  // Clone the template
  try {
    execSync(`git clone --depth 1 ${TEMPLATE_REPO} "${target}"`, {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
      windowsHide: true,
    });
  } catch (err) {
    return { ok: false, error: `git clone failed: ${(err as Error).message}` };
  }

  // Detach from the template's history so this is its own repo
  try {
    fs.rmSync(path.posix.join(target, '.git'), { recursive: true, force: true });
    execSync('git init -q', { cwd: target, stdio: 'ignore', windowsHide: true });
  } catch {
    /* non-fatal */
  }

  // Fill devneural.jsonc
  const configFile = path.posix.join(target, 'devneural.jsonc');
  if (fs.existsSync(configFile)) {
    let raw = fs.readFileSync(configFile, 'utf-8');
    raw = raw
      .replace(/REPLACE_ME_NAME|"name":\s*"REPLACE_ME"/g, `"name": "${input.name}"`)
      .replace(
        /REPLACE_ME_LOCAL_PATH|"localPath":\s*"REPLACE_ME"/g,
        `"localPath": "${target}"`,
      )
      .replace(
        /"stage":\s*"REPLACE_ME"|REPLACE_ME_STAGE/g,
        `"stage": "${input.stage ?? 'alpha'}"`,
      )
      .replace(
        /"description":\s*"REPLACE_ME"|REPLACE_ME_DESCRIPTION/g,
        `"description": "${(input.description ?? '').replace(/"/g, "'")}"`,
      );

    if (input.tags && input.tags.length > 0) {
      raw = raw.replace(
        /"tags":\s*\[\s*\]/,
        `"tags": [${input.tags.map((t) => `"${t}"`).join(', ')}]`,
      );
    }

    fs.writeFileSync(configFile, raw, 'utf-8');
  }

  // Seed the project registry so the new project shows up on the
  // dashboard immediately, before any Claude session writes capture
  // events to register it. resolveProjectIdentity walks the new
  // folder's git config (which we just init'd above) and falls back
  // to a path-based id if no remote is set yet.
  const warnings: string[] = [];
  try {
    const identity = resolveProjectIdentity(target);
    recordIdentity(identity);
  } catch (err) {
    warnings.push(
      `failed to register project in dashboard: ${(err as Error).message}`,
    );
  }

  // Optionally open VS Code (host only). On Windows, `code` ships as
  // a `.cmd` shim that node's spawn cannot resolve without going
  // through cmd.exe, so spawn('code', ...) emits an ENOENT and the
  // window never opens. shell:true routes through cmd.exe which
  // resolves PATHEXT (.cmd, .bat) the same way an interactive shell
  // would. We also listen for the spawn error event because shell:true
  // can mask launcher failures, and surface them as warnings so the
  // dashboard can show a real reason instead of silent failure.
  if (input.open_vscode !== false) {
    try {
      const child = spawn('code', [target], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        shell: true,
      });
      child.on('error', (err) => {
        warnings.push(
          `vs code did not launch: ${err.message}. Add VS Code's bin/ directory to PATH or open the folder manually: ${target}`,
        );
      });
      child.unref();
    } catch (err) {
      warnings.push(
        `vs code did not launch: ${(err as Error).message}. Open the folder manually: ${target}`,
      );
    }
  }

  return { ok: true, path: target, warnings: warnings.length ? warnings : undefined };
}
