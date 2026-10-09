import { useId, useState } from "react";
import { loadUltrafast, offersUltrafast, setUltrafast } from "../lib/ai-provider";

/**
 * The ChatGPT card's speed switch: OpenAI's Ultrafast tier for every request
 * the app sends to OpenAI (AI Summary, Analysis, String Outs and its Ask).
 * Off by default because it costs about six times as much per token. OpenAI
 * offers it for gpt-6-astra (and gpt-5.6-sol in preview) and refuses the
 * whole request with any other model, so it is sent only with one of those,
 * and the row says when the chosen model is not one.
 */
export function OpenAiSpeed({ model }: { model: string }) {
  const [on, setOn] = useState(loadUltrafast);
  const id = useId();
  const offered = offersUltrafast(model);
  return (
    <div className="cp-pane-row">
      <div className="k">
        <span id={`${id}-name`}>Ultrafast</span>
        <span id={`${id}-desc`} className="desc">
          {on && !offered
            ? `${model} does not offer it, so requests go at the standard speed and price. Choose gpt-6-astra to use it.`
            : "OpenAI's fastest tier, for gpt-6-astra. Answers come several times faster and cost about six times as much."}
        </span>
      </div>
      <div className="v">
        <button
          type="button" role="switch" aria-checked={on}
          aria-labelledby={`${id}-name`} aria-describedby={`${id}-desc`}
          className={"cp-toggle-switch" + (on ? " on" : "")}
          onClick={() => { setUltrafast(!on); setOn(!on); }}
        />
      </div>
    </div>
  );
}
