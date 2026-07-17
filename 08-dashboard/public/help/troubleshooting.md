# Troubleshooting

The system is built to fail loudly: every known failure mode writes a
distinctive line to the daemon log. When something feels wrong, the
log is the first stop.

**Daemon log:** `C:\dev\data\skill-connections\daemon.log`

## Voice is silent

1. Check the Home voice tile. If the pipeline shows down, use the
   start-voice button.
2. Grep the daemon log for `TTS SYNTH FAILED`, `TTS STREAM ERROR`, or
   `no-live-sink`. Those mean the voice engine died or had nowhere to
   play; the log line names the cause.
3. If Lex is mid-work, silence up to the heartbeat interval is
   normal. A `HEARTBEAT MISSED` line means the voice brain skipped a
   pulse; the work itself is usually still running.

## Lex repeats herself

One replay after a reconnect is intentional (catching you up). More
than one repeat of the same line means connection churn; check the
log for repeated `ws-close` lines and the close code (1000/1001 is a
clean close, 1006 is an abnormal drop such as a daemon restart).

## My spoken request never reached the work session

Grep for `INJECT DELIVERY FAILED` or `TRUNCATED DELIVERY`. The
injection layer retries on its own; a FAILED line means the paste
never produced a user record (usually a stuck prompt in the terminal;
press Enter there or re-speak).

## Session shows "ended" but I did not end it

That should never happen. Connection drops and brainstorm switches
only flush; ending is reserved for the explicit paths. Grep the log
for `session-end pipeline entered` and check the `reason=` field to
see which path fired, then report it.

## Distillations look stale or missing

- Grep for `distill-headless` and `per-session-distill` lines; every
  skip logs a structured reason (timeout, exit code, empty transcript,
  no scoped chunks).
- A `TIMEOUT after ...ms` line means the summarizer pass ran out of
  time. The budget is configurable via `DEVNEURAL_DISTILL_TIMEOUT_MS`.
- Cold starts fall back to the raw recent turns when distillation
  lags, so a stale summary degrades gracefully rather than losing the
  thread.

## Dashboard feels dead

Hard-refresh the browser first (Ctrl+Shift+R). If tiles stay stale,
the daemon SSE stream may have dropped; the tiles reconnect on their
own within seconds. A daemon restart is visible in the log as a new
boot banner with step timings.

## When to restart the daemon

Restarting the daemon is an operator action, not a reflex. Restart it
when the log shows a crash loop or the voice pipeline cannot be
revived from the dashboard. Brainstorms survive restarts; live voice
connections reconnect.
