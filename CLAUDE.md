# DevNeural agent instructions

Project-level rules for any Claude Code (or compatible) agent
working on this repo. The global rules in `~/.claude/CLAUDE.md`
still apply; this file adds repo-specific guardrails on top.

## Bash: no chained destructive ops

Do NOT chain destructive shell verbs behind another command. One
destructive op per Bash tool call.

Banned shapes:

```
cd <dir> && rm <a> && rm <b>
rm <a> && rm <b>
mv <a> <b> && rm <c>
git checkout <ref> && rm -rf <path>
```

Allowed equivalents (split into separate Bash calls):

```
# call 1
cd <dir>
# call 2
rm <a>
# call 3
rm <b>
```

Or pass the path explicitly so cd is unnecessary:

```
rm <dir>/<a>
rm <dir>/<b>
```

### Why

Claude Code's permission matcher evaluates the full chained
command string against the allow-list as one token. Patterns that
authorise `rm <path>` do not decompose `cd X && rm Y && rm Z` into
three checks; the chain hits the deny path and the operator gets
prompted on every routine sweep. Splitting the work into
single-op calls keeps the matcher accurate and the worker fast.

### Scope

"Destructive" means any of: `rm`, `rmdir`, `mv` (overwrite), `git
reset --hard`, `git clean -f`, `git branch -D`, `git checkout --`,
`git stash drop`, `git stash clear`, `git push --force`, `taskkill
/f`, redirected writes that clobber files (`> file`,
`tee file`), database `DROP` / `TRUNCATE` shelled through the
SQLite or psql CLI, or any combination that ends in unrecoverable
state mutation.

`cd && ls` is fine. `cd && cat` is fine. `cd && grep` is fine.
The rule only fires when at least one element of the chain is
destructive.

### Multi-step recipes

For recipes that genuinely need a sequence (build, test, commit),
either:

1. Use the existing test runners / build scripts (`npm test`,
   `npm run build`) which encapsulate the sequence inside one
   non-destructive entry point.
2. Issue the calls sequentially, one Bash invocation per step,
   reading the previous result before continuing.

Do NOT bundle a destructive cleanup into the same chain as the
build that produced the artefacts it cleans up. The two are
separate intents and the cleanup should be re-runnable on its own.

### Pre-action checklist for any `rm`/`mv`/`git reset`

- Is the path under the current project CWD?
- Is the path in your tool-call args verbatim, not assembled by
  chaining a `cd`?
- Are you about to run this once, or in a loop? Loops belong in a
  Bash invocation that lists every target explicitly, not in a
  shell `for path in ...; do rm ...; done` — listing makes the
  audit log honest.

If any of these is uncertain, stop and ask.
