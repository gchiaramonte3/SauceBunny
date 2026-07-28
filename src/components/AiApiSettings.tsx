import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { formatError } from "../lib/error-format";
import { IconCheck, IconAlert } from "./Icons";
import {
  loadAiProvider, setAiProvider, loadCloudModel, setCloudModel,
  hasApiKey, setApiKey, deleteApiKey, cloudChat,
  DEFAULT_CLOUD_MODEL, type AiProvider, type CloudProvider,
} from "../lib/ai-provider";

/** Open a key-management page in the default browser. Rust validates the
 *  scheme; a failure here is not worth interrupting a settings pane for. */
function openExternal(url: string) {
  invoke("open_external_url", { url }).catch(() => { /* ignore */ });
}

const CLOUD: { id: CloudProvider; label: string; keyHint: string; keyUrl: string; modelHint: string }[] = [
  { id: "anthropic", label: "Claude · Anthropic", keyHint: "sk-ant-…", keyUrl: "https://console.anthropic.com/settings/keys", modelHint: "e.g. claude-sonnet-5, claude-opus-4-8" },
  { id: "openai", label: "ChatGPT · OpenAI", keyHint: "sk-…", keyUrl: "https://platform.openai.com/api-keys", modelHint: "e.g. gpt-4o, gpt-4o-mini" },
];

function CloudProviderCard({ p }: { p: (typeof CLOUD)[number] }) {
  const [present, setPresent] = useState<boolean | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [model, setModel] = useState(() => loadCloudModel(p.id));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => { hasApiKey(p.id).then(setPresent).catch(() => setPresent(false)); }, []);

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
    try { await deleteApiKey(p.id); setPresent(false); setMsg({ ok: true, text: "Key removed." }); }
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

  return (
    <div className="cp-aiapi-card">
      <div className="cp-aiapi-cardhead">
        <span className="cp-aiapi-name">{p.label}</span>
        {present && <span className="cp-aiapi-set"><IconCheck size={12} /> Key saved</span>}
      </div>
      <label className="cp-aiapi-label">API key</label>
      <div className="cp-aiapi-row">
        <input
          type="password" className="cp-aiapi-input" value={keyInput}
          onChange={(e) => setKeyInput(e.target.value)}
          placeholder={present ? "•••••••••• (saved)" : p.keyHint}
          autoComplete="off" spellCheck={false}
        />
        <button type="button" className="btn" disabled={busy || !keyInput.trim()} onClick={save}>Save</button>
        {present && <button type="button" className="btn btn-ghost" disabled={busy} onClick={remove}>Remove</button>}
      </div>
      <label className="cp-aiapi-label">Model</label>
      <div className="cp-aiapi-row">
        <input
          type="text" className="cp-aiapi-input" value={model}
          onChange={(e) => setModel(e.target.value)} onBlur={() => setCloudModel(p.id, model)}
          placeholder={DEFAULT_CLOUD_MODEL[p.id]} spellCheck={false}
        />
        <button type="button" className="btn btn-ghost" disabled={busy || !present} onClick={test}>Test</button>
      </div>
      <div className="cp-aiapi-hints">
        <span>{p.modelHint}</span>
        <button type="button" className="cp-aiapi-link" onClick={() => openExternal(p.keyUrl)}>Get a key ↗</button>
      </div>
      {msg && (
        <p className={"cp-aiapi-msg" + (msg.ok ? " ok" : " err")}>
          {msg.ok ? <IconCheck size={12} /> : <IconAlert size={12} />} {msg.text}
        </p>
      )}
    </div>
  );
}

/**
 * Settings ▸ AI APIs — pick which provider the AI Summary + reader Analysis
 * features use. Local Qwen is the default (nothing leaves the Mac); Claude or
 * ChatGPT are opt-in with the user's own key (Keychain-stored). Choosing a
 * cloud provider is the consent that transcript text is sent to it.
 */
export function AiApiSettings() {
  const [provider, setProvider] = useState<AiProvider>(() => loadAiProvider());
  function choose(p: AiProvider) { setProvider(p); setAiProvider(p); }

  return (
    <section>
      <h3 className="cp-pane-title">AI APIs</h3>
      <p className="cp-pane-sub">
        By default, AI Summary and the reader's Analysis run the local Qwen model, so nothing
        leaves your Mac. You can instead use Claude or ChatGPT with your own API key. The key
        is stored in the macOS Keychain, never in plain text.
      </p>

      <label className="cp-aiapi-label">Use for AI features</label>
      <div className="cp-aiapi-providers" role="radiogroup" aria-label="AI provider">
        {(["local", "anthropic", "openai"] as AiProvider[]).map((p) => (
          <button
            key={p} type="button" role="radio" aria-checked={provider === p}
            className={"cp-aiapi-choice" + (provider === p ? " active" : "")}
            onClick={() => choose(p)}
          >
            {p === "local" ? "Local · Qwen" : p === "anthropic" ? "Claude" : "ChatGPT"}
          </button>
        ))}
      </div>
      {provider !== "local" && (
        <p className="cp-aiapi-warn">
          <IconAlert size={13} />
          With a cloud provider selected, the transcript text you analyze is sent to that provider each time.
        </p>
      )}

      {CLOUD.map((p) => <CloudProviderCard key={p.id} p={p} />)}
    </section>
  );
}
