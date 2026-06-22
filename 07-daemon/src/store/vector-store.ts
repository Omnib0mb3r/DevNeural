/**
 * Native in-process vector store.
 *
 * Replaces Chroma. Single-developer volumes (tens of thousands of
 * vectors over a year) are well-served by an in-memory linear cosine
 * scan with project-id metadata filtering. Persists each collection
 * as an append-only binary file plus a JSON metadata sidecar.
 *
 * If we ever need richer indexing (HNSW, IVF, billion-scale), this
 * module is the swap point.
 *
 * File layout per collection:
 *   <dir>/<name>.vec      raw Float32 vectors, packed
 *   <dir>/<name>.meta.jsonl  one JSON line per vector with metadata
 *   <dir>/<name>.head.json   header: dim, count, version
 *
 * Durability:
 *   - flush() writes .vec and .head.json atomically (.tmp + fsync + rename).
 *     Daemon kill mid-flush leaves either the previous good copy or the
 *     fully-written new copy, never a half file.
 *   - add() appends to .meta.jsonl synchronously for between-flush durability.
 *     Last line may be partial after a kill; loader tolerates that.
 *   - On load mismatch (vectors != metadata) we truncate to the shorter side
 *     and log a warning instead of throwing, so the daemon recovers without
 *     manual quarantine. The discarded surplus is reset by the next flush.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ensureDir } from '../paths.js';

export interface VectorRecord<M = Record<string, unknown>> {
  id: string;
  vector: Float32Array;
  metadata: M;
}

export interface SearchResult<M> {
  id: string;
  score: number;
  metadata: M;
}

export interface SearchOptions<M> {
  topK?: number;
  filter?: (m: M) => boolean;
  minScore?: number;
}

interface CollectionHeader {
  version: 1;
  dim: number;
  count: number;
  name: string;
}

type LogFn = (msg: string) => void;
const noopLog: LogFn = () => undefined;

export class VectorStore<M = Record<string, unknown>> {
  private vectors: Float32Array[] = [];
  private metadata: M[] = [];
  private ids: string[] = [];
  private idToIndex = new Map<string, number>();
  private dirty = false;
  private log: LogFn = noopLog;

  private constructor(
    private readonly dir: string,
    private readonly name: string,
    private readonly dim: number,
  ) {}

  static async open<M>(
    dir: string,
    name: string,
    dim: number,
    log: LogFn = noopLog,
  ): Promise<VectorStore<M>> {
    ensureDir(dir);
    const store = new VectorStore<M>(dir, name, dim);
    store.log = log;
    await store.load();
    return store;
  }

  private headFile(): string {
    return path.posix.join(this.dir, `${this.name}.head.json`);
  }
  private vecFile(): string {
    return path.posix.join(this.dir, `${this.name}.vec`);
  }
  private metaFile(): string {
    return path.posix.join(this.dir, `${this.name}.meta.jsonl`);
  }

  private async load(): Promise<void> {
    const head = this.headFile();
    if (!fs.existsSync(head)) {
      this.writeHeader(0);
      this.log(`[vector-store] ${this.name} initialized empty (dim=${this.dim})`);
      return;
    }

    let parsed: CollectionHeader;
    try {
      parsed = JSON.parse(fs.readFileSync(head, 'utf-8')) as CollectionHeader;
    } catch (err) {
      this.log(
        `[vector-store] ${this.name} header unreadable (${(err as Error).message}); reinitializing`,
      );
      this.writeHeader(0);
      return;
    }

    if (parsed.dim !== this.dim) {
      throw new Error(
        `vector store ${this.name} dim ${parsed.dim} does not match expected ${this.dim}`,
      );
    }

    if (fs.existsSync(this.vecFile())) {
      const buf = fs.readFileSync(this.vecFile());
      const dim = this.dim;
      const total = Math.floor(buf.length / 4 / dim);
      for (let i = 0; i < total; i++) {
        const slice = new Float32Array(
          buf.buffer,
          buf.byteOffset + i * dim * 4,
          dim,
        ).slice();
        this.vectors.push(slice);
      }
    }

    if (fs.existsSync(this.metaFile())) {
      const lines = fs
        .readFileSync(this.metaFile(), 'utf-8')
        .split('\n')
        .filter((l) => l.length > 0);
      for (const line of lines) {
        try {
          const parsedLine = JSON.parse(line) as { id: string; m: M };
          if (typeof parsedLine?.id !== 'string') continue;
          const idx = this.ids.length;
          this.ids.push(parsedLine.id);
          this.idToIndex.set(parsedLine.id, idx);
          this.metadata.push(parsedLine.m);
        } catch {
          /* skip bad/partial line — common after kill mid-append */
        }
      }
    }

    if (this.metadata.length !== this.vectors.length) {
      const target = Math.min(this.metadata.length, this.vectors.length);
      this.log(
        `[vector-store] ${this.name} mismatch: ${this.vectors.length} vectors, ${this.metadata.length} metadata; truncating to ${target} and rewriting on next flush`,
      );
      // Truncate both to the shorter side; mark dirty so the next flush
      // produces a consistent, atomic rewrite. Index/ids must be rebuilt to
      // match the truncated metadata.
      this.vectors.length = target;
      this.metadata.length = target;
      this.ids.length = target;
      this.idToIndex.clear();
      for (let i = 0; i < target; i++) {
        const id = this.ids[i];
        if (id) this.idToIndex.set(id, i);
      }
      this.dirty = true;
      // Trigger a synchronous rewrite of the meta sidecar so we never
      // re-encounter this same surplus on the next start.
      this.rewriteMetaSync();
    }

    this.log(
      `[vector-store] ${this.name} loaded: ${this.vectors.length} vectors`,
    );
  }

  private writeHeader(count: number): void {
    const header: CollectionHeader = {
      version: 1,
      dim: this.dim,
      count,
      name: this.name,
    };
    writeFileAtomicSync(this.headFile(), JSON.stringify(header), 'utf-8');
  }

  /** Synchronously rewrite the .meta.jsonl sidecar from in-memory state.
   * Used during recovery to re-truncate after a mismatch repair. */
  private rewriteMetaSync(): void {
    const lines: string[] = [];
    for (let i = 0; i < this.ids.length; i++) {
      const id = this.ids[i];
      if (!id) continue;
      lines.push(JSON.stringify({ id, m: this.metadata[i] }));
    }
    const body = lines.length ? lines.join('\n') + '\n' : '';
    writeFileAtomicSync(this.metaFile(), body, 'utf-8');
  }

  async add(record: VectorRecord<M>): Promise<void> {
    if (record.vector.length !== this.dim) {
      throw new Error(
        `vector dim ${record.vector.length} != store dim ${this.dim}`,
      );
    }
    if (this.idToIndex.has(record.id)) {
      // Update in place
      const idx = this.idToIndex.get(record.id) as number;
      const v = this.vectors[idx];
      if (!v) {
        throw new Error('internal: missing vector slot');
      }
      v.set(record.vector);
      this.metadata[idx] = record.metadata;
    } else {
      const idx = this.vectors.length;
      this.vectors.push(record.vector.slice());
      this.metadata.push(record.metadata);
      this.ids.push(record.id);
      this.idToIndex.set(record.id, idx);
    }
    this.dirty = true;

    // Append to metaFile for durability between flushes; rewrite atomically
    // on flush. A kill mid-append may leave a partial trailing line, which
    // the loader tolerates by skipping unparseable lines.
    fs.appendFileSync(
      this.metaFile(),
      JSON.stringify({ id: record.id, m: record.metadata }) + '\n',
      'utf-8',
    );
  }

  /**
   * Persist the in-memory vectors to .vec and rewrite the header
   * atomically. Also rewrites .meta.jsonl atomically so the sidecar
   * stays in lockstep with the binary blob (no orphan tail lines).
   * Call on shutdown or periodically.
   */
  async flush(): Promise<void> {
    if (!this.dirty && fs.existsSync(this.vecFile())) return;
    const dim = this.dim;
    const buf = Buffer.allocUnsafe(this.vectors.length * dim * 4);
    for (let i = 0; i < this.vectors.length; i++) {
      const src = this.vectors[i];
      if (!src) continue;
      Buffer.from(src.buffer, src.byteOffset, dim * 4).copy(buf, i * dim * 4);
    }
    const t0 = Date.now();
    writeFileAtomicSync(this.vecFile(), buf);
    this.rewriteMetaSync();
    this.writeHeader(this.vectors.length);
    this.dirty = false;
    this.log(
      `[vector-store] ${this.name} flushed ${this.vectors.length} vectors (${buf.length} bytes) in ${Date.now() - t0}ms`,
    );
  }

  size(): number {
    return this.vectors.length;
  }

  /** Diagnostic snapshot for /system. */
  stats(): {
    name: string;
    dim: number;
    count: number;
    dirty: boolean;
    vec_bytes: number;
    meta_bytes: number;
  } {
    let vec = 0;
    let meta = 0;
    try {
      vec = fs.existsSync(this.vecFile()) ? fs.statSync(this.vecFile()).size : 0;
    } catch {
      vec = 0;
    }
    try {
      meta = fs.existsSync(this.metaFile())
        ? fs.statSync(this.metaFile()).size
        : 0;
    } catch {
      meta = 0;
    }
    return {
      name: this.name,
      dim: this.dim,
      count: this.vectors.length,
      dirty: this.dirty,
      vec_bytes: vec,
      meta_bytes: meta,
    };
  }

  search(
    query: Float32Array,
    options: SearchOptions<M> = {},
  ): SearchResult<M>[] {
    if (query.length !== this.dim) {
      throw new Error(
        `query dim ${query.length} != store dim ${this.dim}`,
      );
    }
    const topK = options.topK ?? 10;
    const minScore = options.minScore ?? -Infinity;
    const filter = options.filter;

    const results: { idx: number; score: number }[] = [];
    for (let i = 0; i < this.vectors.length; i++) {
      const meta = this.metadata[i];
      if (filter && !filter(meta as M)) continue;
      const v = this.vectors[i];
      if (!v) continue;
      let dot = 0;
      for (let j = 0; j < this.dim; j++) {
        dot += (v[j] ?? 0) * (query[j] ?? 0);
      }
      if (dot < minScore) continue;
      results.push({ idx: i, score: dot });
    }
    results.sort((a, b) => b.score - a.score);

    return results.slice(0, topK).map((r) => ({
      id: this.ids[r.idx] ?? '',
      score: r.score,
      metadata: this.metadata[r.idx] as M,
    }));
  }

  getMetadata(id: string): M | undefined {
    const idx = this.idToIndex.get(id);
    if (idx === undefined) return undefined;
    return this.metadata[idx];
  }

  has(id: string): boolean {
    return this.idToIndex.has(id);
  }

  /**
   * Remove every record whose metadata matches `pred`. Returns the count
   * removed. Single O(n) filtering pass that rebuilds the id index, so a
   * bulk delete (e.g. all chunks of one file) is one rebuild, not N
   * splices. Marks the store dirty; the next flush rewrites .vec +
   * .meta.jsonl from the surviving in-memory state, so the deletion is
   * durable (the append-only meta sidecar is reconciled on flush). Used
   * by the incremental knowledge-index re-indexer to drop a changed or
   * deleted file's stale chunks before re-adding fresh ones.
   */
  deleteWhere(pred: (metadata: M, id: string) => boolean): number {
    const keepVectors: Float32Array[] = [];
    const keepMetadata: M[] = [];
    const keepIds: string[] = [];
    let removed = 0;
    for (let i = 0; i < this.ids.length; i++) {
      const id = this.ids[i] ?? '';
      const m = this.metadata[i] as M;
      const v = this.vectors[i];
      if (!v) continue;
      if (pred(m, id)) {
        removed += 1;
        continue;
      }
      keepVectors.push(v);
      keepMetadata.push(m);
      keepIds.push(id);
    }
    if (removed > 0) {
      this.vectors = keepVectors;
      this.metadata = keepMetadata;
      this.ids = keepIds;
      this.idToIndex.clear();
      for (let i = 0; i < keepIds.length; i++) {
        this.idToIndex.set(keepIds[i]!, i);
      }
      this.dirty = true;
    }
    return removed;
  }

  /**
   * Iterate metadata. Useful for SQLite reindexing.
   */
  *all(): IterableIterator<{ id: string; metadata: M }> {
    for (let i = 0; i < this.ids.length; i++) {
      yield { id: this.ids[i] ?? '', metadata: this.metadata[i] as M };
    }
  }
}

/** Atomic write: tmp file in the same dir + fsync + rename. Same dir is
 * required so rename stays a single atomic syscall on Windows + POSIX. */
function writeFileAtomicSync(
  target: string,
  data: string | Buffer,
  encoding?: BufferEncoding,
): void {
  const dir = path.posix.dirname(target);
  const base = path.posix.basename(target);
  const tmp = path.posix.join(dir, `.${base}.${process.pid}.${Date.now()}.tmp`);
  const fd = fs.openSync(tmp, 'w');
  try {
    if (typeof data === 'string') {
      fs.writeSync(fd, data, 0, encoding ?? 'utf-8');
    } else {
      fs.writeSync(fd, data, 0, data.length, 0);
    }
    try {
      fs.fsyncSync(fd);
    } catch {
      /* fsync best-effort; some filesystems on Windows reject fsync on tmp */
    }
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, target);
}
