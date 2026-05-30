import { useRef } from "react";
import { readText } from "@tauri-apps/plugin-clipboard-manager";
import { IconLink, IconClipboard, IconSettings, IconImport, IconStack } from "./Icons";
import { NotificationBell, type Notif } from "./NotificationBell";
import type { AppStatus } from "../types";

type Props = {
  url: string;
  onChange: (v: string) => void;
  onFetch: (url?: string) => void;
  onClear: () => void;
  onImportFile: () => void;
  onToggleQueue: () => void;
  queueCount: number;
  queueOpen: boolean;
  hasSource: boolean;
  status: AppStatus;
  onOpenSettings: () => void;
  notifications: Notif[];
  onMarkAllRead: () => void;
  onClearNotifications: () => void;
  onDismissNotification: (id: string) => void;
};

function stripScheme(s: string): string {
  return s.replace(/^https?:\/\//i, "");
}

export function Toolbar({
  url, onChange, onFetch, onClear, onImportFile, onToggleQueue, queueCount, queueOpen,
  hasSource, status, onOpenSettings,
  notifications, onMarkAllRead, onClearNotifications, onDismissNotification,
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
        if (cleaned && !fetching) onFetch(cleaned);
      }
    } catch (err) {
      console.warn("clipboard read failed", err);
    }
  }

  return (
    <div className="cp-toolbar">
      <div className="cp-wordmark">
        <span>sauce bunny</span>
        <span className="dot" />
      </div>

      <div className="cp-url" onClick={() => inputRef.current?.focus()}>
        <IconLink size={14} stroke="var(--fg-4)" />
        <span className="scheme">https://</span>
        <input
          ref={inputRef}
          type="text"
          value={display}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !fetching && display) onFetch();
          }}
          placeholder="paste any video URL — youtube, vimeo, tiktok, twitter, reddit, …"
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
        />
        <button
          type="button"
          className="btn-icon"
          style={{ width: 22, height: 22, border: "none" }}
          title="Paste & fetch"
          onClick={(e) => {
            e.stopPropagation();
            pasteFromClipboard();
          }}
        >
          <IconClipboard size={13} />
        </button>
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
        title={`Clips queue (${queueCount}) — ⌘⇧Q`}
        onClick={onToggleQueue}
      >
        <IconStack size={15} />
        {queueCount > 0 && <span className="cp-queue-badge">{queueCount}</span>}
      </button>
      <NotificationBell
        notifications={notifications}
        onMarkAllRead={onMarkAllRead}
        onClearAll={onClearNotifications}
        onDismiss={onDismissNotification}
      />
      <button type="button" className="btn-icon" title="Settings (⌘,)" onClick={onOpenSettings}>
        <IconSettings size={15} />
      </button>
    </div>
  );
}
