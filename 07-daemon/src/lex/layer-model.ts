/**
 * Per-layer model + permission-mode resolution (2026-07-18).
 *
 * Three-layer voice topology, each layer a headless `claude` session:
 *   L1 TOP    - haiku (voice-brain-session.ts, DEVNEURAL_VOICE_BRAIN_MODEL)
 *   L2 MID    - opus, --permission-mode plan (the planner/supervisor)
 *   L3 WORKER - opus, --dangerously-skip-permissions (the executor)
 *
 * The operator wants a LIVE switch of L2 + L3 between opus and fable
 * with no rebuild. That value lives in runtime_config (flippable via
 * POST /runtime-config/:key) and is read per-spawn, so a new mid/worker
 * session picks up the current choice. This module is the single, pure,
 * tested resolver both spawn sites use.
 *
 * SECURITY: the worker model is interpolated into a command STRING that
 * the session bridge types into a terminal (queueProjectBootstrap). An
 * unvalidated value would be a command-injection vector, so resolveLayer
 * Model whitelists known aliases and clean `claude-*` ids and rejects
 * everything else back to the fallback. Never pass an unresolved value
 * into an argv or a command string.
 */

/* Short aliases Claude Code accepts for --model. */
const KNOWN_MODEL_ALIASES: ReadonlySet<string> = new Set([
  'opus',
  'fable',
  'sonnet',
  'haiku',
]);

/* Full model ids (e.g. claude-opus-4-8, claude-fable-5,
 * claude-haiku-4-5-20251001). Deliberately strict: lowercase letters,
 * digits, dot, hyphen only, and must start with `claude-`. This is the
 * command-injection guard - no spaces, quotes, semicolons, backticks,
 * ampersands, or redirects can survive it. */
const FULL_MODEL_ID_RE = /^claude-[a-z0-9.-]+$/;

/* The permission modes Claude Code accepts for --permission-mode
 * (from `claude --help`). */
const KNOWN_PERMISSION_MODES: ReadonlySet<string> = new Set([
  'acceptEdits',
  'auto',
  'bypassPermissions',
  'manual',
  'dontAsk',
  'plan',
]);

/**
 * Resolve a per-layer model to a safe --model value. Accepts a short
 * alias (opus/fable/sonnet/haiku, case-insensitive) or a clean
 * `claude-*` full id; anything else (empty, unknown, or containing
 * shell metacharacters) falls back to `fallback`. The returned value is
 * always safe to place in an argv or a command string.
 */
export function resolveLayerModel(
  raw: string | null | undefined,
  fallback: string,
): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return fallback;
  const lower = trimmed.toLowerCase();
  if (KNOWN_MODEL_ALIASES.has(lower)) return lower;
  if (FULL_MODEL_ID_RE.test(lower)) return lower;
  return fallback;
}

/**
 * Resolve a per-layer permission mode to a valid --permission-mode
 * value. Unknown/empty falls back to `fallback`. Case-sensitive because
 * the CLI enum is case-sensitive (acceptEdits, bypassPermissions, ...).
 */
export function resolvePermissionMode(
  raw: string | null | undefined,
  fallback: string,
): string {
  const trimmed = (raw ?? '').trim();
  if (KNOWN_PERMISSION_MODES.has(trimmed)) return trimmed;
  return fallback;
}

/* runtime_config keys + env fallbacks for the live switch. Read order:
 * runtime_config (live, flippable via the endpoint) wins, then the env
 * var (start-daemon.ps1 / process env), then the hard default. */
export const MID_MODEL_KEY = 'mid_model';
export const WORKER_MODEL_KEY = 'worker_model';
export const MID_PERMISSION_MODE_KEY = 'mid_permission_mode';

export interface RuntimeConfigReader {
  getRuntimeConfig(key: string): string | null;
}

/** Resolve the MID (L2) model: runtime_config.mid_model ->
 * DEVNEURAL_MID_MODEL -> 'opus'. */
export function midModel(cfg: RuntimeConfigReader): string {
  return resolveLayerModel(
    cfg.getRuntimeConfig(MID_MODEL_KEY) ?? process.env.DEVNEURAL_MID_MODEL,
    'opus',
  );
}

/** Resolve the MID (L2) permission mode: runtime_config
 * .mid_permission_mode -> DEVNEURAL_MID_PERMISSION_MODE -> default.
 *
 * Default is 'bypassPermissions' (exactly today's working headless
 * behavior), NOT 'plan'. The operator wants the mid in plan mode, but a
 * headless `--permission-mode plan` session STALLS on the plan-approval
 * prompt (no human in the TUI to approve). That approval must first be
 * routed to Layer 1 headlessly (detect the mid's plan-approval prompt ->
 * top layer decides -> daemon injects the approval). Until that routing
 * lands, defaulting to 'plan' would hang the mid on every turn, so the
 * safe default ships and 'plan' is one live flip away with no rebuild:
 *   POST /runtime-config/mid_permission_mode {"value":"plan"} */
export function midPermissionMode(cfg: RuntimeConfigReader): string {
  return resolvePermissionMode(
    cfg.getRuntimeConfig(MID_PERMISSION_MODE_KEY) ??
      process.env.DEVNEURAL_MID_PERMISSION_MODE,
    'bypassPermissions',
  );
}

/** Resolve the WORKER (L3) model: runtime_config.worker_model ->
 * DEVNEURAL_WORKER_MODEL -> 'opus'. */
export function workerModel(cfg: RuntimeConfigReader): string {
  return resolveLayerModel(
    cfg.getRuntimeConfig(WORKER_MODEL_KEY) ?? process.env.DEVNEURAL_WORKER_MODEL,
    'opus',
  );
}
