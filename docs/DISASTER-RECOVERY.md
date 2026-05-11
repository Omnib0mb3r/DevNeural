# DevNeural Disaster Recovery Runbook

> **Status:** Manual procedure as of 2026-05-11. Automation lives in Phase 8 (`docs/spec/PHASE-8-RELIABILITY-PLAN.md`). Until that ships, run snapshots by hand before any daemon upgrade or risky operation.

---

## When to snapshot

- **Always** before restarting the daemon to pick up a new build.
- **Always** before running migrations or destructive schema changes.
- **Always** before bulk operations against `index.db` (mass deletes, vacuum, restore from chroma).
- **Nightly** as habit until Phase 8 automates it.
- **On brainstorm end** if the conversation contained durable corrections, new memories, or critical decisions.

## What to snapshot

Three categories cannot be re-derived from git:

1. **Brainstorm memory folder.** Path: `C:\Users\michael\.claude\projects\C--dev-data-skill-connections-brainstorm\memory\`. About 28 markdown files. This is Lex's personality.
2. **Daemon SQLite database.** Path: `C:\dev\data\skill-connections\index.db` plus `index.db-shm` and `index.db-wal`. All three files together, because the DB runs in WAL mode and the shm/wal hold un-checkpointed writes.
3. **Claude Code session jsonls.** Path: `C:\Users\michael\.claude\projects\<slug>\<session-id>.jsonl`. One per active or recent CC session. These are the verbatim conversation logs, including tool calls and assistant reasoning.

Not in scope for the lightweight snapshot, but worth periodic separate backup:
- `C:\dev\data\skill-connections\brainstorms\<id>\audio\*.wav` (audio captures, large)
- `C:\dev\data\skill-connections\wiki\pages\*.md` (curated wiki bodies)
- `C:\dev\data\skill-connections\chroma\` (vector store; can be regenerated from chunks but slowly)
- `C:\dev\data\skill-connections\lex-prompts\` (prompt archive, few-shot, refusal contracts; once populated by the new daemon build)

---

## How to take a snapshot (manual, until Phase 8)

Run this from any PowerShell session on the host:

```powershell
$ts = Get-Date -Format 'yyyy-MM-dd-HHmmss'
$dest = "C:\tmp\backups\devneural-$ts"
$brainstormMemory = 'C:\Users\michael\.claude\projects\C--dev-data-skill-connections-brainstorm\memory'
$dataRoot = 'C:\dev\data\skill-connections'

New-Item -ItemType Directory -Path "$dest\memory" -Force | Out-Null
Copy-Item "$brainstormMemory\*" "$dest\memory" -Recurse -Force
Copy-Item "$dataRoot\index.db" "$dest\index.db" -Force
if (Test-Path "$dataRoot\index.db-shm") { Copy-Item "$dataRoot\index.db-shm" "$dest\index.db-shm" -Force }
if (Test-Path "$dataRoot\index.db-wal") { Copy-Item "$dataRoot\index.db-wal" "$dest\index.db-wal" -Force }

# Pull the most-recent jsonl per active session
Get-ChildItem 'C:\Users\michael\.claude\projects\' -Directory | ForEach-Object {
  $latest = Get-ChildItem $_.FullName -Filter '*.jsonl' -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($latest) { Copy-Item $latest.FullName "$dest\$($_.Name)-$($latest.Name)" -Force }
}

Compress-Archive -Path "$dest\*" -DestinationPath "$dest.zip" -Force
Remove-Item $dest -Recurse -Force
Write-Output "Snapshot at: $dest.zip ($([Math]::Round((Get-Item "$dest.zip").Length/1MB, 2)) MB)"
```

Always include a `RESTORE.md` inside the zip describing what's in it and how to restore (see the canonical template at `docs/templates/RESTORE-template.md` once written; for now copy the body of any prior backup's `RESTORE.md`).

---

## How to restore from a snapshot

Hand the snapshot's `RESTORE.md` to a Claude Code session with: "Restore the DevNeural backup according to this RESTORE.md file."

Manual version, if no CC session is available:

1. **Stop the daemon** so it does not hold open handles on `index.db`.
   ```powershell
   $daemonPid = Get-Content 'C:\dev\data\skill-connections\daemon.pid' -ErrorAction SilentlyContinue
   if ($daemonPid) { Stop-Process -Id $daemonPid -Force -ErrorAction SilentlyContinue }
   ```
2. **Preserve the broken state** so you can diff against it later. Copy everything you are about to overwrite to `C:\tmp\backups\broken-state-<ts>\` first.
3. **Extract the snapshot zip** to a temp dir.
4. **Copy each piece back** to its canonical path (see `Path:` lines under each category above).
5. **Restart the daemon** (via `npm start` in `07-daemon` or via Windows Service if Phase 8 supervisor is installed).
6. **Verify** by hitting `http://127.0.0.1:3747/health` and checking the dashboard loads expected sessions and reminders.

---

## Operational notes

- **Snapshots taken while the daemon is running are best-effort consistent.** SQLite WAL mode tolerates this; the snapshot will reflect a recent committed state. For true point-in-time consistency, stop the daemon first.
- **Do not overwrite session jsonls if the originals exist and are healthy.** They contain the verbatim CC conversation including tool reasoning; the snapshot copy might be older.
- **Memory folder is a full replacement.** When restoring memory, delete the current contents first so removed memories actually go away. Otherwise restored + current files coexist and stale entries linger.
- **The git repo is its own disaster recovery.** Source code is on GitHub at `Omnib0mb3r/DevNeural`. If the local checkout is corrupted, `git clone` and rebuild.

---

## Phase 8 future state

Phase 8 (Reliability) will:

- Automate snapshots nightly and on brainstorm end.
- Push snapshots off-host (OneDrive, S3, or private GitHub repo).
- Add a Windows Service supervisor so daemon crashes recover automatically.
- Decouple PTY hosting from daemon lifecycle so an upgrade does not kill running Lex sessions.

Until Phase 8 lands, this manual runbook is the disaster recovery story.

---

## Change log

- 2026-05-11: Initial runbook. Captured manual snapshot procedure used pre-Wave-3 daemon restart. Snapshot stored at `C:\tmp\backups\devneural-2026-05-11-015213-pre-restart.zip` for reference.
