import { useEffect, useRef, useState } from "react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { IconUsers } from "./Icons";
import { loadJson } from "../lib/storage";
import { AUTHOR_KEY } from "../lib/review";
import type { SessionState } from "../bindings/SessionState";

/**
 * Co-review (watch party) control — a toolbar popover for the P2P session.
 * Phase 1: host shares a one-line join code (iroh ticket, minted in Rust);
 * peers paste it, auto-load the host's source, and follow the host's
 * transport. All session state lives in Rust; this is a pure view over the
 * `session:state` snapshots App receives.
 */
export function CoReviewPopover({ session, onStart, onJoin, onLeave }: {
  session: SessionState;
  onStart: () => void;
  onJoin: (ticket: string, name: string) => void;
  onLeave: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [ticket, setTicket] = useState("");
  // Default the display name to the review identity — same person, no accounts.
  const [name, setName] = useState(() => loadJson<string>(AUTHOR_KEY, ""));
  const [copied, setCopied] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const active = session.role !== "off";

  // Outside-click + Escape dismissal (mirrors the review popovers).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const copyCode = async () => {
    if (!session.code) return;
    try {
      await writeText(session.code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch { /* clipboard unavailable */ }
  };

  return (
    <div className="cp-coreview" ref={wrapRef}>
      <button
        type="button"
        className={"btn-icon" + (active ? " cp-coreview-live" : "")}
        title={active ? `Co-review session · ${session.peers.length} connected` : "Co-review — watch & review together"}
        aria-label="Co-review session"
        onClick={() => setOpen((o) => !o)}
      >
        <IconUsers size={15} />
        {active && <span className="cp-coreview-dot" />}
      </button>
      {open && (
        <div className="cp-coreview-pop">
          {session.role === "off" && (
            <>
              <div className="cp-coreview-title">Co-review</div>
              <p className="cp-coreview-sub">
                Watch and review together, peer-to-peer. Guests load the same
                source themselves and follow your playhead — no accounts, no cloud.
              </p>
              <button className="btn btn-primary" onClick={onStart}>Start a session</button>
              <div className="cp-coreview-sep">or join with a code</div>
              <input
                className="cp-coreview-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your name"
              />
              <input
                className="cp-coreview-input"
                value={ticket}
                onChange={(e) => setTicket(e.target.value)}
                placeholder="Paste a join code…"
                spellCheck={false}
              />
              <button
                className="btn btn-ghost"
                disabled={!ticket.trim() || !name.trim()}
                onClick={() => onJoin(ticket.trim(), name.trim())}
              >
                Join
              </button>
            </>
          )}
          {session.role === "host" && (
            <>
              <div className="cp-coreview-title">Hosting · {session.peers.length} connected</div>
              {session.peers.length > 0 && (
                <div className="cp-coreview-peers">{session.peers.join(" · ")}</div>
              )}
              <div className="cp-coreview-code" title={session.code ?? ""}>{session.code}</div>
              <button className="btn btn-ghost" onClick={copyCode}>
                {copied ? "Copied ✓" : "Copy join code"}
              </button>
              <button className="btn btn-ghost cp-coreview-leave" onClick={onLeave}>End session</button>
            </>
          )}
          {session.role === "peer" && (
            <>
              <div className="cp-coreview-title">In session · following the host</div>
              {session.peers.length > 0 && (
                <div className="cp-coreview-peers">{session.peers.join(" · ")}</div>
              )}
              <button className="btn btn-ghost cp-coreview-leave" onClick={onLeave}>Leave</button>
            </>
          )}
          {session.error && <div className="cp-coreview-err">{session.error}</div>}
        </div>
      )}
    </div>
  );
}
