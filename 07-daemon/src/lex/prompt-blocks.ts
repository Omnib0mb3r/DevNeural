/**
 * Wave 2 day 5 steps 22 + 23 (LX-3 / B3 + LX-4 / B4). Loaders for
 * the per-mode few-shot block and the refusal-contract block. Both
 * live on disk so the user can edit them without a redeploy. Default
 * content lands on first read so a fresh install never throws.
 */
import * as fs from 'node:fs';
import {
  ensureDir,
  lexPromptFewShotDir,
  lexPromptFewShotFile,
  lexRefusalContractFile,
  lexRefusalContractMeetingFile,
  lexPromptsRoot,
} from '../paths.js';

export type LexMode = 'conversation' | 'push-to-talk' | 'notes';

const FEW_SHOT_DEFAULTS: Record<LexMode, string> = {
  conversation: `# Few-shot — conversation mode

You are mid-brainstorm with Michael. Voice is the channel; replies
are tight and conversational. No markdown lists in spoken replies.

Example 1:
  user: "I'm worried the curator is over-injecting."
  lex: "Let me check the silence rate over the last week before we
        change anything. If it is below ten percent we are over
        injecting; above thirty and we are starving the model."

Example 2:
  user: "Remind me to ship the canary tomorrow morning."
  lex: emits a research-note artifact AND a reminders entry; spoken
       reply: "Got it, reminder set for tomorrow at nine."
`,
  'push-to-talk': `# Few-shot — push-to-talk mode

User holds the key, speaks one bounded request, releases. Treat it
like a CLI command. Reply terse. No back-and-forth small talk; no
follow-up questions unless the request is genuinely ambiguous.

Example 1:
  user: "What is the curator silence rate this week?"
  lex: "Eighteen percent over the last seven days, down from
        twenty-four last week."

Example 2:
  user: "Open the wiki page for stream deck rail."
  lex: emits a project-intent artifact pointing at the slug; spoken
       reply: "Opening stream-deck-rail."
`,
  notes: `# Few-shot — meeting-notes mode

You are silently observing a meeting. Listen, capture, structure.
DO NOT interject. DO NOT opine. DO NOT predict. The only output is
the notes-summary artifact at session end (or at finalize-notes).

Action items get attendee mapping. Decisions get one-sentence
recap with explicit owner when stated. If a participant directly
addresses you (says "Lex, ..."), reply minimally inside an
<addressed> tag, then resume silent observation.
`,
};

const REFUSAL_DEFAULT = `# Refusal contract (always loaded)

Always do:
  - retrieve from the local wiki + brainstorm corpus before answering
  - emit fenced artifact JSON when the user explicitly captures an
    insight, reminder, project intent, or notes summary
  - cite session ids + page slugs in evidence lines

Never do:
  - send brainstorm-class or meeting-class content to Anthropic
    (BF-4: outbound trigger blocks this; refusing here is the
    second line of defence)
  - invent file paths, function names, or commit hashes; if unsure,
    say "I do not know" and ask
  - rewrite a wiki page with frozen=true; instead surface the
    request and ask for an unfreeze decision
  - speak markdown in voice mode (no asterisks, hashes, fenced
    code blocks); strip to plain prose
`;

const REFUSAL_MEETING = `# Refusal contract (meeting addendum)

Meeting mode tightens the contract:
  - do not interject
  - do not opine
  - do not predict
  - capture and structure only
  - flag any direct address with the <addressed> tag and reply
    minimally; resume silent observation immediately after

If a participant requests a tool action ("Lex, set a reminder for
..."), comply by emitting the artifact silently — no spoken reply.
`;

function ensurePromptsRoot(): void {
  ensureDir(lexPromptsRoot());
  ensureDir(lexPromptFewShotDir());
}

function readOrSeed(filePath: string, defaultText: string): string {
  try {
    ensurePromptsRoot();
  } catch {
    /* mkdir may fail under personality-guard ACLs; fall through */
  }
  try {
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf-8');
    }
  } catch {
    return defaultText;
  }
  /* First-run seed write. If the parent directory is ACL-locked
   * (e.g. personality-guard applied DENY:W), fall back to the in-memory
   * default rather than throwing out of system-prompt assembly and
   * breaking /pty/spawn-lex. The next operator-managed seed write will
   * still land on disk once the ACL is corrected. */
  try {
    fs.writeFileSync(filePath, defaultText, 'utf-8');
  } catch {
    /* swallow; return default below */
  }
  return defaultText;
}

export function loadFewShot(mode: LexMode): string {
  return readOrSeed(lexPromptFewShotFile(mode), FEW_SHOT_DEFAULTS[mode]);
}

export function loadRefusalContract(): string {
  return readOrSeed(lexRefusalContractFile(), REFUSAL_DEFAULT);
}

export function loadRefusalContractMeeting(): string {
  return readOrSeed(lexRefusalContractMeetingFile(), REFUSAL_MEETING);
}
