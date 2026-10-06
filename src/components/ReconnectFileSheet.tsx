import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { LocalFileMeta } from "../bindings/LocalFileMeta";
import type { MediaAvailability } from "../bindings/MediaAvailability";
import { useModalFocus } from "../hooks/use-modal-focus";
import { useTauriListeners } from "../hooks/use-tauri-listeners";
import { formatError } from "../lib/error-format";
import { AUDIO_EXTENSIONS, VIDEO_EXTENSIONS } from "../lib/import-extensions";
import { dirOf, pathKey } from "../lib/repath";
import { othersThatMoved, reconnectFiles, storedPathsUnder } from "../lib/relink";
import { fileDifferences } from "../lib/media-offline";

export type ReconnectRequest = { path: string; title: string; durationSeconds?: number | null };
type Step = { kind: "checking" } | { kind: "waiting"; volume: string } | { kind: "ask" }
  | { kind: "differs"; picked: string; differences: string[] } | { kind: "working" };

/**
 * "Where is this file?" (docs/RECONNECT-MEDIA-SPEC-2026-10-05.md, phase 2).
 * A file on a drive that is not connected waits for the drive and opens by
 * itself; a file that moved is located, checked against what was last known
 * about it, and the other files that moved with it are reconnected too, as
 * one undo. Nothing is written until a file is chosen and accepted.
 */
export function ReconnectFileSheet({ request, known, onDone, onCancel }: {
  request: ReconnectRequest; known: readonly string[];
  onDone: (path: string, others: number) => void; onCancel: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useModalFocus(true, ref);
  const [step, setStep] = useState<Step>({ kind: "checking" });
  const [others, setOthers] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const folder = dirOf(request.path);

  const check = useCallback(async () => {
    const [file] = await invoke<MediaAvailability[]>("media_availability", { paths: [request.path] }).catch(() => []) ?? [];
    if (file?.state === "online") { onDone(request.path, 0); return; }
    setStep(file?.state === "driveOffline" ? { kind: "waiting", volume: file.volume ?? "Its drive" } : { kind: "ask" });
  }, [request.path, onDone]);
  useEffect(() => { void check(); }, [check]);
  useTauriListeners((on) => {
    const onMediaVolumesChanged = () => { void check(); };
    on("media:volumes-changed", onMediaVolumesChanged);
  }, [check]);

  const accept = async (picked: string) => {
    setStep({ kind: "working" }); setError(null);
    const pairs: [string, string][] = [[pathKey(request.path), pathKey(picked)]];
    const candidates = others ? othersThatMoved(request.path, picked, storedPathsUnder(folder, known)).slice(0, 999) : [];
    if (candidates.length) {
      // Only files that are gone from the old place AND present at the new one move.
      const answers = await invoke<MediaAvailability[]>("media_availability", { paths: candidates.flat() }).catch(() => []) ?? [];
      const state = new Map(answers.map((answer) => [answer.path, answer]));
      for (const [from, to] of candidates) {
        if (state.get(from)?.state !== "online" && state.get(to)?.state === "online" && !state.get(to)?.folder) pairs.push([from, to]);
      }
    }
    reconnectFiles(pairs);
    onDone(pathKey(picked), pairs.length - 1);
  };

  const locate = async () => {
    setError(null);
    try {
      const picked = await open({ multiple: false, directory: false, title: `Locate ${request.title}`,
        filters: [{ name: "Media", extensions: [...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS] }] });
      if (typeof picked !== "string") return;
      setStep({ kind: "working" });
      const meta = await invoke<LocalFileMeta>("probe_local_file", { path: picked });
      const differences = fileDifferences(request, meta);
      if (differences.length) setStep({ kind: "differs", picked, differences });
      else await accept(picked);
    } catch (cause) { setError(formatError(cause)); setStep({ kind: "ask" }); }
  };

  const busy = step.kind === "working" || step.kind === "checking";
  const name = request.path.split("/").pop() ?? request.title;
  return createPortal(<div className="cp-rowmenu-scrim modal" onPointerDown={(event) => { if (!busy && event.target === event.currentTarget) onCancel(); }}
    onKeyDown={(event) => { if (event.key === "Escape" && !busy) { event.stopPropagation(); onCancel(); } }}>
    <div ref={ref} tabIndex={-1} className="cp-rowmenu-dialog cp-project-dialog" role="dialog" aria-modal="true" aria-label={`Where is ${name}?`}>
      <h4 className="cp-rowmenu-title">{step.kind === "waiting" ? `${step.volume} is not connected` : `Where is ${name}?`}</h4>
      {step.kind === "checking" && <p className="cp-project-help" role="status">Looking for it…</p>}
      {step.kind === "waiting" && <p className="cp-project-help" role="status">
        It is on {step.volume}, which is not connected. Connect it and the file opens by itself.</p>}
      {(step.kind === "ask" || step.kind === "working") && <p className="cp-project-help">
        It was in <span className="cp-reconnect-path">{folder}</span>, and it is not there now.</p>}
      {step.kind === "differs" && <>
        <p className="cp-project-help">This file is not the same as the one that went offline:</p>
        <ul className="cp-reconnect-differences">{step.differences.map((line) => <li key={line}>{line}</li>)}</ul>
      </>}
      {step.kind !== "waiting" && step.kind !== "checking" && <label className="cp-reconnect-option">
        <input type="checkbox" checked={others} disabled={busy} onChange={(event) => setOthers(event.target.checked)}/>
        Reconnect other offline files that moved with it
      </label>}
      {error && <p className="cp-project-error" role="alert">{error}</p>}
      <div className="cp-rowmenu-actions">
        <button className="btn btn-ghost" disabled={busy} onClick={onCancel}>Cancel</button>
        {step.kind === "differs"
          ? <><button className="btn btn-ghost" onClick={() => void locate()}>Choose another…</button>
            <button className="btn" onClick={() => void accept(step.picked)}>Use this file anyway</button></>
          : <button className="btn" disabled={busy} onClick={() => void locate()}>
            {step.kind === "working" ? "Reconnecting…" : step.kind === "waiting" ? "Locate elsewhere…" : "Locate file…"}</button>}
      </div>
    </div>
  </div>, document.body);
}
