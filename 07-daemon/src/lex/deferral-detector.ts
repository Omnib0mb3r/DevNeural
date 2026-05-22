/**
 * Deferral detection on every brainstorm turn (plan section M).
 *
 * Brainstorm-as-durable-primary-entity (2026-05-22). When the user
 * or Lex defers a concrete task in conversation ("later", "phase 2",
 * "future", "down the road", "when we get to it", etc.), we don't
 * want to rely on the user to manually create a reminder. The
 * brainstorm-as-god model says Lex captures these automatically.
 *
 * Pipeline:
 *   1. Cheap regex pass over the assistant turn text. The regex is a
 *      tight OR of common deferral phrasings; on miss we skip
 *      entirely so the LLM is not called for every turn.
 *   2. On regex hit, fire a small LLM gate. Two-sentence prompt asks
 *      "did the user defer a concrete task? Return strict JSON
 *      {defer: bool, task: string, suggested_when: string|null}".
 *      Gate runs through callVoiceChat so it stays local-only
 *      (BF-4).
 *   3. On `defer: true`, call createReminder + appendArtifact so
 *      the deferral shows up in BrainstormDetail (via the reminders
 *      bucket) AND in the global reminders list.
 *
 * The detector is fire-and-forget: failures log and never block the
 * voice turn flow.
 */
import { createReminder } from '../dashboard/reminders.js';
import { appendArtifact } from './brainstorm-store.js';
import { callVoiceChat } from '../llm/voice-chat.js';

const DEFERRAL_REGEX =
  /\b(later|phase\s*2|defer|push (?:this )?off|future(?:\s+date)?|nice to have|when we get to|down the road|some\s?day|next sprint|after (?:we|i) ship|put a pin in)\b/i;

const GATE_SYSTEM_PROMPT = `You decide if a concrete task was deferred in a short conversation turn. Return STRICT JSON only:
{
  "defer": boolean,
  "task": "the concrete deferred task, one short sentence; empty when defer=false",
  "suggested_when": "natural-language time (e.g. 'next week', 'phase 2', 'after migration ships'); null when no signal"
}
Only return defer=true when the speaker concretely deferred a specific actionable task. A general musing about "phase 2" with no task attached returns defer=false.`;

interface GateResult {
  defer: boolean;
  task: string;
  suggested_when: string | null;
}

async function gate(turnText: string): Promise<GateResult | null> {
  let reply;
  try {
    reply = await callVoiceChat(
      [
        { role: 'system', content: GATE_SYSTEM_PROMPT },
        { role: 'user', content: turnText.slice(0, 4_000) },
      ],
      { maxTokens: 180, temperature: 0.0 },
    );
  } catch {
    return null;
  }
  const match = reply.text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as Partial<GateResult>;
    return {
      defer: Boolean(parsed.defer),
      task: (parsed.task ?? '').trim(),
      suggested_when:
        typeof parsed.suggested_when === 'string' && parsed.suggested_when.trim()
          ? parsed.suggested_when.trim()
          : null,
    };
  } catch {
    return null;
  }
}

export interface DetectDeferralInput {
  brainstormId: string;
  /** Text of the turn to scan. Caller passes the post-strip assistant
   * text (or user turn — both can defer). */
  turnText: string;
  /** Tag for the reminder so the operator can filter to deferrals. */
  source: 'lex-assistant' | 'user';
}

export async function detectDeferral(
  input: DetectDeferralInput,
): Promise<{ created: boolean; reason?: string }> {
  const text = input.turnText.trim();
  if (!text || text.length < 20) return { created: false, reason: 'too-short' };
  if (!DEFERRAL_REGEX.test(text)) return { created: false, reason: 'no-regex' };
  const result = await gate(text);
  if (!result) return { created: false, reason: 'gate-failed' };
  if (!result.defer || !result.task) {
    return { created: false, reason: 'gate-no-defer' };
  }
  /* Translate "suggested_when" into a due_at when it looks like a
   * concrete date; otherwise leave undefined and let the reminder
   * surface without a deadline. The LLM tends to return phrasings
   * ("next week") rather than ISO; trying to parse those reliably
   * is out of scope for this commit. */
  const due = parseIsoDate(result.suggested_when);
  try {
    const reminder = createReminder({
      title: result.task,
      due_at: due ?? undefined,
      tags: ['deferral', `brainstorm:${input.brainstormId}`, input.source],
    });
    appendArtifact(input.brainstormId, 'reminders', {
      id: reminder.id,
      title: result.task,
    });
    return { created: true };
  } catch (err) {
    return {
      created: false,
      reason: `reminder-write-failed: ${(err as Error).message}`,
    };
  }
}

function parseIsoDate(value: string | null): string | null {
  if (!value) return null;
  const t = Date.parse(value);
  if (Number.isFinite(t) && t > Date.now()) {
    return new Date(t).toISOString();
  }
  return null;
}
