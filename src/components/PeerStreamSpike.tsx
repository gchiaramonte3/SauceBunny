import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { MSEStreamPlayer } from "./MSEStreamPlayer";
import type { PlayerHandle } from "./player-handle";
import { formatError } from "../lib/error-format";
import { asLogTag, type LogTag } from "../types";

/**
 * DEV-ONLY Tier B phase 3a proof (_design/p2p-media-plan.md): the presenter
 * plays its OWN local file through the proxy's peer routes with the real
 * MSEStreamPlayer. No network, no second machine — this isolates exactly one
 * claim: `serve_fmp4` works on local input, end to end through the production
 * player. Renders only in dev builds when localStorage
 * saucebunny.devPeerStream === "1".
 *
 * Pass criteria (drive them by hand, watch the Pipeline log channel "peer"):
 *   1. Picture AND audio play (ffmpeg's remux carries both).
 *   2. A far seek lands exactly (X-Timeline "absolute" via the epoch probe —
 *      risk R8 says a local probe must not silently fall back to rebased).
 *   3. The scrub preview paints while dragging (raw route Range access).
 */
export function PeerStreamSpike({ localFilePath, duration, onClose, appendLog }: {
  /** The loaded local source (Clip view) — the file the spike streams. */
  localFilePath: string | null;
  duration: number | null;
  onClose: () => void;
  appendLog: (tag: LogTag, channel: string, line: string) => void;
}) {
  const [reg, setReg] = useState<{ id: string; url: string } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const playerRef = useRef<PlayerHandle>(null);
  const regIdRef = useRef<string | null>(null);

  const start = async () => {
    if (!localFilePath) return;
    try {
      const r = await invoke<{ id: string; url: string }>("peer_media_register", { path: localFilePath });
      regIdRef.current = r.id;
      setReg(r);
      setErr(null);
      appendLog("ok", "peer", `3a: registered peer media ${r.id.slice(0, 8)}…`);
    } catch (e) {
      setErr(formatError(e));
    }
  };

  // The registration dies with the panel: leaving the spike open must not
  // leave the file reachable on the route.
  useEffect(() => () => {
    const id = regIdRef.current;
    if (id) void invoke("peer_media_unregister", { id }).catch(() => { /* proxy gone */ });
  }, []);

  return (
    <div className="cp-spike">
      <div className="cp-spike-head">
        <strong>Peer stream spike (Tier B 3a)</strong>
        <button type="button" className="btn btn-ghost btn-compact" onClick={onClose}>Close</button>
      </div>
      <p className="cp-spike-note">
        Streams the loaded local file through the proxy peer route with the
        real MSE player. Check picture, audio, a far seek landing exactly, and
        the scrub preview while dragging.
      </p>
      {!reg && (
        <button
          type="button"
          className="btn btn-ghost"
          disabled={!localFilePath}
          onClick={() => { void start(); }}
        >
          {localFilePath ? "Stream the loaded file" : "Load a local file first"}
        </button>
      )}
      {err && <p className="cp-spike-err">{err}</p>}
      {reg && (
        <div className="cp-spike-stage">
          <MSEStreamPlayer
            ref={playerRef}
            path={reg.url}
            hasVideo
            initialVolume={1}
            knownDuration={duration ?? undefined}
            onDiag={(tag, line) => appendLog(asLogTag(tag), "peer", line)}
            onReady={(d) => appendLog("ok", "peer", `3a: pipeline open, duration ${d.toFixed(2)}s`)}
            onError={(m) => { setErr(m); appendLog("err", "peer", `3a: ${m}`); }}
          />
        </div>
      )}
    </div>
  );
}
