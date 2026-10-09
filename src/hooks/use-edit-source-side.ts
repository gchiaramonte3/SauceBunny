import { useEffect, useMemo, useRef, useState } from "react";
import type { AafDocument } from "../bindings/AafDocument";
import type { EditDocument } from "../bindings/EditDocument";
import type { AskCitation } from "../lib/edit-ask";
import { placeWords, type TimelineWord } from "../lib/edit-model";
import { ALL_VOICES, firstSpeaker, sourceOrder, sourcePeople } from "../lib/edit-source-view";
import { measure } from "../lib/pipeline";
import { fromWords } from "../lib/edit-words-cache";
import { alternativeLane } from "../lib/multitrack-graph";
import type { EditSourceInfo } from "../components/EditSourcePane";
import { useEditPlayback } from "./use-edit-playback";

export type EditMarks = { in: number | null; out: number | null };
/**
 * What Insert or Append takes from the source: words when text is selected,
 * else the marked time, and the lanes whose mics are on, in the sequence's
 * own track order (so they patch top-down the way the sequence has them).
 */
/**
 * What the source offers an edit: its marks (either may be unset, as in
 * Avid), its playhead, the people it brings, and the record track each lands
 * on (the patch).
 */
export type EditSourceTake = { source: string; words: TimelineWord[]; in: number | null; out: number | null; playhead: number; lanes: string[]; patch: Record<string, number> };

/**
 * The patch, as Avid's patch panel: each source track brought lands on a
 * record track. One patched by hand keeps its track; the rest go top-down from
 * A1 onto tracks nobody was patched to, so a single lav lands on A1 whoever
 * it is, and two land on A1 and A2.
 */
export function patchFor(lanes: string[], chosen: Record<string, number>): Record<string, number> {
  const taken = new Set(lanes.flatMap((lane) => chosen[lane] != null ? [chosen[lane]] : []));
  let next = 1;
  return Object.fromEntries(lanes.map((lane) => {
    if (chosen[lane] != null) return [lane, chosen[lane]];
    while (taken.has(next)) next++;
    taken.add(next);
    return [lane, next];
  }));
}

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
  /** Record tracks patched by hand, per source: person to track number. */
  const [patches, setPatches] = useState<Record<string, Record<string, number>>>({});
  const source = sources.find((item) => item.id === chosen) ?? sources[0] ?? null;
  const aaf = source ? documents.get(source.id) : undefined;
  const frames = source ? Math.round(source.duration * fps) : 0;
  const whole: EditDocument = useMemo(() => ({ ...document, segments: source && frames > 0 ? [{ kind: "source", id: "whole", source: source.id, in_frame: 0, out_frame: frames }] : [], mutes: [], markers: [] }),
    [document, source, frames]);
  // Kept with the word list, so a tab reopened over the same words places none.
  const own = useMemo(() => source ? fromWords(words, `source\n${source.id}\n${source.duration}`, () => measure("String Outs", `Placing the source's words (of ${words.length.toLocaleString("en-US")})`,
    () => placeWords(words, { segments: [{ id: "whole", source: source.id, srcIn: 0, srcOut: source.duration }], mutes: [] }))) : [], [words, source]);
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
  // Source track selectors, as Avid's: an edit brings exactly the source
  // tracks that are on. Until the editor turns any on or off they FOLLOW THE
  // TEXT: the mics of whoever said the selected words, or with only marks the
  // person whose tab is read (every main mic in All voices). Every main mic
  // on by default, as Avid loads a clip, brought a whole room into each cut:
  // one word of Cara's became that word under all fifty people, because every
  // lav in the room heard her.
  const following = !source || !selectors[source.id];
  const mains = useMemo(() => aaf ? aaf.manifest.tracks.filter((track) => !alternativeLane(aaf, track.id)).map((track) => track.id)
    : [...laneOf].filter(([, lane]) => document.tracks.find((track) => track.id === lane)?.featured !== false).map(([mic]) => mic), [aaf, laneOf, document.tracks]);
  const micsOf = useMemo(() => (lanes: Set<string>) => [...laneOf].filter(([, lane]) => lanes.has(lane)).map(([mic]) => mic), [laneOf]);
  const speaking = chosenWords.map((word) => word.track);
  const selected = useMemo(() => new Set(!following && source ? selectors[source.id]
    : speaking.length ? micsOf(new Set(speaking))
    : tab !== ALL_VOICES ? micsOf(new Set([tab])) : mains),
  // `speaking` is derived from chosenWords; the words, not the array, are what change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  [following, source, selectors, chosenWords, micsOf, tab, mains]);
  // The source monitor plays the source: the mics that are on, whatever the record has patched.
  const audible = solo.size ? [...solo] : [...new Set([...laneOf].filter(([mic]) => selected.has(mic)).map(([, lane]) => lane))];
  // The source's playhead moves in `playback.frames`; what draws it reads it there (use-frame).
  const playback = useEditPlayback({ document: whole, audible, active: active && !!source });
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
  const mark = (edge: "in" | "out", at = playback.frames.get() / fps) => setMarks(edge === "in"
    ? { in: at, out: marks.out != null && marks.out > at ? marks.out : null }
    : { in: marks.in != null && marks.in < at ? marks.in : null, out: at });
  // Exactly the source tracks that are on (see `selected`), in track order, and where each lands.
  const order = aaf ? aaf.manifest.tracks.map((track) => track.id) : [...laneOf.keys()];
  const bringing = [...new Set(order.filter((mic) => laneOf.has(mic) && selected.has(mic)).map((mic) => laneOf.get(mic)!))];
  const patch = patchFor(bringing, source ? patches[source.id] ?? {} : {});
  return {
    mode, setMode, source, aaf, sources, choose: (id: string) => { playback.pause(); setChosen(id); },
    people, tab, setTab: (next: string) => source && setTabs((state) => ({ ...state, [source.id]: next })),
    own, shown, range, setRange, marks, playback, laneOf, selected, following, expanded, solo,
    /** Back to source tracks that follow the selected words. */
    followText: () => source && setSelectors((state) => { const next = { ...state }; delete next[source.id]; return next; }),
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
    /**
     * Match Frame, as Avid's: the source a record clip came from, parked on the
     * matched frame with an In marked there, that person's mic the one source
     * track on, and patched back to the record track they came from, so V or B
     * puts more of the same moment where it was.
     */
    match: (target: { source: string; lane: string; at: number; layer: number }) => {
      const into = sources.find((item) => item.id === target.source);
      if (!into) return false;
      const mic = document.tracks.find((track) => track.id === target.lane)?.source_tracks[into.id];
      setChosen(into.id);
      setTabs((state) => ({ ...state, [into.id]: target.lane }));
      setRanges((state) => Object.fromEntries(Object.entries(state).filter(([key]) => !key.startsWith(`${into.id}\n`))));
      setExplicit((state) => ({ ...state, [into.id]: { in: target.at, out: null } }));
      if (mic) setSelectors((state) => ({ ...state, [into.id]: [mic] }));
      setPatches((state) => ({ ...state, [into.id]: { ...state[into.id], [target.lane]: target.layer } }));
      if (into.id === source?.id) void playback.seek(Math.round(target.at * fps), false); else { playback.pause(); pendingSeek.current = target.at; }
      return true;
    },
    /** Whether the source has anything marked for an edit: words, an In or an Out. */
    marked: marks.in != null || marks.out != null,
    /**
     * The source's contribution to an Insert or Overwrite, or null with no
     * source. Its marks need not be a pair: which marks decide the edit is
     * Avid's three-point rule (edit-three-point.ts), applied with the record's.
     */
    take: (): EditSourceTake | null => {
      if (!source) return null;
      return { source: source.id, words: chosenWords, in: marks.in, out: marks.out, playhead: playback.frames.get() / fps, lanes: bringing, patch };
    },
    /** The record track each person brought lands on. */
    patch,
    /** Patch a person to a record track, or back to top-down (null). */
    setPatch: (lane: string, layer: number | null) => source && setPatches((state) => {
      const mine = { ...state[source.id] };
      if (layer == null) delete mine[lane]; else mine[lane] = layer;
      return { ...state, [source.id]: mine };
    }),
  };
}

export type EditSourceSide = ReturnType<typeof useEditSourceSide>;
