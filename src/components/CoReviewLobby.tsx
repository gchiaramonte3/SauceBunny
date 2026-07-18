import { useEffect, useRef, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { loadJson, saveJson } from "../lib/storage";
import { IconCrown } from "./Icons";
import {
  AUTHOR_COLOR_KEY, AUTHOR_KEY, AVATAR_COLORS, REVIEW_CHANGED_EVENT,
  initialsOf, loadReviewer,
} from "../lib/review";
import { useMediaCapture } from "../hooks/use-media-capture";
import { GreenRoomDevices } from "./GreenRoomDevices";
import type { Participant } from "./PeoplePanel";
import type { SessionState } from "../bindings/SessionState";

/**
 * The Review lobby - the GREEN ROOM. Three calm steps in one tone-card
 * column: IDENTITY (name + avatar color; returning users skip it),
 * DEVICES (GreenRoomDevices sibling: preview, selects, meter, permission
 * states), READY (host Start / join code). Saved identity + granted
 * permissions land straight on READY with a compact device strip.
 *
 * The capture opened here is THE session capture (use-media-capture's
 * module singleton) - the room's self tile and the mesh reuse it; it is
 * released when the session ends, whichever surface ended it.
 */
type Step = "identity" | "devices" | "ready";

export function CoReviewLobby({ session, localSource, participants, onStart, onJoin, onLeave }: {
  session: SessionState;
  /** A local file is loaded - guests can't receive it yet (hosting still allowed). */
  localSource: boolean;
  participants: Participant[];
  onStart: (title?: string) => void;
  onJoin: (ticket: string, name: string) => void;
  onLeave: () => void;
}) {
  const cap = useMediaCapture();
  const [copied, setCopied] = useState(false);
  const [name, setName] = useState(() => loadReviewer().name);
  const [color, setColor] = useState(() => loadReviewer().color);
  const [ticket, setTicket] = useState("");
  // Optional session name (13a follow-up): shows in the room header and on
  // every guest's side via Welcome. Last used name is the friendly default.
  const [sessionTitle, setSessionTitle] = useState(() => loadJson<string>("saucebunny.sessionTitle", ""));
  const [joining, setJoining] = useState(false);
  const [step, setStep] = useState<Step>(() => (loadReviewer().name ? "devices" : "identity"));
  const active = session.role !== "off";
  const isHost = session.role === "host";
  const joinReady = ticket.trim().length > 0 && name.trim().length > 0;

  // Returning-user fast path: saved identity + already-granted permissions
  // land on READY (a one-shot upgrade before any interaction this mount).
  const steppedRef = useRef(false);
  useEffect(() => {
    if (steppedRef.current) return;
    if (loadReviewer().name && cap.permission === "granted") setStep("ready");
  }, [cap.permission]);

  // Session over -> release the hardware (the camera light must never
  // outlive the session, whichever surface ended it).
  const prevRoleRef = useRef(session.role);
  useEffect(() => {
    if (prevRoleRef.current !== "off" && session.role === "off") cap.release();
    prevRoleRef.current = session.role;
  }, [session.role, cap]);

  // Clear the transient "Connecting…" once the session resolves either way.
  useEffect(() => { setJoining(false); }, [session.role, session.error]);

  const persistIdentity = (n: string, c: string) => {
    saveJson(AUTHOR_KEY, n);
    saveJson(AUTHOR_COLOR_KEY, c);
    try { window.dispatchEvent(new CustomEvent(REVIEW_CHANGED_EVENT)); } catch { /* non-DOM */ }
  };
  const continueIdentity = () => {
    const v = name.trim();
    if (!v) return;
    steppedRef.current = true;
    persistIdentity(v, color);
    setStep("devices");
  };
  const startSession = () => {
    const v = name.trim();
    if (v) persistIdentity(v, color);
    saveJson("saucebunny.sessionTitle", sessionTitle.trim());
    onStart(sessionTitle.trim() || undefined);
  };
  const joinSession = () => {
    const v = name.trim(); const t = ticket.trim();
    if (!v || !t) return;
    persistIdentity(v, color);
    setJoining(true);
    onJoin(t, v);
  };
  const copyCode = async () => {
    if (!session.code) return;
    try {
      await writeText(session.code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch { /* clipboard unavailable */ }
  };

  const deviceSummary = [
    cap.choice.cameraOff ? "Camera off" : (cap.devices.cameras.find((d) => d.deviceId === cap.choice.cameraId)?.label || "Default camera"),
    cap.choice.micMuted ? "Mic muted" : (cap.devices.mics.find((d) => d.deviceId === cap.choice.micId)?.label || "Default mic"),
  ].join(" · ");

  return (
    <main className="cp-coreview-lobby" aria-label="Co-Review">
      <div className="cp-colobby-inner">
        {!active && (
          <>
            <header className="cp-colobby-head">
              <h1 className="cp-colobby-title">Review together</h1>
              <p className="cp-colobby-sub">
                Watch the same source and comment in sync. Media never leaves each machine.
              </p>
            </header>

            {step === "identity" && (
              <section className="cp-colobby-card" aria-label="Your identity">
                <h2 className="cp-colobby-card-title">You</h2>
                <label className="cp-colobby-field">
                  <span className="cp-colobby-field-label">Your name</span>
                  <input className="cp-colobby-input" value={name} autoFocus
                    onChange={(e) => setName(e.target.value)} placeholder="Your name"
                    onKeyDown={(e) => { if (e.key === "Enter") continueIdentity(); }} />
                </label>
                <div className="cp-gr-swatches" role="radiogroup" aria-label="Avatar color">
                  {AVATAR_COLORS.map((c) => (
                    <button key={c} type="button" role="radio" aria-checked={color === c}
                      className={"cp-gr-swatch" + (color === c ? " picked" : "")}
                      style={{ ["--sw" as string]: c }} aria-label={`Avatar color ${c}`}
                      onClick={() => setColor(c)} />
                  ))}
                </div>
                <button type="button" className="btn btn-primary cp-colobby-cta"
                  disabled={!name.trim()} onClick={continueIdentity}>
                  Continue
                </button>
              </section>
            )}

            {step === "devices" && (
              <GreenRoomDevices cap={cap} onContinue={() => { steppedRef.current = true; setStep("ready"); }} />
            )}

            {step === "ready" && (
              <>
                <section className="cp-colobby-card" aria-label="Devices">
                  <div className="cp-gr-strip">
                    <GreenRoomThumb stream={cap.stream} />
                    <span className="cp-gr-strip-names" title={deviceSummary}>{deviceSummary}</span>
                    <button type="button" className="btn btn-ghost btn-compact"
                      onClick={() => { steppedRef.current = true; setStep("devices"); }}>
                      Change
                    </button>
                  </div>
                </section>

                <section className="cp-colobby-card">
                  <h2 className="cp-colobby-card-title">Host</h2>
                  <label className="cp-colobby-field">
                    <span className="cp-colobby-field-label">Session name</span>
                    <input className="cp-colobby-input" value={sessionTitle}
                      onChange={(e) => setSessionTitle(e.target.value)}
                      placeholder="Rough cut review" maxLength={80} />
                  </label>
                  <button type="button" className="btn btn-primary cp-colobby-cta" onClick={startSession}>
                    Start session
                  </button>
                </section>
                {localSource && (
                  <p className="cp-colobby-hint">
                    Local files can't be shared yet. Load a web URL to screen together.
                  </p>
                )}

                <section className="cp-colobby-card">
                  <h2 className="cp-colobby-card-title">Join</h2>
                  <label className="cp-colobby-field">
                    <span className="cp-colobby-field-label">Join code</span>
                    <input className="cp-colobby-input" value={ticket} spellCheck={false}
                      onChange={(e) => setTicket(e.target.value)} placeholder="Paste a join code" />
                  </label>
                  {/* P7: neutral until code + name validate, then it arms to
                      the primary green; the .join floor stops the width jump
                      while "Connecting…" is in flight. */}
                  <button type="button"
                    className={"btn " + (joinReady ? "btn-primary" : "btn-ghost") + " cp-colobby-cta join"}
                    disabled={!joinReady || joining} onClick={joinSession}>
                    {joining ? "Connecting…" : "Join"}
                  </button>
                  {session.error && <p className="cp-colobby-err" role="alert">{session.error}</p>}
                </section>

                <button type="button" className="cp-gr-editname"
                  onClick={() => { steppedRef.current = true; setStep("identity"); }}>
                  Not you? Edit name
                </button>
              </>
            )}
          </>
        )}

        {active && (
          <>
            <header className="cp-colobby-head">
              <h1 className="cp-colobby-title">
                <span className="cp-colobby-live" aria-hidden="true" />
                In session
              </h1>
            </header>

            {isHost && session.code && (
              <div className="cp-colobby-share">
                <button type="button" className="cp-keycap cp-colobby-code"
                  onClick={copyCode} aria-label="Copy invite" title="Copy the full invite">
                  {/* 13a: the invite renders COLLAPSED (SAUC- handle + first
                      groups); the click copies the full dressed ticket. */}
                  {session.code.length > 26 ? session.code.slice(0, 26) + "…" : session.code}
                </button>
                <span className={"cp-colobby-code-hint" + (copied ? " copied" : "")} aria-live="polite">
                  {copied ? "Invite copied" : "Copy invite"}
                </span>
              </div>
            )}

            <ul className="cp-colobby-people" aria-label={`In the room: ${participants.length}`}>
              {participants.map((p, i) => (
                <li key={i} className="cp-colobby-person"
                  aria-label={p.name + (p.isHost ? ", host" : "") + (p.isSelf ? ", you" : "")}>
                  <span className={"cp-colobby-avatar" + (p.isHost ? " host" : "")}
                    style={{ ["--co-color" as string]: p.color }} aria-hidden="true">
                    {initialsOf(p.name)}
                    {p.isHost && <span className="cp-colobby-crown"><IconCrown size={9} /></span>}
                  </span>
                  <span className="cp-colobby-name" title={p.name}>{p.name}</span>
                  <span className="cp-colobby-person-tag" aria-hidden="true">
                    {p.isSelf ? "You" : p.isHost ? "Host" : ""}
                  </span>
                </li>
              ))}
            </ul>

            {session.error && <p className="cp-colobby-err center" role="alert">{session.error}</p>}

            <div className="cp-colobby-actions">
              <button type="button" className="cp-colobby-leave" onClick={onLeave}>
                {isHost ? "End session" : "Leave session"}
              </button>
            </div>
          </>
        )}
      </div>
    </main>
  );
}

/** Tiny live preview thumb for the READY device strip (avatar-size). */
function GreenRoomThumb({ stream }: { stream: MediaStream | null }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    v.srcObject = stream;
    if (stream) v.play().catch(() => { /* autoplay */ });
  }, [stream]);
  if (!stream || stream.getVideoTracks().length === 0) {
    return <span className="cp-gr-strip-thumb off" aria-hidden />;
  }
  return <video ref={ref} className="cp-gr-strip-thumb" muted playsInline aria-hidden />;
}
