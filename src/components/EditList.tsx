import { useState, type KeyboardEvent } from "react";
import type { EditSummary } from "../bindings/EditSummary";
import { secondsToClock } from "../lib/timecode";
import { EditStrip } from "./EditStrip";
import { IconSearch } from "./Icons";

type Props = { edits: EditSummary[]; onOpen: (id: string) => void };

const DAY = 86_400_000;
const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
const daysAgo = (ms: number, now: Date) => Math.round((startOfDay(now) - startOfDay(new Date(ms))) / DAY);
const time = (date: Date) => date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

/** "Today, 7:20 PM", "Yesterday, 3:48 PM", "Oct 5, 1:31 PM", and the year only when it is not this one. */
export function editedLabel(ms: number, now = new Date()): string {
  const date = new Date(ms), days = daysAgo(ms, now);
  if (days === 0) return `Today, ${time(date)}`;
  if (days === 1) return `Yesterday, ${time(date)}`;
  if (date.getFullYear() !== now.getFullYear()) return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
  return `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}, ${time(date)}`;
}

/** The heading a row is filed under: Today, Yesterday, Previous 7 days, then the month. */
export function editedGroup(ms: number, now = new Date()): string {
  const date = new Date(ms), days = daysAgo(ms, now);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "Previous 7 days";
  return date.toLocaleDateString(undefined, date.getFullYear() === now.getFullYear() ? { month: "long" } : { month: "long", year: "numeric" });
}

/** What the row's right edge says: the time within the last two days, the date before that. */
function editedShort(ms: number, now: Date): string {
  const date = new Date(ms), days = daysAgo(ms, now);
  if (days <= 1) return time(date);
  return date.toLocaleDateString(undefined, date.getFullYear() === now.getFullYear() ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}

/** How long it plays, as a clock: "4:12", "1:02:03". Empty when it holds nothing. */
export function playsFor(edit: EditSummary): string {
  const rate = edit.edit_rate;
  if (!rate?.numerator || edit.duration_frames <= 0) return "";
  return secondsToClock(edit.duration_frames * rate.denominator / rate.numerator, { round: true });
}

const bitesText = (count: number) => count ? `${count.toLocaleString()} ${count === 1 ? "bite" : "bites"}` : "No bites yet";

/** Up and Down walk the rows across every group, Home and End jump to the ends. */
function walk(event: KeyboardEvent<HTMLDivElement>) {
  const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(".cp-te-shelf-row")];
  const at = rows.indexOf(document.activeElement as HTMLButtonElement);
  const next = event.key === "ArrowDown" ? at + 1 : event.key === "ArrowUp" ? at - 1 : event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 : null;
  if (next === null || !rows.length) return;
  event.preventDefault();
  // Used here: the page's own shortcuts (arrows step the player) must not also act on it.
  event.stopPropagation();
  rows[Math.max(0, Math.min(rows.length - 1, next))].focus();
}

/**
 * Every saved string out, newest first, filed under when it was last edited
 * the way Finder's and Notes' recents are. Each row leads with the cut
 * itself, drawn to scale (EditStrip), then its name, its bites and the
 * sequence it is cut from, how long it plays, and when it was touched. Two
 * lines on every row, so the list keeps one rhythm.
 */
export function EditList({ edits, onOpen }: Props) {
  const [query, setQuery] = useState("");
  const now = new Date();
  const words = query.trim().toLowerCase();
  const shown = [...edits].sort((a, b) => b.updated_at - a.updated_at)
    .filter((item) => !words || [item.title, ...item.sources].some((text) => text.toLowerCase().includes(words)));
  const groups: { label: string; items: EditSummary[] }[] = [];
  for (const item of shown) {
    const label = editedGroup(item.updated_at, now);
    if (groups.at(-1)?.label === label) groups.at(-1)?.items.push(item); else groups.push({ label, items: [item] });
  }
  return <div className="cp-te-shelf">
    <div className="cp-te-shelf-bar">
      <label className="cp-te-shelf-search">
        <IconSearch size={13} />
        <span className="cp-visually-hidden">Find a string out</span>
        <input type="search" value={query} placeholder="Find by name or sequence" spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Escape" && query) { event.stopPropagation(); setQuery(""); } }} />
      </label>
      <span className="cp-te-shelf-count">{edits.length.toLocaleString()} {edits.length === 1 ? "string out" : "string outs"}</span>
    </div>
    {shown.length ? <div className="cp-te-shelf-groups" onKeyDown={walk}>
      {groups.map((group) => <section key={group.label} className="cp-te-shelf-group" aria-label={group.label}>
        <h2 className="cp-te-shelf-day">{group.label}</h2>
        <ul className="cp-te-shelf-list">
          {group.items.map((item) => {
            const from = item.sources.length > 1 ? `${item.sources.length} sequences` : item.sources[0] ?? "";
            const length = playsFor(item);
            // One sentence for a screen reader; the cells alone would run together ("Scene4:1224Today").
            const name = [item.title, from && `cut from ${from}`, length && `plays ${length}`, item.bites ? bitesText(item.bites) : "",
              `edited ${editedLabel(item.updated_at, now)}`].filter(Boolean).join(", ");
            // The count first, so it survives when a long Avid sequence name is cut short.
            const meta = [bitesText(item.bites), from !== item.title ? from : ""].filter(Boolean).join(" · ");
            return <li key={item.id}>
              <button type="button" className="cp-te-shelf-row" onClick={() => onOpen(item.id)} aria-label={name}>
                <EditStrip frames={item.bite_frames} bites={item.bites} />
                <span className="cp-te-shelf-what">
                  <span className="cp-te-shelf-name">{item.title}</span>
                  <span className="cp-te-shelf-meta">{meta}</span>
                </span>
                <span className="cp-te-shelf-length">{length}</span>
                <span className="cp-te-shelf-when">{editedShort(item.updated_at, now)}</span>
              </button>
            </li>;
          })}
        </ul>
      </section>)}
    </div> : <p className="cp-te-shelf-none" role="status">No string out matches &ldquo;{query.trim()}&rdquo;.</p>}
  </div>;
}
