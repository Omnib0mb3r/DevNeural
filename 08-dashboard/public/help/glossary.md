# Glossary

Terms you will see across the dashboard, in plain English.

## Anchor

The persistent identity of a Lex brainstorm or a project session.
An anchor outlives any single claude-code session: when a session
is reset or compacted, a fresh claude-code spawns and rebinds to
the same anchor, so the conversation continues. Each anchor has
its own ID, transcript history, and supervision state.

## Brainstorm

A voice or text conversation between you and Lex. Lives as a row
in the brainstorm index with its full transcript, optional audio
recording, and an auto-generated distillation summary. Different
from a meeting (no consent-gated retention) and from a project
session (no code worker bound).

## Sibling session

Another brainstorm with the same user label. When you start a new
brainstorm and give it a name you have used before, Lex preloads
the most recent distillation summaries from the matching siblings
so the new conversation starts with context.

## Distillation

A short LLM-generated summary of a brainstorm or meeting. Produced
at session end (and force-produced when a sibling preload needs
fresh context). Distillations live on the brainstorm row in the
`last_summary` column and feed the sibling-preload pipeline.

## Worker

A claude-code instance Lex is supervising. Each worker has a PTY
(or a bridge binding), a session ID, a project anchor, and a
supervision mode. The Sessions and Projects pages list active
workers.

## Project anchor

Same idea as an anchor, scoped to a project's working directory.
Persists across worker resets. Holds the supervision mode and the
recent activity timestamp.

## Supervision mode

How Lex watches a project worker. Polling (cron-style), event
(daemon push), or off (no watching). Set per project on the
Projects tile.

## Smart compact

The auto-reset for stuck workers feature on `/system`. When a
worker fills its context window, Lex resets it with `/clear` and
pastes a resume summary so work continues without losing thread.
Three modes: off, shadow (logs only), live.

## Auto-advance

The auto-advance-to-next-task feature on `/system`. When a worker
finishes a task cleanly, Lex picks the next item from the project
backlog and sends it. Three modes: off, shadow, live. Questions
that need your input still stop for you.

## Resume summary

The structured prompt Lex pastes after a `/clear`. Six sections
when each is populated: Goal, Current state, Files in flight,
Changed since last resume, Failed attempts, Next step. Empty
sections are dropped, never padded.

## Wake-word / voice command

The only mechanical spoken keyword is `lex emergency stop`, the
panic phrase that halts the live worker with no AI in the loop.
There is no other command grammar: everything else you say is just
talked to the voice layer and interpreted, not matched against a
fixed keyword list.

## Reinforcement

The wiki's self-improving loop. Every time Lex pulls a wiki page
into a worker's context Lex scores whether the page actually
helped. Useful pages get a weight boost; ignored or contradicted
pages decay. Surfaces on Home as the Wiki match history.

## Cold-start preload

The "carry context into fresh Lex sessions" feature on `/system`.
When a new Lex chat opens, the daemon preloads what you discussed
in related earlier sessions (sibling brainstorms) so you do not
start from zero.

## Pause mode

The wiki freeze toggle on `/system`. Stops Lex from fading older
wiki pages while you are not actively working on the project.
Three modes: auto (pause after 21 days idle), off, on.

## Notify class

The source class on every notification, governing which surface
sees it. Conversation rows (Lex chatter) are filtered out of the
top-bar bell; report, followup, and signal classes hit the bell.
The right-rail activity feed sees every row.

## Outbound log

The audit log of every off-host call DevNeural ever makes.
Visible on the dashboard's Outbound card. DevNeural is local-first
by default; the outbound log proves what did and did not leave
your machine.
