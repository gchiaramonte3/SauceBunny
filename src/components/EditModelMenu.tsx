import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import type { LlmModel } from "../bindings/LlmModel";
import { hasApiKey, type CloudProvider } from "../lib/ai-provider";
import { CLOUD_NAMES, type StringOutModel } from "../lib/string-out-model";

type Props = { value: StringOutModel; appLocalModelId: string | null | undefined; disabled: boolean; onChange: (model: StringOutModel) => void; onSettings: () => void };

const CLOUDS: CloudProvider[] = ["anthropic", "openai"];

/**
 * Which model String Outs asks. Local models are the ones downloaded on this
 * Mac; Claude and ChatGPT appear once their key is in Settings. The choice
 * belongs to String Outs alone.
 */
export function EditModelMenu({ value, appLocalModelId, disabled, onChange, onSettings }: Props) {
  const [local, setLocal] = useState<LlmModel[]>([]);
  const [keys, setKeys] = useState<Partial<Record<CloudProvider, boolean>>>({});
  useEffect(() => {
    let live = true;
    invoke<LlmModel[]>("list_llm_models").then((models) => { if (live) setLocal(models.filter((model) => model.downloaded)); }).catch(() => undefined);
    for (const provider of CLOUDS) hasApiKey(provider).then((has) => { if (live) setKeys((state) => ({ ...state, [provider]: has })); }).catch(() => undefined);
    return () => { live = false; };
  }, []);
  const localId = value.kind === "local" ? value.id ?? appLocalModelId ?? local.find((model) => model.recommended)?.id ?? local[0]?.id ?? "" : "";
  const selected = value.kind === "cloud" ? `cloud:${value.provider}` : `local:${localId}`;
  return <div className="cp-te-model">
    <select className="cp-select cp-te-model-pick" aria-label="Model for String Outs" title="The model String Outs asks. Other AI features keep their own." value={selected} disabled={disabled}
      onChange={(event) => {
        const [kind, id] = event.target.value.split(/:(.*)/s);
        onChange(kind === "cloud" ? { kind: "cloud", provider: id as CloudProvider } : { kind: "local", id: id || null });
      }}>
      <optgroup label="On this Mac">
        {local.length ? local.map((model) => <option key={model.id} value={`local:${model.id}`}>{model.name}</option>)
          : <option value={`local:${localId}`} disabled>No local model</option>}
      </optgroup>
      <optgroup label="Cloud, with your key">
        {CLOUDS.map((provider) => <option key={provider} value={`cloud:${provider}`} disabled={!keys[provider]}>
          {CLOUD_NAMES[provider]}{keys[provider] ? "" : " (add a key in Settings → AI APIs)"}</option>)}
      </optgroup>
    </select>
    <button type="button" className="btn btn-ghost cp-te-btn" onClick={onSettings} title="Download local models or add API keys">AI settings</button>
  </div>;
}
