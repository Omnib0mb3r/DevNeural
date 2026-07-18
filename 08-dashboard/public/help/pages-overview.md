# Pages overview

What each top-level dashboard tab is for, in plain English.

## Home

The landing page. Shows your daily brief (what Lex thinks you
should look at today plus a "what's new" summary), a compact view
of your registered projects, the knowledge-map graph, and the
wiki match history. This is where you start each morning.

## Brainstorms

Every voice and text session you have had with Lex. Filter by
project, mode (conversation, push-to-talk, notes-only), or date
to find a past conversation. Each row links to the full transcript
plus any audio recording and distillation summary.

## Meetings

Sessions tagged as meetings (consent-acked audio retained,
diarised when possible). Same shape as Brainstorms but scoped to
the meeting kind so notes and action items are easier to find.

## Sessions

Live and recent claude-code worker sessions. The terminal mirror
of any active worker, plus the supervision mode and live status
per session. Use this when you want to know what every worker is
doing right now.

## Wiki

Everything Lex has learned about you and your projects, plus
reference docs you have uploaded. Search any keyword to find
what Lex knows. The right rail lists your uploaded references
(PDFs, audio transcripts, code dumps) separately from
auto-generated wiki pages.

## Drafts

New wiki pages Lex wrote from your recent brainstorms. Review
each one and accept, edit, or discard before it lands in the
wiki. Drafts surface here so an auto-distilled summary never
silently joins the canonical wiki without your eye on it.

## Projects

Every code project Lex is supervising plus its anchor binding,
last-seen activity, and the supervision mode (polling, event,
off). The supervision chip on each tile flips the mode for that
project without leaving the page.

## Reminders

Time- or condition-triggered reminders Lex has scheduled for
you. Different from notifications: reminders are action items
with a due time; notifications are a passive signal stream.

## System

Health, diagnostics, and the runtime toggles for the daemon's
optional automation: auto-reset for stuck workers, auto-advance
to the next task, voice diagnostics log, cold-start preload,
panic history, and the daemon restart control. The page is
the operator's cockpit.

## Knowledge map

The `/orb` tab. A single force-directed graph that puts your
brainstorms, wiki pages, projects, and meetings in one view so you
can see how everything Lex knows connects. Pan and zoom to explore
the web of related work at a glance.

## Knowledge index

The `/knowledge` tab. A project-scoped, browsable map of the
markdown knowledge stores. Narrower than the Knowledge map: where
`/orb` shows the global brainstorm, wiki, and project graph, this
one indexes the knowledge for a project so you can drill into it.

## Settings

Reached from the gear icon rather than a top-nav tab. Persistent
preferences stored on the daemon, chiefly the voice settings.
Daemon controls (restart, live vitals, services, and the log tail)
live on System; Settings just links you there.

## Lex

The brainstorm panel. Start or resume a Lex conversation; voice
or text. Past sessions in the right column. This is the room
where you and Lex talk.

## Help

This page.
