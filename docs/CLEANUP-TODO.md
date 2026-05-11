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

## Done

(none yet)
