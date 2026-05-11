# Phase 8: Reliability

> **Origin:** Brainstorm "Dev brainstorm season" 2026-05-11. Surfaced during Wave 3 daemon-restart chicken-and-egg discussion. Captured as a new phase rather than a wave inside Phase Two because the scope is cross-cutting infrastructure, not feature work.
>
> **Numbering note:** Phase 8 follows Phase 7 (diarization) in monotonic order even though Phases 3-5 do not exist as named units. Phase Two absorbed earlier phases via its waves.
>
> **Not in Phase Two scope.** This phase opens after Phase Two completes (Wave 4 exit, plus the cross-host data root sync spec).

---

## Headline goal

Make the daemon and PTY hosting durable enough that a daemon upgrade or crash does not destroy in-flight Lex brainstorms and worker sessions. Also harden data persistence so a disk loss does not erase the personality corpus.

---

## Scope

### Process supervisor (priority 1)

Auto-restart the daemon when it crashes or exits non-zero. Single-user Windows-native approach.

- Wrap the daemon in a Windows Service or a supervisor process (e.g., `node-windows`, `nssm`, or a small custom PowerShell-launched watchdog).
- Health check endpoint exists at `/health` already; supervisor polls every 30s.
- Three consecutive failed health checks: restart daemon, alert via dashboard notification + reminder.
- Boot-on-login so user does not have to start it manually.
- Acceptance: kill daemon process from Task Manager, supervisor restarts it within 30s, dashboard recovers automatically.

### Memory + transcript backup (priority 1)

Recurring snapshot of the data that cannot be re-derived from git.

- Files in scope: brainstorm memory folder, `index.db` (+ shm/wal), Lex prompts archive, brainstorm audio + cues, this brainstorm's session jsonl, worker session jsonls.
- Frequency: nightly + on brainstorm end.
- Destination: configurable (OneDrive folder, external drive, or private GitHub repo). Default: OneDrive.
- Retention: 30 daily snapshots, 12 monthly snapshots.
- Acceptance: corrupt `index.db`, restore from last snapshot, brainstorms list comes back intact.

### PTY survival across daemon restart (priority 2)

Decouple PTY hosting from daemon lifecycle so an upgrade does not kill running Lex sessions.

Two viable approaches; pick one during phase planning:

**Approach A: Detached PTY processes.** Each PTY runs as its own Node child process. Daemon manages metadata (which PTYs exist, who owns them) but does not own the OS handle. On daemon restart, supervisor or systemd-style unit relaunches daemon, daemon re-attaches to live PTYs via PID + named pipe handoff.

**Approach B: PTY-host worker pool.** Separate `pty-host` long-running process always-on. Daemon talks to it over IPC. Daemon can restart freely; PTY host keeps sessions alive.

Approach B is cleaner architecturally; Approach A is faster to implement. Decision lives in the Phase 8 plan discussion phase, not this seed doc.

- Acceptance: kill daemon process while a Lex brainstorm is active, daemon restarts, brainstorm voice WS reconnects and the same Lex session resumes (no new session id, no lost context).

### Read-only personality file enforcement at OS level (priority 3)

Wave 3 shipped the personality guard as a prompt rule + filesystem watcher (Layer A + B). Phase 8 adds the Windows ACL hardening (Layer C) and verifies it survives a daemon restart.

- Confirm `applyIcacls` runs at daemon boot, sets DENY-write on personality files for the daemon process user.
- Run a test where the daemon tries to write to a personality file; expect EACCES.
- Acceptance: even if a future bug or misconfiguration lets Lex try to write a personality file, the OS refuses.

### Daemon graceful shutdown protocol (priority 3)

Flush in-memory state to disk before exit. Currently the daemon does not gracefully close PTYs or persist the live awareness queue on shutdown.

- Trap SIGTERM and SIGINT.
- Drain pending awareness events to `audit_findings`.
- Close PTYs with a "daemon restarting" banner so the user sees the cause.
- Acceptance: send Ctrl+C to daemon, log shows "shutdown complete, flushed N events" and exits within 5s.

---

## Out of scope

- Multi-host sync (this is Wave 4 spec / Wave 5 implementation).
- Cloud-hosted daemon. This is local-first by design.
- Cross-platform Linux / Mac supervisor. Windows only.

---

## Acceptance criteria (phase exit)

- Daemon supervisor running; killing daemon results in auto-restart within 30s.
- Snapshot backup runs nightly and on brainstorm end; restore tested at least once successfully.
- A Lex brainstorm survives a daemon restart (Approach A or B implemented).
- Personality guard ACL verified.
- Graceful shutdown protocol works on SIGTERM and SIGINT.

---

## Sequencing

Phase 8 opens after Phase Two Wave 4 exit. Estimated 3-5 days of single-agent execution depending on which PTY-survival approach we pick. Approach B will run longer because it requires designing the IPC contract; Approach A is mostly wiring.
