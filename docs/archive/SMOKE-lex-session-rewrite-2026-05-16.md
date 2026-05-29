# Lex session rewrite verification (commit 5af07d0)

Date: 2026-05-16
Operator: autonomous (Lex)
Daemon: pid 55564, uptime 6863s, phase P3.2-reference-corpus
Branch: master @ 42d8d9b (131 commits past 5af07d0)

## Scope

PLAN-lex-session-rewrite.md introduced durable `lex_session` anchors
decoupled from CC session UUIDs. This smoke confirms 131 commits of
drift did not break the anchor list, the spawn-or-bind contract, the
Stream Deck tile feed, or the end-session route. Physical Stream
Deck render is hardware-bound and parked.

## Results

| # | Check | Method | Result |
|---|---|---|---|
| 1 | `GET /lex/anchors` returns durable list | curl 127.0.0.1:3747 | PASS |
| 2 | `GET /lex/anchors/:id` returns anchor + transcript refs (dormant row 20c512ce) | curl | PASS |
| 3 | spawn-or-bind binds when current_pty_id is live | `POST /lex/anchors/4bbafb48-.../open` | PASS (mode=bind, pty_id matches anchor row) |
| 4 | spawn-or-bind 404 on missing anchor | `POST /lex/anchors/does-not-exist/end` | PASS (404 + `{ok:false,error:"anchor not found"}`) |
| 5 | `POST /lex/anchors/:id/end` is idempotent on dormant | curl on 20c512ce | PASS (200 ok, status stays dormant) |
| 6 | `GET /lex/anchor-tiles` (Stream Deck feed) returns live anchor with current_pty_id + transcript_path | curl | PASS (1 tile, phase=thinking) |
| 7 | `/lex` page renders past-anchor list with end/open buttons | Playwright MCP, accessibility snapshot | PASS (50 listitems, "DevNeural Testing" shows `live` + `end`, 49 dormant show `open`) |
| 8 | Page console clean (no JS errors) | Playwright MCP | PASS (only `favicon.ico 404`, cosmetic) |
| 9 | spawn-or-bind spawn branch (live spawn of CC PTY for dormant anchor) | n/a | SKIP, would spawn a real Claude Code child; needs human consent before disturbing process tree |
| 10 | End on live anchor (`DevNeural Testing` / `4bbafb48`) | n/a | SKIP, would terminate the operator's active session |
| 11 | Stream Deck "Brainstorms" group renders the tile feed | n/a | SKIP, hardware blocker |

## TODOs left for the operator

- Verify Stream Deck `Brainstorms` group physically renders the live
  anchor + tile colours match the phase=thinking response above.
  Reference: `GET /lex/anchor-tiles` payload mirrors what the deck
  reads.
- Click `end` on a real live session at least once when there is one
  you are willing to terminate, to confirm the dashboard button
  fires `POST /lex/anchors/:id/end` and the row flips to dormant in
  the same render.
- Drive the spawn branch end-to-end: click `open` on a dormant
  anchor and confirm a CC PTY spawns with the correct
  `--session-id` and reopen prompt header.

## Reference payload (anchor-tiles, Stream Deck source)

```
{
  "ok": true,
  "tiles": [
    {
      "anchor_id": "4bbafb48-bbfd-47e6-b076-e1a58a334303",
      "title": "DevNeural Testing",
      "derived_title": null,
      "status": "live",
      "current_pty_id": "e6bd7ad1-8b27-44b0-a80a-f6583e7b413b",
      "current_cc_session_id": "2d87f4ca-d6c7-497a-b041-4147fe7b0678",
      "transcript_path": "C:/Users/michael/.claude/projects/C--dev-data-skill-connections-brainstorm/2d87f4ca-d6c7-497a-b041-4147fe7b0678.jsonl",
      "phase": "thinking",
      "pending_prompt": null,
      "last_activity_ms": 1778905197221,
      "transcript_count": 50
    }
  ]
}
```

## Verdict

GO. Wiring + UI surface for the rewrite are intact at 5af07d0 + 131
commits. Two route branches and the physical deck render still need
operator-driven confirmation, listed under TODOs above.
