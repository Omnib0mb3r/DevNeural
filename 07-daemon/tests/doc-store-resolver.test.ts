/**
 * Knowledge-index store-set auto-resolver (HANDOVER "Next up" item).
 * Maps a project cwd to its markdown store roots so /lex/index-docs,
 * /lex/watch-docs, and the /knowledge orb work without the caller
 * hand-passing absolute dirs. Existence-gated: only dirs that exist
 * become stores.
 */
import { describe, expect, it } from 'vitest';
import { resolveProjectDocStores } from '../src/lex/doc-store-resolver.js';

function isDirStub(existing: string[]): (p: string) => boolean {
  const set = new Set(existing.map((p) => p.replace(/\\/g, '/')));
  return (p: string) => set.has(p.replace(/\\/g, '/'));
}

const CWD = 'C:/dev/Projects/DevNeural';
const HOME = 'C:/Users/michael';
const MEMORY_DIR =
  'C:/Users/michael/.claude/projects/C--dev-Projects-DevNeural/memory';

describe('resolveProjectDocStores', () => {
  it('resolves root, memory, docs, spec, and bugs stores when all exist', () => {
    const stores = resolveProjectDocStores({
      cwd: CWD,
      homeDir: HOME,
      isDir: isDirStub([
        CWD,
        MEMORY_DIR,
        `${CWD}/docs`,
        `${CWD}/docs/spec`,
        `${CWD}/docs/bugs`,
      ]),
    });
    const byStore = Object.fromEntries(stores.map((s) => [s.store, s]));
    expect(byStore['root']?.dir).toBe(CWD);
    expect(byStore['root']?.recursive).toBeUndefined();
    expect(byStore['memory']?.dir).toBe(MEMORY_DIR);
    expect(byStore['docs']?.dir).toBe(`${CWD}/docs`);
    expect(byStore['docs']?.recursive).toBe(true);
    expect(byStore['spec']?.dir).toBe(`${CWD}/docs/spec`);
    expect(byStore['bugs']?.dir).toBe(`${CWD}/docs/bugs`);
  });

  it('orders spec and bugs AFTER docs so their labels win the id upsert', () => {
    const stores = resolveProjectDocStores({
      cwd: CWD,
      homeDir: HOME,
      isDir: isDirStub([CWD, `${CWD}/docs`, `${CWD}/docs/spec`, `${CWD}/docs/bugs`]),
    });
    const order = stores.map((s) => s.store);
    expect(order.indexOf('docs')).toBeLessThan(order.indexOf('spec'));
    expect(order.indexOf('docs')).toBeLessThan(order.indexOf('bugs'));
  });

  it('skips stores whose directories do not exist', () => {
    const stores = resolveProjectDocStores({
      cwd: CWD,
      homeDir: HOME,
      isDir: isDirStub([CWD, `${CWD}/docs`]),
    });
    const labels = stores.map((s) => s.store);
    expect(labels).toContain('root');
    expect(labels).toContain('docs');
    expect(labels).not.toContain('memory');
    expect(labels).not.toContain('spec');
    expect(labels).not.toContain('bugs');
  });

  it('returns empty when even the cwd is missing', () => {
    const stores = resolveProjectDocStores({
      cwd: 'C:/gone/project',
      homeDir: HOME,
      isDir: isDirStub([]),
    });
    expect(stores).toEqual([]);
  });

  it('normalises backslash cwds', () => {
    const stores = resolveProjectDocStores({
      cwd: 'C:\\dev\\Projects\\DevNeural',
      homeDir: HOME,
      isDir: isDirStub([CWD, `${CWD}/docs`]),
    });
    expect(stores.find((s) => s.store === 'docs')?.dir).toBe(`${CWD}/docs`);
  });
});
