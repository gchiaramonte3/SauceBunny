import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { IconUsers } from "./Icons";
import { CoReviewJoinForm } from "./CoReviewJoinForm";
import type { SessionState } from "../bindings/SessionState";

/**
 * Co-review (watch party) control — a toolbar popover for the P2P session.
 * Phase 1: host shares a one-line join code (iroh ticket, minted in Rust);
 * peers paste it, auto-load the host's source, and follow the host's
 * transport. All session state lives in Rust; this is a pure view over the
 * `session:state` snapshots useCoReview receives.
 *
 * The dropdown is PORTALED to document.body with position:fixed — the
 * toolbar's `backdrop-filter: blur(20px)` creates a stacking context, so an
 * absolutely-positioned child (even at z-index:3000) renders UNDER the canvas
 * below. Portaling out of that context is the same fix NotificationBell uses.
 */
export function CoReviewPopover({ session, localSource, hasSource, screening, onToggleScreening, onStart, onJoin, onLeave }: {
  session: SessionState;
  /** A local file is loaded — warn that guests can't receive it yet (hosting still allowed). */
  localSource: boolean;
  /** Any source loaded at all — drives the host's "load a video to start" hint. */
  hasSource: boolean;
  /** Screening (cinematic watch-party layout) on/off + toggle. */
  screening: boolean;
  onToggleScreening: () => void;
  onStart: () => void;
  onJoin: (ticket: string, name: string) => void;
  onLeave: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const triggerRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  // Anchor coords for the portaled popover — recomputed on open + resize so it
  // tracks the trigger through sidebar collapses / window resizes.
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);
  const active = session.role !== "off";

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const compute = () => {
      const r = triggerRef.current!.getBoundingClientRect();
      setAnchor({ top: r.bottom + 8, right: window.innerWidth - r.right });
    };
    compute();
    // Coalesce resize bursts to one measurement per frame — a drag-resize
    // fires dozens of events/sec, and each setAnchor re-renders the portal.
    let raf = 0;
    const onResize = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; compute(); });
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [open]);

  // Outside-click + Escape dismissal — must clear BOTH the trigger and the
  // portaled popover (which is no longer a DOM descendant of the trigger).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t)) return;
      if (popoverRef.current?.contains(t)) return;
      setOpen(false);
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
    <div className="cp-coreview" ref={triggerRef}>
      <button
        type="button"
        className={"btn-icon" + (active ? " cp-coreview-live" : "")}
        title={active ? `Co-review session · ${session.peers.length} connected` : "Co-review · watch and review together"}
        aria-label="Co-review session"
        onClick={() => setOpen((o) => !o)}
      >
        <IconUsers size={15} />
        {active && <span className="cp-coreview-dot" />}
      </button>
      {open && anchor && createPortal(
        <div
          ref={popoverRef}
          className="cp-coreview-pop"
          style={{ position: "fixed", top: anchor.top, right: anchor.right }}
        >
          {session.role === "off" && (
            <CoReviewJoinForm localSource={localSource} onStart={onStart} onJoin={onJoin} />
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
              {!hasSource && (
                <div className="cp-coreview-hint">Paste a video URL up top. It loads for everyone.</div>
              )}
              {hasSource && localSource && (
                <div className="cp-coreview-hint">Guests can't see local files yet. Load a web URL to screen together.</div>
              )}
              <button className="btn btn-ghost" onClick={onToggleScreening}>
                {screening ? "Exit screening view" : "Screening view"}
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
              <button className="btn btn-ghost" onClick={onToggleScreening}>
                {screening ? "Exit screening view" : "Screening view"}
              </button>
              <button className="btn btn-ghost cp-coreview-leave" onClick={onLeave}>Leave</button>
            </>
          )}
          {session.error && <div className="cp-coreview-err">{session.error}</div>}
        </div>,
        document.body,
      )}
    </div>
  );
}
