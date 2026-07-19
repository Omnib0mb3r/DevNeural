"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  sessions as sessionsClient,
  listPtys,
  type PtyEntry,
} from "@/lib/daemon-client";
import { createAutoScrollController } from "@/lib/terminal-auto-scroll";
import "@xterm/xterm/css/xterm.css";

interface MirrorState {
  updated_at: string;
  api_available: boolean;
  subscribed: boolean;
  reason: string | null;
  tracked_terminals: number;
  last_flush_at: string | null;
  last_flush_session_id: string | null;
  last_flush_bytes: number | null;
  last_resolution_failure_at: string | null;
  last_resolution_failure_reason: string | null;
  last_post_error: string | null;
  last_post_error_at: string | null;
  /* Daemon-enriched: the project the last-flush session belongs to (off
   * the anchor->worker binding), or null when it is no project's worker.
   * Drives the cross-project mismatch warning below. */
  last_flush_project?: string | null;
}

interface BridgeStatusResponse {
  ok: boolean;
  alive: boolean;
  last_seen_ms: number | null;
  age_ms: number | null;
  mirror: MirrorState | null;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function ContextBadge({ tokens, max }: { tokens: number; max: number }) {
  const pct = Math.min(100, (tokens / max) * 100);
  /* Tone thresholds. Below 60% is fine, 60-85 starts warning the
   * user that /compact is coming, 85+ is the red zone where the
   * next turn risks a context overflow. */
  const tone = pct < 60 ? "ok" : pct < 85 ? "warn" : "err";
  const fillColor =
    tone === "ok"
      ? "bg-promoted"
      : tone === "warn"
        ? "bg-attn"
        : "bg-err";
  const textColor =
    tone === "ok" ? "text-promoted" : tone === "warn" ? "text-attn" : "text-err";
  return (
    <span
      className="inline-flex items-center gap-2 text-nano font-mono"
      title={`Context: ${tokens.toLocaleString()} / ${max.toLocaleString()} tokens. /clear to reset, /compact to summarize.`}
    >
      <span className="text-txt3">ctx</span>
      <span className="relative w-20 h-1.5 rounded-pill bg-surface3 overflow-hidden">
        <span
          className={`absolute inset-y-0 left-0 ${fillColor} transition-[width]`}
          style={{ width: `${pct}%` }}
        />
      </span>
      <span className={textColor}>
        {formatTokens(tokens)}/{formatTokens(max)} ({pct.toFixed(0)}%)
      </span>
    </span>
  );
}

function describeBridge(
  bridge: BridgeStatusResponse | null,
  sessionId: string,
  daemonPtyOwnsSession: boolean,
  daemonPtyPending: boolean,
  watchedProject: string | null,
): { label: string; tone: "ok" | "warn" | "err"; detail: string } {
  if (daemonPtyOwnsSession) {
    /* When this session is hosted by a daemon-PTY (Lex / Start-Claude
     * buttons) the bridge isn't in the loop. Bytes flow daemon → ring,
     * not VS Code → bridge → ring. Bridge state is irrelevant; show
     * a steady "daemon-hosted" pill so the user understands. */
    return { label: "host: daemon-pty", tone: "ok", detail: "" };
  }
  if (daemonPtyPending) {
    /* A daemon-PTY exists but hasn't bound a session-id yet (claude
     * hasn't written its first jsonl). Suppress bridge state because
     * the bridge has nothing to do with this session either. */
    return { label: "host: daemon-pty (binding…)", tone: "warn", detail: "" };
  }
  if (!sessionId) {
    /* No session at all yet. Don't fire bridge warnings. */
    return { label: "no session", tone: "warn", detail: "" };
  }
  if (!bridge) {
    return { label: "bridge: probing", tone: "warn", detail: "" };
  }
  if (!bridge.alive) {
    const ageS = bridge.age_ms == null ? null : Math.round(bridge.age_ms / 1000);
    return {
      label: "bridge: offline",
      tone: "err",
      detail:
        ageS == null
          ? "no heartbeat ever recorded; install or enable the VS Code bridge extension"
          : `last heartbeat ${ageS}s ago; the bridge VS Code extension is paused or VS Code is closed`,
    };
  }
  const m = bridge.mirror;
  if (!m) {
    return {
      label: "mirror: unknown",
      tone: "warn",
      detail:
        "bridge is alive but no mirror state file yet; old bridge build, rebuild and reinstall the .vsix",
    };
  }
  if (!m.api_available) {
    return {
      label: "mirror: proposed API not exposed",
      tone: "err",
      detail:
        m.reason ??
        "launch VS Code with --enable-proposed-api omnib0mb3r.devneural-bridge",
    };
  }
  if (!m.subscribed) {
    return {
      label: "mirror: not subscribed",
      tone: "err",
      detail: m.reason ?? "subscription failed",
    };
  }
  /* Cross-PROJECT mismatch only. The bridge multiplexes every VS Code
   * terminal, so its single last_flush_session_id is just whichever
   * terminal produced bytes most recently - comparing it to THIS panel's
   * session id false-fired constantly (e.g. a dead voice-brain flushed
   * last while this worker is streaming fine). Warn only when the last
   * flush belongs to a DIFFERENT project than the one we watch: that is a
   * genuine "registered the wrong cwd". A stale flush from no project
   * (last_flush_project null) or from THIS project never warns. Both
   * sides resolve off the one anchor->worker binding, so A == B. */
  if (
    m.last_flush_session_id &&
    m.last_flush_session_id !== sessionId &&
    m.last_flush_project &&
    watchedProject &&
    m.last_flush_project !== watchedProject
  ) {
    return {
      label: "mirror: streaming other project",
      tone: "warn",
      detail: `bridge is sending bytes to ${m.last_flush_project} (${m.last_flush_session_id.slice(
        0,
        8,
      )}…), not ${watchedProject}. Check StreamDeck.App registered the right cwd.`,
    };
  }
  if (!m.last_flush_at) {
    if (m.last_resolution_failure_reason) {
      return {
        label: "mirror: cwd unmapped",
        tone: "warn",
        detail: m.last_resolution_failure_reason,
      };
    }
    return {
      label: "mirror: subscribed, idle",
      tone: "warn",
      detail: `tracking ${m.tracked_terminals} terminal(s); waiting for bytes from a Claude session`,
    };
  }
  const ageS = Math.max(
    0,
    Math.round((Date.now() - Date.parse(m.last_flush_at)) / 1000),
  );
  return {
    label: `mirror: live (${ageS}s ago)`,
    tone: "ok",
    detail: `${m.last_flush_bytes ?? 0} B last batch; ${m.tracked_terminals} terminal(s) tracked`,
  };
}

function fmtAgo(ms: number | null | undefined): string {
  if (!ms) return "—";
  const delta = Math.max(0, Date.now() - ms);
  if (delta < 60_000) return `${Math.floor(delta / 1000)}s ago`;
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  return `${Math.floor(delta / 3_600_000)}h ago`;
}

/**
 * Expandable diagnostic block. Shown when the PTY backing this
 * session has exited (any code, including 0 since we still want a
 * "session ended" pill in that case) or when the most recent inject
 * recorded a non-null last_error. Collapsed by default; click to
 * reveal the structured fields (exit code, signal, error class,
 * error message, last-injected command, output tail).
 *
 * The block exists because daemon-PTY sessions that die from a
 * non-obvious cause (crash, OOM, panic-kill, a TypeError thrown
 * inside ptyInject) previously left no visible evidence: the
 * terminal mirror just stopped streaming and the user had no
 * indication of what happened. The bridge-mirror pill was
 * insufficient because daemon-hosted sessions don't use the bridge.
 */
function PtyDiagnosticBlock({ pty }: { pty: PtyEntry }): React.ReactElement {
  const exited = pty.exited;
  const exitCode = pty.exit_code ?? null;
  const exitSignal = pty.exit_signal ?? null;
  const lastError = pty.last_error ?? null;
  const lastErrorClass = pty.last_error_class ?? null;
  const lastCommand = pty.last_command ?? null;
  const lastCommandAt = pty.last_command_at ?? null;
  const exitedAt = pty.exited_at ?? null;
  const outputTail = pty.output_tail ?? "";
  /* Tone picks the chrome. A non-zero exit, any signal, or a recorded
   * error is treated as an error condition; a clean exit (code 0, no
   * signal, no error) renders in the neutral warn tone. */
  const tone =
    lastError || (exitCode !== null && exitCode !== 0) || exitSignal !== null
      ? "err"
      : exited
        ? "warn"
        : "warn";
  const headline = exited
    ? `Session terminated (exit code ${exitCode ?? "?"}${
        exitSignal !== null ? `, signal ${exitSignal}` : ""
      })`
    : "Last inject errored";
  return (
    <details
      data-testid="pty-diagnostic-block"
      className={`px-5 py-2 border-b border-border1 text-nano font-mono ${
        tone === "err" ? "bg-err/10 text-err" : "bg-attn/10 text-attn"
      }`}
    >
      <summary className="cursor-pointer select-none">
        {tone === "err" ? "⚠ " : ""}
        {headline}
        {exitedAt ? ` · ${fmtAgo(exitedAt)}` : ""}
        <span className="text-txt3 ml-2">(click to expand)</span>
      </summary>
      <div className="mt-2 space-y-1 text-txt2">
        <div>
          <span className="text-txt3">pty_id:</span>{" "}
          {pty.ptyId.slice(0, 12)}
        </div>
        {pty.sessionId ? (
          <div>
            <span className="text-txt3">session_id:</span>{" "}
            {pty.sessionId.slice(0, 12)}
          </div>
        ) : null}
        <div>
          <span className="text-txt3">command:</span> {pty.command}
        </div>
        {exited ? (
          <div>
            <span className="text-txt3">exit:</span> code={exitCode ?? "?"}
            {exitSignal !== null ? ` signal=${exitSignal}` : ""}
          </div>
        ) : null}
        {lastError ? (
          <div className="break-all">
            <span className="text-txt3">last_error:</span>{" "}
            {lastErrorClass ? `[${lastErrorClass}] ` : ""}
            {lastError}
          </div>
        ) : null}
        {lastCommand ? (
          <div className="break-all">
            <span className="text-txt3">
              last_command{lastCommandAt ? ` (${fmtAgo(lastCommandAt)})` : ""}:
            </span>{" "}
            {lastCommand}
          </div>
        ) : null}
        {outputTail ? (
          <div>
            <div className="text-txt3 mt-2">output_tail (last bytes):</div>
            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all bg-surface2 p-2 rounded-card text-txt2">
              {outputTail}
            </pre>
          </div>
        ) : null}
      </div>
    </details>
  );
}

/**
 * Read-only mirror of a Claude Code terminal.
 *
 * Bridges into the daemon's terminal-stream pipeline. On mount we:
 *   1. Fetch /sessions/:id/terminal-replay to seed xterm with the
 *      current screen state (so mid-stream joins don't render blank).
 *   2. Open /sessions/:id/terminal-ws and write every chunk into
 *      xterm verbatim — ANSI escape sequences, color, cursor moves
 *      all just work because we're streaming the original bytes.
 *
 * The component dynamic-imports xterm so the dashboard's static
 * export doesn't pull a 200 KB module into pages that don't need it.
 * Mobile-friendly: no input listeners, just a render surface plus
 * a small "soft keys" bar for ESC/Tab/arrows that the user can use
 * via the existing Steer + Nav grid (which is already wired).
 */
interface Props {
  sessionId: string;
  /** Header title. Defaults to "Terminal mirror"; set e.g. "Lex
   * terminal" / "Worker terminal" when more than one mirror shares a
   * page so they are tellable apart. */
  title?: string;
  /** WIRE (2026-07-19): the project label to show in the "watching …"
   * header, resolved by the page from the authoritative anchor->project
   * binding. Overrides the /sessions lookup (which is empty for a
   * Lex/anchor session and stale for a rotated worker uuid). Omit to
   * keep the legacy /sessions-derived label. */
  projectSlug?: string | null;
}

/* Header label naming what this mirror is actually watching
 * (2026-07-16 operator audit: landing here from a feed click gave no
 * clue which project/session the terminal belonged to, or that it is
 * read-only). Exported for tests. */
export function mirrorWatchLabel(
  projectSlug: string | null | undefined,
  sessionId: string,
): string {
  const proj = projectSlug?.trim() ? projectSlug : "unknown project";
  const sess = sessionId ? sessionId.slice(0, 8) : "unbound";
  return `watching ${proj} · session ${sess} · read-only`;
}

/* WIRE (2026-07-19): resolve which project label the mirror header
 * shows. The /sessions lookup (sessionEntry.project_slug) is keyed by
 * the raw session id, so it is EMPTY for a Lex/anchor session (never a
 * project worker → "unknown project") and STALE for a worker whose uuid
 * rotated on /clear. The page already resolves the real project off the
 * authoritative anchor->project binding (the supervised project tile /
 * the brainstorm anchor) and passes it as `projectSlug`; prefer it, and
 * fall back to the /sessions slug only when the page supplied none.
 * Exported for tests. */
export function resolveMirrorProjectSlug(
  explicit: string | null | undefined,
  sessionEntrySlug: string | null | undefined,
): string | null {
  if (explicit?.trim()) return explicit;
  if (sessionEntrySlug?.trim()) return sessionEntrySlug;
  return null;
}

export function TerminalMirror({ sessionId, title, projectSlug }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<unknown>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<"loading" | "live" | "offline">("loading");
  const [bridge, setBridge] = useState<BridgeStatusResponse | null>(null);

  /* Reuse the SessionsTable's react-query cache so the context bar
   * updates on the same 5s cadence as the rest of the page without an
   * extra poll. Find this session's entry by id. */
  const sessionsQ = useQuery({
    queryKey: ["sessions"],
    queryFn: sessionsClient,
    refetchInterval: 5_000,
  });
  const sessionEntry = sessionsQ.data?.sessions?.find(
    (s) => s.session_id === sessionId,
  );
  const ctx = sessionEntry?.context ?? null;

  /* Detect daemon-PTY ownership so the bridge-status pill can show
   * "host: daemon-pty" instead of misleading bridge-mirror warnings.
   * Polled less aggressively (8s) since it changes rarely. */
  const ptysQ = useQuery({
    queryKey: ["pty-list"],
    queryFn: listPtys,
    refetchInterval: 8_000,
  });
  const daemonPtyOwnsSession = Boolean(
    sessionId &&
      ptysQ.data?.ptys?.some(
        (p) => !p.exited && p.sessionId === sessionId,
      ),
  );
  /* A daemon-PTY is alive but hasn't bound a session yet (cold spawn
   * before the first turn writes the jsonl). Catches the gap right
   * after auto-spawning Lex on /lex page load. */
  const daemonPtyPending = Boolean(
    !daemonPtyOwnsSession &&
      ptysQ.data?.ptys?.some((p) => !p.exited && !p.sessionId),
  );
  /* Diagnostic surface. Find the matching PTY for this session so the
   * mirror can render an expandable error block if the process exited
   * non-zero, was killed, or an inject threw. We look for an exited
   * PTY first (a session that died is the failure mode the user most
   * needs to see), then fall back to a live PTY that has a non-null
   * last_error from a recent inject. */
  const diagnosticPty: PtyEntry | undefined = sessionId
    ? ptysQ.data?.ptys
        ?.filter((p) => p.sessionId === sessionId)
        .sort((a, b) => {
          /* exited first, then most-recent activity */
          if (a.exited && !b.exited) return -1;
          if (!a.exited && b.exited) return 1;
          return b.lastActivity - a.lastActivity;
        })[0]
    : undefined;
  const hasDiagnostic = Boolean(
    diagnosticPty &&
      (diagnosticPty.exited ||
        (diagnosticPty.last_error && diagnosticPty.last_error.length > 0)),
  );

  useEffect(() => {
    let cancelled = false;
    const fetchStatus = async () => {
      try {
        const res = await fetch("/dashboard/bridge-status", {
          credentials: "include",
        });
        if (!res.ok) return;
        const json = (await res.json()) as BridgeStatusResponse;
        if (!cancelled) setBridge(json);
      } catch {
        /* leave previous value */
      }
    };
    void fetchStatus();
    const id = setInterval(fetchStatus, 4000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let disposed = false;
    let unbindResize: (() => void) | undefined;
    let autoScrollHandle: { dispose(): void } | null = null;

    (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      if (disposed) return;
      const term = new Terminal({
        cursorBlink: false,
        disableStdin: true,
        fontFamily:
          'ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, Consolas, monospace',
        fontSize: 13,
        theme: {
          background: "#0a0a0a",
          foreground: "#e5e5e5",
          cursor: "#666",
          selectionBackground: "#333",
        },
        scrollback: 5000,
        allowProposedApi: true,
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(el);

      try {
        const { WebglAddon } = await import("@xterm/addon-webgl");
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose());
        term.loadAddon(webgl);
      } catch {
        try {
          const { CanvasAddon } = await import("@xterm/addon-canvas");
          term.loadAddon(new CanvasAddon());
        } catch {
          /* DOM renderer fallback */
        }
      }

      termRef.current = term;

      /* Sticky auto-scroll with timed resume. The viewport pins to
       * bottom by default; if the user scrolls up the controller
       * flips following=false and arms a resume timer. After
       * resumeMs of no further scroll activity the timer snaps the
       * viewport back to bottom and resumes tailing. New output
       * while scrolled up does NOT pull the viewport — the user is
       * reading older output. State machine lives in
       * lib/terminal-auto-scroll.ts so it can be tested without
       * standing up xterm. */
      const isAtBottomNow = (): boolean => {
        const buf = term.buffer.active;
        return buf.viewportY >= buf.baseY;
      };
      const autoScroll = createAutoScrollController({
        scrollToBottom: () => {
          try {
            term.scrollToBottom();
          } catch {
            /* ignore */
          }
        },
      });
      autoScrollHandle = autoScroll;
      term.onScroll(() => {
        autoScroll.onScroll(isAtBottomNow());
      });
      const writeFollowing = (data: string): void => {
        const wasFollowing = autoScroll.isFollowing();
        term.write(data, () => {
          if (!wasFollowing) return;
          /* Defer to the next frame so WebGL has finished painting
           * the just-written rows; scrollToBottom inside the same
           * micro-task occasionally landed one row short. */
          requestAnimationFrame(() => {
            try {
              term.scrollToBottom();
            } catch {
              /* ignore */
            }
          });
        });
      };

      /* Match the source terminal's grid by scaling fontSize until
       * xterm's natural cols/rows for the container >= the source's
       * cols/rows, then locking the grid to source dims. This is the
       * fix for the "scrunched + mid-word wrap" problem: without it
       * xterm picks its own grid and the source's cursor positioning
       * ANSI sequences address cells that don't exist. */
      /* Pre-built measurement context. Lets us compute char width for
       * any fontSize without waiting for xterm's async render cycle.
       * The font string must match TerminalMirror's Terminal options
       * exactly; otherwise the predicted width drifts from the actual
       * rendered cells. */
      const measureCanvas = document.createElement("canvas");
      const measureCtx = measureCanvas.getContext("2d");
      const measureCharWidth = (fs: number): number => {
        if (!measureCtx) return fs * 0.6;
        measureCtx.font = `${fs}px ui-monospace, SFMono-Regular, "JetBrains Mono", Menlo, Consolas, monospace`;
        return measureCtx.measureText("M").width;
      };

      let sourceCols: number | null = null;
      let sourceRows: number | null = null;
      const applyDims = (cols: number, rows: number) => {
        if (!cols || !rows) return;
        sourceCols = cols;
        sourceRows = rows;
        if (!el || el.clientWidth === 0 || el.clientHeight === 0) return;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const t = term as any;
        /* Two-stage fit. Stage 1: predict fontSize from canvas
         * measureText (synchronous, no render wait). Stage 2: after
         * xterm renders, measure the actual canvas width and apply a
         * corrective scale on a follow-up frame. xterm's WebGL
         * renderer uses different glyph metrics than measureText so
         * the prediction is consistently off by ~15% on this font;
         * the corrective pass pulls it the rest of the way. */
        const targetW = el.clientWidth;
        const predicted = targetW / cols / 0.6;
        let fs = Math.max(4, Math.min(predicted, 16));
        t.options.fontSize = fs;
        try {
          term.resize(cols, rows);
        } catch {
          /* ignore */
        }
        const correct = (depth: number) => {
          if (depth > 5) return;
          const screen = el.querySelector(".xterm-screen") as HTMLElement | null;
          const measured = screen?.clientWidth ?? 0;
          if (!measured) {
            setTimeout(() => correct(depth + 1), 60);
            return;
          }
          const off = measured / targetW;
          if (Math.abs(off - 1) < 0.02) return;
          // Pull back slightly each pass to converge from above without
          // oscillating around the target.
          fs = Math.max(4, Math.min((fs / off) * 0.99, 16));
          t.options.fontSize = fs;
          setTimeout(() => correct(depth + 1), 60);
        };
        setTimeout(() => correct(0), 60);
        /* Resize pulls the viewport down only if the user was already
         * tailing the output; otherwise a window resize would yank them
         * back to the bottom of a session they were reviewing. */
        if (autoScroll.isFollowing()) {
          try {
            term.scrollToBottom();
          } catch {
            /* ignore */
          }
        }
      };
      void measureCharWidth; // retained for future use; suppress unused

      /* Debounce resize so rapid layout shifts (orientation change,
       * panel toggling) don't run the fontSize-fit loop tens of times
       * per second, which made the iPad app crawl. */
      let resizeTimer: ReturnType<typeof setTimeout> | null = null;
      const onResize = () => {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          resizeTimer = null;
          if (sourceCols && sourceRows) {
            applyDims(sourceCols, sourceRows);
          } else {
            try {
              fit.fit();
            } catch {
              /* ignore */
            }
          }
        }, 150);
      };
      window.addEventListener("resize", onResize);
      unbindResize = () => {
        window.removeEventListener("resize", onResize);
        if (resizeTimer) clearTimeout(resizeTimer);
      };

      /* Finger-drag scrollback for iPad / touch devices. xterm's
       * native viewport scrollbar is a couple of pixels wide and hard
       * to grab on a touch screen, so we translate touch drags
       * anywhere on the terminal surface into term.scrollLines() and
       * preventDefault to suppress the page scroll that would
       * otherwise hijack the gesture. Read-only mirror, no input
       * collisions. Pixel-to-line ratio is approximate; xterm doesn't
       * expose row height publicly, so we use a sensible default that
       * tracks fontSize-based geometry (~16 px per row). */
      const ROW_PX_HINT = 16;
      let lastTouchY: number | null = null;
      const onTouchStart = (ev: TouchEvent) => {
        if (ev.touches.length === 1) {
          lastTouchY = ev.touches[0]?.clientY ?? null;
        } else {
          lastTouchY = null;
        }
      };
      const onTouchMove = (ev: TouchEvent) => {
        if (ev.touches.length !== 1 || lastTouchY === null) return;
        const y = ev.touches[0]?.clientY ?? lastTouchY;
        const dy = lastTouchY - y;
        if (Math.abs(dy) < 2) return;
        const lines = Math.round(dy / ROW_PX_HINT);
        if (lines !== 0) {
          try {
            term.scrollLines(lines);
          } catch {
            /* ignore */
          }
          lastTouchY = y;
          ev.preventDefault();
        }
      };
      const onTouchEnd = () => {
        lastTouchY = null;
      };
      el.addEventListener("touchstart", onTouchStart, { passive: true });
      el.addEventListener("touchmove", onTouchMove, { passive: false });
      el.addEventListener("touchend", onTouchEnd, { passive: true });
      el.addEventListener("touchcancel", onTouchEnd, { passive: true });
      const prevUnbindResize = unbindResize;
      unbindResize = () => {
        prevUnbindResize?.();
        el.removeEventListener("touchstart", onTouchStart);
        el.removeEventListener("touchmove", onTouchMove);
        el.removeEventListener("touchend", onTouchEnd);
        el.removeEventListener("touchcancel", onTouchEnd);
      };

      try {
        const res = await fetch(
          `/sessions/${encodeURIComponent(sessionId)}/terminal-replay`,
          { credentials: "include" },
        );
        if (res.ok) {
          const replay = (await res.json()) as {
            data: string;
            cols?: number;
            rows?: number;
          };
          if (!disposed) {
            if (replay.cols && replay.rows) {
              applyDims(replay.cols, replay.rows);
            } else {
              try {
                fit.fit();
              } catch {
                /* ignore */
              }
            }
            if (replay.data) {
              term.write(replay.data);
              try {
                term.scrollToBottom();
              } catch {
                /* ignore */
              }
            }
          }
        }
      } catch {
        /* non-fatal */
      }

      let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
      const connect = () => {
        if (disposed) return;
        const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
        const url = `${proto}//${window.location.host}/sessions/${encodeURIComponent(
          sessionId,
        )}/terminal-ws`;
        const ws = new WebSocket(url);
        wsRef.current = ws;
        ws.binaryType = "arraybuffer";
        ws.onopen = () => setStatus("live");
        ws.onmessage = (ev) => {
          const text =
            typeof ev.data === "string"
              ? ev.data
              : ev.data instanceof ArrayBuffer
                ? new TextDecoder().decode(ev.data)
                : "";
          if (!text) return;
          try {
            const msg = JSON.parse(text) as
              | { t: "s"; c: number; r: number }
              | { t: "d"; d: string };
            if (msg.t === "s") applyDims(msg.c, msg.r);
            else if (msg.t === "d") writeFollowing(msg.d);
          } catch {
            /* tolerate the old plain-text wire format during rolling
             * upgrades: write the chunk verbatim. */
            writeFollowing(text);
          }
        };
        ws.onclose = () => {
          setStatus("offline");
          if (disposed) return;
          reconnectTimer = setTimeout(connect, 2000);
        };
        ws.onerror = () => {
          ws.close();
        };
      };
      connect();

      return () => {
        if (reconnectTimer) clearTimeout(reconnectTimer);
      };
    })();

    return () => {
      disposed = true;
      try {
        wsRef.current?.close();
      } catch {
        /* ignore */
      }
      unbindResize?.();
      try {
        autoScrollHandle?.dispose();
      } catch {
        /* ignore */
      }
      const term = termRef.current as { dispose?: () => void } | null;
      try {
        term?.dispose?.();
      } catch {
        /* ignore */
      }
      termRef.current = null;
    };
  }, [sessionId]);

  const bridgeView = describeBridge(
    bridge,
    sessionId,
    daemonPtyOwnsSession,
    daemonPtyPending,
    sessionEntry?.project_slug ?? null,
  );

  return (
    <section className="rounded-panel bg-surface1 hairline overflow-hidden">
      <div className="px-5 py-3 border-b border-border1 flex items-center gap-2 flex-wrap">
        <span className="font-display text-sm font-emphasized">{title ?? "Terminal mirror"}</span>
        <span
          data-testid="mirror-watch-label"
          className="text-nano font-mono text-txt3"
          title="A live read-only view of this session's terminal. Nothing you type here is sent to the worker."
        >
          {mirrorWatchLabel(
            resolveMirrorProjectSlug(projectSlug, sessionEntry?.project_slug),
            sessionId,
          )}
        </span>
        <span
          className={`text-nano font-mono ml-2 ${
            status === "live"
              ? "text-promoted"
              : status === "loading"
                ? "text-txt3"
                : "text-err"
          }`}
        >
          ws:{" "}
          {status === "live"
            ? "live"
            : status === "loading"
              ? "connecting…"
              : "offline (reconnecting)"}
        </span>
        <span
          className={`text-nano font-mono ${
            bridgeView.tone === "ok"
              ? "text-promoted"
              : bridgeView.tone === "warn"
                ? "text-attn"
                : "text-err"
          }`}
          title={bridgeView.detail || undefined}
        >
          {bridgeView.label}
        </span>
        {ctx && ctx.max > 0 ? (
          <ContextBadge tokens={ctx.tokens} max={ctx.max} />
        ) : null}
        <span className="ml-auto flex items-center gap-3">
          <button
            type="button"
            onClick={() => {
              /* Local-only clear: wipes the xterm view buffer for the
               * current viewer. Does not touch the daemon's terminal-stream
               * ring or any other client. Reload re-pulls the replay. */
              const t = termRef.current as { clear?: () => void } | null;
              t?.clear?.();
            }}
            className="text-nano text-txt3 hover:text-txt1 font-mono px-2 py-0.5 rounded-pill hairline-soft"
            title="Clear the visible terminal output (local only; reloading restores it from the replay buffer)"
          >
            clear
          </button>
          <span className="text-nano text-txt3">
            read-only · use Steer / Nav for input
          </span>
        </span>
      </div>
      {bridgeView.tone !== "ok" && bridgeView.detail ? (
        <div className="px-5 py-2 border-b border-border1 text-nano text-txt2 bg-surface2">
          {bridgeView.detail}
        </div>
      ) : null}
      {hasDiagnostic && diagnosticPty ? (
        <PtyDiagnosticBlock pty={diagnosticPty} />
      ) : null}
      <div
        ref={containerRef}
        className="h-[65vh] min-h-[420px] bg-[oklch(8%_0_0)]"
        aria-label="Live Claude Code terminal output"
      />
    </section>
  );
}
