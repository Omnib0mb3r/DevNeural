# Cleanup TODO

Janitorial items that don't belong in a wave plan. Append as discovered, strike through when done.

## Open

### Stale worktree branches (Wave 3)
- `worktree-agent-a354fa4e` (Lane A orb)
- `worktree-agent-a3547bb5` (Lane B lex/phase6)

Both branches were merged to master via Wave 3 merge commits. Worktree dirs already removed; only the local branch refs remain. Safe to delete:

```bash
git branch -D worktree-agent-a354fa4e worktree-agent-a3547bb5
```

Logged 2026-05-11 after Wave 3 push (origin/master at `255e20f`).

### Local untracked artifacts (gitignored; safe to delete on owner's box)

These live in the working tree but are `.gitignore`d so they never reached the remote. Listed here so the next janitor pass clears local disk; not destructive to the repo either way.

- `step5-verify-after-open-click.png`
- `step5-verify-lex-page-initial.png`
- `step5-verify-spawn-or-bind-success.png`
- `.playwright-mcp/` — accumulated Playwright MCP console logs from May 2026 exploratory sessions; safe to wipe.

```bash
# Run from repo root when convenient:
rm -f step5-verify-*.png
rm -rf .playwright-mcp
```

Logged 2026-05-12 during the post-PROJECT-ANCHORS docs/prune sweep.

### Empty directories under tracked paths

- `.claude/worktrees` — placeholder; left for the worktree skill to fill.
- `09-bridge/.vscode` — VS Code workspace dir for the bridge extension dev loop; reappears if `code` is opened there. Leave.

No action; documented so future passes don't waste time investigating.

### Surveyed and considered, NOT pruned

- `docs/HANDOVER-2026-05-{09,10}-*.md` — historical handover docs from Wave 1 / Wave 2. Useful for cold-start context; retain.
- `docs/bugs/*.md` — bug postmortems, one per incident. Retain.
- `08-dashboard/references/_self/{report.html,report.json,post-token-viewport.png}` — design reference snapshots. Retain (the OTLC-Design skill reads these).
- `08-dashboard/POSTMORTEM.md`, `08-dashboard/VERIFICATION.md` — Phase 3.4 dashboard rebuild artifacts. Retain.
- `07-daemon/scripts/migrations/*` — every numbered migration is referenced by the runner; nothing abandoned. None of them have `*.down.sql` counterparts so there is nothing to prune.

## Done

(none yet)
