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
import "./catalog.css";
import "./transcript-editor.css";

// Deliberately not src/main.tsx: no store hydration, Tauri, media or devices.
// Vite's production input remains index.html, so this entry is development-only.
// ?prototype=transcript-editor opens a whole-window prototype instead of the
// catalog: a workspace is judged at window size, not inside a catalog card.
if (import.meta.env.DEV) {
  const prototype = new URLSearchParams(location.search).get("prototype") === "transcript-editor";
  if (prototype) document.title = "Sauce Bunny · Transcript Editor prototype";
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>{prototype ? <TranscriptEditorPrototype /> : <DesignCatalog />}</React.StrictMode>,
  );
}
