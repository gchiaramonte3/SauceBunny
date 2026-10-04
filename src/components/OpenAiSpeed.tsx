import { useId, useState } from "react";
import { loadUltrafast, setUltrafast } from "../lib/ai-provider";

/**
 * The ChatGPT card's speed switch: OpenAI's Ultrafast tier for every request
 * the app sends to OpenAI (AI Summary, Analysis, String Outs and its Ask).
 * Off by default because it costs about six times as much per token. Only a
 * model that offers the tier (gpt-6-astra) accepts it; Test says so at once.
 */
export function OpenAiSpeed() {
  const [on, setOn] = useState(loadUltrafast);
  const id = useId();
  return (
    <div className="cp-aiapi-speed">
      <button
        type="button" role="switch" aria-checked={on}
        aria-labelledby={`${id}-name`} aria-describedby={`${id}-desc`}
        className={"cp-toggle-switch" + (on ? " on" : "")}
        onClick={() => { setUltrafast(!on); setOn(!on); }}
      />
      <span className="cp-aiapi-speed-text">
        <span id={`${id}-name`} className="cp-aiapi-speed-name">Ultrafast</span>
        <span id={`${id}-desc`}>OpenAI's fastest tier, for gpt-6-astra. Answers come several times faster and cost about six times as much.</span>
      </span>
    </div>
  );
}
