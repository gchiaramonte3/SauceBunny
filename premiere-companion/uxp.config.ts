// Adapted from Hyperbrew Bolt UXP 1.3.13. See public/BOLT-UXP-LICENSE.txt.
import type { UXP_Config, UXP_Manifest } from "vite-uxp-plugin";
import { version } from "./package.json";
import { panelId } from "./src/panel-id";

export { panelId };
// Bolt's current manifest type predates Adobe's documented CSSNextSupport.
type PremiereManifest = Omit<UXP_Manifest, "featureFlags"> & {
  featureFlags: NonNullable<UXP_Manifest["featureFlags"]> & { CSSNextSupport: string[] };
};
export const manifest: PremiereManifest = {
  id: "com.saucebunny.premiere-companion",
  name: "Sauce Bunny Companion (Beta)",
  version,
  main: "index.html",
  manifestVersion: 5,
  host: [{ app: "premierepro", minVersion: "26.3.2" }],
  entrypoints: [{
    type: "panel", id: panelId, label: { default: "Sauce Bunny" },
    minimumSize: { width: 280, height: 260 },
    maximumSize: { width: 2000, height: 2000 },
    preferredDockedSize: { width: 340, height: 500 },
    preferredFloatingSize: { width: 380, height: 540 },
  }],
  requiredPermissions: { network: { domains: ["ws://localhost"] } },
  featureFlags: { CSSNextSupport: ["boxShadow"] },
};

export const config: UXP_Config = {
  manifest,
  hotReloadPort: 8080,
  webviewUi: false,
  webviewReloadPort: 8082,
  copyZipAssets: [],
  uniqueIds: false,
  debugger: "udt",
};
