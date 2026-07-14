import { useRef } from "react";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { IconLink, IconClipboard, IconImport, IconPanelRight, IconPanelLeft } from "./Icons";
import { NotificationBell, type Notif } from "./NotificationBell";
import { CoReviewPopover } from "./CoReviewPopover";
import { RecentSources } from "./RecentSources";
import type { RecentSource } from "../lib/recent-sources";
import type { AppStatus } from "../types";
import type { SessionState } from "../bindings/SessionState";

type Props = {
  url: string;
  onChange: (v: string) => void;
  onFetch: (url?: string) => void;
  onClear: () => void;
  onImportFile: () => void;
  /** Recent sources (URL-bar history popover). Opening one routes through
   *  the same fetch/import handlers as paste/import — no parallel path. */
  recentSources: RecentSource[];
  onOpenRecent: (entry: RecentSource) => void;
  onRemoveRecent: (value: string) => void;
  onClearRecents: () => void;
  onToggleQueue: () => void;
  queueCount: number;
  queueOpen: boolean;
  /** Left source/export sidebar visibility — the toggle rides the sidebar's
   *  right-edge line in the toolbar, mirroring the right panel's toggle. */
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  hasSource: boolean;
  status: AppStatus;
  notifications: Notif[];
  onMarkAllRead: () => void;
  onClearNotifications: () => void;
  onDismissNotification: (id: string) => void;
  /** Co-review (P2P watch party) session state + controls. */
  coSession: SessionState;
  /** A local file is loaded — the popover warns guests can't receive it yet (hosting still allowed). */
  coLocalSource: boolean;
  /** Screening (cinematic watch-party layout) on/off + toggle. */
  coScreening: boolean;
  onCoToggleScreening: () => void;
  onCoStart: () => void;
  onCoJoin: (ticket: string, name: string) => void;
  onCoLeave: () => void;
};

function stripScheme(s: string): string {
  return s.replace(/^https?:\/\//i, "");
}

export function Toolbar({
  url, onChange, onFetch, onClear, onImportFile,
  recentSources, onOpenRecent, onRemoveRecent, onClearRecents,
  onToggleQueue, queueCount, queueOpen,
  sidebarOpen, onToggleSidebar,
  hasSource, status,
  notifications, onMarkAllRead, onClearNotifications, onDismissNotification,
  coSession, coLocalSource, coScreening, onCoToggleScreening, onCoStart, onCoJoin, onCoLeave,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const fetching = status === "fetching";
  const display = stripScheme(url);

  async function pasteFromClipboard() {
    try {
      // Tauri's clipboard-manager plugin reads via the OS through Rust,
      // so macOS won't show the browser's "Paste from clipboard?" modal.
      const text = await readText();
      if (text) {
        const cleaned = stripScheme(text.trim());
        onChange(cleaned);
        // Auto-fetch as soon as we have a URL that looks valid. We
        // defer with a microtask so React state has already settled.
        // Pass the URL explicitly so the fetch doesn't race the `url` state
        // update (onChange above is async; handleFetch would otherwise read
        // the previous/empty value).
        if (cleaned && !fetching) { onFetch(cleaned); inputRef.current?.blur(); }
      }
    } catch (err) {
      console.warn("clipboard read failed", err);
    }
  }

  return (
    // <header> = the banner landmark (screen-reader "jump to toolbar").
    <header className="cp-toolbar">
      {/* Left cluster: wordmark + the sidebar toggle. When the sidebar is
          open, the cluster is sized so the toggle sits exactly on the
          sidebar's right-edge line — the mirror of the right panel toggle. */}
      <div className={"cp-toolbar-left" + (sidebarOpen ? " sidebar-open" : "")}>
        <div className="cp-wordmark">
          <span>sauce bunny</span>
          <span className="dot" />
        </div>
        <button
          type="button"
          className={"btn-icon cp-sidebar-toggle" + (sidebarOpen ? " active" : "")}
          onClick={onToggleSidebar}
          title={sidebarOpen ? "Hide source panel" : "Show source panel"}
          aria-label={sidebarOpen ? "Hide source panel" : "Show source panel"}
          aria-pressed={sidebarOpen}
        >
          <IconPanelLeft size={15} />
        </button>
      </div>

      <div className="cp-url" onClick={() => inputRef.current?.focus()}>
        <IconLink size={14} stroke="var(--fg-3)" />
        <span className="scheme">https://</span>
        <input
          ref={inputRef}
          type="text"
          value={display}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !fetching && display) {
              onFetch();
              // Drop focus so it leaves the URL bar. Otherwise the App keyboard
              // handler's `inField` guard swallows every transport key
              // (Space/K play, J/L seek, I/O marks) until you click elsewhere.
              e.currentTarget.blur();
            }
          }}
          placeholder="paste any video URL — youtube, vimeo, tiktok, twitter, reddit, …"
          aria-label="Video URL"
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
        />
        <button
          type="button"
          className="btn-icon"
          style={{ width: 22, height: 22, border: "none" }}
          title="Paste & fetch"
          aria-label="Paste URL and fetch"
          onClick={(e) => {
            e.stopPropagation();
            pasteFromClipboard();
          }}
        >
          <IconClipboard size={13} />
        </button>
        <RecentSources
          entries={recentSources}
          onOpen={onOpenRecent}
          onRemove={onRemoveRecent}
          onClearAll={onClearRecents}
        />
      </div>

      {hasSource ? (
        <button
          type="button"
          className="btn btn-ghost"
          onClick={onClear}
          style={{ minWidth: 86 }}
          title="Unload current source (does not delete the exported file)"
        >
          Clear
        </button>
      ) : (
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => onFetch()}
          disabled={fetching || !display}
          style={{ minWidth: 86 }}
        >
          {fetching ? "Resolving…" : "Fetch"}
        </button>
      )}
      {/* Text+icon Import button — matches the Fetch/Clear button style
          so the toolbar has a single, consistent action grammar instead
          of a mix of text buttons and bare icons. */}
      <button
        type="button"
        className="btn btn-ghost"
        style={{ minWidth: 86 }}
        title="Import a local video or audio file"
        onClick={onImportFile}
      >
        <IconImport size={13} />
        <span>Import</span>
      </button>
      <button
        type="button"
        className={"btn-icon cp-queue-toggle" + (queueCount > 0 ? " has-items" : "") + (queueOpen ? " active" : "")}
        title={`Side panel (${queueCount} queued) — ⌘⇧Q`}
        aria-label={`Toggle side panel (${queueCount} queued)`}
        aria-pressed={queueOpen}
        onClick={onToggleQueue}
      >
        <IconPanelRight size={15} />
        {queueCount > 0 && <span className="cp-queue-badge">{queueCount}</span>}
      </button>
      <CoReviewPopover
        session={coSession}
        localSource={coLocalSource}
        hasSource={hasSource}
        screening={coScreening}
        onToggleScreening={onCoToggleScreening}
        onStart={onCoStart}
        onJoin={onCoJoin}
        onLeave={onCoLeave}
      />
      {/* The Settings gear lives in the nav rail now (NavRail.tsx) — the
          toolbar ends with the bell so the rail owns app-level chrome. */}
      <NotificationBell
        notifications={notifications}
        onMarkAllRead={onMarkAllRead}
        onClearAll={onClearNotifications}
        onDismiss={onDismissNotification}
      />
    </header>
  );
}
