/**
 * Browser fakes for mounting the real VoiceClient under jsdom.
 *
 * VoiceClient owns a WebSocket, a getUserMedia stream, an AudioContext
 * with a worklet, and a silero VAD instance. None of those exist in
 * jsdom, so the tests that need the engine running (BUG-053 mode
 * switch, BUG-054 typed text over the socket) install these fakes on
 * the globals and drive the socket by hand: `ws.open()` fires onopen,
 * `ws.receive(frame)` feeds a JSON frame into onmessage, and
 * `ws.framesOf("hello")` reads back what the client sent.
 *
 * No vi.mock calls live here: module mocks must sit in the test file
 * itself so vitest can hoist them above the imports.
 */
import { vi } from "vitest";
import type { PtyEntry } from "@/lib/daemon-client";

export class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  static reset(): void {
    FakeWebSocket.instances = [];
  }

  url: string;
  readyState = FakeWebSocket.CONNECTING;
  binaryType = "blob";
  sent: unknown[] = [];
  closeCalls = 0;
  onopen: ((ev: Event) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: unknown): void {
    this.sent.push(data);
  }

  /* Browsers fire onclose asynchronously after close(); mirror that so
   * the client's own teardown path (which sets cancelled first) sees
   * the same ordering it does in production. */
  close(): void {
    this.closeCalls += 1;
    this.readyState = FakeWebSocket.CLOSED;
    setTimeout(() => {
      this.onclose?.({ code: 1000, reason: "" } as CloseEvent);
    }, 0);
  }

  /* Test drivers. */
  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  receive(frame: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(frame) } as MessageEvent);
  }

  jsonFrames(): Array<Record<string, unknown>> {
    return this.sent
      .filter((s): s is string => typeof s === "string")
      .map((s) => JSON.parse(s) as Record<string, unknown>);
  }

  framesOf(t: string): Array<Record<string, unknown>> {
    return this.jsonFrames().filter((f) => f.t === t);
  }
}

export interface FakeTrack {
  kind: "audio";
  enabled: boolean;
  stop: () => void;
}

export interface FakeStream {
  tracks: FakeTrack[];
  getAudioTracks(): FakeTrack[];
  getTracks(): FakeTrack[];
}

export function makeFakeStream(): FakeStream {
  const tracks: FakeTrack[] = [{ kind: "audio", enabled: true, stop: vi.fn() }];
  return {
    tracks,
    getAudioTracks: () => tracks,
    getTracks: () => tracks,
  };
}

export interface FakeMediaDevices {
  getUserMedia: ReturnType<typeof vi.fn>;
  /** Every stream getUserMedia handed out, in order. */
  streams: FakeStream[];
}

/* Installs navigator.mediaDevices with a getUserMedia that returns a
 * fresh fake stream per call and records each one. */
export function installFakeMediaDevices(): FakeMediaDevices {
  const streams: FakeStream[] = [];
  const getUserMedia = vi.fn(async () => {
    const s = makeFakeStream();
    streams.push(s);
    return s;
  });
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      enumerateDevices: vi.fn(async () => []),
    },
  });
  return { getUserMedia, streams };
}

export function removeFakeMediaDevices(): void {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: undefined,
  });
}

/* Minimal AudioContext: enough surface for initParallelCapture (gain
 * node, worklet, stream destination) and initPushToTalk (script
 * processor). Nothing here produces audio. */
export class FakeAudioContext {
  state: "running" | "closed" = "running";
  sampleRate = 16000;
  destination = {};
  audioWorklet = { addModule: vi.fn(async () => undefined) };
  createMediaStreamSource() {
    return { connect: vi.fn(), disconnect: vi.fn() };
  }
  createGain() {
    return { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
  }
  createMediaStreamDestination() {
    return { stream: makeFakeStream() };
  }
  createScriptProcessor() {
    return {
      connect: vi.fn(),
      disconnect: vi.fn(),
      onaudioprocess: null as null | ((e: unknown) => void),
    };
  }
  createBuffer() {
    return {};
  }
  createBufferSource() {
    return { buffer: null, connect: vi.fn(), start: vi.fn() };
  }
  async close(): Promise<void> {
    this.state = "closed";
  }
  async resume(): Promise<void> {
    /* no-op */
  }
}

export class FakeAudioWorkletNode {
  port = { onmessage: null as null | ((ev: unknown) => void) };
  connect = vi.fn();
  disconnect = vi.fn();
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_ctx: unknown, _name: string) {
    /* the client only wires port.onmessage and connect */
  }
}

export interface FakeVad {
  start: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  setOptions: ReturnType<typeof vi.fn>;
}

export function makeFakeVad(): FakeVad {
  return {
    start: vi.fn(),
    pause: vi.fn(),
    destroy: vi.fn(),
    setOptions: vi.fn(),
  };
}

/* A live Lex brainstorm PTY. The cwd must end in /brainstorm for the
 * client's lexPty resolution to pick it up (hasLex), otherwise the
 * auto-stop effect turns voice off 2.5s after mount. */
export const BRAINSTORM_PTY: PtyEntry = {
  ptyId: "pty-lex-1",
  sessionId: "sess-lex-1",
  cwd: "C:\\dev\\data\\brainstorm",
  command: "claude",
  startedAt: 1_000,
  lastActivity: 1_000,
  exited: false,
} as PtyEntry;

/* sessionStorage key VoiceClient reads at mount to restore `enabled`
 * (lib/voice-active-anchor.ts). Seeding it starts the engine without
 * clicking "start voice", which keeps the gesture-only AudioContext
 * warm path out of these tests. */
export const VOICE_ENABLED_STORAGE_KEY = "devneural.voice.enabled";

export function installVoiceGlobals(): void {
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("AudioWorkletNode", FakeAudioWorkletNode);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: false, json: async () => ({}) })),
  );
}

/* The /lex page renders this div; VoiceClient portals its full panel
 * (mode buttons, mute, stop) into it when present at mount. */
export const PANEL_MOUNT_ID = "voice-panel-mount";

export function installPanelMount(): HTMLElement {
  const el = document.createElement("div");
  el.id = PANEL_MOUNT_ID;
  document.body.appendChild(el);
  return el;
}
