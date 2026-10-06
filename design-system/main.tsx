import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/nunito-sans/300.css";
import "@fontsource/nunito-sans/400.css";
import "@fontsource/nunito-sans/400-italic.css";
import "@fontsource/nunito-sans/600.css";
import "@fontsource/nunito-sans/700.css";
import "@fontsource/nunito-sans/800.css";
import "../src/styles/app.css";
import { DesignCatalog } from "./DesignCatalog";
import { TranscriptEditorPrototype } from "./TranscriptEditorPrototype";
import { ReviewFullscreenPrototype } from "./ReviewFullscreenPrototype";
import "./catalog.css";
import "./transcript-editor.css";
import "./review-fullscreen.css";

// Deliberately not src/main.tsx: no store hydration, Tauri, media or devices.
// Vite's production input remains index.html, so this entry is development-only.
// ?prototype=transcript-editor or ?prototype=review-fullscreen opens a
// whole-window prototype instead of the catalog: a workspace is judged at
// window size, not inside a catalog card.
if (import.meta.env.DEV) {
  const prototype = new URLSearchParams(location.search).get("prototype");
  const titles: Record<string, string> = { "transcript-editor": "Transcript Editor", "review-fullscreen": "Review full screen" };
  if (prototype && titles[prototype]) document.title = `Sauce Bunny · ${titles[prototype]} prototype`;
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>{prototype === "transcript-editor" ? <TranscriptEditorPrototype />
      : prototype === "review-fullscreen" ? <ReviewFullscreenPrototype /> : <DesignCatalog />}</React.StrictMode>,
  );
}
