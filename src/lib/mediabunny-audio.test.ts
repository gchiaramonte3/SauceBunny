import { describe, expect, it } from "vitest";
import { encodeWavMono16 } from "./mediabunny-audio";

/**
 * The WAV bytes Whisper reads.
 *
 * `extractAudioAsWav16k` itself needs a real container to decode, so it is not
 * tested here — but the last thing it does is hand-roll a WAV file, and that
 * part is pure. It matters more than its size suggests: a wrong header field or
 * a mis-scaled sample does not throw. Whisper accepts the file and transcribes
 * garbage, or silence, and the result looks like a bad model rather than a bad
 * header. Nothing downstream can tell the difference.
 *
 * So this reads the bytes back and checks them against the spec at fixed
 * offsets, rather than comparing against a recorded blob. A snapshot would lock
 * in whatever the encoder does today, including a mistake.
 */

const bytesOf = async (b: Blob) => new DataView(await b.arrayBuffer());
const ascii = (v: DataView, at: number, len: number) =>
  Array.from({ length: len }, (_, i) => String.fromCharCode(v.getUint8(at + i))).join("");

describe("the 44-byte header", () => {
  it("declares RIFF/WAVE and a data chunk in the right places", async () => {
    const v = await bytesOf(encodeWavMono16(new Float32Array(100), 16000));
    expect(ascii(v, 0, 4)).toBe("RIFF");
    expect(ascii(v, 8, 4)).toBe("WAVE");
    expect(ascii(v, 12, 4)).toBe("fmt ");
    expect(ascii(v, 36, 4)).toBe("data");
  });

  it("declares uncompressed mono PCM at 16 bits", async () => {
    const v = await bytesOf(encodeWavMono16(new Float32Array(8), 16000));
    expect(v.getUint32(16, true), "fmt chunk size").toBe(16);
    expect(v.getUint16(20, true), "format tag (1 = PCM)").toBe(1);
    expect(v.getUint16(22, true), "channel count").toBe(1);
    expect(v.getUint16(34, true), "bits per sample").toBe(16);
  });

  it("gets the two sizes right, which is what truncates audio when wrong", async () => {
    // RIFF size is everything after the first 8 bytes; data size is the samples
    // alone. Overstate either and a decoder reads past the end; understate and
    // the tail of the audio is silently dropped.
    const samples = 1234;
    const b = encodeWavMono16(new Float32Array(samples), 16000);
    const v = await bytesOf(b);
    expect(b.size).toBe(44 + samples * 2);
    expect(v.getUint32(4, true), "RIFF size").toBe(36 + samples * 2);
    expect(v.getUint32(40, true), "data size").toBe(samples * 2);
  });

  it("derives byte rate and block align from the sample rate", async () => {
    // Mono 16-bit: blockAlign is 2 and byteRate is sampleRate * 2. Get byteRate
    // wrong and players compute the wrong duration, which shifts every cue
    // timestamp Whisper returns.
    for (const rate of [8000, 16000, 44100, 48000]) {
      const v = await bytesOf(encodeWavMono16(new Float32Array(4), rate));
      expect(v.getUint32(24, true), `sample rate ${rate}`).toBe(rate);
      expect(v.getUint32(28, true), `byte rate for ${rate}`).toBe(rate * 2);
      expect(v.getUint16(32, true), "block align").toBe(2);
    }
  });
});

describe("float to int16 conversion", () => {
  const read = async (input: number[]) => {
    const v = await bytesOf(encodeWavMono16(Float32Array.from(input), 16000));
    return input.map((_, i) => v.getInt16(44 + i * 2, true));
  };

  it("maps the full-scale endpoints to the full int16 range", async () => {
    // The asymmetry is deliberate and correct: int16 holds -32768..32767, so
    // -1 scales by 0x8000 and +1 by 0x7FFF. Using one factor for both either
    // clips the negative peak or wastes a level.
    expect(await read([-1, 0, 1])).toEqual([-32768, 0, 32767]);
  });

  it("clamps beyond full scale instead of wrapping", async () => {
    // Float audio can exceed ±1 after mixing or resampling. Without the clamp
    // these wrap around and a loud passage becomes a loud passage of the
    // OPPOSITE sign — audible as violent distortion, and it confuses Whisper.
    expect(await read([1.5, -1.5, 99, -99])).toEqual([32767, -32768, 32767, -32768]);
  });

  it("clamps infinities rather than emitting garbage", async () => {
    expect(await read([Infinity, -Infinity])).toEqual([32767, -32768]);
  });

  it("turns a NaN sample into silence, not a random value", async () => {
    // NaN survives Math.min/max, so the clamp does not catch it; setInt16's
    // ToInteger sends it to 0. That is the right outcome — one silent sample
    // beats one impulse — and it is worth pinning because it is accidental.
    expect(await read([NaN, 0.5, NaN])).toEqual([0, 16383, 0]);
  });

  it("preserves ordinary sample values, truncating toward zero", async () => {
    expect(await read([0.5, -0.5, 0.25])).toEqual([16383, -16384, 8191]);
  });

  it("keeps sample order, so audio is not reversed or interleaved", async () => {
    // A ramp catches a stride or endianness mistake that constant input hides.
    const ramp = Array.from({ length: 16 }, (_, i) => i / 16);
    const out = await read(ramp);
    for (let i = 1; i < out.length; i++) {
      expect(out[i], `sample ${i} did not increase`).toBeGreaterThan(out[i - 1]);
    }
  });

  it("writes little-endian samples, as the header claims", async () => {
    // The header says WAV; WAV is little-endian. If setInt16 lost its `true`,
    // every sample would be byte-swapped — quiet audio becoming full-scale
    // noise. Checked against the raw bytes, not getInt16.
    const v = await bytesOf(encodeWavMono16(Float32Array.from([1]), 16000));
    expect(v.getUint8(44), "low byte first").toBe(0xff);
    expect(v.getUint8(45), "high byte second").toBe(0x7f);
  });
});

describe("degenerate input", () => {
  it("produces a valid header-only file for no samples", async () => {
    // A source with no audio track reaches here. A 44-byte WAV is legal and
    // Whisper handles it; a malformed one would be reported as a decode error
    // that looks like a broken file.
    const b = encodeWavMono16(new Float32Array(0), 16000);
    expect(b.size).toBe(44);
    const v = await bytesOf(b);
    expect(ascii(v, 0, 4)).toBe("RIFF");
    expect(v.getUint32(40, true), "data size").toBe(0);
    expect(v.getUint32(4, true), "RIFF size").toBe(36);
  });

  it("declares itself audio/wav so the blob is handled as audio", async () => {
    expect(encodeWavMono16(new Float32Array(4), 16000).type).toBe("audio/wav");
  });

  it("handles a single sample", async () => {
    const b = encodeWavMono16(Float32Array.from([-1]), 16000);
    expect(b.size).toBe(46);
    expect((await bytesOf(b)).getInt16(44, true)).toBe(-32768);
  });
});
