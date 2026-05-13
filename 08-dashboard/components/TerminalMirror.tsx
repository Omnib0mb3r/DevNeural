"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { sessions as sessionsClient, listPtys } from "@/lib/daemon-client";
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
  if (m.last_flush_session_id && m.last_flush_session_id !== sessionId) {
    return {
      label: "mirror: streaming other session",
      tone: "warn",
      detail: `bridge is sending bytes to ${m.last_flush_session_id.slice(
        0,
        8,
      )}…, not this one. Check StreamDeck.App registered the right cwd.`,
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
}

export function TerminalMirror({ sessionId }: Props) {
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
  const ctx =
    sessionsQ.data?.sessions?.find((s) => s.session_id === sessionId)?.context ??
    null;

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

      /* Sticky auto-scroll: follow the live tail unless the user has
       * scrolled up to read older output. xterm's built-in pin-to-
       * bottom heuristic was flaky enough that pasted ANSI bursts
       * occasionally left the viewport stuck a few lines above the
       * cursor, so we own the decision explicitly.
       *
       * "At bottom" means viewportY is within 1 line of baseY (the
       * row where the scrollback ends and the live screen begins).
       * That's the xterm-buffer equivalent of the DOM `scrollTop vs
       * scrollHeight - clientHeight < 20px` check most chat / dev-
       * tools surfaces use. */
      const isAtBottom = (): boolean => {
        const buf = term.buffer.active;
        return buf.viewportY >= buf.baseY - 1;
      };
      const writeFollowing = (data: string): void => {
        const wasFollowing = isAtBottom();
        term.write(data, () => {
          if (wasFollowing) {
            try {
              term.scrollToBottom();
            } catch {
              /* ignore */
            }
          }
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
        if (isAtBottom()) {
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
  );

  return (
    <section className="rounded-panel bg-surface1 hairline overflow-hidden">
      <div className="px-5 py-3 border-b border-border1 flex items-center gap-2 flex-wrap">
        <span className="font-display text-sm font-emphasized">Terminal mirror</span>
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
      <div
        ref={containerRef}
        className="h-[65vh] min-h-[420px] bg-[oklch(8%_0_0)]"
        aria-label="Live Claude Code terminal output"
      />
    </section>
  );
}
