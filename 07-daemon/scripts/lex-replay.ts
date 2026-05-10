/**
 * CLI bootstrap: `npm run lex-replay -- --input <fixture> --version-a <vA> --version-b <vB>`.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let inputPath = '';
  let versionA = '';
  let versionB = '';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = args[i + 1] ?? '';
    if (a === '--input') {
      inputPath = next;
      i++;
    } else if (a === '--version-a') {
      versionA = next;
      i++;
    } else if (a === '--version-b') {
      versionB = next;
      i++;
    }
  }
  if (!inputPath || !versionA || !versionB) {
    console.error('usage: lex-replay --input <fixture.jsonl> --version-a <vA> --version-b <vB>');
    process.exit(2);
  }
  const { runLexReplay } = await import('../src/lex/replay.js');
  const r = await runLexReplay({
    inputPath,
    versionA,
    versionB,
    log: (m) => console.log(m),
  });
  console.log(JSON.stringify(r, null, 2));
}

main().catch((err) => {
  console.error('[lex-replay] fatal:', err);
  process.exit(1);
});
