/** Internal acceptance fixture. Never called by normal playback/capture. */
export type AcceptanceToneKind = "html" | "web-audio";
export type AcceptanceTone = { ready: Promise<void>; stop(): void };
const SAMPLE_RATE = 48_000;
const AMPLITUDE = 0.01;
const FREQUENCIES = [880, 1320] as const;
const HTML_DURATION_SECONDS = 20;

export function acceptanceToneSamples(frames = SAMPLE_RATE): Float32Array<ArrayBuffer>[] {
  return FREQUENCIES.map(frequency => Float32Array.from({ length: frames },
    (_, i) => AMPLITUDE * Math.sin(2 * Math.PI * frequency * i / SAMPLE_RATE)));
}

/** One bounded stereo PCM16 file, longer than the 18-second measurement
 * deadline. HTML media looping can insert silence even with periodic PCM. */
export function acceptanceToneWav(): ArrayBuffer {
  const frames = SAMPLE_RATE * HTML_DURATION_SECONDS;
  const channels = acceptanceToneSamples(frames);
  const bytes = new ArrayBuffer(44 + frames * 4);
  const view = new DataView(bytes);
  const text = (offset: number, value: string) => [...value].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, "RIFF"); view.setUint32(4, bytes.byteLength - 8, true); text(8, "WAVE");
  text(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 2, true); view.setUint32(24, SAMPLE_RATE, true);
  view.setUint32(28, SAMPLE_RATE * 4, true); view.setUint16(32, 4, true);
  view.setUint16(34, 16, true); text(36, "data"); view.setUint32(40, frames * 4, true);
  for (let i = 0; i < frames; i++) {
    for (let channel = 0; channel < 2; channel++) {
      view.setInt16(44 + i * 4 + channel * 2, Math.round(channels[channel][i] * 32767), true);
    }
  }
  return bytes;
}

/** Start only inside an explicit user gesture, in the actual main WKWebView. */
export function startAcceptanceTone(kind: AcceptanceToneKind): AcceptanceTone {
  if (kind === "html") {
    const url = URL.createObjectURL(new Blob([acceptanceToneWav()], { type: "audio/wav" }));
    let audio: HTMLAudioElement | undefined;
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      try { audio?.pause(); audio?.removeAttribute("src"); audio?.load(); }
      finally { URL.revokeObjectURL(url); }
    };
    try {
      audio = new Audio(url); audio.loop = false;
      const ready = audio.play().then(() => {
        if (stopped) audio?.pause();
      }).catch(error => { stop(); throw error; });
      return { ready, stop };
    } catch (error) { stop(); throw error; }
  }
  const context = new AudioContext({ sampleRate: SAMPLE_RATE });
  let source: AudioBufferSourceNode | undefined;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    try { source?.stop(); } catch { /* It may not have started. */ }
    try { source?.disconnect(); } finally { void context.close().catch(() => {}); }
  };
  try {
    const buffer = context.createBuffer(2, SAMPLE_RATE, SAMPLE_RATE);
    acceptanceToneSamples().forEach((samples, channel) => buffer.copyToChannel(samples, channel));
    source = context.createBufferSource();
    source.buffer = buffer; source.loop = true; source.connect(context.destination);
    source.start();
    const ready = context.resume().then(() => {
      if (!stopped && context.state !== "running") throw new Error("Test tone audio context is not running.");
    }).catch(error => { stop(); throw error; });
    return { ready, stop };
  } catch (error) { stop(); throw error; }
}
