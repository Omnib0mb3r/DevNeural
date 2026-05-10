import { describe, expect, it } from 'vitest';
import { GpuQueue } from '../src/gpu/queue.js';

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('GpuQueue', () => {
  it('serialises submitted jobs (one runs at a time)', async () => {
    const q = new GpuQueue();
    let running = 0;
    let maxConcurrent = 0;
    const work = (label: string) => async () => {
      running += 1;
      maxConcurrent = Math.max(maxConcurrent, running);
      await delay(15);
      running -= 1;
      return label;
    };
    const results = await Promise.all([
      q.submit({ lane: 1, fn: work('a') }),
      q.submit({ lane: 1, fn: work('b') }),
      q.submit({ lane: 1, fn: work('c') }),
    ]);
    expect(results).toEqual(['a', 'b', 'c']);
    expect(maxConcurrent).toBe(1);
  });

  it('higher-priority lane wins when both are pending at submit time', async () => {
    const q = new GpuQueue();
    const order: string[] = [];
    const start = (label: string) => async () => {
      order.push(label);
      await delay(5);
      return label;
    };
    /* Block the queue with a long lane-2 job. */
    const long = q.submit({
      lane: 2,
      fn: async () => {
        order.push('long-start');
        await delay(40);
        order.push('long-end');
      },
    });
    /* Submit lane-3 then lane-0 while lane-2 is running. After
     * lane-2 completes the queue must dispatch lane-0 first
     * regardless of FIFO position. */
    await delay(5);
    const c = q.submit({ lane: 3, fn: start('lane3') });
    const a = q.submit({ lane: 0, fn: start('lane0') });
    await Promise.all([long, a, c]);
    const lane0Idx = order.indexOf('lane0');
    const lane3Idx = order.indexOf('lane3');
    const longEndIdx = order.indexOf('long-end');
    expect(lane0Idx).toBeGreaterThan(longEndIdx);
    expect(lane0Idx).toBeLessThan(lane3Idx);
  });

  it('drainSessionId waits until all jobs for that session complete', async () => {
    const q = new GpuQueue();
    let aDone = false;
    let bDone = false;
    q.submit({
      lane: 2,
      sessionId: 'sess-x',
      fn: async () => {
        await delay(20);
        aDone = true;
      },
    });
    q.submit({
      lane: 2,
      sessionId: 'sess-x',
      fn: async () => {
        await delay(20);
        bDone = true;
      },
    });
    /* Unrelated session that should NOT block the drain. */
    q.submit({
      lane: 2,
      sessionId: 'sess-y',
      fn: async () => {
        await delay(60);
      },
    });
    await q.drainSessionId('sess-x');
    expect(aDone).toBe(true);
    expect(bDone).toBe(true);
  });

  it('VRAM gate defers lane 2 jobs when vramOk returns false', async () => {
    let vramReleases = 0;
    const q = new GpuQueue({
      vramOk: () => vramReleases > 0,
      vramBackoffMs: 20,
    });
    let ran = false;
    const p = q.submit({
      lane: 2,
      fn: async () => {
        ran = true;
        return 'ok';
      },
    });
    await delay(40);
    expect(ran).toBe(false);
    /* Release VRAM. The next backoff retry should dispatch. */
    vramReleases = 1;
    await p;
    expect(ran).toBe(true);
    expect(q.stats().deferred_vram).toBeGreaterThan(0);
  });

  it('lane 0 bypasses the VRAM gate', async () => {
    const q = new GpuQueue({
      vramOk: () => false,
      vramBackoffMs: 200,
    });
    let ran = false;
    await q.submit({
      lane: 0,
      fn: async () => {
        ran = true;
      },
    });
    expect(ran).toBe(true);
  });

  it('rejection in a job does not stall later jobs', async () => {
    const q = new GpuQueue();
    const failed = q.submit({
      lane: 1,
      fn: async () => {
        throw new Error('boom');
      },
    });
    await expect(failed).rejects.toThrow('boom');
    const result = await q.submit({
      lane: 1,
      fn: async () => 42,
    });
    expect(result).toBe(42);
  });
});
