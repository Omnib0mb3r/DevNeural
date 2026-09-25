/**
 * System metrics for the dashboard System tab and the vitals ribbon.
 *
 * BUG-042 (2026-09-24): this module used to shell out to PowerShell
 * with execSync on EVERY call (413 ms measured on this box) and walk
 * the data root with readdirSync/statSync. Both froze the daemon's
 * event loop, and the dashboard polls this endpoint every 4 s (vitals
 * ribbon) and again through /dashboard/health every 5 s (top bar), so
 * the daemon spent roughly a fifth of every second unable to serve
 * anything: every other fetch the home page issues queued behind the
 * freeze (1.1 to 1.8 s stalls on a 10 ms static shell).
 *
 * Now: the two expensive readings (drive usage, data-root size) are
 * refreshed in the background with async primitives and served from
 * cache. A request never spawns a process and never walks a tree; the
 * first call after boot awaits one async refresh so the payload is
 * complete, and every later call is sub-millisecond. Ollama reachability
 * is memoised for a few seconds for the same reason (its 1.5 s timeout
 * was on the request path when Ollama was down).
 */
import * as os from 'node:os';
import * as fs from 'node:fs';
import { execFile } from 'node:child_process';
import { DATA_ROOT } from '../paths.js';

export interface CpuMetric {
  cores: number;
  load_avg_1m: number;
  load_avg_5m: number;
  load_avg_15m: number;
  usage_percent: number;
}

export interface MemoryMetric {
  total_bytes: number;
  free_bytes: number;
  used_bytes: number;
  used_percent: number;
}

export interface DiskMetric {
  drive: string;
  total_bytes: number;
  free_bytes: number;
  used_bytes: number;
  used_percent: number;
}

export interface ProcessMetric {
  pid: number;
  rss_bytes: number;
  uptime_s: number;
  node_version: string;
  platform: string;
  arch: string;
}

export interface SystemMetrics {
  timestamp: string;
  hostname: string;
  cpu: CpuMetric;
  memory: MemoryMetric;
  disks: DiskMetric[];
  process: ProcessMetric;
  ollama: { reachable: boolean; host: string };
  data_root: { path: string; size_bytes: number };
}

let lastCpuSample: { idle: number; total: number } | null = null;

function cpuUsagePercent(): number {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    idle += cpu.times.idle;
    total +=
      cpu.times.user +
      cpu.times.nice +
      cpu.times.sys +
      cpu.times.idle +
      cpu.times.irq;
  }
  if (lastCpuSample === null) {
    lastCpuSample = { idle, total };
    return 0;
  }
  const idleDiff = idle - lastCpuSample.idle;
  const totalDiff = total - lastCpuSample.total;
  lastCpuSample = { idle, total };
  if (totalDiff === 0) return 0;
  return Math.max(0, Math.min(100, ((totalDiff - idleDiff) / totalDiff) * 100));
}

/* ------------------------------------------------------------------ */
/* Cached async readings                                               */
/* ------------------------------------------------------------------ */

/** A reading that is expensive to take: refreshed off the request path,
 * served from the last value. `refresh()` dedupes concurrent callers so
 * a burst of polls triggers one read. */
class CachedReading<T> {
  private value: T | null = null;
  private takenAt = 0;
  private inFlight: Promise<T> | null = null;

  constructor(
    private readonly take: () => Promise<T>,
    private readonly ttlMs: number,
    private readonly fallback: T,
  ) {}

  /** Current value. Kicks a background refresh when stale; awaits the
   * first read only (so a fresh daemon answers with real numbers). */
  async get(): Promise<T> {
    if (this.value === null) {
      return this.refresh();
    }
    if (Date.now() - this.takenAt > this.ttlMs) {
      void this.refresh();
    }
    return this.value;
  }

  refresh(): Promise<T> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.take()
      .then((v) => {
        this.value = v;
        this.takenAt = Date.now();
        return v;
      })
      .catch(() => {
        /* Keep the previous value on a failed read; a fresh cache
         * with no value yet falls back so the payload stays shaped. */
        if (this.value === null) this.value = this.fallback;
        this.takenAt = Date.now();
        return this.value;
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  /** Test seam: forget the cached value. */
  reset(): void {
    this.value = null;
    this.takenAt = 0;
  }
}

/** Drive usage via one async PowerShell call. Never on the request path
 * after the first read; the OS answer changes slowly enough that a
 * minute-old number is the same number to a human. */
function takeDisks(): Promise<DiskMetric[]> {
  if (process.platform !== 'win32') {
    return Promise.resolve([]);
  }
  return new Promise((resolve, reject) => {
    execFile(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Get-PSDrive -PSProvider FileSystem | Select-Object Name,Used,Free | ConvertTo-Json -Compress',
      ],
      { encoding: 'utf-8', timeout: 8_000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (err, stdout) => {
        if (err) {
          reject(err);
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as
            | { Name: string; Used?: number; Free?: number }
            | Array<{ Name: string; Used?: number; Free?: number }>;
          const arr = Array.isArray(parsed) ? parsed : [parsed];
          resolve(
            arr.map((d) => {
              const used = d.Used ?? 0;
              const free = d.Free ?? 0;
              const total = used + free;
              return {
                drive: d.Name,
                total_bytes: total,
                free_bytes: free,
                used_bytes: used,
                used_percent: total > 0 ? (used / total) * 100 : 0,
              };
            }),
          );
        } catch (parseErr) {
          reject(parseErr);
        }
      },
    );
  });
}

/** Recursive size of a tree with async fs calls, a bounded number of
 * directories in flight so a large data root does not fan out into
 * thousands of open handles. Symlinks are not followed. */
async function dirSizeAsync(dir: string): Promise<number> {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  const stack = [dir];
  const CONCURRENCY = 8;
  async function drainOne(): Promise<void> {
    while (stack.length > 0) {
      const cur = stack.pop();
      if (!cur) continue;
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(cur, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const p = `${cur}/${e.name}`;
        if (e.isDirectory()) {
          stack.push(p);
        } else if (e.isFile()) {
          try {
            const st = await fs.promises.stat(p);
            total += st.size;
          } catch {
            /* ignore */
          }
        }
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => drainOne()));
  return total;
}

async function takeOllama(): Promise<boolean> {
  const host = process.env.DEVNEURAL_OLLAMA_HOST ?? 'http://localhost:11434';
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(`${host}/api/tags`, { signal: ctrl.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

const DISKS_TTL_MS = 60_000;
const DATA_ROOT_TTL_MS = 60_000;
const OLLAMA_TTL_MS = 5_000;

const disks = new CachedReading<DiskMetric[]>(takeDisks, DISKS_TTL_MS, []);
const dataRootSize = new CachedReading<number>(
  () => dirSizeAsync(DATA_ROOT),
  DATA_ROOT_TTL_MS,
  0,
);
const ollama = new CachedReading<boolean>(takeOllama, OLLAMA_TTL_MS, false);

/** Test seam: drop every cached reading so the next call re-reads. */
export function _resetSystemMetricsCachesForTests(): void {
  disks.reset();
  dataRootSize.reset();
  ollama.reset();
}

export async function getSystemMetrics(): Promise<SystemMetrics> {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;

  const [load1, load5, load15] = os.loadavg();

  /* All three readings resolve from cache after the first call; on a
   * cold cache they run concurrently, none of them on the event loop. */
  const [diskList, rootBytes, ollamaUp] = await Promise.all([
    disks.get(),
    dataRootSize.get(),
    ollama.get(),
  ]);

  return {
    timestamp: new Date().toISOString(),
    hostname: os.hostname(),
    cpu: {
      cores: os.cpus().length,
      load_avg_1m: load1 ?? 0,
      load_avg_5m: load5 ?? 0,
      load_avg_15m: load15 ?? 0,
      usage_percent: cpuUsagePercent(),
    },
    memory: {
      total_bytes: totalMem,
      free_bytes: freeMem,
      used_bytes: usedMem,
      used_percent: (usedMem / totalMem) * 100,
    },
    disks: diskList,
    process: {
      pid: process.pid,
      rss_bytes: process.memoryUsage().rss,
      uptime_s: process.uptime(),
      node_version: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    ollama: {
      reachable: ollamaUp,
      host: process.env.DEVNEURAL_OLLAMA_HOST ?? 'http://localhost:11434',
    },
    data_root: { path: DATA_ROOT, size_bytes: rootBytes },
  };
}
