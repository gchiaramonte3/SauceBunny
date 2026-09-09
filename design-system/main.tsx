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
import "./catalog.css";

// Deliberately not src/main.tsx: no store hydration, Tauri, media or devices.
// Vite's production input remains index.html, so this entry is development-only.
if (import.meta.env.DEV) {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode><DesignCatalog /></React.StrictMode>,
  );
}
