/**
 * Storage facade. The daemon owns one instance.
 */
import * as path from 'node:path';
import { DATA_ROOT } from '../paths.js';
import { VectorStore } from './vector-store.js';
import { IndexDb } from './index-db.js';
import { getEmbedDim } from '../embedder/index.js';

export interface RawChunkMetadata {
  project_id: string;
  session_id: string;
  timestamp_ms: number;
  kind: string;
  role: string;
  byte_length: number;
  text_preview: string;
  /* Optional brainstorm-summary fields, populated only on chunks
   * written by the session-end pipeline. brainstorm_id pins the chunk
   * to a specific brainstorm_sessions row even after that row is
   * archived; brainstorm_mode preserves the meeting-vs-chat
   * distinction (`notes` = meeting recording) for filtered retrieval;
   * end_reason is debuggability only. */
  brainstorm_id?: string;
  brainstorm_mode?: string;
  end_reason?: string;
}

export interface WikiPageMetadata {
  status: 'pending' | 'canonical' | 'archived';
  weight: number;
  trigger: string;
  insight: string;
  title: string;
}

export class Store {
  constructor(
    public readonly rawChunks: VectorStore<RawChunkMetadata>,
    public readonly wikiPages: VectorStore<WikiPageMetadata>,
    public readonly db: IndexDb,
  ) {}

  static async open(log: (msg: string) => void = () => undefined): Promise<Store> {
    const collectionsDir = path.posix.join(DATA_ROOT, 'chroma', 'collections');
    const dim = getEmbedDim();
    const rawChunks = await VectorStore.open<RawChunkMetadata>(
      path.posix.join(collectionsDir, 'raw_chunks'),
      'raw_chunks',
      dim,
      log,
    );
    const wikiPages = await VectorStore.open<WikiPageMetadata>(
      path.posix.join(collectionsDir, 'wiki_pages'),
      'wiki_pages',
      dim,
      log,
    );
    const db = new IndexDb();
    log(`[store] opened: raw_chunks=${rawChunks.size()} wiki_pages=${wikiPages.size()} dim=${dim}`);
    return new Store(rawChunks, wikiPages, db);
  }

  async flush(): Promise<void> {
    await this.rawChunks.flush();
    await this.wikiPages.flush();
  }

  async close(): Promise<void> {
    await this.flush();
    this.db.close();
  }
}
