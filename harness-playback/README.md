# Playback-first native verification

This isolated **packaged Tauri/WKWebView** fixture imports the production
`ProxyPresentationPlayer`, local WebCodecs decoder, and native MSE adapter.
It uses a completed local web-review file and a frame-matched H.264/AAC file.
It does not modify the installed app, resolve/download Internet media, build
a DMG, or publish anything. Its separate bundle identifier isolates app data.

1. Set `REVIEW_FILE`, `HIGH_FILE`, `DURATION`, and optionally `FPS`; run
   `node harness-playback/server.mjs`. Both paths must exist on this Mac.
2. `npx tauri build --config harness-playback/tauri.conf.json --bundles app --no-sign`
3. Open the resulting **Sauce Playback Test.app** and click **Run 20 warm-cache resumes**.
4. The local server prints JSON containing every sample, diagnostics, and p95.
5. **Check buffered promotion and starvation** prepares a paused frame, plays
   the real native stream, then withholds delivery after 1.5 MB. It waits for
   a genuine `waiting` event and confirms local playback/rendered audio resume.
   It does not synthesize a browser media event or wait for the 20s fatal timeout.

The first ten runs hold high-quality resolution absent. The next ten delay
each high-quality fetch by 1800ms, respecting cancellation. Each run scrubs
and lands locally, then measures the first changed canvas picture and first
nonzero rendered Web Audio PCM after Play. The audio analyzer is a passive
branch; it does not replace the audio destination. These measurements do not
prove sound reaches a particular speaker or external audio interface.

For deterministic offline testing, high-quality input is registered on the
existing local-file FFmpeg proxy route. The browser still uses the real Rust
remux and MSE pipeline. This is a fixture transport, not a change to peer
quality policy, and does **not** test real CDN/signature/network performance.
Production SSRF restrictions are left intact. No allowlist bypass is added.

Target: picture and rendered PCM p95 <=300ms across at least 20 warm resumes.
Do not substitute `play()` promise completion, a React play-state update,
Chromium tests, or source resolution for this measurement.
