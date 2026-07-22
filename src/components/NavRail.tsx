import { IconHome, IconStack, IconScissors, IconSettings, IconCoReview, IconTranscript } from "./Icons";
import type { AppView } from "../App";
import logoUrl from "../assets/saucebunny.svg";

/**
 * Persistent left navigation rail — the app-shell switch between the
 * top-level views: Home (landing page), Library (detail browser), Clip
 * (the editor) and Review (co-review).
 *
 * This is a STATE switch, not a router (CLAUDE.md forbids routers): App owns
 * a single `activeView` useState and both views stay mounted — the inactive
 * one is hidden with [hidden], QueueDrawer-tab style, so playback and
 * running jobs survive navigation. The
 * rail stays visible in every mode, including the session room (room.css)
 * — it never unmounts, so the player is untouched.
 */
type Props = {
  active: AppView;
  onNavigate: (view: AppView) => void;
  /** Opens the Settings modal — the gear moved here from the toolbar. */
  onOpenSettings: () => void;
  /** Pretty display combos for the tooltips (live rebindable shortcuts). */
  homeShortcut?: string;
  libraryShortcut?: string;
  clipShortcut?: string;
  coreviewShortcut?: string;
  readerShortcut?: string;
  /** A co-review session is live — lights the badge dot on the Review item. */
  sessionActive: boolean;
  /** People connected to the live session — surfaced in the item's title. */
  sessionPeers?: number;
};

export function NavRail({ active, onNavigate, onOpenSettings, homeShortcut, libraryShortcut, clipShortcut, coreviewShortcut, readerShortcut, sessionActive, sessionPeers }: Props) {
  return (
    <nav className="cp-nav" aria-label="Primary">
      {/* Brand mark — a non-interactive logo, NOT a second Home button. The
          Home nav item below (and its ⌘1) is the only home affordance. */}
      <div className="cp-nav-logo" aria-hidden="true">
        <img src={logoUrl} alt="Sauce Bunny" draggable={false} />
      </div>
      <button
        type="button"
        className={"cp-nav-item" + (active === "home" ? " active" : "")}
        onClick={() => onNavigate("home")}
        title={homeShortcut ? `Home (${homeShortcut})` : "Home"}
        aria-label="Home"
        aria-current={active === "home" ? "page" : undefined}
      >
        <IconHome size={18} />
        <span className="cp-nav-label">Home</span>
      </button>
      <button
        type="button"
        className={"cp-nav-item" + (active === "library" ? " active" : "")}
        onClick={() => onNavigate("library")}
        title={libraryShortcut ? `Library (${libraryShortcut})` : "Library"}
        aria-label="Library"
        aria-current={active === "library" ? "page" : undefined}
      >
        <IconStack size={18} />
        <span className="cp-nav-label">Library</span>
      </button>
      <button
        type="button"
        className={"cp-nav-item" + (active === "clip" ? " active" : "")}
        onClick={() => onNavigate("clip")}
        title={clipShortcut ? `Clip (${clipShortcut})` : "Clip"}
        aria-label="Clip"
        aria-current={active === "clip" ? "page" : undefined}
      >
        <IconScissors size={18} />
        <span className="cp-nav-label">Clip</span>
      </button>
      <button
        type="button"
        className={"cp-nav-item" + (active === "coreview" ? " active" : "")}
        onClick={() => onNavigate("coreview")}
        title={
          (coreviewShortcut ? `Review (${coreviewShortcut})` : "Review") +
          (sessionActive ? ` · ${sessionPeers ?? 0} watching` : "")
        }
        aria-label="Review"
        aria-current={active === "coreview" ? "page" : undefined}
      >
        <IconCoReview size={18} />
        <span className="cp-nav-label">Review</span>
        {/* Decorative live-session marker — the accessible "N watching" state
            rides the button title above, so a screen reader isn't handed a
            stray dot. */}
        {sessionActive && <span className="cp-nav-badge" aria-hidden="true" />}
      </button>
      {/* Transcripts reader — sits directly under Review: a reading-first
          workspace over every transcript on disk, outside the Clip editor. */}
      <button
        type="button"
        className={"cp-nav-item" + (active === "reader" ? " active" : "")}
        onClick={() => onNavigate("reader")}
        title={readerShortcut ? `Transcripts (${readerShortcut})` : "Transcripts"}
        aria-label="Transcripts"
        aria-current={active === "reader" ? "page" : undefined}
      >
        <IconTranscript size={18} />
        <span className="cp-nav-label">Transcripts</span>
      </button>
      <div className="cp-nav-spacer" />
      <button
        type="button"
        className="cp-nav-item"
        onClick={onOpenSettings}
        title="Settings (⌘,)"
        aria-label="Settings"
      >
        <IconSettings size={17} />
        <span className="cp-nav-label">Settings</span>
      </button>
    </nav>
  );
}
