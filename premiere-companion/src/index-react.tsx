// React entrypoint adapted from Bolt UXP, without its demo, webview or host shims.
import ReactDOM from "react-dom/client";
import { CompanionPanel } from "./CompanionPanel";
import { BridgeClient } from "./bridge-client";
import { Companion } from "./companion";
import { MarkerLedger } from "./ledger";
import { PremiereAdapter, type AdobeApi } from "./premiere";
import { panelId } from "./panel-id";
import "./panel.css";

type Lifecycle = { create: () => void; show: () => void; hide: () => void; destroy: () => void };
type Uxp = { versions?: { uxp?: string }; entrypoints: { setup(config: {
  plugin: Pick<Lifecycle, "create" | "destroy">;
  panels: Record<string, Lifecycle>;
}): void } };

function start() {
  const element = document.getElementById("app");
  if (!element) throw new Error("The companion panel root is missing.");
  let companion: Companion | null = null;
  let root: ReturnType<typeof ReactDOM.createRoot> | null = null;
  const showFailure = (error: unknown) => {
    element.textContent = "";
    const message = document.createElement("main");
    message.className = "cp-companion";
    message.setAttribute("role", "alert");
    const heading = document.createElement("h1");
    heading.textContent = "Sauce Bunny could not start";
    const detail = document.createElement("p");
    detail.textContent = error instanceof Error ? error.message : "The companion could not start safely.";
    const help = document.createElement("p");
    help.textContent = "Close and reopen this panel. If it still fails, install the latest companion from Sauce Bunny Settings → Integrations. No connection or marker was created.";
    message.appendChild(heading); message.appendChild(detail); message.appendChild(help);
    element.appendChild(message);
  };
  const mount = () => {
    if (root) return;
    try {
      const premiere = require("premierepro") as AdobeApi;
      companion ??= new Companion(new BridgeClient(), new PremiereAdapter(premiere, new MarkerLedger(localStorage)));
      root = ReactDOM.createRoot(element);
      root.render(<CompanionPanel companion={companion} />);
    } catch (error) { showFailure(error); }
  };
  try {
    const uxp = require("uxp") as Uxp;
    // Real UXP has native form chrome; the isolated browser fixture does not.
    if (uxp.versions?.uxp) element.classList.add("cp-companion-native");
    uxp.entrypoints.setup({
      plugin: {
        create: mount,
        destroy: () => { companion?.disconnect(); root?.unmount(); root = null; companion = null; },
      },
      panels: { [panelId]: {
        create: mount, show: mount,
        // Premiere currently ties panel hide/destroy together. Retain drafts and
        // the connection until plugin destruction; reopening never pairs anew.
        hide: () => {}, destroy: () => {},
      } },
    });
  } catch (error) { showFailure(error); }
}
// Bolt emits a classic script. Browser smoke tests and UXP must both wait for
// the panel root rather than assuming Vite's original module/defer semantics.
if (document.getElementById("app")) start();
else document.addEventListener("DOMContentLoaded", start, { once: true });
