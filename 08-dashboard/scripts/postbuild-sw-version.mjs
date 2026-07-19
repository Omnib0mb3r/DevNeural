/**
 * Post-build: stamp a unique SW_VERSION into out/sw.js.
 *
 * Next.js copies public/sw.js to out/sw.js verbatim, including the
 * literal "__BUILD_VERSION__" sentinel. Without rewriting it, every
 * build produces an identical sw.js byte stream and the browser never
 * fetches the new SW. Browsers only refetch sw.js when its bytes change.
 *
 * This script replaces the sentinel with an ISO timestamp on every
 * build. Combined with skipWaiting() + clients.claim() in the SW, the
 * next page load activates the new SW immediately and the user sees
 * the new bundle without manual DevTools acrobatics.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const swPath = join(here, '..', 'out', 'sw.js');

if (!existsSync(swPath)) {
  console.warn(`[postbuild-sw-version] ${swPath} missing, skipping (build did not produce static export)`);
  process.exit(0);
}

const stamp = new Date().toISOString();

// Deploy-version marker the running client polls (BuildAutoUpdate) to
// detect a new build and reload itself. Written unconditionally when a
// static export exists, even if the SW sentinel was already replaced by
// an earlier run, so the marker never goes stale relative to the bundle.
const versionPath = join(here, '..', 'out', 'version.json');
writeFileSync(versionPath, JSON.stringify({ v: stamp }) + '\n', 'utf-8');
console.log(`[postbuild-sw-version] wrote version.json ${stamp}`);

const before = readFileSync(swPath, 'utf-8');
if (!before.includes('__BUILD_VERSION__')) {
  console.warn(`[postbuild-sw-version] sentinel not found in ${swPath}; skipping (already stamped or sentinel removed)`);
  process.exit(0);
}
const after = before.replace('__BUILD_VERSION__', stamp);
writeFileSync(swPath, after, 'utf-8');
console.log(`[postbuild-sw-version] stamped sw.js with ${stamp}`);
