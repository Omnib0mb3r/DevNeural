# Brainstorms and sessions

A **brainstorm** is the durable thing: the named thread of thought
you keep coming back to. A **session** is one sitting inside it (one
voice connection, one Claude Code binding). Brainstorms outlive
sessions by design.

## What ends a brainstorm (and what does not)

A brainstorm ends only when you end it:

- you say something like "we're done, end the session",
- you press the explicit End control in the UI, or
- a compaction restart replaces the session on purpose.

Everything else is **not** terminal. Closing the tab, switching to a
different brainstorm, a dropped network connection, a daemon restart:
all of these just flush (see below) and leave the brainstorm alive
for the next reconnect. If a brainstorm ever shows "ended" and you
did not end it, that is a bug.

## The flush

Whenever a connection closes, the daemon runs a distillation flush:
it force-ingests pending content, distills the transcript so far, and
refreshes the rolling summary. The brainstorm stays live. This is why
you can bounce between brainstorms freely; each switch banks your
progress without closing anything.

## End-of-session pipeline

A real end runs the full ordered pipeline: drain in-flight
transcription, finalize audio, force wiki ingest, distill the
transcript into wiki drafts, refresh the per-session summary, write
the thread doc, and mark the row distilled. You get a bell
notification summarizing what was produced.

## Cold-start preload

When a new session binds to an existing brainstorm, Lex preloads:

- the rolling distilled summary of prior sessions,
- structured summaries of the most recent sibling sessions,
- the last 10 turns from the live conversation log (the same log the
  dashboard shows), so the newest exchange is verbatim even if
  distillation has not caught up yet.

Lex's first reply quotes a context verdict (fresh / stale / partial /
outdated / empty) so you know exactly how much she remembers before
you continue.

## Meetings

Meetings are a separate kind: they record and transcribe but do not
auto-distill into wiki drafts, and audio is only kept when consent
was acknowledged.
