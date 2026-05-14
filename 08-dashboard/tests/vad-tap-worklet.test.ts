/**
 * Pins the VAD parallel-capture tap on AudioWorkletNode, not the
 * deprecated ScriptProcessorNode. Web Audio's worklet runs in a
 * dedicated thread that jsdom does not provide, so we cannot mount
 * the worklet processor itself; instead we read the VoiceClient
 * source + the static worklet asset and assert the migration is in
 * place.
 *
 * Bug doc: docs/bugs/2026-05-14-vad-scriptprocessornode-deprecation
 * .md. Chromium has emitted the deprecation warning for several
 * years and has signalled eventual removal. If a future edit
 * regresses initParallelCapture to ctx.createScriptProcessor, this
 * test fails before that lands on master.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const VOICE_CLIENT = path.resolve(
  __dirname,
  "..",
  "components",
  "VoiceClient.tsx",
);
const WORKLET_FILE = path.resolve(
  __dirname,
  "..",
  "public",
  "vad-tap.worklet.js",
);

function readFile(p: string): string {
  return fs.readFileSync(p, "utf-8");
}

/** Locate the body of `async function initParallelCapture` so the
 * assertions check ONLY that scope. The push-to-talk path lower in
 * the file is intentionally NOT migrated (separate rig, user said
 * keep scope minimal) and would otherwise false-trip the script-
 * processor regression check. */
function initParallelCaptureBody(src: string): string {
  const marker = "async function initParallelCapture";
  const start = src.indexOf(marker);
  if (start < 0) throw new Error("initParallelCapture not found");
  /* Walk braces to find the matching close. */
  const openIdx = src.indexOf("{", start);
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error("unterminated initParallelCapture body");
}

describe("VAD parallel-capture worklet migration", () => {
  it("ships the worklet processor module as a static asset at /vad-tap.worklet.js", () => {
    expect(fs.existsSync(WORKLET_FILE)).toBe(true);
    const src = readFile(WORKLET_FILE);
    expect(src).toContain('registerProcessor("vad-tap"');
    expect(src).toContain("process(inputs)");
    expect(src).toContain("port.postMessage");
  });

  it("initParallelCapture uses AudioWorkletNode and NOT createScriptProcessor", () => {
    const body = initParallelCaptureBody(readFile(VOICE_CLIENT));
    expect(body).toContain("audioWorklet.addModule");
    expect(body).toContain('new AudioWorkletNode(ctx, "vad-tap")');
    expect(body).not.toContain("createScriptProcessor");
  });
});
