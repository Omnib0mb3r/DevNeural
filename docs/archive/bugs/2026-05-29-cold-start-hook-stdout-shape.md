# Cold-start hook stdout shape: plain markdown dropped by CC

Date: 2026-05-29
Component: 07-daemon/src/capture/hooks/hook-runner.ts
Severity: high (silent failure of cold-start preload + worker-handoff feature)
Status: CLOSED 2026-05-29. Shipped as Fix 50 (investigation `b18ffaa` + code `20147a7`). See FIXES.md row 50.

## 1. Symptom + evidence

The Lex cold-start preload route `/lex/cold-start-preload` is wired
and fires on every fresh SessionStart per `postColdStartPreload` in
`07-daemon/src/capture/hooks/hook-runner.ts` (line ~165). The route
returns `ok=true` with a non-empty `block` field. Despite this, the
operator-observed behaviour is: Lex sees no preload block in the
SessionStart hook attachments on the very first user turn.

Concrete evidence:

- Session `a134b501-8ff0-472e-bab7-aedd4a3a6a36` (2026-05-29 13:09:13Z).
  Brainstorm anchor `4bbafb48`. Audit row in
  `cross_session_injection_log` (caller_label `cold-start-preload`)
  carries the composed block.
- Reading that session's jsonl directly: attachments 1-9 on the
  first user turn show injected `additionalContext` blocks from
  three OTHER hook sources (`caveman/...`, `superpowers/...`,
  `deep-project/...`). The DevNeural cold-start block is NOT among
  them.
- All three hooks that DID inject successfully emit JSON-shaped
  stdout. Example, `superpowers/scripts/hooks/capture-session-id.py`
  prints:

  ```python
  output = {
      "hookSpecificOutput": {
          "hookEventName": "SessionStart",
          "additionalContext": "\n".join(context_parts),
      }
  }
  print(json.dumps(output))
  ```

- DevNeural's `postColdStartPreload` instead writes plain markdown:

  ```ts
  process.stdout.write(json.block + '\n');
  ```

  Per CC's SessionStart hook protocol, plain stdout is displayed but
  NOT auto-injected as `additionalContext`. Only the JSON envelope
  shape (`hookSpecificOutput.hookEventName='SessionStart' +
  additionalContext`) flows into the first-turn context.

## 2. Root cause

`07-daemon/src/capture/hooks/hook-runner.ts:196` and `:238`. Both
SessionStart-time injectors write the block as bare markdown text.

CC's SessionStart hook reads stdout with two distinct contracts
depending on shape:

1. Stdout that parses as JSON with a `hookSpecificOutput.hookEventName`
   matching the event name is treated as a structured hook result;
   its `additionalContext` field is concatenated into the first user
   turn's hook context attachments.
2. Stdout that does NOT parse as that envelope is treated as
   transcript noise (shown in the terminal, possibly logged, never
   threaded into the user-prompt context).

DevNeural's writers fall through path (2). The route's block is
composed correctly and returned; the hook's `process.stdout.write`
emits it; CC reads it; CC drops it.

`postWorkerHandoff` (the sibling function at line ~216) has the
identical defect on its own stdout writer.

## 3. Fix scope

Two stdout writers, single one-line shape change each:

- `07-daemon/src/capture/hooks/hook-runner.ts` `postColdStartPreload`
- `07-daemon/src/capture/hooks/hook-runner.ts` `postWorkerHandoff`

Each writer changes from:

```ts
process.stdout.write(json.block + '\n');
```

to:

```ts
process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'SessionStart',
    additionalContext: json.block,
  },
}));
```

No route change. No envelope change on the daemon side. The route
still returns `{ ok, block }`; the hook is responsible for wrapping
that block in CC's SessionStart envelope before printing.

Both functions are converted to named exports so the new test pins
can call them directly with a mocked `fetch`.

## 4. Tests required

New file `07-daemon/tests/hook-runner-stdout-shape.test.ts` with one
pin per writer:

- `postColdStartPreload writes a SessionStart additionalContext
  envelope`: stub `globalThis.fetch` to resolve with
  `{ ok: true, block: '<sentinel-block>' }`; intercept
  `process.stdout.write` calls; invoke `postColdStartPreload`;
  assert exactly one stdout write happened, that the write parses
  as JSON, that `hookSpecificOutput.hookEventName === 'SessionStart'`,
  and that `hookSpecificOutput.additionalContext === '<sentinel-block>'`.
- `postWorkerHandoff writes a SessionStart additionalContext
  envelope`: same shape against the `/worker/clear-handoff` route.

Both pins use a real `Response`-shaped stub so the writer's
`res.json()` path matches production behaviour.

## 5. Rebuild needed

Yes. Daemon TS-only. Run:

```
cd 07-daemon && npm run build
```

`07-daemon/dist/capture/hooks/hook-runner.js` regenerates. No
migration. No dashboard rebuild. No daemon restart strictly
required for the hook itself (CC re-invokes `node hook-runner.js`
per SessionStart and reads the freshly-built dist), but the
operator should confirm CC's hook command path points at the
post-build dist before testing.
