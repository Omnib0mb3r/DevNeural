/**
 * GPU job queue with priority lanes (OP-3).
 *
 * Single in-process queue serialising every GPU-bound job in the
 * daemon. Four priority lanes per spec section 11 Wave 2 day 1
 * step 3:
 *
 *   Lane 0 - curator path (recall + injection, latency-critical).
 *   Lane 1 - voice transcription (whisper.cpp).
 *   Lane 2 - Pass 2 ingest jobs.
 *   Lane 3 - lint, self-audit, schema-regression nightly jobs.
 *
 * Dispatch picks from the highest non-empty lane. Long-running
 * jobs in lane 2 or 3 do NOT delay lane 0: the queue is preemptive
 * at-job-boundary. As soon as a lane-0 job arrives, dispatch is
 * paused for new work until the existing job completes; the lane-0
 * job runs next instead of the queue resuming lower lanes. The
 * queue does not preempt mid-job, which is acceptable for the
 * curator's ~80ms P50 budget because individual GPU calls are
 * sub-50ms.
 *
 * VRAM gating (step 4): lanes 2 and 3 consult an optional
 * pre-dispatch hook. If the hook returns false, the job is
 * deferred for the configured backoff window. Lanes 0 and 1 ignore
 * the hook so the latency-critical paths always run.
 *
 * drainSessionId(sessionId) is the BF-7 step 20 hook: the
 * session-end pipeline calls it to block until no pending or
 * running job carries the given session_id. Implemented by
 * filtering the pending lanes for that sessionId and awaiting
 * each remaining promise.
 */

export type GpuLane = 0 | 1 | 2 | 3;

export interface GpuJob<T> {
  lane: GpuLane;
  /* Optional session_id for drainSessionId(). When set, the
   * pipeline can await all in-flight work for one session before
   * proceeding past the GPU-drain step in the session-end ordered
   * flush. */
  sessionId?: string;
  /* Human-readable label for telemetry / debug. */
  label?: string;
  fn: () => Promise<T>;
}

interface PendingJob<T = unknown> {
  job: GpuJob<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

export interface GpuQueueOptions {
  /* When set, called for lane 2 and 3 jobs before dispatch.
   * Returning false defers the job by `vramBackoffMs`. */
  vramOk?: () => boolean;
  vramBackoffMs?: number;
  /* Telemetry hook. Called once per lifecycle event. */
  log?: (msg: string) => void;
}

export class GpuQueue {
  private lanes: PendingJob[][] = [[], [], [], []];
  private running: PendingJob | null = null;
  private opts: Required<GpuQueueOptions>;
  /* Per-session in-flight set. Drains check this rather than
   * scanning all lanes each call. */
  private inflightBySession = new Map<string, Set<symbol>>();
  /* Counters surfaced via stats() for the Curator Health card and
   * future GPU panel. */
  private stat = {
    accepted: [0, 0, 0, 0],
    completed: [0, 0, 0, 0],
    deferred_vram: 0,
    preempted: 0,
  };

  constructor(opts: GpuQueueOptions = {}) {
    this.opts = {
      vramOk: opts.vramOk ?? (() => true),
      vramBackoffMs: opts.vramBackoffMs ?? 10_000,
      log: opts.log ?? (() => undefined),
    };
  }

  submit<T>(job: GpuJob<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const pending: PendingJob<T> = { job, resolve, reject };
      this.lanes[job.lane]!.push(pending as PendingJob);
      this.stat.accepted[job.lane]! += 1;
      if (job.sessionId) {
        const tag = Symbol(job.label ?? job.lane);
        const set = this.inflightBySession.get(job.sessionId) ?? new Set();
        set.add(tag);
        this.inflightBySession.set(job.sessionId, set);
        // Stash the tag on the pending object so we can clear it on settle.
        (pending as PendingJob & { _tag?: symbol })._tag = tag;
      }
      this.opts.log(
        `[gpu] submit lane=${job.lane} session=${job.sessionId ?? '-'} label=${job.label ?? '-'}`,
      );
      void this.pump();
    });
  }

  async drainSessionId(sessionId: string): Promise<void> {
    /* drainSessionId waits until no pending OR running job carries
     * this sessionId. We loop because new submits can land while
     * we wait (rare during teardown, but possible). The loop exits
     * when the per-session set is empty or undefined. */
    while (true) {
      const set = this.inflightBySession.get(sessionId);
      if (!set || set.size === 0) return;
      // Wait one tick; jobs settling clear their tag.
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  stats(): {
    accepted: number[];
    completed: number[];
    deferred_vram: number;
    preempted: number;
    pending_per_lane: number[];
    running_lane: GpuLane | null;
  } {
    return {
      accepted: [...this.stat.accepted],
      completed: [...this.stat.completed],
      deferred_vram: this.stat.deferred_vram,
      preempted: this.stat.preempted,
      pending_per_lane: this.lanes.map((l) => l.length),
      running_lane: (this.running?.job.lane as GpuLane) ?? null,
    };
  }

  private nextLane(): GpuLane | null {
    for (let lane = 0 as GpuLane; lane < 4; lane = (lane + 1) as GpuLane) {
      if (this.lanes[lane]!.length > 0) return lane;
    }
    return null;
  }

  private async pump(): Promise<void> {
    if (this.running) {
      /* At-job-boundary preemption: if lane 0 has work and the
       * running job is from lane >= 1, we cannot interrupt; we just
       * track that lane 0 is waiting so the next dispatch picks it.
       * The next dispatch always picks the highest non-empty lane,
       * so this is automatic; the counter records the contention. */
      if (
        this.lanes[0]!.length > 0 &&
        this.running.job.lane > 0
      ) {
        this.stat.preempted += 1;
      }
      return;
    }
    const lane = this.nextLane();
    if (lane === null) return;

    const pending = this.lanes[lane]!.shift()!;
    /* VRAM gate for lanes 2 and 3. If the pre-dispatch hook says
     * not enough VRAM, push back to the head of the lane and
     * defer for vramBackoffMs. Lane 0 and 1 bypass. */
    if ((lane === 2 || lane === 3) && !this.opts.vramOk()) {
      this.lanes[lane]!.unshift(pending);
      this.stat.deferred_vram += 1;
      this.opts.log(`[gpu] defer lane=${lane} reason=vram backoff_ms=${this.opts.vramBackoffMs}`);
      setTimeout(() => void this.pump(), this.opts.vramBackoffMs);
      return;
    }

    this.running = pending;
    this.opts.log(
      `[gpu] run lane=${lane} session=${pending.job.sessionId ?? '-'} label=${pending.job.label ?? '-'}`,
    );
    try {
      const result = await pending.job.fn();
      pending.resolve(result);
    } catch (err) {
      pending.reject(err);
    } finally {
      this.stat.completed[lane]! += 1;
      this.clearInflight(pending);
      this.running = null;
      // Schedule next dispatch on the next microtask so the
      // resolved promise's .then chain can run before the next
      // job grabs the queue.
      void Promise.resolve().then(() => this.pump());
    }
  }

  private clearInflight(pending: PendingJob): void {
    const sessionId = pending.job.sessionId;
    if (!sessionId) return;
    const tag = (pending as PendingJob & { _tag?: symbol })._tag;
    if (!tag) return;
    const set = this.inflightBySession.get(sessionId);
    if (!set) return;
    set.delete(tag);
    if (set.size === 0) this.inflightBySession.delete(sessionId);
  }
}

/* Module-level singleton. Daemon boot wires it up via initGpuQueue();
 * test code spins fresh instances. */
let SINGLETON: GpuQueue | null = null;

export function initGpuQueue(opts: GpuQueueOptions = {}): GpuQueue {
  SINGLETON = new GpuQueue(opts);
  return SINGLETON;
}

export function gpuQueue(): GpuQueue {
  if (!SINGLETON) {
    /* Lazy default if a caller submits before the daemon has
     * called initGpuQueue. Useful for tests and one-shot scripts. */
    SINGLETON = new GpuQueue();
  }
  return SINGLETON;
}
