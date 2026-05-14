/**
 * Distillation backfill scheduler.
 *
 * Binds the local-only ollama distillation generator to the existing
 * runDistillationBackfill module. Fires once after a 30s grace period
 * (so daemon startup is not blocked by an ollama warm-up) then every
 * 10 minutes on a setInterval. Each tick is bounded by
 * BACKFILL_DEFAULT_LIMIT so a cold start cannot melt the provider.
 *
 * Guards:
 *   - No provider configured / provider not configured -> log once and
 *     return a no-op handle (no schedule). Keeps daemon logs quiet.
 *   - Anthropic provider selected -> BF-4 blocks brainstorm content
 *     ever leaving the host; log once and skip the schedule.
 *   - Re-entrancy: if a previous tick is still running when the next
 *     fires, the new tick logs a skip and bails so we never stack
 *     concurrent backfills.
 */
import type { IndexDb } from '../store/index-db.js';
import type { LlmProvider } from '../llm/index.js';
import { pickProvider } from '../llm/index.js';
import { createLlmDistillationGenerator } from './distillation-generator.js';
import {
  runDistillationBackfill,
  BACKFILL_DEFAULT_LIMIT,
} from './sibling-distillation-backfill.js';

const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;
const DEFAULT_FIRST_FIRE_DELAY_MS = 30 * 1000;

export interface DistillationSchedulerOptions {
  db: IndexDb;
  log?: (msg: string) => void;
  intervalMs?: number;
  firstFireDelayMs?: number;
  limit?: number;
  provider?: LlmProvider | null;
}

export interface DistillationSchedulerHandle {
  stop(): void;
}

export function startDistillationBackfillScheduler(
  opts: DistillationSchedulerOptions,
): DistillationSchedulerHandle {
  const log = opts.log ?? (() => undefined);
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const firstDelay = opts.firstFireDelayMs ?? DEFAULT_FIRST_FIRE_DELAY_MS;
  const limit = opts.limit ?? BACKFILL_DEFAULT_LIMIT;
  const provider = opts.provider ?? pickProvider();
  if (!provider) {
    log(`[distill-scheduler] no LLM provider; skipping schedule`);
    return { stop: () => undefined };
  }
  if (!provider.isConfigured()) {
    log(
      `[distill-scheduler] provider ${provider.name} not configured; skipping schedule`,
    );
    return { stop: () => undefined };
  }
  if (provider.name === 'anthropic') {
    log(
      `[distill-scheduler] BF-4: anthropic blocked for brainstorm content; skipping schedule`,
    );
    return { stop: () => undefined };
  }
  const generator = createLlmDistillationGenerator({
    db: opts.db,
    log,
    provider,
  });
  let firstTimer: ReturnType<typeof setTimeout> | null = null;
  let intervalTimer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) {
      log(`[distill-scheduler] previous tick still running; skip`);
      return;
    }
    running = true;
    try {
      const result = await runDistillationBackfill({
        db: opts.db,
        generator,
        limit,
        log,
      });
      log(
        `[distill-scheduler] processed=${result.processed.length} errors=${result.errors.length} skipped=${result.skipped.length} hit_cap=${result.hit_cap}`,
      );
    } catch (err) {
      log(`[distill-scheduler] tick failed: ${(err as Error).message}`);
    } finally {
      running = false;
    }
  };
  firstTimer = setTimeout(() => {
    void tick();
    intervalTimer = setInterval(() => void tick(), intervalMs);
    if (intervalTimer && typeof intervalTimer.unref === 'function') {
      intervalTimer.unref();
    }
  }, firstDelay);
  if (firstTimer && typeof firstTimer.unref === 'function') {
    firstTimer.unref();
  }
  log(
    `[distill-scheduler] up (interval=${intervalMs}ms first_fire_delay=${firstDelay}ms limit=${limit} provider=${provider.name})`,
  );
  return {
    stop: () => {
      if (firstTimer) clearTimeout(firstTimer);
      if (intervalTimer) clearInterval(intervalTimer);
    },
  };
}
