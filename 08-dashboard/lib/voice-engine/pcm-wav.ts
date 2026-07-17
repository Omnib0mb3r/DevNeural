/**
 * PCM-to-WAV wrapper for the media-element playback path
 * (VOICE-TOP-LAYER-SPEC.md, "Echo, first line"): piper streams raw
 * 16-bit mono PCM; an HTMLAudioElement needs a container, so each TTS
 * segment is wrapped in a canonical 44-byte-header WAV before it
 * becomes a blob URL. Pure function, no DOM.
 */

export function pcmToWavBytes(
  chunks: readonly Uint8Array[],
  sampleRate: number,
): Uint8Array {
  const dataLen = chunks.reduce((sum, c) => sum + c.byteLength, 0);
  const out = new Uint8Array(44 + dataLen);
  const dv = new DataView(out.buffer);
  const ascii = (off: number, s: string): void => {
    for (let i = 0; i < s.length; i++) out[off + i] = s.charCodeAt(i);
  };
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;

  ascii(0, "RIFF");
  dv.setUint32(4, 36 + dataLen, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  dv.setUint32(16, 16, true); // fmt chunk size
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, numChannels, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, byteRate, true);
  dv.setUint16(32, blockAlign, true);
  dv.setUint16(34, bitsPerSample, true);
  ascii(36, "data");
  dv.setUint32(40, dataLen, true);

  let off = 44;
  for (const c of chunks) {
    out.set(c, off);
    off += c.byteLength;
  }
  return out;
}
