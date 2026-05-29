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

import "./styles/app.css";

// Single-bundle multi-window: the floating side-panel window loads the
// same `index.html?window=panel` URL, and we route here based on the
// query string. Keeps the Vite build to one entry and lets PanelApp
// reuse QueueDrawer + every component it depends on.
const isPanelWindow =
  new URLSearchParams(window.location.search).get("window") === "panel";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {isPanelWindow ? <PanelApp /> : <App />}
  </React.StrictMode>
);
