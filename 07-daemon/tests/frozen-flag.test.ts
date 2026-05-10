import { describe, expect, it } from 'vitest';
import { parsePage, type PageFrontmatter } from '../src/wiki/schema.js';

const SAMPLE_BASE = `---
id: connection-pooling
title: Connection pooling
trigger: When opening a DB connection per request
insight: Pool the connections instead, reuse across requests
summary: |
  Open a fixed pool of connections at boot and check them out
  per request. Avoids handshake overhead.
status: canonical
weight: 0.8
hits: 5
corrections: 0
created: 2026-01-01
last_touched: 2026-04-30
projects: ['proj-a']
human_edited: false
schema_version: 2
last_verified: null
frozen: __FROZEN__
source_brainstorms: ['bs-1', 'bs-2']
source_meetings: []
derived_from_brainstorm: true
derived_from_meeting: false
---

# Connection pooling

## Pattern
Open a fixed-size pool at boot. Check out per request.

## Cross-references

## Evidence

## Open questions

## Log
`;

function pageFrozen(frozen: boolean): string {
  return SAMPLE_BASE.replace('__FROZEN__', frozen ? 'true' : 'false');
}

describe('PageFrontmatter Phase Two fields (WI-1, WI-2, WI-3, WI-4)', () => {
  it('parses schema_version, last_verified, frozen, source_brainstorms', () => {
    const parsed = parsePage(pageFrozen(true));
    const fm: PageFrontmatter = parsed.frontmatter;
    expect(fm.schema_version).toBe(2);
    expect(fm.last_verified).toBeNull();
    expect(fm.frozen).toBe(true);
    expect(fm.source_brainstorms).toEqual(['bs-1', 'bs-2']);
    expect(fm.source_meetings).toEqual([]);
    expect(fm.derived_from_brainstorm).toBe(true);
    expect(fm.derived_from_meeting).toBeUndefined();
  });

  it('parses frozen=false correctly', () => {
    const parsed = parsePage(pageFrozen(false));
    expect(parsed.frontmatter.frozen).toBe(false);
  });

  it('handles legacy pages with no Phase Two fields', () => {
    const legacy = `---
id: x
title: x
trigger: t
insight: i
summary: |
  s
status: pending
weight: 0.3
hits: 0
corrections: 0
created: 2026-01-01
last_touched: 2026-01-01
projects: []
human_edited: false
---

# x
`;
    const parsed = parsePage(legacy);
    expect(parsed.frontmatter.frozen).toBeUndefined();
    expect(parsed.frontmatter.schema_version).toBeUndefined();
    expect(parsed.frontmatter.source_brainstorms).toBeUndefined();
  });
});
