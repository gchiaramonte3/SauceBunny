import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  hydrateScreeningIndex, listScreenings, screeningPath, type ScreeningIndexEntry,
} from "../lib/screening-store";
import { formatTimeAgo } from "../lib/transcript-history";
import { IconChevronRight, IconReveal, IconReview } from "./Icons";

/**
 * Past screenings, listed where someone would think to look for them.
 *
 * Every co-review session has always written a full record to
 * `~/Documents/Sauce Bunny/Screenings/` — who was there, what was watched,
 * every comment — and the read half of that store (`hydrateScreeningIndex`,
 * `listScreenings`, `loadScreening`) had ZERO callers outside its own tests.
 * The app was quietly filing away a folder of session records nothing in it
 * could open, on a machine whose owner had no reason to know they existed.
 *
 * This is the list, not a viewer: the row says what the session was and Reveal
 * opens the JSON in Finder. A record you can find and read with any text
 * editor beats one that is invisible, and a proper screening viewer — playing
 * the source back with the comments on the timeline — is a bigger piece of
 * work than making them reachable.
 */
const OPEN_KEY = "saucebunny.screeningsOpen";

export function ScreeningShelf() {
  const [rows, setRows] = useState<(ScreeningIndexEntry & { id: string })[] | null>(null);
  /**
   * FOLDED BY DEFAULT. This is a history list on a screen whose job is to
   * start or join a session, and it grows without limit - a dozen past
   * sessions pushed the Join card off the bottom, so the lobby's second verb
   * was below the fold behind a list of things already finished.
   *
   * The preference is remembered, so someone who does live out of their
   * screening history only opens it once.
   */
  const [open, setOpen] = useState(() => {
    try { return localStorage.getItem(OPEN_KEY) === "1"; } catch { return false; }
  });
  const toggle = () => {
    const next = !open;
    // Outside the updater: a setState updater must be pure, and React may run
    // it more than once.
    try { localStorage.setItem(OPEN_KEY, next ? "1" : "0"); } catch { /* quota */ }
    setOpen(next);
  };

  useEffect(() => {
    let alive = true;
    void hydrateScreeningIndex()
      .then(() => { if (alive) setRows(listScreenings()); })
      // A missing folder is the normal state before the first session, not a
      // failure worth showing anybody.
      .catch(() => { if (alive) setRows([]); });
    return () => { alive = false; };
  }, []);

  // Nothing at all until there IS something: an empty "Past screenings"
  // heading on a first run is chrome advertising a feature the user has not
  // reached yet.
  if (!rows || rows.length === 0) return null;

  return (
    <section className="cp-screenings" aria-label="Past screenings">
      <h2 className="cp-screenings-title">
        <button
          type="button"
          className="cp-screenings-toggle"
          aria-expanded={open}
          onClick={toggle}
        >
          <IconChevronRight
            size={12}
            className={"cp-screenings-chev" + (open ? " open" : "")}
          />
          Past screenings
          <span className="cp-screenings-count">{rows.length}</span>
        </button>
      </h2>
      {open && (
      <ul className="cp-screenings-list">
        {rows.map((r) => {
          // Built from parts, because a screening saved before participants
          // were ever written has NONE - and "0 people" is not a smaller
          // number, it is a false statement: there was at least the person
          // reading the row. Say nothing about a roster we never recorded.
          const parts = [formatTimeAgo(r.endedAt)];
          if (r.participants.length === 1) parts.push(r.participants[0]);
          else if (r.participants.length > 1) parts.push(`${r.participants.length} people`);
          if (r.segmentCount > 0) {
            parts.push(`${r.segmentCount} ${r.segmentCount === 1 ? "source" : "sources"}`);
          }
          parts.push(`${r.commentCount} ${r.commentCount === 1 ? "note" : "notes"}`);
          return (
            <li key={r.id} className="cp-screenings-row">
              <IconReview size={13} />
              <span className="cp-screenings-name" title={r.title}>{r.title}</span>
              <span className="cp-screenings-meta">{parts.join(" \u00b7 ")}</span>
              <button
                type="button"
                className="cp-screenings-reveal"
                title="Reveal in Finder"
                aria-label={`Reveal ${r.title} in Finder`}
                onClick={() => {
                  const path = screeningPath(r.id);
                  if (path) void invoke("reveal_in_finder", { path }).catch(() => {});
                }}
              >
                <IconReveal size={13} />
              </button>
            </li>
          );
        })}
      </ul>
      )}
    </section>
  );
}
