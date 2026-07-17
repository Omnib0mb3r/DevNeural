# Getting started

DevNeural is a voice-first thinking partner (Lex) wrapped around a
persistent knowledge engine. You talk, Lex answers and works; the
daemon records, distills, and files everything so nothing is lost
between sessions.

## The three pieces

- **Lex** is the voice and the brain. Quick questions get answered on
  the spot; real work is handed to her deeper reasoning session and
  the answer is spoken when it lands.
- **The daemon** is the always-on engine on this machine. It owns the
  microphone pipeline, the text-to-speech voice, the database, the
  wiki ingest, and every background job. If the daemon is down,
  nothing else works.
- **The dashboard** (this app) is the window into all of it: live
  brainstorms, session history, the wiki, worker supervision, and
  the settings.

## Your first five minutes

1. Open **Home**. The tiles show the live status of the daemon, the
   voice pipeline, and any running brainstorms.
2. Press the **start-voice** button (or open a brainstorm and start
   talking). Say hello; Lex answers out loud.
3. Ask for something real ("look at the failing test in the daemon
   repo"). Lex tells you she is on it and speaks the result when it
   is ready. You can keep talking while she works.
4. Open **Brainstorms** to watch the conversation log land in real
   time, and **Wiki** later to see what got filed.

## Where things go

Everything you say in a brainstorm is chunked into the database as it
happens. When a session ends (or a connection flushes), the daemon
distills the transcript into a structured summary. The next session
on the same brainstorm preloads that summary plus the most recent
turns, so Lex picks up where you left off instead of starting cold.

## If something looks dead

Check the **Troubleshooting** section below. The short version: the
daemon log screams loudly on every known failure mode, and the Home
tiles tell you which layer stopped.
