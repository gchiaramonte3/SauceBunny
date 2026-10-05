import { useEffect, useMemo, useRef, useState } from "react";
import type { AafDocument } from "../bindings/AafDocument";
import type { EditDocument } from "../bindings/EditDocument";
import type { AskCitation } from "../lib/edit-ask";
import { placeWords, type TimelineWord } from "../lib/edit-model";
import { ALL_VOICES, firstSpeaker, sourceOrder, sourcePeople } from "../lib/edit-source-view";
import { measure } from "../lib/pipeline";
import { alternativeLane } from "../lib/multitrack-graph";
import type { EditSourceInfo } from "../components/EditSourcePane";
import { useEditPlayback } from "./use-edit-playback";

export type EditMarks = { in: number | null; out: number | null };
/**
 * What Insert or Append takes from the source: words when text is selected,
 * else the marked time, and the lanes whose mics are on, in the sequence's
 * own track order (so they patch top-down the way the sequence has them).
 */
export type EditSourceTake = { source: string; words: TimelineWord[]; from: number; to: number; lanes: string[] };

/** Marks to open with, from AAF Audio's "Open in String Outs": seconds into that sequence. */
export type EditSourceMarks = { documentId: string; in: number | null; out: number | null; tick: number };

type Options = {
  document: EditDocument; sources: EditSourceInfo[]; documents: Map<string, AafDocument>;
  words: TimelineWord[]; colors: Record<string, string>; fps: number; active: boolean;
  /** Marks AAF Audio carried over; applied once per tick, to the source made from that sequence. */
  request?: EditSourceMarks | null;
};

const NO_MARKS: EditMarks = { in: null, out: null };

/**
 * The SOURCE side of Source/Record, shared by the source pane (its text) and
 * the timeline (its tracks), as Avid's source monitor is shared by the
 * monitor and the timeline's Source view. One source at a time, one playhead,
 * one pair of marks: selecting text marks it, and I and O mark time directly.
 *
 * Source track selectors say which mics an insert brings, as in Avid: a main
 * track starts on, a group alternate off (as in AAF Audio). The new clip
 * plays those mics plus whoever said the selected words, each patched to a
 * record track if they have none yet; anyone else is not in the clip at all
 * (filler on their track).
 */
export function useEditSourceSide({ document, sources, documents, words, colors, fps, active, request }: Options) {
  const [mode, setMode] = useState<"source" | "record">("record");
  const [chosen, setChosen] = useState<string | null>(null);
  const [tabs, setTabs] = useState<Record<string, string>>({});
  const [ranges, setRanges] = useState<Record<string, [number, number] | null>>({});
  const [explicit, setExplicit] = useState<Record<string, EditMarks>>({});
  const [selectors, setSelectors] = useState<Record<string, string[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [solo, setSolo] = useState<Set<string>>(() => new Set());
  const source = sources.find((item) => item.id === chosen) ?? sources[0] ?? null;
  const aaf = source ? documents.get(source.id) : undefined;
  const frames = source ? Math.round(source.duration * fps) : 0;
  const whole: EditDocument = useMemo(() => ({ ...document, segments: source && frames > 0 ? [{ kind: "source", id: "whole", source: source.id, in_frame: 0, out_frame: frames }] : [], mutes: [], markers: [] }),
    [document, source, frames]);
  const own = useMemo(() => source ? measure("String Outs", `Placing the source's words (of ${words.length.toLocaleString("en-US")})`, () => placeWords(words, { segments: [{ id: "whole", source: source.id, srcIn: 0, srcOut: source.duration }], mutes: [] })) : [], [words, source]);
  const people = useMemo(() => source ? sourcePeople(document.tracks, source.id, colors, aaf) : [], [document.tracks, source, colors, aaf]);
  const tab = source ? tabs[source.id] ?? firstSpeaker(people, own) : ALL_VOICES;
  const shown = useMemo(() => measure("String Outs", `Ordering ${own.length.toLocaleString("en-US")} source words for ${tab === ALL_VOICES ? "All voices" : "one person"}`, () => sourceOrder(own, tab)), [own, tab]);
  const rangeKey = source ? `${source.id}\n${tab}` : "";
  const range = ranges[rangeKey] ?? null;
  const chosenWords = useMemo(() => range ? shown.slice(range[0], range[1] + 1).map((item) => item.word) : [], [range, shown]);
  // Which lane each of this source's mics feeds, and which mics insert.
  const laneOf = useMemo(() => new Map<string, string>(source ? document.tracks.flatMap((track) => {
    const mic = track.source_tracks[source.id];
    return mic ? [[mic, track.id] as [string, string]] : [];
  }) : []), [document.tracks, source]);
  // Main tracks on, group alternates off. Without the sequence itself (still
  // loading, or it failed) the lanes say which mics are angles.
  const selected = useMemo(() => new Set(source && selectors[source.id] ? selectors[source.id]
    : aaf ? aaf.manifest.tracks.filter((track) => !alternativeLane(aaf, track.id)).map((track) => track.id)
    : [...laneOf].filter(([, lane]) => document.tracks.find((track) => track.id === lane)?.featured !== false).map(([mic]) => mic)), [source, selectors, aaf, laneOf, document.tracks]);
  // The source monitor plays the source: its mics that are on, and whoever
  // said the selected words, whatever the record has patched.
  const speaking = chosenWords.map((word) => word.track);
  const audible = solo.size ? [...solo] : [...new Set([...[...laneOf].filter(([mic]) => selected.has(mic)).map(([, lane]) => lane), ...speaking])];
  const playback = useEditPlayback({ document: whole, audible, active: active && !!source });
  const playhead = playback.frame / fps;
  const marks: EditMarks = chosenWords.length ? { in: Math.min(...chosenWords.map((word) => word.start)), out: Math.max(...chosenWords.map((word) => word.end)) }
    : source ? explicit[source.id] ?? NO_MARKS : NO_MARKS;

  // Revealing a line in another source changes the source first; the seek
  // waits for the playback engine to take that source's document.
  const pendingSeek = useRef<number | null>(null);
  useEffect(() => {
    if (pendingSeek.current == null) return;
    void playback.seek(Math.round(pendingSeek.current * fps), false);
    pendingSeek.current = null;
  }, [whole, playback, fps]);

  // The last thing marked wins: selecting text replaces an earlier I or O,
  // and clearing the text clears them too, so nothing marked before returns.
  // AAF Audio's In and Out arrive with "Open in String Outs": that source, marked, parked on In.
  const applied = useRef(0);
  useEffect(() => {
    const into = request && document.sources.find((item) => item.document_id === request.documentId);
    if (!request || !into || applied.current === request.tick) return;
    applied.current = request.tick;
    setChosen(into.id);
    setRanges((state) => Object.fromEntries(Object.entries(state).filter(([key]) => !key.startsWith(`${into.id}\n`))));
    setExplicit((state) => ({ ...state, [into.id]: { in: request.in, out: request.out } }));
    if (request.in == null) return;
    if (into.id === source?.id) void playback.seek(Math.round(request.in * fps), false); else pendingSeek.current = request.in;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- applied once per tick; the source and engine are read as they are then
  }, [request, document.sources]);

  const setRange = (next: [number, number] | null) => {
    setRanges((state) => ({ ...state, [rangeKey]: next }));
    if (source) setExplicit((state) => ({ ...state, [source.id]: NO_MARKS }));
  };
  /** Marks as edited by a key, with Avid's rule that a mark set past the other one clears it. */
  const setMarks = (next: EditMarks) => {
    if (!source) return;
    setRanges((state) => ({ ...state, [rangeKey]: null }));
    setExplicit((state) => ({ ...state, [source.id]: next }));
  };
  const mark = (edge: "in" | "out", at = playhead) => setMarks(edge === "in"
    ? { in: at, out: marks.out != null && marks.out > at ? marks.out : null }
    : { in: marks.in != null && marks.in < at ? marks.in : null, out: at });
  return {
    mode, setMode, source, aaf, sources, choose: (id: string) => { playback.pause(); setChosen(id); },
    people, tab, setTab: (next: string) => source && setTabs((state) => ({ ...state, [source.id]: next })),
    own, shown, range, setRange, marks, playback, playhead, laneOf, selected, expanded, solo,
    markIn: () => mark("in"), markOut: () => mark("out"),
    clearMarks: () => setRange(null),
    clearEdge: (edge: "in" | "out") => setMarks({ ...marks, [edge]: null }),
    toggleSelector: (trackId: string, only: boolean) => source && setSelectors((state) => {
      const current = new Set(state[source.id] ?? selected);
      const next = only ? new Set([trackId]) : current.delete(trackId) ? current : current.add(trackId);
      return { ...state, [source.id]: [...next] };
    }),
    toggleExpanded: (trackId: string, all: boolean) => setExpanded((current) => {
      const parents = (aaf?.manifest.graph?.lanes ?? []).map((lane) => lane.parent_track_id).filter((id): id is string => !!id);
      if (all) return current.has(trackId) ? new Set() : new Set(parents);
      const next = new Set(current);
      if (!next.delete(trackId)) next.add(trackId);
      return next;
    }),
    toggleSolo: (lane: string) => setSolo((current) => { const next = new Set(current); if (!next.delete(lane)) next.add(lane); return next; }),
    /** A cited line: its source, its speaker's tab, the line selected and the source parked on it. */
    reveal: (line: AskCitation) => {
      const into = sources.find((item) => item.id === line.source);
      if (!into) return false;
      const placed = placeWords(words, { segments: [{ id: "whole", source: into.id, srcIn: 0, srcOut: into.duration }], mutes: [] });
      const ids = new Set(line.wordIds), order = sourceOrder(placed, line.track);
      const found = order.flatMap((item, index) => ids.has(item.word.id) ? [index] : []);
      if (!found.length) return false;
      setChosen(into.id);
      setTabs((state) => ({ ...state, [into.id]: line.track }));
      setRanges((state) => ({ ...state, [`${into.id}\n${line.track}`]: [found[0], found[found.length - 1]] }));
      if (into.id === source?.id) void playback.seek(Math.round(line.from * fps), false); else { playback.pause(); pendingSeek.current = line.from; }
      return true;
    },
    /** The source's contribution to an insert, or null when nothing is marked. */
    take: (): EditSourceTake | null => {
      if (!source || marks.in == null || marks.out == null || marks.out <= marks.in) return null;
      // The mics that are on, and whoever said the words selected: a line
      // chosen in someone's tab always comes with them, a group angle too.
      const speaking = new Set(chosenWords.map((word) => word.track));
      const order = aaf ? aaf.manifest.tracks.map((track) => track.id) : [...laneOf.keys()];
      const lanes = [...new Set(order.filter((mic) => laneOf.has(mic) && (selected.has(mic) || speaking.has(laneOf.get(mic)!))).map((mic) => laneOf.get(mic)!))];
      return { source: source.id, words: chosenWords, from: marks.in, to: marks.out, lanes };
    },
  };
}

export type EditSourceSide = ReturnType<typeof useEditSourceSide>;
