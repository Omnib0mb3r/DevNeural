/**
 * Parallel-capture audio tap. Replaces the deprecated
 * ScriptProcessorNode in 08-dashboard/components/VoiceClient.tsx's
 * initParallelCapture path. Runs in the AudioWorklet thread, posts
 * one Float32 mono frame per process() tick to the main thread via
 * port.postMessage. Gain + Int16 conversion stays on the main
 * thread to keep this module byte-for-byte equivalent to what the
 * onaudioprocess callback used to do.
 *
 * process() returns true so the worklet stays alive for the
 * lifetime of the node. Outputs are not written (the source graph
 * is connected for energy only, not playback).
 */
class VadTapProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const channel = input[0];
    if (!channel || channel.length === 0) return true;
    /* Slice into a fresh Float32Array so the transfer-list copy
     * matches the original ScriptProcessor frame shape; the
     * underlying buffer cannot be reused after postMessage. */
    const frame = new Float32Array(channel.length);
    frame.set(channel);
    this.port.postMessage(frame, [frame.buffer]);
    return true;
  }
}

registerProcessor("vad-tap", VadTapProcessor);
