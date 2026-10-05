import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { VoiceprintSummary } from "../bindings/VoiceprintSummary";
import { formatError } from "../lib/error-format";

/**
 * Settings ▸ Transcription ▸ Voiceprints. The voice check learns what each
 * mic's owner sounds like (accuracy spec, phase 4). Voiceprints are biometric
 * data, so the editor can always see how many are kept and delete them all.
 */
export function VoiceprintSettings() {
  const [summary, setSummary] = useState<VoiceprintSummary | null>(null);
  const [armed, setArmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const none = { documents: 0, voices: 0 };
    invoke<VoiceprintSummary | null>("voiceprints_summary").then((value) => setSummary(value ?? none)).catch(() => setSummary(none));
  }, []);
  async function remove() {
    setError(null);
    try { await invoke("delete_voiceprints"); setSummary({ documents: 0, voices: 0 }); }
    catch (cause) { setError(formatError(cause)); }
    finally { setArmed(false); }
  }
  return <>
    <p className="cp-settings-note">
      Check voices, in AAF Audio, learns what each mic's owner sounds like from that sequence alone, to tell their
      lines from what their mic picked up from others. Voiceprints stay on this Mac, outside your Documents folder,
      and are never sent anywhere or shown to an assistant.
    </p>
    <div className="cp-folder-row">
      <span className="cp-folder-path" role="status">{!summary ? "Checking…" : summary.voices ? `${summary.voices} ${summary.voices === 1 ? "voice" : "voices"} from ${summary.documents} ${summary.documents === 1 ? "sequence" : "sequences"}` : "No voiceprints are kept."}</span>
      {!!summary?.voices && <button type="button" className={"btn btn-ghost" + (armed ? " armed" : "")} onClick={() => { if (armed) void remove(); else setArmed(true); }}
        aria-label={armed ? "Confirm deleting every voiceprint" : "Delete every voiceprint"}>{armed ? "Delete every voiceprint?" : "Delete all"}</button>}
    </div>
    {error && <p className="cp-settings-note" role="alert">{error}</p>}
  </>;
}
