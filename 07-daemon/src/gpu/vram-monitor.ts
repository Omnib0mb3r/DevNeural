/**
 * VRAM monitor (OP-3 step 4 of Wave 2 day 1).
 *
 * Polls nvidia-smi every 5s by default and exposes the latest
 * free-MB value. The GPU queue uses vramOk() as a pre-dispatch
 * hook for lanes 2 and 3 (Pass 2 ingest, lint / self-audit /
 * schema-regression nightly). Lanes 0 and 1 bypass the gate so
 * curator and voice transcription always run.
 *
 * Q-20 day-1 verification: nvidia-smi is on PATH at
 * /c/Windows/system32/nvidia-smi on the production host. If the
 * binary is missing on a different host, the monitor logs once and
 * reports vramOk() = true forever (fail-open so the queue does not
 * deadlock on machines without an NVIDIA card or driver).
 */
import { spawn } from 'node:child_process';

export interface VramSample {
  free_mb: number;
  used_mb: number;
  total_mb: number;
  measured_at: number;
}

export interface VramMonitorOptions {
  pollIntervalMs?: number;
  /* Free-MB floor below which lanes 2 and 3 should defer. Default
   * 1024 MB so the curator + voice transcription have headroom on
   * an 8GB card. Override per host via DEVNEURAL_VRAM_FLOOR_MB. */
  freeFloorMb?: number;
  log?: (msg: string) => void;
}

export class VramMonitor {
  private latest: VramSample | null = null;
  private timer: NodeJS.Timeout | null = null;
  private failOpen = false;
  private opts: Required<VramMonitorOptions>;

  constructor(opts: VramMonitorOptions = {}) {
    const envFloor = Number(process.env.DEVNEURAL_VRAM_FLOOR_MB ?? 1024);
    this.opts = {
      pollIntervalMs: opts.pollIntervalMs ?? 5_000,
      freeFloorMb:
        opts.freeFloorMb ?? (Number.isFinite(envFloor) && envFloor > 0 ? envFloor : 1024),
      log: opts.log ?? (() => undefined),
    };
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.opts.pollIntervalMs);
    /* Allow the daemon to exit even with the monitor running. */
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /* GpuQueue uses this. fail-open returns true so lanes 2 / 3 are
   * not permanently locked out on hosts without nvidia-smi. */
  vramOk(): boolean {
    if (this.failOpen) return true;
    if (!this.latest) return true; // first tick has not landed yet; allow
    return this.latest.free_mb >= this.opts.freeFloorMb;
  }

  current(): VramSample | null {
    return this.latest;
  }

  private async tick(): Promise<void> {
    try {
      const sample = await runNvidiaSmi();
      this.latest = sample;
    } catch (err) {
      if (!this.failOpen) {
        this.failOpen = true;
        this.opts.log(
          `[vram] nvidia-smi unavailable; failing open: ${(err as Error).message}`,
        );
        this.stop();
      }
    }
  }
}

function runNvidiaSmi(): Promise<VramSample> {
  return new Promise((resolve, reject) => {
    const p = spawn(
      'nvidia-smi',
      [
        '--query-gpu=memory.free,memory.used,memory.total',
        '--format=csv,noheader,nounits',
      ],
      { windowsHide: true },
    );
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (b) => (stdout += b.toString()));
    p.stderr.on('data', (b) => (stderr += b.toString()));
    p.on('error', (err) => reject(err));
    p.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`nvidia-smi exit=${code}: ${stderr.trim()}`));
        return;
      }
      const firstLine = stdout.split('\n').find((l) => l.trim().length > 0);
      if (!firstLine) {
        reject(new Error('nvidia-smi: empty output'));
        return;
      }
      const parts = firstLine.split(',').map((s) => Number(s.trim()));
      if (parts.length < 3 || parts.some((n) => !Number.isFinite(n))) {
        reject(new Error(`nvidia-smi: parse failed: ${firstLine}`));
        return;
      }
      resolve({
        free_mb: parts[0]!,
        used_mb: parts[1]!,
        total_mb: parts[2]!,
        measured_at: Date.now(),
      });
    });
  });
}
