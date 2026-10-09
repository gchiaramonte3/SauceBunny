import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { formatError } from "../lib/error-format";
import { IconCheck, IconAlert, IconInfo } from "./Icons";
import { OpenAiSpeed } from "./OpenAiSpeed";
import { CloudModelPicker } from "./CloudModelPicker";
import type { CloudModel } from "../bindings/CloudModel";
import {
  loadCloudModel, setCloudModel, loadScanModel, setScanModel, listCloudModels,
  hasApiKey, setApiKey, deleteApiKey, cloudChat, type CloudProvider,
} from "../lib/ai-provider";

export type CloudProviderInfo = { id: CloudProvider; label: string; company: string; keyHint: string; keyUrl: string };

/** Open a key-management page in the default browser. Rust validates the
 *  scheme; a failure here is not worth interrupting a settings pane for. */
function openExternal(url: string) {
  invoke("open_external_url", { url }).catch(() => { /* ignore */ });
}

/**
 * The chosen cloud provider's settings: its key (kept in the Keychain and
 * never read back), the two models, and a test. Rows in the Settings row
 * style, so it reads as part of the pane rather than a form dropped into it.
 */
export function CloudProviderCard({ p }: { p: CloudProviderInfo }) {
  const [present, setPresent] = useState<boolean | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [model, setModel] = useState(() => loadCloudModel(p.id));
  const [scan, setScan] = useState(() => loadScanModel(p.id));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // Every model this key can call, from the provider; fetched once a key is saved, and on Refresh.
  const [models, setModels] = useState<CloudModel[] | null>(null);
  const [listing, setListing] = useState(false);
  async function refresh() {
    setListing(true);
    try { setModels(await listCloudModels(p.id)); }
    catch (e) { setMsg({ ok: false, text: `Could not list the models: ${formatError(e)}` }); }
    finally { setListing(false); }
  }
  useEffect(() => { if (present) void refresh(); }, [present]); // eslint-disable-line react-hooks/exhaustive-deps -- refresh reads only the provider, fixed for the card's life
  // The card is keyed by provider, so `p.id` is fixed for its life.
  useEffect(() => { hasApiKey(p.id).then(setPresent).catch(() => setPresent(false)); }, [p.id]);

  async function save() {
    const k = keyInput.trim();
    if (!k) return;
    setBusy(true); setMsg(null);
    try { await setApiKey(p.id, k); setKeyInput(""); setPresent(true); setMsg({ ok: true, text: "Saved to your Keychain." }); }
    catch (e) { setMsg({ ok: false, text: formatError(e) }); }
    finally { setBusy(false); }
  }
  async function remove() {
    setBusy(true); setMsg(null);
    try { await deleteApiKey(p.id); setPresent(false); setModels(null); setMsg({ ok: true, text: "Key removed." }); }
    catch (e) { setMsg({ ok: false, text: formatError(e) }); }
    finally { setBusy(false); }
  }
  async function test() {
    setBusy(true); setMsg(null);
    try {
      setCloudModel(p.id, model);
      const reply = await cloudChat(p.id, "You are a connection test.", [{ role: "user", content: "Reply with the single word OK." }]);
      setMsg({ ok: true, text: `Connected. Replied: ${reply.trim().slice(0, 40)}` });
    } catch (e) { setMsg({ ok: false, text: formatError(e) }); }
    finally { setBusy(false); }
  }
  const chat = models?.filter((item) => item.chat).length ?? 0;

  return (
    <div className="cp-aiapi-card" role="group" aria-labelledby={`aiapi-${p.id}-name`}>
      <div className="cp-aiapi-cardhead">
        <span id={`aiapi-${p.id}-name`} className="cp-aiapi-name">{p.label}</span>
        <span className={"cp-aiapi-status" + (present ? " ok" : "")}>
          {present === null ? "Checking the Keychain…" : present ? <><IconCheck size={12} /> Key saved</> : "No key saved"}
        </span>
      </div>
      <p className="cp-aiapi-note"><IconInfo size={13} /> The transcript text you analyze is sent to {p.company} each time.</p>
      <div className="cp-pane-row">
        <div className="k"><label htmlFor={`aiapi-key-${p.id}`}>API key</label>
          <span className="desc">Kept in the macOS Keychain, never in plain text. <button type="button" className="cp-aiapi-link" onClick={() => openExternal(p.keyUrl)}>Get a key ↗</button></span></div>
        <div className="v cp-aiapi-field">
          <input id={`aiapi-key-${p.id}`} type="password" className="cp-aiapi-input" value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void save(); }}
            placeholder={present ? "•••••••••• (saved)" : p.keyHint} autoComplete="off" spellCheck={false} />
          <button type="button" className="btn" disabled={busy || !keyInput.trim()} onClick={save}>Save</button>
          {present && <button type="button" className="btn btn-ghost" disabled={busy} onClick={remove}>Remove</button>}
        </div>
      </div>
      <div className="cp-pane-row">
        <div className="k"><label htmlFor={`aiapi-model-${p.id}`}>Model</label><span className="desc">For Ask, AI Summary and Analysis.</span></div>
        <div className="v cp-aiapi-field"><CloudModelPicker id={`aiapi-model-${p.id}`} value={model} models={models}
          onChange={(next) => { setModel(next); setCloudModel(p.id, next); }} /></div>
      </div>
      <div className="cp-pane-row">
        <div className="k"><label htmlFor={`aiapi-scan-${p.id}`}>Scan model</label><span className="desc">Reads many stretches of transcript at once to find a topic. A fast one is best.</span></div>
        <div className="v cp-aiapi-field"><CloudModelPicker id={`aiapi-scan-${p.id}`} value={scan} models={models}
          onChange={(next) => { setScan(next); setScanModel(p.id, next); }} /></div>
      </div>
      {p.id === "openai" && <OpenAiSpeed model={model} />}
      <div className="cp-aiapi-foot">
        <span className="cp-aiapi-count">{models ? `${chat} chat ${chat === 1 ? "model" : "models"} on this key` : present ? listing ? "Listing the models this key can use…" : "" : "Save a key to list its models"}</span>
        <button type="button" className="btn btn-ghost" disabled={listing || !present} onClick={() => void refresh()}>{listing ? "Listing…" : "Refresh models"}</button>
        <button type="button" className="btn" disabled={busy || !present} onClick={test}>Test connection</button>
      </div>
      {/* status for a success, alert for a failure: saving a key is a
          deliberate act whose result the user is waiting on, and a wrong key
          reported only in colour is reported to nobody. */}
      {msg && <p className={"cp-aiapi-msg" + (msg.ok ? " ok" : " err")} role={msg.ok ? "status" : "alert"}>
        {msg.ok ? <IconCheck size={12} /> : <IconAlert size={12} />} {msg.text}</p>}
    </div>
  );
}
