import { describe, expect, it } from "vitest";
import { pcmToWavBytes } from "@/lib/voice-engine/pcm-wav";

/**
 * Spec: TTS plays through an HTMLAudioElement (media element) so the
 * browser echo canceller references it. Media elements cannot eat raw
 * PCM; each segment is wrapped in a canonical 16-bit mono WAV.
 */
describe("pcmToWavBytes: canonical 16-bit mono WAV wrapper", () => {
  const pcm = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);

  it("produces RIFF/WAVE/fmt/data structure with correct sizes", () => {
    const wav = pcmToWavBytes([pcm], 22_050);
    const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    const ascii = (off: number, len: number) =>
      String.fromCharCode(...wav.slice(off, off + len));
    expect(ascii(0, 4)).toBe("RIFF");
    expect(ascii(8, 4)).toBe("WAVE");
    expect(ascii(12, 4)).toBe("fmt ");
    expect(ascii(36, 4)).toBe("data");
    expect(wav.byteLength).toBe(44 + pcm.byteLength);
    expect(dv.getUint32(4, true)).toBe(36 + pcm.byteLength);
    expect(dv.getUint32(40, true)).toBe(pcm.byteLength);
  });

  it("encodes mono 16-bit at the given sample rate", () => {
    const wav = pcmToWavBytes([pcm], 22_050);
    const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    expect(dv.getUint16(22, true)).toBe(1); // channels
    expect(dv.getUint32(24, true)).toBe(22_050); // sample rate
    expect(dv.getUint32(28, true)).toBe(22_050 * 2); // byte rate
    expect(dv.getUint16(34, true)).toBe(16); // bits per sample
  });

  it("concatenates multiple chunks in order", () => {
    const a = new Uint8Array([1, 2]);
    const b = new Uint8Array([3, 4, 5, 6]);
    const wav = pcmToWavBytes([a, b], 16_000);
    expect(Array.from(wav.slice(44))).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
