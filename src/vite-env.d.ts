/// <reference types="vite/client" />

/** CFBundleVersion (YYYYMMDDNN), injected by vite.config.ts from
 *  tauri.conf.json so the About tab cannot drift from the bundle. */
declare const __BUILD_NUMBER__: string;
