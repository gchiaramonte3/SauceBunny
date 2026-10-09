import { useState } from "react";
import type { CloudModel } from "../bindings/CloudModel";

type Props = {
  /** The control's id; the caller's label points at it. */
  id: string;
  value: string; onChange: (model: string) => void;
  /** The provider's list, or null before it has been fetched (a typed id until then). */
  models: CloudModel[] | null;
};

/**
 * One model choice in Settings ▸ AI APIs: every model the editor's key can
 * call, from the provider's own list, chat models first and newest first,
 * the rest under "Other models". A model the list does not show (one newer
 * than the list, or a typed id) stays chosen and says so, and "Type a model
 * id…" takes any id by hand.
 */
export function CloudModelPicker({ id, value, onChange, models }: Props) {
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState(value);
  const listed = !!models?.some((model) => model.id === value);
  const name = (model: CloudModel) => model.name ? `${model.name} · ${model.id}` : model.id;
  const choose = (next: string) => { if (next === TYPE) { setDraft(value); setTyping(true); } else if (next !== CURRENT) onChange(next); };
  return models && !typing
    ? <select id={id} className="cp-select cp-aiapi-select" value={listed ? value : CURRENT} onChange={(event) => choose(event.target.value)}>
      {!listed && <option value={CURRENT}>{value} (not in the list)</option>}
      <optgroup label="Chat models">{models.filter((model) => model.chat).map((model) => <option key={model.id} value={model.id}>{name(model)}</option>)}</optgroup>
      {models.some((model) => !model.chat) && <optgroup label="Other models">{models.filter((model) => !model.chat).map((model) => <option key={model.id} value={model.id}>{name(model)}</option>)}</optgroup>}
      <option value={TYPE}>Type a model id…</option>
    </select>
    : <input id={id} type="text" className="cp-aiapi-input" value={draft} spellCheck={false}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => { if (draft.trim()) onChange(draft.trim()); setTyping(false); }}
      onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") { setDraft(value); setTyping(false); } }} />;
}

const CURRENT = "__current", TYPE = "__type";
