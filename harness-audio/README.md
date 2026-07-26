# harness-audio — Opus/AV1 decode probe

Exercises the **real** mediabunny decode path (including
`src/lib/mediabunny-decoders.ts` and `src/lib/av-clock.ts`) against a real
Opus-bearing file in a real browser engine, and prints observed numbers.

## Run it

```bash
node harness-audio/run.mjs              # all modes, Chromium
node harness-audio/run.mjs custom       # one mode
ENGINE=webkit node harness-audio/run.mjs   # same probes in Playwright WebKit
SAMPLE=/abs/path/to/file.mp4 node harness-audio/run.mjs
node harness-audio/run.mjs 'race&blip=1'   # modes take query params
```

Sample file: `$SAMPLE`, else
`~/Desktop/Test/Vingadores_-Doutor-Destino-_-Trailer-Oficial-Legendado-3.mp4`,
else one is generated with the bundled ffmpeg (AV1 + Opus + 440 Hz tone).

Nothing here is in `tsconfig.json`'s `include` (`src` only), vitest's globs, or
the lint targets — the harness cannot affect CI.

## Modes

| mode | what it answers |
|---|---|
| `caps` | engine WebCodecs support, track codecs, the Opus `OpusHead` bytes |
| `native` | control: **no** custom decoder registered → native WebCodecs Opus |
| `custom` | the app's `registerLocalDecoders()` → who actually decodes |
| `prime` | `await getBuffer(0)`, **then** `buffers()` on that same sink |
| `prime-race` | fire-and-forget `getBuffer(0)` + immediate `buffers()` (the shipped shape) |
| `interleave` | `getBuffer()` called *during* a live `buffers()` iteration |
| `concurrent` | a **second** `buffers()` iterator on the same sink, in parallel |
| `rate-mismatch` | 48 kHz buffers into a 44.1 kHz `AudioContext` |
| `playback` / `playback-primed` | real `AudioContext`, real `runAudioLoop` arithmetic, AnalyserNode measures what is actually rendered |
| `race` | both loops concurrently, real AV1 decode load, real `av-clock.ts` rules. `?prime=0` skips the warm-up, `?blip=1` fires scrub blips during playback |

Two spies prove which decoder ran: `AudioDecoder` construction/configure
(native path) vs `WebAssembly.compile/instantiate` (our libopus path).
