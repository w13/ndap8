// The Ear's audio engine: raw capture, ring-buffer listening, burst
// detection and decode, room sounding, and playback — all on the phone,
// using the embedded NDAP-8 codec (./ndap.js).
//
// Rules implemented here (stage-2 requirements):
//   * microphone with echoCancellation / noiseSuppression /
//     autoGainControl all OFF (the exact constraints the probe proved
//     on this phone), raw PCM capture at the context's real rate,
//     resampled to the codec's 48 kHz when needed;
//   * a rolling ~15 s ring buffer while a session is live, so a burst
//     is captured from its beginning;
//   * self-guard: audio captured during our own playback plus a 1 s
//     tail is never treated as incoming; a burst whose text/checksum
//     matches one we just sent is also treated as our own echo;
//   * listen-before-talk: playback waits for a quiet channel;
//   * duplicates delivered once (session ID + payload CRC, checked
//     here and again server-side), with an expiry window so a peer
//     re-sending the same short text later is not swallowed forever;
//   * screen Wake Lock while live, re-acquired by the engine itself
//     when the system releases it.
//
// Hardening (2026-11-26, before the first exchange):
//   * one transmission lock: ping, sounding and speech are serialized
//     through a single playback chain, so two sounds can never start
//     over each other regardless of which caller asks first;
//   * stop() halts a burst that is already playing (it stops the
//     actual buffer source), not just future playback;
//   * listen-before-talk backs off and retries with jitter instead of
//     talking over a busy channel after a fixed deadline; a ping that
//     cannot find a clear channel is skipped, and a message that
//     cannot is reported as an error so it stays queued.
//
// First-exchange fix (2026-11-26, after both phones buzzed without a
// single message crossing):
//   * decode scans are capped to a recent window and duty-cycled:
//     a full 14 s scan takes seconds of solid main-thread CPU on a
//     phone, and at the old rate the decoder crowded out the outbox
//     poll and the listen-before-talk sampling, so speech kept
//     failing its clear-channel check and nothing was ever sent.
//     Scans now cover the most recent seconds (a burst is re-scanned
//     on consecutive attempts while it is in the window) and the gap
//     between attempts grows with how long the last attempt took, so
//     decoding never owns the thread.
//   * when there is no usable room sounding, speech falls back to
//     Mode B (strong Reed–Solomon, the robust profile) instead of
//     Mode A (fast but fragile in a real room). The peer decodes any
//     mode, so this is a purely local transmission choice.

import {
analyze_channel,
crc32,
decode_adaptive_report,
encode_adaptive,
encode_auto,
sounding_burst,
SR,
type ChannelAnalysis,
} from "./ndap.js";

export type EarState = "idle" | "listening" | "playing" | "decoding";

export interface HeardMessage {
  text: string;
  mode: string | null;
  sessionId: number | null;
  payloadCrc: number | null;
}

export interface EarCallbacks {
  onState: (s: EarState) => void;
  onHeard: (m: HeardMessage) => void;
  onFailed: (note: string, mode: string | null) => void;
  onLevel: (rms: number) => void;
  onNote: (note: string) => void;
  /** The peer was heard just now: a decoded message, a real burst
   *  that failed to decode, or the peer's heartbeat sounding found in
   *  the room. Fires repeatedly while the peer is present. */
  onPeerActivity: () => void;
}

const RING_SECONDS = 15;
const GUARD_TAIL_SECONDS = 1;
const DETECT_EVERY_MS = 800;
const MIN_WINDOW_SECONDS = 2.5;
// Scan only the recent seconds: a burst stays inside this window for
// many consecutive attempts, and a shorter window is far cheaper to
// scan — the saving is what leaves the main thread free for polling,
// playback and listen-before-talk.
const MAX_WINDOW_SECONDS = 8;
const SEEN_WINDOW_MS = 10 * 60 * 1000;

function resample(samples: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return samples;
  const ratio = from / to;
  const outLen = Math.floor(samples.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const lo = Math.floor(pos);
    const hi = Math.min(lo + 1, samples.length - 1);
    const frac = pos - lo;
    const a = samples[lo] ?? 0;
    const b = samples[hi] ?? 0;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

export class EarEngine {
  private cb: EarCallbacks;
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private silentGain: GainNode | null = null;

  private ring = new Float32Array(RING_SECONDS * SR);
  private ringWrite = 0; // next write index in ring
  private totalWritten = 0; // absolute capture samples (48 kHz domain)
  private captureRate = SR;

  private state: EarState = "idle";
  private detectTimer: number | null = null;
  private presenceTimer: number | null = null;
  private decoding = false;
  private lastAttemptAt = 0;
  private attemptGapMs = 1200;
  private cooldownUntil = 0;

  private lastFailedKey = "";
  private lastFailedAt = 0;
  private ownPlays: Array<{ start: number; end: number }> = [];
  private recentSent: Array<{ crc: number; at: number }> = [];
  private seen = new Map<string, number>();

  private playChain: Promise<void> = Promise.resolve();
  private currentSource: AudioBufferSourceNode | null = null;

  private wakeLock: WakeLockSentinel | null = null;
  private wakeLockWanted = false;
  private lastLevelAt = 0;

  soundingSamples: Float32Array | null = null;
  lastAnalysis: ChannelAnalysis | null = null;

  constructor(cb: EarCallbacks) {
    this.cb = cb;
  }

  getState(): EarState {
    return this.state;
  }

  private setState(s: EarState) {
    this.state = s;
    this.cb.onState(s);
  }

  async start(): Promise<{ sampleRate: number; trackLabel: string }> {
    if (this.state !== "idle") {
      return { sampleRate: this.ctx?.sampleRate ?? SR, trackLabel: "" };
    }
    // The exact constraints the probe proved on this phone.
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    if (!this.ctx) {
      this.ctx = new AudioContext();
    }
    if (this.ctx.state === "suspended") {
      await this.ctx.resume();
    }
    this.captureRate = this.ctx.sampleRate;
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.processor = this.ctx.createScriptProcessor(4096, 1, 1);
    this.silentGain = this.ctx.createGain();
    this.silentGain.gain.value = 0;
    this.processor.onaudioprocess = (e) => {
      const input = e.inputBuffer.getChannelData(0);
      const at48 = resample(new Float32Array(input), this.captureRate, SR);
      this.pushSamples(at48);
      let sum = 0;
      for (let i = 0; i < input.length; i++) {
        const v = input[i] ?? 0;
        sum += v * v;
      }
      const rms = Math.sqrt(sum / Math.max(1, input.length));
      const now = performance.now();
      if (now - this.lastLevelAt > 200) {
        this.lastLevelAt = now;
        this.cb.onLevel(rms);
      }
    };
    this.source.connect(this.processor);
    this.processor.connect(this.silentGain);
    this.silentGain.connect(this.ctx.destination);

    const track = this.stream.getAudioTracks()[0];
    this.setState("listening");
    this.detectTimer = window.setInterval(() => {
      void this.detectTick();
    }, DETECT_EVERY_MS);
    this.presenceTimer = window.setInterval(() => {
      this.presenceTick();
    }, 4000);
    this.wakeLockWanted = true;
    await this.requestWakeLock();
    return {
      sampleRate: this.captureRate,
      trackLabel: track?.label ?? "",
    };
  }

  async stop(): Promise<void> {
    if (this.detectTimer !== null) {
      window.clearInterval(this.detectTimer);
      this.detectTimer = null;
    }
    if (this.presenceTimer !== null) {
      window.clearInterval(this.presenceTimer);
      this.presenceTimer = null;
    }
    // Halt a burst that is already playing — stopping must be able to
    // silence the speaker, not just prevent future sounds.
    if (this.currentSource) {
      try {
        this.currentSource.stop();
      } catch {
        // already ended
      }
      this.currentSource = null;
    }
    this.wakeLockWanted = false;
    try {
      this.processor?.disconnect();
      this.source?.disconnect();
      this.silentGain?.disconnect();
    } catch {
      // already disconnected
    }
    this.processor = null;
    this.source = null;
    this.silentGain = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    if (this.wakeLock) {
      try {
        await this.wakeLock.release();
      } catch {
        // already released
      }
      this.wakeLock = null;
    }
    this.setState("idle");
  }

  private async requestWakeLock(): Promise<void> {
    try {
      if ("wakeLock" in navigator) {
        const lock = await navigator.wakeLock.request("screen");
        this.wakeLock = lock;
        // The system releases the lock on its own (tab hidden, battery
        // saver, …). If the session is still live and the page is back
        // in view, take it again instead of letting the screen sleep
        // mid-session.
        lock.addEventListener("release", () => {
          if (this.wakeLock === lock) this.wakeLock = null;
          if (
            this.wakeLockWanted &&
            this.state !== "idle" &&
            document.visibilityState === "visible"
          ) {
            void this.requestWakeLock();
          }
        });
      }
    } catch {
      this.wakeLock = null;
    }
  }

  async reacquireWakeLock(): Promise<void> {
    if (this.state !== "idle" && !this.wakeLock) {
      await this.requestWakeLock();
    }
  }

  private pushSamples(samples: Float32Array) {
    for (let i = 0; i < samples.length; i++) {
      this.ring[this.ringWrite] = samples[i] ?? 0;
      this.ringWrite = (this.ringWrite + 1) % this.ring.length;
    }
    this.totalWritten += samples.length;
  }

  /** Chronological snapshot of the last `seconds` of captured audio. */
  private snapshot(seconds: number): { data: Float32Array; startAbs: number } {
    const want = Math.min(
      Math.floor(seconds * SR),
      this.totalWritten,
      this.ring.length,
    );
    const out = new Float32Array(want);
    const startIdx = (this.ringWrite - want + this.ring.length) % this.ring.length;
    for (let i = 0; i < want; i++) {
      out[i] = this.ring[(startIdx + i) % this.ring.length] ?? 0;
    }
    return { data: out, startAbs: this.totalWritten - want };
  }

  /** Snapshot of an absolute capture range [startAbs, endAbs). */
  private snapshotRange(startAbs: number, endAbs: number): Float32Array {
    const earliest = this.totalWritten - Math.min(this.totalWritten, this.ring.length);
    const s = Math.max(startAbs, earliest);
    const e = Math.min(endAbs, this.totalWritten);
    if (e <= s) return new Float32Array(0);
    const out = new Float32Array(e - s);
    const base = this.ringWrite - (this.totalWritten - s);
    for (let i = 0; i < out.length; i++) {
      const idx = ((base + i) % this.ring.length + this.ring.length) % this.ring.length;
      out[i] = this.ring[idx] ?? 0;
    }
    return out;
  }

  private windowOverlapsOwnPlay(startAbs: number, endAbs: number): boolean {
    return this.ownPlays.some((p) => startAbs < p.end && endAbs > p.start + SR * 0.2);
  }

  private async detectTick(): Promise<void> {
    if (this.state !== "listening" || this.decoding) return;
    const now = performance.now();
    if (now < this.cooldownUntil) return;
    if (now - this.lastAttemptAt < this.attemptGapMs) return;
    const filled = Math.min(this.totalWritten / SR, RING_SECONDS);
    if (filled < MIN_WINDOW_SECONDS) return;
    const seconds = Math.min(filled, MAX_WINDOW_SECONDS);
    const { data, startAbs } = this.snapshot(seconds);
    // Cheap energy gate: near-silence is never a burst.
    let peak = 0;
    for (let i = 0; i < data.length; i++) {
      const a = Math.abs(data[i] ?? 0);
      if (a > peak) peak = a;
    }
    if (peak < 0.03) return;

    this.lastAttemptAt = now;
    this.decoding = true;
    this.setState("decoding");
    // Let the UI paint "Decoding" before the heavy scan.
    await new Promise((r) => setTimeout(r, 30));
    try {
      const report = decode_adaptive_report(data);
      const endAbs = startAbs + data.length;
      if (report.ok && report.data) {
        const text = new TextDecoder().decode(report.data);
        const crc = crc32(report.data);
        const key = `${report.session ?? "?"}:${crc}`;
        const selfEcho =
          this.windowOverlapsOwnPlay(startAbs, endAbs) ||
          this.recentSent.some(
            (s) => s.crc === crc && Date.now() - s.at < 90_000,
          );
        // Dedupe with an expiry window (mirrors the server's): the
        // same burst re-scanned from the ring buffer is one message,
        // but the same text arriving again minutes later is a new one.
        const seenAt = this.seen.get(key);
        const isDupe =
          seenAt !== undefined && Date.now() - seenAt < SEEN_WINDOW_MS;
        if (!isDupe) {
          this.seen.set(key, Date.now());
          if (this.seen.size > 200) {
            const cutoff = Date.now() - SEEN_WINDOW_MS;
            for (const [k, t] of this.seen) {
              if (t < cutoff) this.seen.delete(k);
            }
          }
          if (!selfEcho && text.trim().length > 0) {
            this.cb.onPeerActivity();
            this.cb.onHeard({
              text,
              mode: report.mode,
              sessionId: report.session,
              payloadCrc: crc,
            });
          }
        }
        this.cooldownUntil = performance.now() + 1500;
      } else if (report.error && !report.error.includes("mini-header")) {
        // A burst was found but its segments failed: a real failed burst.
        // The same broken burst sits in the window for a while — report
        // it once, not on every scan.
        const failKey = `${report.session ?? "?"}:${report.error}`;
        const isRepeat =
          failKey === this.lastFailedKey && Date.now() - this.lastFailedAt < 30_000;
        if (!isRepeat && !this.windowOverlapsOwnPlay(startAbs, endAbs)) {
          this.lastFailedKey = failKey;
          this.lastFailedAt = Date.now();
          this.cb.onPeerActivity();
          this.cb.onFailed(
            `A burst was heard but could not be read (${report.error}).`,
            report.mode,
          );
        }
        this.cooldownUntil = performance.now() + 2500;
      }
    } catch {
      // No burst in this window — the normal case for room noise.
    } finally {
      // Duty-cycle the decoder: the next attempt waits at least as
      // long as this one took (bounded), so scanning can never
      // consume more than about half the main thread and the page's
      // polling, playback and channel checks stay responsive.
      const tookMs = performance.now() - now;
      this.attemptGapMs = Math.min(6000, Math.max(1200, Math.ceil(tookMs)));
      this.decoding = false;
      if (this.getState() !== "idle") this.setState("listening");
    }
  }

  /**
   * Peer-presence check: look for the other phone's heartbeat in the
   * recent capture. The heartbeat IS a sounding burst, and
   * analyze_channel finds a sounding when one is in the window (and
   * reports a degenerate analysis when none is). A window that
   * overlaps our own playback is skipped — our own sounding is not
   * the peer.
   */
  private presenceTick(): void {
    if (this.state !== "listening" || this.decoding) return;
    const filled = Math.min(this.totalWritten / SR, RING_SECONDS);
    if (filled < 4.5) return;
    const { data, startAbs } = this.snapshot(4.5);
    const endAbs = startAbs + data.length;
    if (this.windowOverlapsOwnPlay(startAbs, endAbs)) return;
    let peak = 0;
    for (let i = 0; i < data.length; i++) {
      const a = Math.abs(data[i] ?? 0);
      if (a > peak) peak = a;
    }
    if (peak < 0.03) return;
    try {
      const ana = analyze_channel(data);
      if (
        !ana.degenerate &&
        Number.isFinite(ana.A.median_snr_db) &&
        ana.A.median_snr_db > 3
      ) {
        this.cb.onPeerActivity();
      }
    } catch {
      // No sounding in this window — the peer is not (yet) here.
    }
  }

  /** RMS of the most recent fraction of a second of capture. */
  private recentRms(seconds: number): number {
    const { data } = this.snapshot(seconds);
    if (data.length === 0) return 0;
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const v = data[i] ?? 0;
      sum += v * v;
    }
    return Math.sqrt(sum / data.length);
  }

  /**
   * Listen-before-talk: wait for a quiet channel before playing.
   * Returns true once the channel is clear. If it stays busy, back
   * off with jitter and retry rather than talking over the other
   * side; returns false only when the session stopped or the channel
   * never cleared — the caller then skips (ping) or fails (message)
   * instead of playing into a collision.
   */
  private async waitForClearChannel(): Promise<boolean> {
    const roundBudgetsMs = [5000, 6000, 9000];
    for (const budget of roundBudgetsMs) {
      const deadline = Date.now() + budget;
      while (Date.now() < deadline) {
        if (this.state === "idle") return false;
        if (this.recentRms(0.4) < 0.02) return true;
        await new Promise((r) => setTimeout(r, 350));
      }
      // Jittered pause between rounds so two waiting phones do not
      // fall into step and both decide the channel is clear together.
      await new Promise((r) =>
        setTimeout(r, 400 + Math.floor(Math.random() * 800)),
      );
    }
    return this.state !== "idle" && this.recentRms(0.4) < 0.02;
  }

  /**
   * The single transmission lock: every sound the Ear makes goes
   * through this chain, so a ping, a sounding and a message can never
   * overlap no matter which caller asks first.
   */
  private playSamples(samples48: ArrayLike<number>): Promise<void> {
    const run = this.playChain.then(() => this.playSamplesNow(samples48));
    this.playChain = run.catch(() => {});
    return run;
  }

  private async playSamplesNow(samples48: ArrayLike<number>): Promise<void> {
    if (!this.ctx) throw new Error("audio not started");
    if (this.ctx.state === "suspended") await this.ctx.resume();
    const atCtx = resample(Float32Array.from(samples48), SR, this.ctx.sampleRate);
    const buffer = this.ctx.createBuffer(1, atCtx.length, this.ctx.sampleRate);
    buffer.copyToChannel(atCtx, 0);
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.ctx.destination);
    this.currentSource = src;
    const playStartAbs = this.totalWritten;
    const prevState = this.state;
    this.setState("playing");
    await new Promise<void>((resolve) => {
      src.onended = () => resolve();
      src.start();
    });
    if (this.currentSource === src) this.currentSource = null;
    const playEndAbs = this.totalWritten + Math.floor(GUARD_TAIL_SECONDS * SR);
    this.ownPlays.push({ start: playStartAbs, end: playEndAbs });
    if (this.ownPlays.length > 12) this.ownPlays.shift();
    // If stop() tore the session down while this burst was playing,
    // stay idle — never resurrect "listening" over a closed engine.
    if (this.state === "playing" && this.stream) {
      this.setState(prevState === "playing" ? "listening" : prevState);
    }
  }

  /** Play the sounding burst, record it, and analyze the room. */
  async soundTheRoom(): Promise<{ mode: string; analysis: ChannelAnalysis }> {
    if (!this.ctx || this.state === "idle") {
      throw new Error("Start the session first — the ear needs the microphone to hear the room.");
    }
    const clear = await this.waitForClearChannel();
    if (!clear) {
      throw new Error("The channel stayed busy — the room could not be measured. Try again.");
    }
    const burst = sounding_burst();
    const startAbs = this.totalWritten - Math.floor(0.25 * SR);
    await this.playSamples(new Float32Array(burst));
    // A beat for the room's tail to land in the buffer.
    await new Promise((r) => setTimeout(r, 350));
    const endAbs = this.totalWritten;
    const recorded = this.snapshotRange(startAbs, endAbs);
    if (recorded.length < burst.length / 2) {
      throw new Error("The recording was too short to measure the room. Try again.");
    }
    const analysis = analyze_channel(recorded);
    this.soundingSamples = recorded;
    this.lastAnalysis = analysis;
    return { mode: analysis.recommendation, analysis };
  }

  /**
   * Emit a single short ping burst — the sounding tones only, no message.
   * This is the ONLY sound the Ping control makes. Starting and stopping
   * listening never call this. Captures its own echo so later speaks can
   * reuse the room measurement, and updates lastAnalysis when possible.
   */
  async ping(): Promise<void> {
    if (!this.ctx || this.state === "idle") {
      throw new Error("Begin listening first — ping needs the session open.");
    }
    // A heartbeat that cannot find a clear channel is simply skipped:
    // talking over the peer to announce presence would defeat it. The
    // next beat (1–3 s later) tries again.
    const clear = await this.waitForClearChannel();
    if (!clear) return;
    const burst = sounding_burst();
    const startAbs = this.totalWritten - Math.floor(0.25 * SR);
    await this.playSamples(new Float32Array(burst));
    await new Promise((r) => setTimeout(r, 350));
    const endAbs = this.totalWritten;
    const recorded = this.snapshotRange(startAbs, endAbs);
    if (recorded.length >= burst.length / 2) {
      this.soundingSamples = recorded;
      try {
        this.lastAnalysis = analyze_channel(recorded);
      } catch {
        // Ping still counted as emitted even if analysis fails.
      }
    }
  }

  /** Encode a text and play it over the air. Returns the mode used. */
  async speak(text: string): Promise<string> {
    if (!this.ctx || this.state === "idle") {
      throw new Error("Start the session before speaking.");
    }
    const data = new TextEncoder().encode(text);
    let samples: Float64Array;
    let mode: string;
    if (this.soundingSamples && this.lastAnalysis) {
      const [auto, autoMode] = encode_auto(data, this.soundingSamples);
      if (auto) {
        samples = auto;
        mode = autoMode;
      } else {
        // The sounding read as unusable (encode_auto returned no
        // burst): fall back to Mode B, whose heavy Reed–Solomon
        // survives a real room, rather than fragile Mode A.
        samples = encode_adaptive(data, "B");
        mode = "B";
      }
    } else {
      samples = encode_adaptive(data, "B");
      mode = "B";
    }
    this.recentSent.push({ crc: crc32(data), at: Date.now() });
    if (this.recentSent.length > 20) this.recentSent.shift();
    // Never talk over the peer: if the channel never clears, fail —
    // the caller leaves the text queued instead of marking it spoken.
    const clear = await this.waitForClearChannel();
    if (!clear) {
      throw new Error("The channel stayed busy, so the message was not sent.");
    }
    await this.playSamples(samples);
    return mode;
  }
}
