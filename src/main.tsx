import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import PanelApp from "./PanelApp";

// Self-hosted Nunito Sans via @fontsource/nunito-sans — covers every
// weight the UI uses (300/400/600/700/800 + a 400 italic). Imported
// BEFORE app.css so the @font-face declarations are registered before
// the first style queries them, avoiding the brief FOUT we'd see if the
// CSS import happened first.
import "@fontsource/nunito-sans/300.css";
import "@fontsource/nunito-sans/400.css";
import "@fontsource/nunito-sans/400-italic.css";
import "@fontsource/nunito-sans/600.css";
import "@fontsource/nunito-sans/700.css";
import "@fontsource/nunito-sans/800.css";

import { platformSupports } from "./lib/platform-capabilities";

// EVERY registration below is gated on measured capability (r150). Each of
// these extensions is WASM-backed and most spawn a blob: Worker; registering
// one the platform cannot run does not fail loudly, it HANGS - mediabunny
// queues work behind an init promise that never settles, and the feature goes
// silent with no error anywhere. That is exactly how a CSP missing
// 'wasm-unsafe-eval' produced perfect video with no audio in the packaged app
// while `tauri dev` (which serves with no CSP at all) was fine.
const platform = platformSupports();

// NOTE: the MP3 encoder is deliberately NOT registered here. It inlines a
// 223 KB WASM module as base64 inside a worker source — about 15% of the whole
// JS bundle — and audio-MP3 export is a feature most sessions never touch, so
// it loads on first use instead. Its capability gate moved with it, intact:
// see ensureMp3Encoder in lib/mediabunny-export.ts.

// Custom mediabunny decoders (WASM libopus) so local playback can be
// mediabunny-first even where WKWebView lacks a WebCodecs AudioDecoder —
// e.g. AV1+Opus YouTube downloads play in-app with no ffmpeg transcode.
// Decode-only; does not touch the web-streaming (MSE/proxy) path.
import { registerLocalDecoders } from "./lib/mediabunny-decoders";
// Custom decoders are a POLYFILL, not an upgrade: mediabunny always prefers a
// matching custom decoder over the platform's own, so registering one where
// WASM cannot run replaces a working native decoder with a broken one. Only
// register when WebAssembly is actually usable; otherwise mediabunny falls
// through to WebCodecs, and past that the app's ffmpeg-transcode path.
if (platform.wasm) registerLocalDecoders(platform.blobWorker);

import "./styles/app.css";

import { hydrateReviewStore } from "./lib/review-store";
import { hydrateCastStore, listenForCastChanges } from "./lib/cast-store";

// Single-bundle multi-window: the floating side-panel window loads the
// same `index.html?window=panel` URL, and we route here based on the
// query string. Keeps the Vite build to one entry and lets PanelApp
// reuse QueueDrawer + every component it depends on.
const isPanelWindow =
  new URLSearchParams(window.location.search).get("window") === "panel";

function renderApp(): void {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      {isPanelWindow ? <PanelApp /> : <App />}
    </React.StrictMode>
  );
}

// Review docs persist as real files (~/Documents/Sauce Bunny/Reviews/) —
// fill the store before the first render so the SYNC loadReview sees them.
// Local JSON reads land in milliseconds, but boot must never hang on them:
// hydrate tolerates every failure internally, and the 2 s race falls through
// to render while hydration keeps filling the store in the background. Only
// the main window migrates legacy localStorage docs (single library writer).
const hydrateDeadline = new Promise<void>((resolve) => setTimeout(resolve, 2000));
// Casts hydrate alongside. They are NOT raced for the first render — nothing
// on screen at boot reads them (the shelf lives behind the speakers modal), so
// blocking paint on a second file read would buy nothing. The store's own
// pre-hydration write guard is what keeps an early save from clobbering the
// file while this is still in flight.
// Both windows run this file, and both can edit casts (the speaker roster
// lives in TranscriptViewer, which each of them renders). Listening is what
// makes the other window SHOW an edit; the merge in the store is what stops
// the two of them erasing each other.
listenForCastChanges();
void hydrateCastStore().catch((err) => {
  console.warn("cast-store hydration failed; starting empty:", err);
});

// The PANEL does not hydrate reviews at all, unlike casts above. QueueDrawer
// drops the Review tab when `embedded`, redirects a restored "review" tab to
// "transcript", keeps its keep-alive set fed from the REDIRECTED value (the
// raw restored one once mounted a hidden ReviewPanel here - caught by an
// adversarial review, pinned in e2e/panel-window.spec.ts), and the tick that
// selects the tab is a prop only App passes. And even if a ReviewPanel did
// mount, the panel window is never handed a review source key, which is what
// every read and write in it is gated on. So hydrating here read index.json
// AND every review doc through a worker pool for a store nothing in this
// window can ask about, with first paint racing it. If the panel is ever
// given the review tab, call hydrateReviewStore() then: it is idempotent and
// latched, so the call site can be wherever the tab is.
if (isPanelWindow) {
  renderApp();
} else {
  void Promise.race([
    hydrateReviewStore({ migrate: true }).catch((err) => {
      console.warn("review-store hydration failed; starting empty:", err);
    }),
    hydrateDeadline,
  ]).then(renderApp);
}
