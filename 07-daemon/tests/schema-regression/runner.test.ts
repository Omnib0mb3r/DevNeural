/**
 * Schema regression suite (CI-8).
 *
 * Loads pinned Pass 2 outputs from ./fixtures and asserts each one
 * passes the validatePass2 contract. Catches drift in:
 *
 *   - validatePass2 itself (a tightening that breaks historical
 *     outputs surfaces here first)
 *   - Pass 2 schema additions that older fixtures need to be
 *     updated for
 *
 * Adding a fixture: write `fixtures/<seq>-<short-name>.json`. The
 * file is the raw Pass 2 response object. To capture drift from the
 * live model in CI, a separate live-replay job (Wave 2) runs each
 * fixture's input back through the model and writes the new output
 * for diffing; this static suite is the contract floor.
 *
 * Spec target: 50 fixtures across the schema's known shapes
 * (single page_update, multi-page_update, new_pending_page, mixed,
 * edge cases for cross_refs_add/remove, evidence_add, log_add,
 * pattern_rewrite, summary_rewrite, flag_for_review). Wave 1 ships
 * the runner plus three seed fixtures; the rest accumulate as new
 * Pass 2 patterns are observed in production.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePass2 } from '../../src/llm/validator.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(HERE, 'fixtures');

function loadFixtures(): Array<{ name: string; payload: unknown }> {
  if (!fs.existsSync(FIXTURES_DIR)) return [];
  return fs
    .readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => ({
      name: f,
      payload: JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, f), 'utf8')),
    }));
}

const fixtures = loadFixtures();

describe('schema regression suite (CI-8)', () => {
  it('has at least one fixture', () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const fx of fixtures) {
    it(`fixture ${fx.name} passes validatePass2`, () => {
      const result = validatePass2(fx.payload);
      if (!result.ok) {
        throw new Error(
          `validation failed for ${fx.name}: ${result.errors.join('; ')}`,
        );
      }
      expect(result.ok).toBe(true);
    });
  }
});
