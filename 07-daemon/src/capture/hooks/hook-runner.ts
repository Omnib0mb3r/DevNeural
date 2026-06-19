#!/usr/bin/env node
/**
 * DevNeural hook runner.
 *
 * Invoked by every Claude Code hook entry that DevNeural cares about
 * (PreToolUse, PostToolUse, UserPromptSubmit, Stop). The hook is called
 * with a single CLI arg (the phase name) and the hook payload on stdin.
 *
 * Hot path. Stays cheap:
 *   1. read stdin
 *   2. evaluate self-loop guards
 *   3. resolve project identity
 *   4. scrub secrets
 *   5. append one observation line
 *   6. throttle-signal the daemon (every N events)
 *   7. lazy-spawn daemon if not running
 *
 * Always exit 0. Hooks must never block Claude.
 */
import { resolveProjectIdentity } from '../../identity/project-id.js';
import { recordIdentity } from '../../identity/registry.js';
import {
  appendObservation,
  bumpSignalCounter,
  purgeOldArchivesOncePerDay,
} from '../observations.js';
import { evaluateGuards } from '../../lifecycle/guards.js';
import { scrubSecrets, scrubObject } from '../secret-scrub.js';
import { ensureDaemonRunning } from '../../lifecycle/spawn.js';
import { readPid, isAlive } from '../../lifecycle/pid.js';
import type { HookPayload, HookPhase, Observation } from '../../types.js';

const CURATE_TIMEOUT_MS = Number(
  process.env.DEVNEURAL_CURATE_TIMEOUT_MS ?? 1500,
);
const DAEMON_PORT = Number(process.env.DEVNEURAL_PORT ?? 3747);

/* Push the live phase to the daemon so the dashboard's stream-deck
 * tile colour reflects what Claude is doing right now. Without this
 * ping every active session sat at "unknown" and the rail showed
 * green/idle for sessions that were actively running tools or
 * thinking. Bounded timeout; daemon-down silently skips. */
async function pingPhase(
  sessionId: string,
  phase: 'thinking' | 'tool' | 'idle' | 'permission',
): Promise<void> {
  if (!sessionId || sessionId === 'unknown') return;
  const url = `http://127.0.0.1:${DAEMON_PORT}/sessions/${encodeURIComponent(sessionId)}/phase`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 800);
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phase }),
      signal: ctrl.signal,
    });
  } catch {
    /* daemon down or timeout; phase ping silently skipped */
  } finally {
    clearTimeout(t);
  }
}

async function curateAndPrint(
  prompt: string,
  sessionId: string,
  projectId: string,
): Promise<void> {
  if (!prompt || prompt.trim().length < 4) return;
  const url = `http://127.0.0.1:${DAEMON_PORT}/curate`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), CURATE_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt,
        session_id: sessionId,
        project_id: projectId,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return;
    const body = (await res.json()) as {
      ok?: boolean;
      injection?: string;
      components?: { skipped_reason?: string };
    };
    if (body.ok && body.injection && body.injection.trim().length > 0) {
      // Claude Code reads hook stdout and treats it as additional context.
      process.stdout.write(body.injection + '\n');
    }
  } catch {
    /* daemon down or timeout; injection silently skipped */
  } finally {
    clearTimeout(t);
  }
}

const MAX_FIELD_BYTES = 5000;

function trim(value: string): string {
  if (value.length <= MAX_FIELD_BYTES) return value;
  return value.slice(0, MAX_FIELD_BYTES) + '...[truncated]';
}

function parsePhase(arg: string | undefined): HookPhase {
  switch ((arg ?? '').toLowerCase()) {
    case 'pre':
    case 'pretool':
    case 'pre_tool':
    case 'pretooluse':
      return 'pre_tool';
    case 'post':
    case 'posttool':
    case 'post_tool':
    case 'posttooluse':
      return 'post_tool';
    case 'prompt':
    case 'user_prompt':
    case 'userpromptsubmit':
      return 'user_prompt';
    case 'stop':
    case 'session_stop':
      return 'session_stop';
    case 'notification':
    case 'notify':
      return 'notification';
    case 'session_start':
    case 'sessionstart':
    case 'start':
      return 'session_start';
    default:
      return 'post_tool';
  }
}

/* Ask the daemon for prior-sibling-session decisions on a fresh Lex
 * spawn (SessionStart source=startup) and print the returned block to
 * stdout so Claude Code injects it as additionalContext on the very
 * first turn. Letting Lex reference a prior decision without firing
 * a Read.
 *
 * Three-state gating mirrors the smart-compact precedent:
 *   - 'off'    : skip everything; the daemon route is not even hit.
 *   - 'shadow' : call the route; it computes the block and writes an
 *                audit row but returns block:'' so this hook prints
 *                nothing to stdout (no inject).
 *   - 'live'   : call the route; it returns the real block; hook
 *                prints to stdout so CC picks it up as
 *                additionalContext on the first turn.
 *
 * The daemon side reads runtime_config first, then this env var,
 * then defaults to 'shadow'. The hook only needs to decide whether
 * to hit the route at all; mode mapping for the response shape
 * happens daemon-side. Explicit env='off' / 'false' / '0' short-
 * circuits the call entirely; any other value (including unset)
 * forwards to the daemon so the shadow default still records what
 * would have happened.
 *
 * Bounded timeout; daemon-down or empty-block paths are silent
 * no-ops so a missing daemon never blocks the session start. */
export async function postColdStartPreload(
  sessionId: string,
  cwd: string,
): Promise<void> {
  if (!sessionId) return;
  const flag = String(
    process.env.DEVNEURAL_LEX_COLD_START_PRELOAD_ENABLED ?? '',
  )
    .trim()
    .toLowerCase();
  if (flag === 'off' || flag === 'false' || flag === '0') return;
  const url = `http://127.0.0.1:${DAEMON_PORT}/lex/cold-start-preload`;
  const ctrl = new AbortController();
  /* The live route force-distills the top-N siblings + runs stale-ref
   * catchup through the LLM generator synchronously before it answers
   * (routes.ts /lex/cold-start-preload). Measured ~8.3s on a real
   * brainstorm with 29 stale refs; the old 2000ms abort guaranteed the
   * hook bailed before the block was ready, so the preamble was computed
   * and audit-logged server-side but NEVER injected (looked like it
   * worked; delivered nothing). 15s clears the measured cost with
   * headroom. Daemon-down still fast-fails on connection refused, so
   * this only extends the wait when the daemon is actually computing.
   * The pre-launch Opus investigator (moves this work off the hook path
   * entirely) supersedes the need for a long hook wait. */
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, cwd }),
      signal: ctrl.signal,
    });
    if (!res.ok) return;
    const json = (await res.json()) as {
      ok?: boolean;
      block?: string;
    };
    if (!json.ok || !json.block || json.block.trim().length === 0) return;
    /* Claude Code's SessionStart hook only auto-injects stdout into
     * the first user turn when the payload is shaped as a
     * hookSpecificOutput JSON envelope with hookEventName and
     * additionalContext. Plain markdown is displayed but dropped
     * from the prompt context. Wrap the block so CC threads it in. */
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: json.block,
        },
      }),
    );
  } catch {
    /* daemon down / network error / timeout: silent no-op */
  } finally {
    clearTimeout(t);
  }
}

/* Ask the daemon to build a worker-handoff doc for the new session
 * and print it to stdout so CC injects it as additionalContext on
 * the first turn. Mirrors postColdStartPreload but targets project
 * anchor worker sessions instead of Lex brainstorms. The daemon's
 * /worker/clear-handoff endpoint returns an empty block (without
 * error) when the cwd is not bound to a project_session row, so
 * non-worker sessions are no-ops.
 *
 * Bounded timeout; daemon-down silently skips. Fires on every
 * SessionStart (startup AND clear/compact) so a /clear inside a
 * project anchor restores the full context, not just a one-line
 * stop hook summary. */
export async function postWorkerHandoff(
  sessionId: string,
  cwd: string,
): Promise<void> {
  if (!sessionId || !cwd) return;
  const flag = String(process.env.DEVNEURAL_WORKER_HANDOFF_ENABLED ?? '')
    .trim()
    .toLowerCase();
  if (flag === 'off' || flag === 'false' || flag === '0') return;
  const url = `http://127.0.0.1:${DAEMON_PORT}/worker/clear-handoff`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 2000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, cwd }),
      signal: ctrl.signal,
    });
    if (!res.ok) return;
    const json = (await res.json()) as { ok?: boolean; block?: string };
    if (!json.ok || !json.block || json.block.trim().length === 0) return;
    /* Same SessionStart envelope contract as postColdStartPreload.
     * Plain stdout is dropped by CC; only the hookSpecificOutput
     * shape threads additionalContext into the first user turn. */
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: json.block,
        },
      }),
    );
  } catch {
    /* daemon down / network error / timeout: silent no-op */
  } finally {
    clearTimeout(t);
  }
}

/* Tell the daemon a SessionStart fired from /clear so it can mark the
 * previous session in this workspace as superseded. Without this the
 * Stream Deck rail keeps the old tile around for ACTIVE_THRESHOLD_MS. */
async function postClearSupersede(
  sessionId: string,
  cwd: string,
): Promise<void> {
  if (!sessionId || !cwd) return;
  const url = `http://127.0.0.1:${DAEMON_PORT}/sessions/clear-supersede`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 800);
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId, cwd }),
      signal: ctrl.signal,
    });
  } catch {
    /* daemon down or timeout; supersede silently skipped */
  } finally {
    clearTimeout(t);
  }
}

/* Forward Claude's notification message to the daemon so the dashboard
 * can render the prompt + answer buttons. Bounded timeout; daemon-down
 * silently skips. */
async function postPendingPrompt(
  sessionId: string,
  message: string,
  kind: string,
): Promise<void> {
  if (!sessionId || sessionId === 'unknown' || !message) return;
  const url = `http://127.0.0.1:${DAEMON_PORT}/sessions/${encodeURIComponent(sessionId)}/pending-prompt`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 800);
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, kind }),
      signal: ctrl.signal,
    });
  } catch {
    /* daemon down or timeout; pending-prompt push silently skipped */
  } finally {
    clearTimeout(t);
  }
}

/* Recap-line forwarder.
 *
 * The user's shell prompt (Starship/Powerlevel etc.) injects a "※ recap:"
 * one-liner above the prompt area summarizing the prior context. Those
 * recaps are pure shell garnish from CC's perspective, but they're
 * exactly the kind of one-line state-of-the-session that's worth
 * surfacing on the dashboard so the user can scan progress remotely.
 *
 * Strategy: scan UserPromptSubmit prompts for "※ recap:" (with or
 * without leading whitespace, anywhere in the message). If found, emit
 * an info-level notification with source="recap" so the activity rail
 * picks it up. Body is the text from the marker to the next blank line
 * or end of prompt, capped so we don't shove a paragraph into a toast. */
const RECAP_MARKER = /(?:^|\n)[ \t]*[※][ \t]*recap[: ]\s*([\s\S]+?)(?=\n\s*\n|$)/i;
const RECAP_MAX = 600;

async function maybeEmitRecap(prompt: string, sessionId: string): Promise<void> {
  if (!prompt) return;
  const m = prompt.match(RECAP_MARKER);
  if (!m || !m[1]) return;
  const body = m[1].trim().replace(/\s+/g, ' ').slice(0, RECAP_MAX);
  if (!body) return;
  const url = `http://127.0.0.1:${DAEMON_PORT}/notifications`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 800);
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        severity: 'info',
        source: 'recap',
        title: '※ recap',
        body,
        link: sessionId
          ? `/sessions/detail?id=${encodeURIComponent(sessionId)}`
          : undefined,
      }),
      signal: ctrl.signal,
    });
  } catch {
    /* daemon down; recap silently skipped */
  } finally {
    clearTimeout(t);
  }
}

/* Lex pulse.
 *
 * Fired on Stop so the dashboard activity rail surfaces Claude's last
 * assistant message in plain English. The daemon does the heavy
 * lifting: tail-reads the jsonl, extracts the last text turn, decides
 * severity, dedupes. Hook-runner just pings the endpoint with
 * session_id + cwd. Bounded timeout; daemon-down silently skips. */
async function postLexPulse(sessionId: string, cwd: string): Promise<void> {
  if (!sessionId || sessionId === 'unknown') return;
  const url = `http://127.0.0.1:${DAEMON_PORT}/sessions/${encodeURIComponent(sessionId)}/lex-pulse`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 1000);
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd }),
      signal: ctrl.signal,
    });
  } catch {
    /* daemon down or timeout; pulse silently skipped */
  } finally {
    clearTimeout(t);
  }
}

async function clearPendingPrompt(sessionId: string): Promise<void> {
  if (!sessionId || sessionId === 'unknown') return;
  const url = `http://127.0.0.1:${DAEMON_PORT}/sessions/${encodeURIComponent(sessionId)}/pending-prompt`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 500);
  try {
    await fetch(url, { method: 'DELETE', signal: ctrl.signal });
  } catch {
    /* ignore */
  } finally {
    clearTimeout(t);
  }
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  process.stdin.setEncoding('utf-8');
  let buf = '';
  for await (const chunk of process.stdin) {
    buf += chunk;
    if (buf.length > 256 * 1024) break;
  }
  return buf;
}

function parsePayload(raw: string): HookPayload | null {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as HookPayload;
  } catch {
    return null;
  }
}

function buildObservation(
  phase: HookPhase,
  payload: HookPayload,
  projectId: string,
  projectName: string,
): Observation {
  const timestamp = new Date().toISOString();
  const session = String(payload.session_id ?? 'unknown');
  const cwd = payload.cwd ? String(payload.cwd) : undefined;

  if (phase === 'user_prompt') {
    const promptText = payload.prompt ?? payload.user_prompt ?? '';
    return {
      timestamp,
      event: 'user_prompt',
      session,
      project_id: projectId,
      project_name: projectName,
      prompt: scrubSecrets(trim(String(promptText))),
      cwd,
    };
  }

  if (phase === 'session_stop') {
    return {
      timestamp,
      event: 'session_stop',
      session,
      project_id: projectId,
      project_name: projectName,
      cwd,
    };
  }

  if (phase === 'notification') {
    const message = String(payload.message ?? '');
    const kind = String(
      payload.notification_type ?? payload.hook_event_name ?? 'notification',
    );
    return {
      timestamp,
      event: 'notification',
      session,
      project_id: projectId,
      project_name: projectName,
      cwd,
      notification_kind: kind,
      notification_message: scrubSecrets(trim(message)),
    };
  }

  const tool = String(payload.tool_name ?? payload.tool ?? 'unknown');

  if (phase === 'pre_tool') {
    const inputRaw = payload.tool_input ?? payload.input ?? '';
    return {
      timestamp,
      event: 'tool_start',
      session,
      project_id: projectId,
      project_name: projectName,
      tool,
      input: trim(scrubObject(inputRaw)),
      cwd,
    };
  }

  // post_tool
  const outputRaw =
    payload.tool_response ?? payload.tool_output ?? payload.output ?? '';
  return {
    timestamp,
    event: 'tool_complete',
    session,
    project_id: projectId,
    project_name: projectName,
    tool,
    output: trim(scrubObject(outputRaw)),
    cwd,
  };
}

async function main(): Promise<void> {
  const phase = parsePhase(process.argv[2]);
  const raw = await readStdin();
  const payload = parsePayload(raw);

  if (payload === null) {
    // Parse error: log a minimal observation under global so we know it happened
    const obs: Observation = {
      timestamp: new Date().toISOString(),
      event: 'parse_error',
      session: 'unknown',
      project_id: 'global',
      project_name: 'global',
      raw: trim(scrubSecrets(raw)),
    };
    try {
      appendObservation('global', obs);
    } catch {
      /* ignore */
    }
    return;
  }

  const guard = evaluateGuards(payload);
  if (guard.skip) return;

  const cwd = payload.cwd ? String(payload.cwd) : process.cwd();
  const identity = resolveProjectIdentity(cwd);

  // SessionStart is a control event, not a captured turn. We only care
  // about source=clear (and source=compact, which behaves the same way:
  // new session_id replaces the previous one in this workspace). For
  // those sources, ping the daemon's supersede endpoint and exit. Other
  // sources (startup, resume) fall through to the no-op return below
  // because there's no prior tile to retire.
  if (phase === 'session_start') {
    const source = String(payload.source ?? '').toLowerCase();
    const sessionId = String(payload.session_id ?? '');
    if ((source === 'clear' || source === 'compact') && sessionId) {
      await postClearSupersede(sessionId, cwd);
    } else if (source === 'startup' && sessionId) {
      /* Fresh spawn: ask the daemon to compose a sibling-decision
       * block and print it to stdout for CC to inject as
       * additionalContext on the first turn. Flag-gated and
       * timeout-bounded; on any failure the session starts normally. */
      await postColdStartPreload(sessionId, cwd);
    }
    /* Worker-handoff doc. Fires on every SessionStart source so a
     * /clear inside a project anchor restores the full context (git
     * state + active task + next-up queue + open blockers) instead
     * of riding on a one-line stop hook summary. Empty for non-
     * project-anchor cwds; no-op when the daemon is down. */
    if (sessionId) {
      await postWorkerHandoff(sessionId, cwd);
    }
    // Lazy-spawn daemon so the supersede arrives even on cold start.
    const pid = readPid();
    if (pid === null || !isAlive(pid)) {
      try {
        ensureDaemonRunning();
      } catch {
        /* ignore */
      }
    }
    return;
  }

  try {
    recordIdentity(identity);
  } catch {
    /* registry write failures must not block the hook */
  }

  const obs = buildObservation(phase, payload, identity.id, identity.name);
  try {
    appendObservation(identity.id, obs);
  } catch {
    return;
  }

  try {
    purgeOldArchivesOncePerDay(identity.id);
  } catch {
    /* ignore */
  }

  // Push current phase so the dashboard tile reflects what Claude is
  // doing right now. Mapping: pre_tool = tool running, post_tool = idle
  // between tool calls, user_prompt = thinking on the new prompt,
  // session_stop = idle, notification = waiting on user permission.
  const phaseMap: Record<HookPhase, 'thinking' | 'tool' | 'idle' | 'permission'> = {
    pre_tool: 'tool',
    post_tool: 'idle',
    user_prompt: 'thinking',
    session_stop: 'idle',
    notification: 'permission',
    // session_start short-circuits earlier in main(); this entry is
    // unreachable but required by the Record<HookPhase, ...> type.
    session_start: 'idle',
  };
  void pingPhase(obs.session, phaseMap[phase]);

  // Forward the notification message so the dashboard can render the
  // permission/elicitation prompt with answer buttons. Clear pending on
  // user_prompt (the user just answered, in CC or remotely) and on stop.
  if (phase === 'notification' && obs.notification_message) {
    void postPendingPrompt(
      obs.session,
      obs.notification_message,
      obs.notification_kind ?? 'notification',
    );
  } else if (phase === 'user_prompt' || phase === 'session_stop') {
    void clearPendingPrompt(obs.session);
  }

  // P4: on UserPromptSubmit, fetch curated injection from daemon and print
  // to stdout so Claude Code includes it as additional context. Bounded
  // timeout; daemon-down silently skips.
  if (phase === 'user_prompt' && obs.prompt) {
    // Surface "※ recap:" lines from the shell prompt to the dashboard
    // activity rail. Fire and continue — recap is a side channel, not
    // a blocker for curation.
    void maybeEmitRecap(obs.prompt, obs.session);
    await curateAndPrint(obs.prompt, obs.session, identity.id);
  }

  // On Stop, ping the daemon to surface Claude's last assistant turn
  // to the dashboard activity rail. Daemon decides whether the turn
  // is worth surfacing based on length + question heuristic.
  if (phase === 'session_stop') {
    void postLexPulse(obs.session, cwd);
  }

  const decision = bumpSignalCounter(identity.id);

  if (decision.shouldSignal) {
    const pid = readPid();
    if (pid !== null && isAlive(pid)) {
      try {
        process.kill(pid, 'SIGUSR1');
      } catch {
        /* daemon may have just died; ignore */
      }
    } else {
      try {
        ensureDaemonRunning();
      } catch {
        /* spawn failure must not block hook */
      }
    }
  } else {
    // First-time spawn even when not signaling, so daemon is alive.
    const pid = readPid();
    if (pid === null || !isAlive(pid)) {
      try {
        ensureDaemonRunning();
      } catch {
        /* ignore */
      }
    }
  }
}

/* Guard the CLI entrypoint so the module is import-safe for tests.
 * When run as `node hook-runner.js`, import.meta.url matches the
 * resolved argv[1] file URL and main() fires; when imported by a
 * test file, the guard is false and only the exported functions
 * become available. Without this guard, importing the module would
 * fire main() inside the test worker and block on stdin. */
import { pathToFileURL as _pathToFileURL } from 'node:url';
const _entry = process.argv[1] ? _pathToFileURL(process.argv[1]).href : '';
if (import.meta.url === _entry) {
  main().catch(() => {
    /* hooks must never throw */
  });

  process.on('uncaughtException', () => process.exit(0));
  process.on('unhandledRejection', () => process.exit(0));
}
