import { useEffect, useId, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ProgramCaptureApp } from "../bindings/ProgramCaptureApp";
import { formatError } from "../lib/error-format";

/** The most applications one capture listens to (the helper's `Command.maxApps`). */
export const MAX_AUDIO_APPS = 16;

/**
 * Whose sound a capture carries. In a call, the default for a screen (every
 * app but Sauce Bunny) already leaves out the voices Sauce Bunny plays, and a
 * window carries only its own app; choosing apps is for exactly what is being
 * shown, such as a remote-desktop viewer, and nothing else. `apps` undefined
 * is the kind's default; an empty list is a choice still being made.
 */
export function ProgramCaptureAudioSource({ kind, apps, onChange, disabled }: {
  kind: "screen" | "window" | "region"; apps: string[] | undefined; onChange: (apps: string[] | undefined) => void; disabled: boolean;
}) {
  const selectId = useId();
  const [running, setRunning] = useState<ProgramCaptureApp[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [request, setRequest] = useState(0);
  const choosing = apps !== undefined;

  useEffect(() => {
    if (!choosing) return;
    let live = true;
    setError(null);
    invoke<ProgramCaptureApp[]>("program_capture_audio_apps")
      .then(list => { if (live) setRunning(list ?? []); })
      .catch(cause => { if (live) setError(formatError(cause)); });
    return () => { live = false; };
  }, [choosing, request]);

  // A chosen app that has since quit stays listed, so unticking it is still possible.
  const listed = [...(running ?? []), ...(apps ?? []).filter(bundle => !running?.some(app => app.bundle === bundle))
    .map(bundle => ({ bundle, name: bundle }))];
  const toggle = (bundle: string, on: boolean) => onChange(on ? [...(apps ?? []), bundle] : (apps ?? []).filter(item => item !== bundle));
  return <div className="cp-capture-audio-source">
    <label htmlFor={selectId}>Audio from</label>
    <select id={selectId} className="cp-select" value={choosing ? "apps" : "default"} disabled={disabled}
      onChange={event => onChange(event.target.value === "apps" ? [] : undefined)}>
      <option value="default">{kind === "window" ? "This app only" : "Every app except Sauce Bunny"}</option>
      <option value="apps">Only the apps I choose</option>
    </select>
    <p className="cp-capture-hint">{choosing
      ? "Only the apps ticked here are heard. Pick what you are showing, and leave out anything playing the call, so nobody hears themselves."
      : kind === "window" ? "Only the sound of the app that owns this window, and its helpers."
        : "Leaves out Sauce Bunny, so nobody in a session hears themselves, and Safari, which macOS plays through the same process."}</p>
    {choosing && <fieldset className="cp-capture-audio-apps" disabled={disabled}>
      <legend>Apps to hear</legend>
      {!running && !error && <p role="status">Looking for running apps…</p>}
      {listed.map(app => <label key={app.bundle}>
        <input type="checkbox" checked={apps.includes(app.bundle)}
          disabled={!apps.includes(app.bundle) && apps.length >= MAX_AUDIO_APPS}
          onChange={event => toggle(app.bundle, event.target.checked)}/>
        <span>{app.name}</span>
      </label>)}
      {running && !listed.length && <p>No apps are running.</p>}
      {running && apps.length === 0 && <p role="status">Tick at least one app.</p>}
      {error && <p role="alert">{error}</p>}
      <button type="button" className="cp-toolbar-disclosure" onClick={() => setRequest(value => value + 1)}>Refresh apps</button>
    </fieldset>}
  </div>;
}
