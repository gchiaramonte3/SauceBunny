import { useEffect, useId, useRef, useState } from "react";
import { loadJson, saveJson } from "../lib/storage";
import { ColorSwatches } from "./ColorSwatches";
import { IconCrown, IconLink, IconPlay } from "./Icons";
import { AUTHOR_COLOR_KEY, AUTHOR_KEY, AVATAR_COLORS, REVIEW_CHANGED_EVENT, initialsOf, loadReviewer } from "../lib/review";
import { useMediaCapture } from "../hooks/use-media-capture";
import { GreenRoomDevices } from "./GreenRoomDevices";
import type { Participant } from "./PeoplePanel";
import type { SessionState } from "../bindings/SessionState";
import { shortJoinCode } from "../lib/join-code";
import { hydrateScreeningIndex, listScreenings, SCREENINGS_CHANGED } from "../lib/screening-store";
import { isSessionNameTaken, nextFreeSessionName } from "../lib/session-name";
import { reviewInviteMessage } from "../lib/review-link";
import { ReviewGrants } from "./ReviewGrants";
import "../styles/co-review-setup.css";

type SetupMode = "host" | "join";
type Editor = "identity" | "devices" | null;

/** Setup sits beside the existing monitor. Entering Review or previewing
 * Premiere never acquires conversation devices: their editor is explicit. */
export function CoReviewLobby({ session, localSource, participants, onStart, onJoin, onLeave, initialCode, onInitialCodeUsed, defaultTitle, onConnectPremiere, premierePreviewName, premierePreviewStatus, onOpenSessionHistory }: {
  session: SessionState;
  localSource: boolean;
  participants: Participant[];
  onStart: (title?: string) => void;
  /** Resolve when the attempt ends, including an already reported failure. */
  onJoin: (ticket: string, name: string) => void | Promise<void>;
  /** A received link fills Join without joining or acquiring devices. */
  initialCode?: string | null;
  onInitialCodeUsed?: () => void;
  onLeave: () => void;
  defaultTitle: string;
  onConnectPremiere?: () => void;
  premierePreviewName?: string | null;
  premierePreviewStatus?: string;
  onOpenSessionHistory?: () => void;
}) {
  const cap = useMediaCapture();
  const id = useId();
  const [copied, setCopied] = useState(false);
  const [name, setName] = useState(() => loadReviewer().name);
  const [color, setColor] = useState(() => loadReviewer().color);
  const [ticket, setTicket] = useState("");
  const [mode, setMode] = useState<SetupMode>("host");
  const [editor, setEditor] = useState<Editor>(() => loadReviewer().name ? null : "identity");
  const [sessionTitle, setSessionTitle] = useState(() => loadJson<string>("saucebunny.sessionTitle", "") || defaultTitle);
  const [joining, setJoining] = useState(false);
  const [takenTitles, setTakenTitles] = useState<string[]>([]);
  const [titlesReady, setTitlesReady] = useState(false);
  const titleEditedRef = useRef(false);
  const changeButtonRef = useRef<HTMLButtonElement>(null);
  const defaultTitleRef = useRef(defaultTitle);
  defaultTitleRef.current = defaultTitle;
  const active = session.role !== "off";
  const isHost = session.role === "host";
  const effectiveTitle = sessionTitle.trim() || defaultTitle;
  const titleTaken = isSessionNameTaken(effectiveTitle, takenTitles);
  const suggestion = titleTaken ? nextFreeSessionName(effectiveTitle, takenTitles) : "";
  const joinReady = ticket.trim().length > 0 && name.trim().length > 0;

  // This panel survives room navigation. A late disk read may suggest a
  // name, never overwrite a user's edit; overlapping reads cannot regress it.
  useEffect(() => {
    let alive = true;
    let revision = 0;
    const read = () => {
      const request = ++revision;
      void hydrateScreeningIndex().then(() => listScreenings().map((r) => r.title))
        .catch(() => [] as string[])
        .then((titles) => {
          if (!alive || request !== revision) return;
          setTakenTitles(titles);
          setTitlesReady(true);
          if (!titleEditedRef.current) setSessionTitle((current) => nextFreeSessionName(current.trim() || defaultTitleRef.current, titles));
        });
    };
    read();
    window.addEventListener(SCREENINGS_CHANGED, read);
    return () => { alive = false; window.removeEventListener(SCREENINGS_CHANGED, read); };
  }, []);

  const prevRoleRef = useRef(session.role);
  useEffect(() => {
    if (prevRoleRef.current !== "off" && session.role === "off") {
      cap.release();
      titleEditedRef.current = false;
      setSessionTitle((current) => nextFreeSessionName(current.trim() || defaultTitle, takenTitles));
    }
    prevRoleRef.current = session.role;
  }, [session.role, cap, defaultTitle, takenTitles]);
  useEffect(() => { setJoining(false); }, [session.role, session.error]);

  const persistIdentity = (n: string, c: string) => {
    saveJson(AUTHOR_KEY, n);
    saveJson(AUTHOR_COLOR_KEY, c);
    try { window.dispatchEvent(new CustomEvent(REVIEW_CHANGED_EVENT)); } catch { /* non-DOM */ }
  };
  const finishIdentity = () => {
    if (!name.trim()) return;
    persistIdentity(name.trim(), color);
    setEditor(null);
    changeButtonRef.current?.focus();
  };
  const startSession = () => {
    if (!titlesReady || titleTaken || !name.trim()) return;
    persistIdentity(name.trim(), color);
    saveJson("saucebunny.sessionTitle", effectiveTitle);
    onStart(effectiveTitle);
  };
  const joinSession = async () => {
    const n = name.trim(), t = ticket.trim();
    if (!n || !t || joining) return;
    persistIdentity(n, color);
    setJoining(true);
    try { await onJoin(t, n); } catch { /* surfaced by the handler */ }
    finally { setJoining(false); }
  };
  const [linkArrived, setLinkArrived] = useState(false);
  useEffect(() => {
    if (!initialCode) return;
    setTicket(initialCode);
    setMode("join");
    setLinkArrived(true);
    onInitialCodeUsed?.();
  }, [initialCode, onInitialCodeUsed]);
  const copyCode = async () => {
    if (!session.code) return;
    try {
      await navigator.clipboard.writeText(reviewInviteMessage(session.code));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch { /* clipboard unavailable */ }
  };
  const cameraOn = !cap.choice.cameraOff && !!cap.stream?.getVideoTracks().some((t) => t.enabled && t.readyState === "live");
  const micOn = !cap.choice.micMuted && !!cap.stream?.getAudioTracks().some((t) => t.enabled && t.readyState === "live");

  return (
    <section className="cp-coreview-lobby cp-setup-rail" aria-label="Session setup">
      <div className="cp-colobby-inner">
        {!active && <>
          <header className="cp-colobby-head">
            <h1 className="cp-colobby-title">Review together</h1>
            <p className="cp-colobby-sub">Watch and leave notes in sync.</p>
          </header>
          <div className="cp-setup-tabs" role="tablist" aria-label="Session setup">
            {(["host", "join"] as const).map((choice) => <button key={choice} type="button"
              id={id + "-" + choice + "-tab"} role="tab" aria-selected={mode === choice}
              aria-controls={id + "-" + choice + "-panel"} tabIndex={mode === choice ? 0 : -1}
              className="cp-setup-tab" onClick={() => setMode(choice)}
              onKeyDown={(e) => {
                if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
                e.preventDefault();
                const next = e.key === "Home" ? "host" : e.key === "End" ? "join" : choice === "host" ? "join" : "host";
                setMode(next);
                document.getElementById(id + "-" + next + "-tab")?.focus();
              }}>{choice === "host" ? "Host a session" : "Join a session"}</button>)}
          </div>
          <section className="cp-colobby-card cp-setup-form" role="tabpanel"
            id={id + "-host-panel"} aria-labelledby={id + "-host-tab"} hidden={mode !== "host"}>
            <label className="cp-colobby-field">
              <span className="cp-colobby-field-label">Session name</span>
              <input className={"cp-colobby-input" + (titleTaken ? " taken" : "")}
                value={sessionTitle} placeholder={defaultTitle} maxLength={80}
                aria-invalid={titleTaken || undefined} aria-describedby={titleTaken ? id + "-title-taken" : undefined}
                onChange={(e) => { titleEditedRef.current = true; setSessionTitle(e.target.value); }}
                onKeyDown={(e) => { if (e.key === "Enter") startSession(); }} />
            </label>
            {titleTaken && <p className="cp-colobby-taken" id={id + "-title-taken"} role="alert">
              You have already screened a session with that name.
              {suggestion && <button type="button" className="cp-colobby-taken-fix"
                onClick={() => { titleEditedRef.current = true; setSessionTitle(suggestion); }}>Use &ldquo;{suggestion}&rdquo;</button>}
            </p>}
            <button type="button" className="btn cp-colobby-cta" onClick={startSession}
              disabled={!titlesReady || titleTaken || !name.trim()}><IconPlay size={12} /> Start session</button>
            {!titlesReady && <p className="cp-colobby-hint" role="status">Checking saved session names…</p>}
            {localSource && <p className="cp-colobby-hint">Share your file after starting. Reviewers can watch it streamed or take a copy.</p>}
          </section>
          <section className="cp-colobby-card cp-setup-form" role="tabpanel"
            id={id + "-join-panel"} aria-labelledby={id + "-join-tab"} hidden={mode !== "join"}>
            {linkArrived && <p className="cp-colobby-linkbanner" role="status">Your review link is ready. Check your name and devices, then join.</p>}
            <label className="cp-colobby-field"><span className="cp-colobby-field-label">Join code</span>
              <input className="cp-colobby-input" value={ticket} spellCheck={false} placeholder="Paste a join code"
                onChange={(e) => setTicket(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void joinSession(); }} />
            </label>
            <button type="button" className="btn cp-colobby-cta join" disabled={!joinReady || joining}
              onClick={() => { void joinSession(); }}><IconLink size={12} /> {joining ? "Connecting…" : "Join"}</button>
            {session.error && <p className="cp-colobby-err" role="alert">{session.error}</p>}
          </section>
          {onConnectPremiere && <div className="cp-setup-premiere">
            <button type="button" className="btn btn-ghost" onClick={onConnectPremiere}>Preview Premiere…</button>
            <span className="cp-setup-help" title={premierePreviewName ?? undefined}>
              {premierePreviewName ? premierePreviewStatus ?? "Premiere ready · Not shared" : "Connect privately. Share when you’re ready."}
            </span>
          </div>}
          <div className="cp-setup-identity">
            <div className="cp-setup-summary">
              <div><strong>{name.trim() || "Add your name"}</strong>
                <span>{cameraOn ? "Camera on" : "Camera off"} · {micOn ? "Microphone on" : cap.choice.micMuted ? "Microphone muted" : "Microphone off"}</span>
              </div>
              <button ref={changeButtonRef} type="button" className="btn btn-ghost btn-compact" aria-expanded={editor !== null}
                aria-controls={id + "-identity"} onClick={() => setEditor(editor ? null : name.trim() ? "devices" : "identity")}>Change…</button>
            </div>
            {editor && <div className="cp-setup-editor" id={id + "-identity"}>
              <div className="cp-setup-editor-tabs">
                <button type="button" className="btn btn-ghost btn-compact" aria-pressed={editor === "identity"} onClick={() => setEditor("identity")}>Your name</button>
                <button type="button" className="btn btn-ghost btn-compact" aria-pressed={editor === "devices"} onClick={() => setEditor("devices")}>Camera and mic</button>
              </div>
              {editor === "identity" ? <section className="cp-colobby-card cp-setup-form" aria-label="Your identity">
                <label className="cp-colobby-field"><span className="cp-colobby-field-label">Your name</span>
                  <input className="cp-colobby-input" value={name} autoFocus maxLength={40} placeholder="Your name"
                    onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") finishIdentity(); }} />
                </label>
                <ColorSwatches colors={AVATAR_COLORS} value={color} onPick={setColor} ariaLabel="Avatar color" />
                <button type="button" className="btn cp-colobby-cta" disabled={!name.trim()} onClick={finishIdentity}>Done</button>
              </section> : <GreenRoomDevices cap={cap} onContinue={() => { setEditor(null); changeButtonRef.current?.focus(); }} />}
            </div>}
          </div>
        </>}
        {active && <>
          <header className="cp-colobby-head"><h1 className="cp-colobby-title"><span className="cp-colobby-live" aria-hidden="true" />In session</h1></header>
          {isHost && session.code && <div className="cp-colobby-share">
            <button type="button" className="cp-keycap cp-colobby-code" onClick={copyCode} aria-label="Copy the review link" title="Copy the review link, and where to get the app">{shortJoinCode(session.code)}</button>
            <span className={"cp-colobby-code-hint" + (copied ? " copied" : "")} aria-live="polite">{copied ? "Link copied" : "Copy link"}</span>
          </div>}
          <ul className="cp-colobby-people" aria-label={"In the room: " + participants.length}>
            {participants.map((p, i) => <li key={i} className="cp-colobby-person" aria-label={p.name + (p.isHost ? ", host" : "") + (p.isSelf ? ", you" : "")}>
              <span className={"cp-colobby-avatar" + (p.isHost ? " host" : "")} style={{ ["--co-color" as string]: p.color }} aria-hidden="true">
                {initialsOf(p.name)}{p.isHost && <span className="cp-colobby-crown"><IconCrown size={9} /></span>}
              </span>
              <span className="cp-colobby-name" title={p.name}>{p.name}</span>
              <span className="cp-colobby-person-tag" aria-hidden="true">{p.isSelf ? "You" : p.isHost ? "Host" : ""}</span>
            </li>)}
          </ul>
          {session.error && <p className="cp-colobby-err center" role="alert">{session.error}</p>}
          <div className="cp-colobby-actions"><button type="button" className="cp-colobby-leave" onClick={onLeave}>{isHost ? "End session" : "Leave session"}</button></div>
        </>}
        <details className="cp-setup-access" hidden={!active || !isHost}>
          <summary>Manage access</summary>
          {/* One stable instance across hidden setup, host/join changes and
              room entry: an issued secret cannot be fetched a second time. */}
          <ReviewGrants sessionCode={isHost ? session.code : null} />
        </details>
        {!active && onOpenSessionHistory && <button type="button" className="cp-setup-history" onClick={onOpenSessionHistory}>Past sessions in Library <IconLink size={12} /></button>}
      </div>
    </section>
  );
}
