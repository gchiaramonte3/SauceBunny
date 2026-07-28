import { useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { IconLink, IconClipboard, IconImport, IconPanelRight, IconPanelLeft } from "./Icons";
import { NotificationBell, type Notif } from "./NotificationBell";
import { RecentSources } from "./RecentSources";
import { StatefulButton } from "./StatefulButton";
import type { RecentSource } from "../lib/recent-sources";
import type { StatefulPhase } from "../lib/stateful-phase";
import type { AppStatus } from "../types";

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
  /** Animated Fetch-button phase (loading → success/error flash). Computed in
   *  App via fetchButtonPhase; the toolbar just renders it. */
  fetchPhase: StatefulPhase;
  /** Returns the Fetch button to idle after its success/error flash. */
  onFetchResolved: () => void;
  notifications: Notif[];
  onMarkAllRead: () => void;
  onClearNotifications: () => void;
  onDismissNotification: (id: string) => void;
};

function stripScheme(s: string): string {
  return s.replace(/^https?:\/\//i, "");
}

export function Toolbar({
  url, onChange, onFetch, onClear, onImportFile,
  recentSources, onOpenRecent, onRemoveRecent, onClearRecents,
  onToggleQueue, queueCount, queueOpen,
  sidebarOpen, onToggleSidebar,
  hasSource, status, fetchPhase, onFetchResolved,
  notifications, onMarkAllRead, onClearNotifications, onDismissNotification,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const fetching = status === "fetching";
  const display = stripScheme(url);

  async function pasteFromClipboard() {
    try {
      // Read through Rust, NOT navigator.clipboard.readText(): the web API
      // raises macOS's "Paste from clipboard?" system modal every time, which
      // is a second confirmation for a button the user just pressed. Reading
      // from the app's own process does not. (r152 replaced the
      // clipboard-manager plugin with read_clipboard_text; the property is
      // the same and this is still the reason for it.)
      const text = await invoke<string>("read_clipboard_text");
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
      {/* First item, hugging the nav rail: the left panel toggle — the
          mirror of the right panel toggle on the far edge. No wordmark;
          the rail's bunny mark is the app's only brand presence. */}
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
          placeholder="Paste a video URL"
          aria-label="Video URL"
          title="Any site yt-dlp supports, or a direct media URL"
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
        />
        <button
          type="button"
          className="btn-icon"
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

      {/* Clear once a source is loaded AND the Fetch flash has settled — while
          the flash plays (phase !== idle) the StatefulButton stays mounted so
          its loading/success/error animation is visible even though the
          optimistic mount already flipped `hasSource` true. */}
      {hasSource && fetchPhase === "idle" ? (
        <button
          type="button"
          className="btn btn-ghost"
          onClick={onClear}
          style={{ minWidth: 86 }}
          title="Unload the current source"
        >
          Clear
        </button>
      ) : (
        <StatefulButton
          className="btn btn-ghost cp-sbtn-fetch"
          phase={fetchPhase}
          idleContent="Fetch"
          // Spinner-only while loading: the 86px width lock is too narrow for a
          // "Resolving…" label, which clipped under the button's overflow:hidden.
          // The visually-hidden aria-live status still announces "Loading".
          loadingLabel=""
          onClick={() => onFetch()}
          onResolved={onFetchResolved}
          disabled={!display}
        />
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
        title={`Side panel (${queueCount} queued) · ⌘⇧Q`}
        aria-label={`Toggle side panel (${queueCount} queued)`}
        aria-pressed={queueOpen}
        onClick={onToggleQueue}
      >
        <IconPanelRight size={15} />
        {queueCount > 0 && <span className="cp-queue-badge">{queueCount}</span>}
      </button>
      {/* Sessions live in the Review workspace now; the nav rail's Review
          badge is the one session affordance outside it. */}
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
