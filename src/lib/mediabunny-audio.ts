import { Input, UrlSource, ALL_FORMATS, AudioBufferSink } from "mediabunny";
import { convertFileSrc } from "@tauri-apps/api/core";

/**
 * Extracts the audio track of a local file, resamples to 16kHz mono, and
 * returns a complete WAV file blob — exactly what whisper-cli expects.
 *
 * Replaces the ffmpeg subprocess `ffmpeg -i in -ac 1 -ar 16000 out.wav`
 * for files mediabunny can decode (most modern h264/aac/opus/mp3).
 * Returns null when:
 *  - The file has no audio track
 *  - WebCodecs can't decode the audio codec on this platform
 *  - Any decode error occurs (caller falls back to the ffmpeg path)
 *
 * Memory note: a 1h podcast at 16kHz mono int16 = 3600 × 16000 × 2 bytes
 * = ~115 MB. Comfortably in-memory. For multi-hour files we'd want to
 * stream to disk, but that's a Phase 2 problem.
 */
export async function extractAudioAsWav16k(
  localPath: string,
  startSeconds?: number,
  endSeconds?: number,
): Promise<Blob | null> {
  const url = convertFileSrc(localPath);
  const input = new Input({ source: new UrlSource(url), formats: ALL_FORMATS });
  try {
    const at = await input.getPrimaryAudioTrack();
    if (!at) return null;
    if (!(await at.canDecode())) return null;

    const sink = new AudioBufferSink(at);

    // Collect all the AudioBuffer chunks for the requested range. Each
    // chunk is a Web Audio API AudioBuffer with the track's native
    // sample rate + channel count.
    const chunks: AudioBuffer[] = [];
    for await (const wrapped of sink.buffers(startSeconds, endSeconds)) {
      chunks.push(wrapped.buffer);
    }
    if (chunks.length === 0) return null;

    // Concat into one AudioBuffer at the source rate, then resample +
    // downmix to 16k mono via OfflineAudioContext. This is the same
    // technique whisper.cpp's CLI does internally with libsamplerate.
    const srcRate = chunks[0].sampleRate;
    const srcChannels = chunks[0].numberOfChannels;
    const totalFrames = chunks.reduce((n, c) => n + c.length, 0);

    // First pass: pack into a single buffer at the source rate (preserves
    // original quality; resample happens via OfflineAudioContext below).
    const stagingCtx = new OfflineAudioContext(srcChannels, totalFrames, srcRate);
    const staging = stagingCtx.createBuffer(srcChannels, totalFrames, srcRate);
    let offset = 0;
    for (const chunk of chunks) {
      for (let ch = 0; ch < srcChannels; ch++) {
        staging.getChannelData(ch).set(chunk.getChannelData(ch), offset);
      }
      offset += chunk.length;
    }

    // Second pass: render through an OfflineAudioContext at 16kHz mono.
    // OfflineAudioContext handles the resample (browser-native quality)
    // and we use a ChannelMergerNode/createGain to downmix to mono.
    const targetRate = 16000;
    const targetFrames = Math.ceil((totalFrames / srcRate) * targetRate);
    const renderCtx = new OfflineAudioContext(1, targetFrames, targetRate);
    const src = renderCtx.createBufferSource();
    src.buffer = staging;
    // Downmix happens automatically when connecting a multi-channel
    // source to a mono destination — Web Audio sums channels per spec.
    src.connect(renderCtx.destination);
    src.start();
    const rendered = await renderCtx.startRendering();

    // Third pass: pack rendered float32 mono into 16-bit PCM + WAV header.
    return encodeWavMono16(rendered.getChannelData(0), targetRate);
  } catch {
    return null;
  } finally {
    void input.dispose();
  }
}

/**
 * Minimal WAV encoder for mono 16-bit PCM. Tiny implementation that
 * sidesteps the need for a WAV encoder library — the WAV spec for
 * uncompressed PCM is ~44 bytes of header + raw samples.
 */
function encodeWavMono16(samples: Float32Array, sampleRate: number): Blob {
  const byteLen = samples.length * 2; // int16 = 2 bytes per sample
  const buf = new ArrayBuffer(44 + byteLen);
  const view = new DataView(buf);

  // RIFF chunk descriptor.
  writeString(view, 0, "RIFF");
  view.setUint32(4, 36 + byteLen, true);
  writeString(view, 8, "WAVE");

  // fmt sub-chunk (PCM, mono).
  writeString(view, 12, "fmt ");
  view.setUint32(16, 16, true);            // PCM fmt chunk size
  view.setUint16(20, 1, true);             // format = 1 (PCM)
  view.setUint16(22, 1, true);             // channels = 1
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate = sampleRate × blockAlign
  view.setUint16(32, 2, true);             // block align (channels × bytesPerSample)
  view.setUint16(34, 16, true);            // bits per sample

  // data sub-chunk.
  writeString(view, 36, "data");
  view.setUint32(40, byteLen, true);

  // Sample data — clamp floats to [-1,1] then scale to int16 range.
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    offset += 2;
  }

  return new Blob([buf], { type: "audio/wav" });
}

function writeString(view: DataView, offset: number, str: string) {
  for (let i = 0; i < str.length; i++) {
    view.setUint8(offset + i, str.charCodeAt(i));
  }
}
