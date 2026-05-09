/**
 * Per-session terminal-output ring buffer + fan-out.
 *
 * The 09-bridge VS Code extension subscribes to onDidWriteTerminalData
 * (proposed API) and POSTs every byte the Claude terminal renders here
 * via /sessions/:id/terminal-stream. We hold a bounded ring per session
 * so a dashboard tab joining mid-stream can replay the last screenful,
 * and we fan the chunks out to every WebSocket client subscribed via
 * /sessions/:id/terminal.
 *
 * Read-only mirror. The bridge is the only writer; dashboard clients
 * only read. No back-channel here — input still flows through the
 * existing prompt + nav-key endpoints.
 */

const RING_BYTES = 256 * 1024; // ~256 KB per session, plenty for one screenful + scrollback

interface SessionRing {
  buf: string[];
  bytes: number;
  cols?: number;
  rows?: number;
  subscribers: Set<(msg: string) => void>;
}

const rings = new Map<string, SessionRing>();

function ensure(sessionId: string): SessionRing {
  let r = rings.get(sessionId);
  if (!r) {
    r = { buf: [], bytes: 0, subscribers: new Set() };
    rings.set(sessionId, r);
  }
  return r;
}

/* Wire envelope. Both directions use a tagged JSON object so a single
 * WebSocket can multiplex grid resize events and data chunks. The
 * mirror reshapes its xterm grid on `s` events and writes raw bytes
 * on `d` events. Without resize forwarding the mirror's xterm renders
 * at whatever cols its container fits, and the source's cursor
 * positioning ANSI sequences land on the wrong cells -> the scrunched
 * + mid-word wrap the user reported. */
type Envelope =
  | { t: 's'; c: number; r: number }
  | { t: 'd'; d: string };

export function pushTerminalData(
  sessionId: string,
  data: string,
  cols?: number,
  rows?: number,
): void {
  if (!sessionId) return;
  if (!data && (cols == null || rows == null)) return;
  const r = ensure(sessionId);
  const dimChanged =
    typeof cols === 'number' &&
    typeof rows === 'number' &&
    cols > 0 &&
    rows > 0 &&
    (r.cols !== cols || r.rows !== rows);
  if (dimChanged) {
    r.cols = cols;
    r.rows = rows;
  }
  if (data) {
    r.buf.push(data);
    r.bytes += data.length;
    while (r.bytes > RING_BYTES && r.buf.length > 1) {
      const head = r.buf.shift()!;
      r.bytes -= head.length;
    }
  }
  if (dimChanged) {
    const sizeMsg = JSON.stringify({ t: 's', c: cols, r: rows } as Envelope);
    for (const cb of r.subscribers) {
      try {
        cb(sizeMsg);
      } catch {
        /* ignore */
      }
    }
  }
  if (data) {
    const dataMsg = JSON.stringify({ t: 'd', d: data } as Envelope);
    for (const cb of r.subscribers) {
      try {
        cb(dataMsg);
      } catch {
        /* one bad subscriber doesn't block the others */
      }
    }
  }
}

/** Snapshot of the current ring for late-joining clients. Returns the
 * concatenated byte stream plus the last known grid dimensions so the
 * mirror can size its xterm before writing the replay. */
export function getTerminalReplay(sessionId: string): {
  data: string;
  cols?: number;
  rows?: number;
} {
  const r = rings.get(sessionId);
  if (!r) return { data: '' };
  return { data: r.buf.join(''), cols: r.cols, rows: r.rows };
}

/** Subscribe to live chunks. Returns an unsubscribe function. The
 * caller is expected to write the replay snapshot first, then process
 * subsequent chunks delivered via the callback. */
export function subscribeTerminal(
  sessionId: string,
  cb: (data: string) => void,
): () => void {
  const r = ensure(sessionId);
  r.subscribers.add(cb);
  return () => {
    r.subscribers.delete(cb);
    if (r.subscribers.size === 0 && r.buf.length === 0) {
      rings.delete(sessionId);
    }
  };
}

/** Drop a session's ring. Useful when the dashboard knows the session
 * is gone (e.g. supersede on /clear). */
export function dropTerminalRing(sessionId: string): void {
  const r = rings.get(sessionId);
  if (!r) return;
  for (const cb of r.subscribers) {
    try {
      cb('\r\n[mirror] session retired\r\n');
    } catch {
      /* ignore */
    }
  }
  rings.delete(sessionId);
}
