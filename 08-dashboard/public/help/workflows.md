# Common workflows

The five things you do most. Two to four sentences each.

## Starting a brainstorm

Open `/lex` and click **start lex**. A fresh Lex anchor spawns
under the brainstorm CWD; the voice panel mounts itself if you
have a mic. Speak or type. Past sessions in the right column let
you resume a topic; new ones live as their own anchor so the
context stays clean.

## Kicking off a project

Go to `/projects` and click the **new project** button (or open
the command palette with `Ctrl+K` and pick "New project", which
jumps to `/projects?new=1`). There is no `/projects/new` route,
and the Home projects panel only has a "view all" link, so the
button lives on the Projects page. It opens a static form modal:
give the project a name, a stage, and tags, then create it. This
is a plain form, not a Lex conversation. After registration the
project tile appears on `/projects` and the Home projects panel;
supervision defaults to polling. Flip the chip to event once Lex
has watched the project for a few sessions.

## What the morning report tells you

The Daily Brief on Home shows three things: what Lex thinks is
worth your attention today (auto-extracted from the last 24h of
sessions plus open reminders), the "what's new" digest of code +
wiki changes since you last logged in, and the queue of pending
drafts and audit findings. Skim the brief first; it's the
shortest path to knowing what changed overnight.

## How reminders fire

Reminders are time- or condition-triggered. The daemon checks
the reminder index every five minutes by default. When a reminder
is due, it lands
in `/reminders`, fires a web push notification (if you granted
permission) and a `followup`-class notification in the top-bar
bell. Reminders never auto-dismiss; click the dismiss button
once you have acted on the item.

## How supervision modes differ

Each project anchor has a supervision mode set on its tile:

- **Polling**: a cron-style loop scans worker state every minute.
  Reliable, lightweight, slow. Default for new projects.
- **Event**: the daemon pushes worker events to Lex the moment
  they happen (file change, tool call, prompt-end). Lex reacts
  in near real time. More CPU, more notifications.
- **Off**: supervision disabled. Workers run alone; Lex does not
  touch them. Use this for projects you are not actively
  developing.

If event mode produces too many notifications in a 10-minute
window, the kill-switch trips and flips back to polling
automatically. You see a `signal`-class notification when this
happens.
