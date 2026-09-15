import { afterEach, expect, it, vi } from "vitest";
import { acceptanceToneSamples, acceptanceToneWav, startAcceptanceTone } from "./capture-acceptance-tone";

afterEach(() => vi.unstubAllGlobals());

it("uses bounded, channel-distinct reference tones, never the external fixture frequencies", () => {
  const channels = acceptanceToneSamples();
  channels.forEach((samples, channel) => {
    expect(samples.length).toBe(48_000);
    expect(samples.every(value => Math.abs(value) <= .010001)).toBe(true);
    for (const frequency of [440, 660, 880, 1320]) {
      const magnitude = 2 * Math.abs(samples.reduce((sum, value, i) =>
        sum + value * Math.sin(2 * Math.PI * frequency * i / 48_000), 0)) / samples.length;
      if (frequency === [880, 1320][channel]) expect(magnitude).toBeCloseTo(.01, 6);
      else expect(magnitude).toBeLessThan(.000001);
    }
  });
});

it("encodes exactly 20 seconds of stereo PCM16 with continuous left/right tones", () => {
  const wav = acceptanceToneWav(); const view = new DataView(wav);
  expect(wav.byteLength).toBe(3_840_044);
  expect(new TextDecoder().decode(wav.slice(0, 4))).toBe("RIFF");
  expect(view.getUint32(4, true)).toBe(wav.byteLength - 8);
  expect(new TextDecoder().decode(wav.slice(8, 16))).toBe("WAVEfmt ");
  expect(view.getUint32(16, true)).toBe(16); expect(view.getUint16(20, true)).toBe(1);
  expect(view.getUint16(22, true)).toBe(2); expect(view.getUint32(24, true)).toBe(48_000);
  expect(view.getUint32(28, true)).toBe(192_000); expect(view.getUint16(32, true)).toBe(4);
  expect(view.getUint16(34, true)).toBe(16);
  expect(new TextDecoder().decode(wav.slice(36, 40))).toBe("data");
  expect(view.getUint32(40, true)).toBe(3_840_000);
  const frames = view.getUint32(40, true) / view.getUint16(32, true);
  expect(frames).toBe(960_000); expect(frames / view.getUint32(24, true)).toBe(20);
  const channels = acceptanceToneSamples();
  for (let second = 0; second < 20; second++) {
    const sameTones = channels.every((samples, channel) => samples.every((sample, frame) =>
      view.getInt16(44 + (second * 48_000 + frame) * 4 + channel * 2, true) === Math.round(sample * 32767)));
    expect(sameTones, `continuous stereo tones through second ${second + 1}`).toBe(true);
  }
});

it("plays the bounded HTML file once and keeps explicit cancellation idempotent", async () => {
  const revoke = vi.fn(), pause = vi.fn(), load = vi.fn(), remove = vi.fn();
  const audio = { loop: true, pause, load, removeAttribute: remove, play: vi.fn(() => Promise.resolve()) };
  const construct = vi.fn();
  vi.stubGlobal("URL", { createObjectURL: () => "blob:fixture", revokeObjectURL: revoke });
  vi.stubGlobal("Audio", class { constructor(url: string) { construct(url); return audio; } });
  const tone = startAcceptanceTone("html"); await tone.ready;
  expect(construct).toHaveBeenCalledExactlyOnceWith("blob:fixture");
  expect(audio.play).toHaveBeenCalledTimes(1); expect(audio.loop).toBe(false);
  expect(pause).not.toHaveBeenCalled(); expect(revoke).not.toHaveBeenCalled();
  tone.stop(); tone.stop();
  expect(pause).toHaveBeenCalledTimes(1); expect(remove).toHaveBeenCalledExactlyOnceWith("src");
  expect(load).toHaveBeenCalledTimes(1); expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:fixture");
});

it("revokes a Blob URL when HTML playback setup throws synchronously", () => {
  const revoke = vi.fn(); const pause = vi.fn();
  vi.stubGlobal("URL", { createObjectURL: () => "blob:fixture", revokeObjectURL: revoke });
  vi.stubGlobal("Audio", class {
    pause = pause; load = vi.fn(); removeAttribute = vi.fn();
    play() { throw new Error("play failed"); }
  });
  expect(() => startAcceptanceTone("html")).toThrow("play failed");
  expect(pause).toHaveBeenCalled(); expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:fixture");
});

it.each(["buffer", "start", "resume"])("closes Web Audio resources on a synchronous %s failure", stage => {
  const stop = vi.fn(); const disconnect = vi.fn(); const close = vi.fn(() => Promise.resolve());
  vi.stubGlobal("AudioContext", class {
    close = close; destination = {};
    createBuffer() { if (stage === "buffer") throw new Error(stage); return { copyToChannel: vi.fn() }; }
    createBufferSource() { return { stop, disconnect, connect: vi.fn(), start: () => { if (stage === "start") throw new Error(stage); } }; }
    resume() { throw new Error(stage); }
  });
  expect(() => startAcceptanceTone("web-audio")).toThrow(stage);
  expect(close).toHaveBeenCalledTimes(1);
  if (stage !== "buffer") { expect(stop).toHaveBeenCalled(); expect(disconnect).toHaveBeenCalled(); }
});
