/**
 * One-shot Smart Turn v3 model fetch.
 *
 *   npx tsx scripts/fetch-smart-turn.ts
 *
 * Idempotent: exits 0 immediately when the model already exists at
 * <DEVNEURAL_DATA_ROOT>/models/smart-turn/. The daemon also lazy
 * downloads on first analyzeTurn call, so running this is optional;
 * it just front-loads the ~8.3MB fetch so the first voice utterance
 * is not answered with 'unavailable'.
 */
import {
  ensureSmartTurnModel,
  smartTurnModelExists,
  smartTurnModelPath,
} from '../src/voice/smart-turn.js';

async function main(): Promise<void> {
  if (smartTurnModelExists()) {
    console.log(`smart-turn model already present: ${smartTurnModelPath()}`);
    return;
  }
  const result = await ensureSmartTurnModel({
    log: (msg) => console.log(msg),
  });
  if (!result) {
    console.error(
      'smart-turn model fetch failed (network down, blocked env, or HF unreachable); ' +
        'the daemon will report smart turn as unavailable until this succeeds',
    );
    process.exitCode = 1;
    return;
  }
  console.log(`smart-turn model ready: ${result}`);
}

void main();
