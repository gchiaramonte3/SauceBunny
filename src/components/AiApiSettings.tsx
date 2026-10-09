import { useState, type CSSProperties } from "react";
import { IconInfo } from "./Icons";
import { AssistantAccess } from "./AssistantAccess";
import { CloudProviderCard, type CloudProviderInfo } from "./CloudProviderCard";
import { loadAiProvider, setAiProvider, type AiProvider } from "../lib/ai-provider";

const CLOUD: Record<Exclude<AiProvider, "local">, CloudProviderInfo> = {
  anthropic: { id: "anthropic", label: "Claude · Anthropic", company: "Anthropic", keyHint: "sk-ant-…", keyUrl: "https://console.anthropic.com/settings/keys" },
  openai: { id: "openai", label: "ChatGPT · OpenAI", company: "OpenAI", keyHint: "sk-…", keyUrl: "https://platform.openai.com/api-keys" },
};
const CHOICES: { id: AiProvider; label: string }[] = [
  { id: "local", label: "Local · Qwen" }, { id: "anthropic", label: "Claude" }, { id: "openai", label: "ChatGPT" },
];

type Props = { onOpenAiSummary: () => void };

/**
 * Settings ▸ AI APIs: which provider the AI features use, and that
 * provider's settings beneath it. Local Qwen is the default (nothing leaves
 * the Mac); Claude or ChatGPT are opt-in with the user's own key
 * (Keychain-stored). Choosing a cloud provider is the consent that
 * transcript text is sent to it.
 *
 * Both providers' cards used to show whatever was chosen, so the choice
 * looked like tabs that did nothing. Only the chosen one is shown now; the
 * other's key stays in the Keychain.
 */
export function AiApiSettings({ onOpenAiSummary }: Props) {
  const [provider, setProvider] = useState<AiProvider>(() => loadAiProvider());
  function choose(p: AiProvider) { setProvider(p); setAiProvider(p); }
  const active = CHOICES.findIndex((choice) => choice.id === provider);

  return (
    <section>
      <h3 className="cp-pane-title">AI APIs</h3>
      <p className="cp-pane-sub">
        Choose what runs AI Summary, Analysis, and Ask and Search with AI. Local keeps everything on your Mac.
        Claude and ChatGPT use your own API key.
      </p>
      <div className="cp-pane-row cp-aiapi-provider">
        <div className="k">Provider<span className="desc">Used by every AI feature in the app.</span></div>
        <div className="v">
          <div className="cp-segmented" role="radiogroup" aria-label="AI provider"
            style={{ "--seg-active": active, "--seg-count": CHOICES.length } as CSSProperties}>
            {CHOICES.map((choice) => <button key={choice.id} type="button" role="radio" aria-checked={provider === choice.id}
              className={provider === choice.id ? "active" : ""} onClick={() => choose(choice.id)}>{choice.label}</button>)}
          </div>
        </div>
      </div>

      {provider === "local"
        ? <div className="cp-aiapi-card" role="group" aria-labelledby="aiapi-local-name">
          <div className="cp-aiapi-cardhead"><span id="aiapi-local-name" className="cp-aiapi-name">Local · Qwen</span><span className="cp-aiapi-status">On this Mac</span></div>
          <p className="cp-aiapi-note"><IconInfo size={13} /> AI features run on your Mac with the local model. Nothing is sent anywhere, and no key is needed.</p>
          <div className="cp-pane-row">
            <div className="k">Local model<span className="desc">Downloaded and chosen in AI Summary.</span></div>
            <div className="v"><button type="button" className="btn btn-ghost" onClick={onOpenAiSummary}>Open AI Summary</button></div>
          </div>
        </div>
        : <CloudProviderCard key={provider} p={CLOUD[provider]} />}

      <p className="cp-aiapi-section">Other apps</p>
      <AssistantAccess />
    </section>
  );
}
