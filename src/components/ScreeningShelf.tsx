import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  hydrateScreeningIndex, listScreenings, screeningPath, type ScreeningIndexEntry,
} from "../lib/screening-store";
import { formatTimeAgo } from "../lib/transcript-history";
import { IconReveal, IconReview } from "./Icons";

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
export function ScreeningShelf() {
  const [rows, setRows] = useState<(ScreeningIndexEntry & { id: string })[] | null>(null);

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
      <h2 className="cp-screenings-title">Past screenings</h2>
      <ul className="cp-screenings-list">
        {rows.map((r) => {
          const people = r.participants.length === 1
            ? r.participants[0]
            : `${r.participants.length} people`;
          return (
            <li key={r.id} className="cp-screenings-row">
              <IconReview size={13} />
              <span className="cp-screenings-name" title={r.title}>{r.title}</span>
              <span className="cp-screenings-meta">
                {formatTimeAgo(r.endedAt)} · {people} · {r.commentCount}{" "}
                {r.commentCount === 1 ? "note" : "notes"}
              </span>
              <button
                type="button"
                className="cp-screenings-reveal"
                title="Reveal in Finder"
                aria-label={`Reveal ${r.title} in Finder`}
                onClick={() => {
                  const path = screeningPath(r.file);
                  if (path) void invoke("reveal_in_finder", { path }).catch(() => {});
                }}
              >
                <IconReveal size={13} />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
