import { IconHome, IconScissors, IconSettings } from "./Icons";
import type { AppView } from "../App";
import logoUrl from "../assets/saucebunny-128.png";

/**
 * Persistent left navigation rail — the app-shell switch between the two
 * top-level views: Home (the Library, phase 3) and Clip (the editor).
 *
 * This is a STATE switch, not a router (CLAUDE.md forbids routers): App owns
 * a single `activeView` useState and both views stay mounted — the inactive
 * one is hidden with [hidden], QueueDrawer-tab style, so playback and
 * running jobs survive navigation. While co-review screening mode is on the
 * rail becomes a CSS-only edge-reveal overlay (see screening.css / .cp-nav-dock)
 * — it never unmounts, so the player is untouched.
 */
type Props = {
  active: AppView;
  onNavigate: (view: AppView) => void;
  /** Opens the Settings modal — the gear moved here from the toolbar. */
  onOpenSettings: () => void;
  /** Pretty display combos for the tooltips (live rebindable shortcuts). */
  homeShortcut?: string;
  clipShortcut?: string;
};

export function NavRail({ active, onNavigate, onOpenSettings, homeShortcut, clipShortcut }: Props) {
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
        className={"cp-nav-item" + (active === "clip" ? " active" : "")}
        onClick={() => onNavigate("clip")}
        title={clipShortcut ? `Clip (${clipShortcut})` : "Clip"}
        aria-label="Clip"
        aria-current={active === "clip" ? "page" : undefined}
      >
        <IconScissors size={18} />
        <span className="cp-nav-label">Clip</span>
      </button>
      <div className="cp-nav-spacer" />
      <button
        type="button"
        className="cp-nav-item cp-nav-settings"
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
