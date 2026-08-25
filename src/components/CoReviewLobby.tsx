import { useEffect, useRef, useState } from "react";
import { loadJson, saveJson } from "../lib/storage";
import { ColorSwatches } from "./ColorSwatches";
import { IconChevronRight, IconCrown, IconLink, IconPlay } from "./Icons";
import {
  AUTHOR_COLOR_KEY, AUTHOR_KEY, AVATAR_COLORS, REVIEW_CHANGED_EVENT,
  initialsOf, loadReviewer,
} from "../lib/review";
import { useMediaCapture } from "../hooks/use-media-capture";
import { GreenRoomDevices } from "./GreenRoomDevices";
import type { Participant } from "./PeoplePanel";
import type { SessionState } from "../bindings/SessionState";
import { shortJoinCode } from "../lib/join-code";
import { ScreeningShelf } from "./ScreeningShelf";
import { hydrateScreeningIndex, listScreenings, SCREENINGS_CHANGED } from "../lib/screening-store";
import { isSessionNameTaken, nextFreeSessionName } from "../lib/session-name";

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
  /** Resolves when the attempt has ENDED, succeeded or not — the lobby
   *  needs that to clear "Connecting…". */
  onJoin: (ticket: string, name: string) => void | Promise<void>;
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
    // !cap.stream: once the user has enabled devices this session, the
    // grant flipping to "granted" must NOT bounce them off the DEVICES step.
    if (loadReviewer().name && cap.permission === "granted" && !cap.stream) setStep("ready");
    // cap.stream belongs here: when it arrives the `!cap.stream` guard turns
    // this into a no-op, which is the intended behaviour - it was simply
    // reading a stale value to decide that.
  }, [cap.permission, cap.stream]);

  // Session over -> release the hardware (the camera light must never
  // outlive the session, whichever surface ended it).
  const prevRoleRef = useRef(session.role);
  useEffect(() => {
    if (prevRoleRef.current !== "off" && session.role === "off") cap.release();
    prevRoleRef.current = session.role;
  }, [session.role, cap]);

  // Clear the transient "Connecting…" once the session resolves either way.
  //
  // This alone was NOT enough, and the gap locked people out. A failed join
  // (a wrong or expired code — the ordinary first-run mistake) is caught
  // inside joinCoReview, which only raises a notification; it never touches
  // `role` or `error`, so neither dependency changes, this effect never
  // re-runs, and the button stays disabled at "Connecting…" for the rest of
  // the session. The only way back was quitting the app. joinSession now
  // clears it in a `finally` as well, so the button always comes back.
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
  /**
   * EVERY SCREENING GETS ITS OWN NAME.
   *
   * The lobby restores the last session's title and nothing stopped Start
   * being pressed on it again, so a week of reviews came back as five rows
   * all called the same thing - a history you cannot read, because the one
   * field that tells sessions apart was identical in all of them.
   *
   * The titles are read once here rather than shared with ScreeningShelf:
   * the shelf renders nothing until there IS history and can be folded away
   * entirely, so the rule cannot depend on it having mounted.
   */
  const [takenTitles, setTakenTitles] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    const read = () => {
      void hydrateScreeningIndex()
        .then(() => { if (alive) setTakenTitles(listScreenings().map((r) => r.title)); })
        // No folder yet is the normal first-run state: nothing is taken.
        .catch(() => { if (alive) setTakenTitles([]); });
    };
    read();
    // AND AGAIN WHENEVER ONE IS SAVED. This lobby is kept alive under [hidden]
    // for the life of the app, so a list read once at mount goes stale the
    // moment a session ends - end "Rough cut", press Start again on the
    // restored title, and the rule waves through a second "Rough cut". A
    // reload blocked it correctly, which is what made it look like it worked.
    window.addEventListener(SCREENINGS_CHANGED, read);
    return () => { alive = false; window.removeEventListener(SCREENINGS_CHANGED, read); };
  }, []);

  const titleTaken = isSessionNameTaken(sessionTitle, takenTitles);
  const suggestion = titleTaken ? nextFreeSessionName(sessionTitle, takenTitles) : "";

  const startSession = () => {
    // Belt and braces: the button is disabled, but Enter in the field and a
    // future call site should both meet the same rule.
    if (titleTaken) return;
    const v = name.trim();
    if (v) persistIdentity(v, color);
    saveJson("saucebunny.sessionTitle", sessionTitle.trim());
    onStart(sessionTitle.trim() || undefined);
  };
  const joinSession = async () => {
    const v = name.trim(); const t = ticket.trim();
    if (!v || !t) return;
    persistIdentity(v, color);
    setJoining(true);
    // Catch as well as finally. `joinCoReview` reports its own failure as a
    // notification and resolves, but the lobby must not DEPEND on that: if the
    // handler ever rejects, an uncaught rejection here is a console error the
    // user cannot see and the button state is the only thing they can.
    // Reporting stays the handler's job; clearing the button is this one's.
    try { await onJoin(t, v); } catch { /* surfaced by the handler */ }
    finally { setJoining(false); }
  };
  const copyCode = async () => {
    if (!session.code) return;
    try {
      await navigator.clipboard.writeText(session.code);
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
              {/* One sentence per line. As a single run it wrapped wherever the
                  44ch measure fell, which was mid-sentence, so the break read as
                  a mistake rather than as structure. Separate blocks put the
                  break where the meaning already is, and each sentence still
                  wraps on its own if the window gets narrow. */}
              <p className="cp-colobby-sub">
                <span>Watch the same source and comment in sync.</span>
                {/* NOT "media never leaves each machine": this is the screen
                    where you are about to send media to another machine, and
                    on a relayed path it travels through n0's relay too
                    (encrypted, capped at the lowest rung). The true and still
                    reassuring claim is the one about servers. */}
                <span>No server sees it. No account, no upload.</span>
              </p>
            </header>

            {(["identity", "devices", "ready"] as const).includes(step) && (
              <nav className="cp-gr-trail" aria-label="Setup steps">
                {([["identity", "You"], ["devices", "Devices"], ["ready", "Ready"]] as const).map(([id, lbl], i) => (
                  <span key={id} className={"cp-gr-trail-step" + (step === id ? " here" : "")}>
                    {i > 0 && <IconChevronRight size={9} className="cp-gr-trail-sep" />}
                    {lbl}
                  </span>
                ))}
              </nav>
            )}
            {step === "identity" && (
              <section className="cp-colobby-card" aria-label="Your identity">
                <h2 className="cp-colobby-card-title">You</h2>
                <label className="cp-colobby-field">
                  <span className="cp-colobby-field-label">Your name</span>
                  {/* Capped like the session title beside it (80). Every peer
                      sees this on each reaction and in the roster; unbounded, it
                      was the one user string with no limit at either end. */}
                  <input className="cp-colobby-input" value={name} autoFocus maxLength={40}
                    onChange={(e) => setName(e.target.value)} placeholder="Your name"
                    onKeyDown={(e) => { if (e.key === "Enter") continueIdentity(); }} />
                </label>
                <ColorSwatches colors={AVATAR_COLORS} value={color} onPick={setColor} ariaLabel="Avatar color" />
                <button type="button" className="btn cp-colobby-cta"
                  disabled={!name.trim()} onClick={continueIdentity}>
                  Continue <IconChevronRight size={12} />
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
                    <GreenRoomThumb stream={cap.stream} cameraOff={cap.choice.cameraOff} />
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
                    <input
                      className={"cp-colobby-input" + (titleTaken ? " taken" : "")}
                      value={sessionTitle}
                      onChange={(e) => setSessionTitle(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter" && !titleTaken) startSession(); }}
                      placeholder="Rough cut review"
                      maxLength={80}
                      aria-invalid={titleTaken || undefined}
                      aria-describedby={titleTaken ? "cp-colobby-title-taken" : undefined}
                    />
                  </label>
                  {titleTaken && (
                    <p className="cp-colobby-taken" id="cp-colobby-title-taken" role="alert">
                      You have already screened a session with that name.
                      {suggestion && (
                        <button
                          type="button"
                          className="cp-colobby-taken-fix"
                          onClick={() => setSessionTitle(suggestion)}
                        >
                          Use &ldquo;{suggestion}&rdquo;
                        </button>
                      )}
                    </p>
                  )}
                  <button
                    type="button"
                    className="btn cp-colobby-cta"
                    onClick={startSession}
                    disabled={titleTaken}
                    title={titleTaken ? "Give this session a name of its own" : undefined}
                  >
                    <IconPlay size={12} /> Start session
                  </button>
                </section>
                {localSource && (
                  /* This said "Local files can't be shared yet. Load a web URL
                     to screen together." — telling a host to abandon the exact
                     workflow the app implements. Offering a local file, a
                     guest watching it as a live stream, and a guest fetching a
                     verified copy all ship (use-co-review's offerCurrentFile
                     and the two guest paths). Screening a local rough cut with
                     a producer IS the job; the string was left behind by the
                     version that could not do it. */
                  <p className="cp-colobby-hint">
                    Your file stays on this Mac. Once the session starts you can offer it,
                    and each person chooses whether to watch it streamed or take a copy.
                  </p>
                )}


                <section className="cp-colobby-card">
                  <h2 className="cp-colobby-card-title">Join</h2>
                  <label className="cp-colobby-field">
                    <span className="cp-colobby-field-label">Join code</span>
                    <input className="cp-colobby-input" value={ticket} spellCheck={false}
                      onChange={(e) => setTicket(e.target.value)} placeholder="Paste a join code" />
                  </label>
                  {/* Grey chip like every lobby action (no green here, ever);
                      disabled carries the gating, the .join floor stops the
                      width jump while "Connecting…" is in flight. */}
                  <button type="button"
                    className="btn cp-colobby-cta join"
                    disabled={!joinReady || joining} onClick={() => { void joinSession(); }}>
                    <IconLink size={12} /> {joining ? "Connecting…" : "Join"}
                  </button>
                  {session.error && <p className="cp-colobby-err" role="alert">{session.error}</p>}
                </section>

                {/* AFTER both verbs, not between them. Past sessions are
                    history; Host and Join are what this screen is for, and a
                    list that grows without limit sat in the middle of them and
                    pushed Join off the bottom. */}
                <ScreeningShelf />

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
                  onClick={copyCode} aria-label="Copy the full invite" title="Copy the full invite">
                  {/* The invite renders COLLAPSED (SAUC- handle + first
                      groups); the click copies the full dressed ticket. Cut on
                      a GROUP boundary - a character cut left a fragment that
                      reads as a typo. */}
                  {shortJoinCode(session.code)}
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
function GreenRoomThumb({ stream, cameraOff }: { stream: MediaStream | null; cameraOff: boolean }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    v.srcObject = stream;
    if (stream) v.play().catch(() => { /* autoplay */ });
  }, [stream]);
  if (!stream || stream.getVideoTracks().length === 0 || cameraOff) {
    // cameraOff: the track exists but is disabled - a live <video> would
    // render solid black, not the styled placeholder.
    return <span className="cp-gr-strip-thumb off" aria-hidden />;
  }
  return <video ref={ref} className="cp-gr-strip-thumb" muted playsInline aria-hidden />;
}
