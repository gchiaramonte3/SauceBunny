import { useState } from "react";
import { IconImport, IconLink, IconTrash } from "./Icons";

/**
 * In-room source control (r124) — the presenter's way to change what the room
 * is watching WITHOUT leaving the session.
 *
 * The room deliberately strips Clip's editing furniture, including the toolbar
 * that owns the URL bar and Import (`.cp-room .cp-view-clip .cp-toolbar` in
 * room.css). That left no way at all to switch or clear the source mid-session
 * — you had to end the session. This is the purpose-built replacement: paste a
 * link, pick a file, or clear, and nothing else.
 *
 * Only the presenter sees it. Everyone else follows.
 */
export function RoomSourceBar({ hasSource, onLoadUrl, onImportFile, onClear }: {
  hasSource: boolean;
  onLoadUrl: (url: string) => void;
  onImportFile: () => void;
  onClear: () => void;
}) {
  const [draft, setDraft] = useState("");
  const submit = () => {
    const url = draft.trim();
    if (!url) return;
    setDraft("");
    onLoadUrl(url);
  };
  return (
    <div className="cp-room-source-bar">
      <div className="cp-room-source-field">
        <IconLink size={12} />
        <input
          type="text"
          value={draft}
          placeholder="Paste a link to watch together"
          title="Everyone plays the same file, in sync. Scrub, pause, and comment on exact timecode."
          aria-label="Load a source for the room"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); submit(); }
            // The room owns most keys (space toggles play); keep typing local.
            e.stopPropagation();
          }}
        />
      </div>
      <button type="button" className="btn btn-ghost btn-compact" onClick={onImportFile} title="Open a file from this Mac. Peers with the same file open their own copy, frame accurate.">
        <IconImport size={12} /> File
      </button>
      {hasSource && (
        <button type="button" className="btn btn-ghost btn-compact" onClick={onClear} title="Clear what the room is watching">
          <IconTrash size={12} /> Clear
        </button>
      )}
    </div>
  );
}
