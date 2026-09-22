import { describe, it, expect, afterEach } from 'vitest';
import {
  resolveLayerModel,
  resolvePermissionMode,
  midModel,
  midPermissionMode,
  workerModel,
  resolveEffort,
  effortArgs,
  effortFlag,
  topModel,
  topEffort,
  midEffort,
  workerEffort,
  dispatchConfirmGateOn,
  type RuntimeConfigReader,
} from '../src/lex/layer-model.js';

/* Per-layer model + permission-mode resolution (2026-07-18). The live
 * opus<->fable switch reads runtime_config per spawn; the resolver both
 * normalizes aliases AND guards command injection (the worker model is
 * interpolated into a command string typed into a terminal). */

function cfg(map: Record<string, string>): RuntimeConfigReader {
  return { getRuntimeConfig: (k) => map[k] ?? null };
}

const savedEnv: Record<string, string | undefined> = {};
afterEach(() => {
  for (const k of Object.keys(savedEnv)) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
    delete savedEnv[k];
  }
});
function setEnv(k: string, v: string | undefined): void {
  savedEnv[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

describe('resolveLayerModel', () => {
  it('accepts the known short aliases case-insensitively', () => {
    expect(resolveLayerModel('opus', 'opus')).toBe('opus');
    expect(resolveLayerModel('Fable', 'opus')).toBe('fable');
    expect(resolveLayerModel('  HAIKU ', 'opus')).toBe('haiku');
    expect(resolveLayerModel('sonnet', 'opus')).toBe('sonnet');
  });

  it('accepts a clean claude-* full model id', () => {
    expect(resolveLayerModel('claude-fable-5', 'opus')).toBe('claude-fable-5');
    expect(resolveLayerModel('claude-haiku-4-5-20251001', 'opus')).toBe(
      'claude-haiku-4-5-20251001',
    );
  });

  it('falls back on empty / null / undefined', () => {
    expect(resolveLayerModel('', 'opus')).toBe('opus');
    expect(resolveLayerModel(null, 'fable')).toBe('fable');
    expect(resolveLayerModel(undefined, 'opus')).toBe('opus');
  });

  it('rejects command-injection payloads back to the fallback', () => {
    /* The worker model lands in `claude --model <X> --dangerously-skip-
     * permissions`, typed into a terminal. None of these may pass. */
    for (const bad of [
      'opus; rm -rf /',
      'opus && curl evil',
      'opus`whoami`',
      'opus $(id)',
      'opus | tee /etc/passwd',
      'opus\nrm x',
      '--dangerously-skip-permissions',
      'claude-opus 4-8',
      'gpt-4',
      'fable"',
    ]) {
      expect(resolveLayerModel(bad, 'opus')).toBe('opus');
    }
  });
});

describe('resolvePermissionMode', () => {
  it('accepts the valid CLI permission modes (case-sensitive)', () => {
    for (const m of [
      'acceptEdits',
      'auto',
      'bypassPermissions',
      'manual',
      'dontAsk',
      'plan',
    ]) {
      expect(resolvePermissionMode(m, 'plan')).toBe(m);
    }
  });

  it('falls back on unknown / wrong-case / empty', () => {
    expect(resolvePermissionMode('Plan', 'plan')).toBe('plan');
    expect(resolvePermissionMode('yolo', 'bypassPermissions')).toBe(
      'bypassPermissions',
    );
    expect(resolvePermissionMode('', 'plan')).toBe('plan');
    expect(resolvePermissionMode(null, 'plan')).toBe('plan');
  });
});

describe('layer resolvers: runtime_config wins, then env, then default', () => {
  it('mid/worker model default to opus', () => {
    setEnv('DEVNEURAL_MID_MODEL', undefined);
    setEnv('DEVNEURAL_WORKER_MODEL', undefined);
    expect(midModel(cfg({}))).toBe('opus');
    expect(workerModel(cfg({}))).toBe('opus');
  });

  it('runtime_config flips the live switch to fable', () => {
    expect(midModel(cfg({ mid_model: 'fable' }))).toBe('fable');
    expect(workerModel(cfg({ worker_model: 'fable' }))).toBe('fable');
  });

  it('env is the fallback when runtime_config is unset', () => {
    setEnv('DEVNEURAL_WORKER_MODEL', 'fable');
    expect(workerModel(cfg({}))).toBe('fable');
    /* runtime_config still wins over env. */
    expect(workerModel(cfg({ worker_model: 'opus' }))).toBe('opus');
  });

  it('mid permission mode defaults to the safe bypassPermissions, flips live to plan', () => {
    /* Default is the working headless mode, NOT 'plan': headless plan
     * mode stalls on plan-approval until that approval is routed to
     * Layer 1. 'plan' is one live flip away. */
    setEnv('DEVNEURAL_MID_PERMISSION_MODE', undefined);
    expect(midPermissionMode(cfg({}))).toBe('bypassPermissions');
    expect(midPermissionMode(cfg({ mid_permission_mode: 'plan' }))).toBe('plan');
  });
});

/* Voice layers (2026-09-21): per-layer effort knobs, the L1 model knob and
 * the Phase B dispatch gate switch. Effort is whitelisted because the
 * worker value is interpolated into a bridge-typed command string. */
describe('effort + top-model knobs', () => {
  it('whitelists effort levels and rejects junk', () => {
    expect(resolveEffort('low')).toBe('low');
    expect(resolveEffort(' XHIGH ')).toBe('xhigh');
    expect(resolveEffort('turbo; rm -rf /')).toBeNull();
    expect(resolveEffort('')).toBeNull();
    expect(resolveEffort(null)).toBeNull();
  });

  it('effortArgs is empty when unset, a flag pair when set', () => {
    expect(effortArgs(null)).toEqual([]);
    expect(effortArgs('low')).toEqual(['--effort', 'low']);
    expect(effortFlag(null)).toBe('');
    expect(effortFlag('max')).toBe(' --effort max');
  });

  it('top model reads runtime_config, then env, then haiku', () => {
    setEnv('DEVNEURAL_VOICE_BRAIN_MODEL', undefined);
    expect(topModel(cfg({}))).toBe('haiku');
    expect(topModel(cfg({ top_model: 'sonnet' }))).toBe('sonnet');
    expect(topModel(cfg({ top_model: 'bad value' }))).toBe('haiku');
    setEnv('DEVNEURAL_VOICE_BRAIN_MODEL', 'claude-sonnet-5');
    expect(topModel(cfg({}))).toBe('claude-sonnet-5');
  });

  it('per-layer effort knobs read runtime_config then env', () => {
    setEnv('DEVNEURAL_TOP_EFFORT', undefined);
    setEnv('DEVNEURAL_MID_EFFORT', undefined);
    setEnv('DEVNEURAL_WORKER_EFFORT', undefined);
    expect(topEffort(cfg({ top_effort: 'low' }))).toBe('low');
    expect(midEffort(cfg({ mid_effort: 'xhigh' }))).toBe('xhigh');
    expect(workerEffort(cfg({}))).toBeNull();
    setEnv('DEVNEURAL_WORKER_EFFORT', 'high');
    expect(workerEffort(cfg({}))).toBe('high');
    expect(workerEffort(cfg({ worker_effort: 'low' }))).toBe('low');
  });

  it('dispatch gate is off unless on', () => {
    setEnv('DEVNEURAL_DISPATCH_CONFIRM_GATE', undefined);
    expect(dispatchConfirmGateOn(cfg({}))).toBe(false);
    expect(dispatchConfirmGateOn(cfg({ dispatch_confirm_gate: 'on' }))).toBe(true);
    expect(dispatchConfirmGateOn(cfg({ dispatch_confirm_gate: 'ON ' }))).toBe(true);
    expect(dispatchConfirmGateOn(cfg({ dispatch_confirm_gate: 'off' }))).toBe(false);
    setEnv('DEVNEURAL_DISPATCH_CONFIRM_GATE', 'on');
    expect(dispatchConfirmGateOn(cfg({}))).toBe(true);
  });
});
