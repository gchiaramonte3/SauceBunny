import { useRef, useState, useSyncExternalStore } from "react";
import {
  addToWebCollection, createWebCollection, getWebCollections,
  removeFromWebCollection, subscribeWebCollections,
} from "../lib/web-collection-store";
import { useDismiss } from "../hooks/use-dismiss";
import { IconPlus } from "./Icons";

/**
 * The per-card "file this somewhere" affordance for a cached web source: a
 * corner button opening a small popover that toggles the card's membership
 * in each collection, plus an inline "New collection" input so filing the
 * first clip does not require a separate setup trip.
 *
 * Membership is a checkbox, not a move command, because a clip may belong
 * to several collections - organisation here is virtual and keyed by URL
 * (see web-collection-store.ts for why nothing ever moves on disk).
 */
export function WebCollectionMenu({ url }: { url: string }) {
  const collections = useSyncExternalStore(subscribeWebCollections, getWebCollections);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const wrapRef = useRef<HTMLDivElement>(null);
  useDismiss(wrapRef, () => setOpen(false), open);

  const commitDraft = () => {
    const c = createWebCollection(draft);
    if (c) {
      addToWebCollection(c.id, url);
      setDraft("");
    }
  };

  return (
    <div className="cp-web-collect" ref={wrapRef}>
      <button
        type="button"
        className={"cp-web-collect-btn" + (open ? " open" : "")}
        title="Add to collection"
        aria-label={`Add to a collection`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <IconPlus size={13} />
      </button>
      {open && (
        <div className="cp-web-collect-pop" role="group" aria-label="Collections">
          {collections.length === 0 && (
            <div className="cp-web-collect-hint">No collections yet. Name one below.</div>
          )}
          {collections.map((c) => {
            const member = c.urls.includes(url);
            return (
              <label key={c.id} className="cp-web-collect-row">
                <input
                  type="checkbox"
                  checked={member}
                  onChange={() => (member ? removeFromWebCollection(c.id, url) : addToWebCollection(c.id, url))}
                />
                <span className="cp-web-collect-name">{c.name}</span>
                <span className="cp-web-collect-count">{c.urls.length}</span>
              </label>
            );
          })}
          <form
            className="cp-web-collect-new"
            onSubmit={(e) => { e.preventDefault(); commitDraft(); }}
          >
            <input
              type="text"
              value={draft}
              placeholder="New collection"
              aria-label="New collection name"
              spellCheck={false}
              onChange={(e) => setDraft(e.target.value)}
            />
            <button type="submit" disabled={!draft.trim()}>Add</button>
          </form>
        </div>
      )}
    </div>
  );
}
