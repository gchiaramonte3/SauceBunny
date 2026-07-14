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

// Mediabunny's MP3 encoder extension — registers a lame-via-WASM encoder
// so Mp3OutputFormat can actually produce MP3 bytes in the browser.
// Without this, audio-MP3 exports for local files would fail at runtime
// with "no encoder available". Registered once at app startup; tree
// shaken out of any build that doesn't use Mp3OutputFormat.
import { registerMp3Encoder } from "@mediabunny/mp3-encoder";
registerMp3Encoder();

// Custom mediabunny decoders (WASM libopus) so local playback can be
// mediabunny-first even where WKWebView lacks a WebCodecs AudioDecoder —
// e.g. AV1+Opus YouTube downloads play in-app with no ffmpeg transcode.
// Decode-only; does not touch the web-streaming (MSE/proxy) path.
import { registerLocalDecoders } from "./lib/mediabunny-decoders";
registerLocalDecoders();

import "./styles/app.css";

import { hydrateReviewStore } from "./lib/review-store";

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
void Promise.race([
  hydrateReviewStore({ migrate: !isPanelWindow }).catch((err) => {
    console.warn("review-store hydration failed; starting empty:", err);
  }),
  hydrateDeadline,
]).then(renderApp);
