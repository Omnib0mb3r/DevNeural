# How the voice works

Updated 2026-07-17. This section explains what happens between your
microphone and Lex's answer, and what the system guarantees.

## One mouth, always

The voice top layer owns text-to-speech completely. Every spoken line,
from any source (a live reply, a status pulse, a replay after a
reconnect), funnels through one speak queue. That queue serializes
segments of the same turn, cancels cleanly when you barge in, and
guarantees a given reply is synthesized at most once even when several
dashboard tabs or watchers are open. You should never hear Lex
double-talk; if you do, that is a bug worth reporting, not a setting.

## The three layers

The stack is three layers: TOP, the quick voice you talk to, hands
off to MID, Lex the thinker, which in turn drives BOTTOM, the
workers that do the actual code work.

- **Quick layer (top layer).** A fast conversational model that hears
  every utterance first. Small talk, status questions, and device
  controls ("be quiet", "hold on") are answered or executed on the
  spot, usually in a second or two. It also decides what needs the
  deep brain.
- **Deep brain.** The full Lex session where real work happens. The
  quick layer forwards substance there; while the deep brain is
  mid-turn you can keep talking to the quick layer, and new
  instructions join the work queue.

If the quick layer ever fails, times out, or is unsure, your words
forward to the deep brain untouched. The top layer failing never eats
what you said.

## Replays after a disconnect

If the voice connection drops mid-reply (stream cut, tab switch,
jumping to another brainstorm and back), the freshest reply is spoken
once when you reconnect, so you catch what you missed. Guarantees:

- Only replies from the last ~10 seconds replay; stale ones never do.
- A reply you already heard in full does not replay.
- A reply replays **once**. Reconnect churn (for example while the
  daemon restarts) can no longer repeat the same line over and over.

## While Lex is working

A heartbeat pulse speaks periodically during long work so you know
she is still on it. The pulse comes from the brain (a real status
line), never a canned phrase; a missed pulse is silence plus a loud
log line, not fake reassurance.

## Delivery verification

Spoken instructions injected into a work session are verified by
fingerprint: the daemon confirms your words actually landed in the
session. Failures retry automatically and log loudly
(`INJECT DELIVERY FAILED`) instead of silently dropping your request.

## The one fixed phrase

**"lex emergency stop"**: immediate panic kill with no AI in the
loop. It works mid-sentence. Everything else is natural speech.
