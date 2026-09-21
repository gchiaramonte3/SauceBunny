import { useId, useMemo, useState } from "react";
import type { AafDocument } from "../bindings/AafDocument";
import { sequenceTimecode, transcriptRows, untimedTranscriptRows } from "../lib/multitrack";
import { multitrackPeople, multitrackScope } from "../lib/multitrack-person";
import { MultitrackTranscriptTabs } from "./MultitrackTranscriptTabs";
import { MultitrackExport } from "./MultitrackExport";
import { MultitrackRunInfo } from "./MultitrackRunInfo";
import type { MultitrackRunReport } from "../hooks/use-multitrack-transcription";
import { useAiTranscriptSearch } from "../hooks/use-ai-transcript-search";

const passageKey = (kind: string, trackId: string, id: string) => JSON.stringify([kind, trackId, id]);

export function MultitrackTranscript({ document, frame, solo, onSeek, report, error, loading, active = true, aiModelId, initialAll = false }: {
  document: AafDocument; frame: number; solo: Set<string>; onSeek: (frame: number, trackId: string) => void;
  report?: MultitrackRunReport | null; error?: string | null; loading?: boolean;
  active?: boolean; aiModelId?: string | null; initialAll?: boolean;
}) {
  const [limit, setLimit] = useState(200);
  const people = useMemo(() => multitrackPeople(document), [document]);
  const [choice, setChoice] = useState(initialAll ? "all" : "");
  const firstWithText = people.find((person) => document.transcripts.some((track) => person.trackIds.includes(track.track_id) && (track.cues.length || track.timing_issues?.length)));
  const selected = choice === "all" ? "all" : people.find((person) => person.id === choice)?.id ?? firstWithText?.id ?? people[0]?.id ?? "all";
  const person = people.find((item) => item.id === selected), panelId = useId();
  const scoped = useMemo(() => multitrackScope(document, person?.trackIds), [document, person]);
  const rows = useMemo(() => transcriptRows(scoped), [scoped]);
  const untimed = useMemo(() => untimedTranscriptRows(scoped), [scoped]);
  const passages = useMemo(() => [
    ...rows.map((row) => ({ key: passageKey("cue", row.trackId, row.id), text: `${row.owner}: ${row.text}` })),
    ...untimed.map((row) => ({ key: passageKey("untimed", row.trackId, row.id), text: `${row.owner}: ${row.text}` })),
  ], [rows, untimed]);
  const search = useAiTranscriptSearch(passages, active, aiModelId);
  const { query, enabled, result } = search;
  const filtered = useMemo(() => rows.filter((row) => enabled
    ? !result.matches || result.matches.has(passageKey("cue", row.trackId, row.id))
    : `${row.owner} ${row.text}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())), [rows, query, enabled, result.matches]);
  const filteredUntimed = useMemo(() => untimed.filter((row) => enabled
    ? !result.matches || result.matches.has(passageKey("untimed", row.trackId, row.id))
    : `${row.owner} ${row.text}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())), [untimed, query, enabled, result.matches]);
  // Cue clocks and run information are fixed until their input changes. Only
  // the current-cue class follows the audition clock on each playback tick.
  const visible = useMemo(() => filtered.slice(0, limit).map((cue) => ({ ...cue, timecode: sequenceTimecode(document.manifest, cue.startFrame) })), [filtered, limit, document.manifest]);
  const visibleUntimed = useMemo(() => filteredUntimed.slice(0, limit).map((cue) => ({ ...cue, timecode: sequenceTimecode(document.manifest, cue.chunk_start_frame) })), [filteredUntimed, limit, document.manifest]);
  const runInfo = useMemo(() => <MultitrackRunInfo document={document} report={report} error={error} loading={loading} />, [document, report, error, loading]);
  return <aside className="cp-multitrack-transcript" aria-label="Track transcripts">
    <div className="cp-multitrack-transcript-content">
    <header className="cp-multitrack-transcript-head"><h2>Transcript</h2><span>{document.transcripts.length} / {document.manifest.tracks.length} tracks</span></header>
    <MultitrackTranscriptTabs people={people} selected={selected} panelId={panelId} onSelect={(id) => { setChoice(id); setLimit(200); search.changeQuery(""); }} />
    <form className="cp-multitrack-search" onSubmit={(event) => { event.preventDefault(); void search.search(); }}>
      <input type="search" aria-label="Search track transcripts" placeholder={enabled ? "Describe what you're looking for…" : "Search transcripts…"} value={query} maxLength={1000} onChange={(event) => { search.changeQuery(event.target.value); setLimit(200); }} />
      <div className="cp-multitrack-search-options">
        <label><input type="checkbox" checked={enabled} onChange={(event) => search.changeEnabled(event.target.checked)} />Search with AI</label>
        {enabled && (search.busy ? <button type="button" className="btn btn-ghost" onClick={search.stop}>Stop search</button> : <button type="submit" className="btn btn-ghost" disabled={!active || !query.trim() || !passages.length}>Search</button>)}
      </div>
      {enabled && <p className="cp-multitrack-note" role={result.phase === "error" ? "alert" : "status"}>{result.message || "Local AI. Press Enter to search."}</p>}
    </form>
    {runInfo}
    <div id={panelId} className="cp-multitrack-transcript-body" role="tabpanel" aria-label={person?.name ?? "All voices"} tabIndex={0}>
      {!rows.length && !untimed.length ? <div className="cp-multitrack-transcript-empty"><h3>{loading ? "Waiting for the first completed track" : report && !report.saved ? "No new transcript was saved" : scoped.transcripts.length ? "No speech found in completed tracks" : person ? `No transcript for ${person.name} yet` : "Read each mic in context"}</h3><p>{report?.failures.length ? "Open Get Info for the failed tracks, then check those tracks and generate again." : "Check tracks, choose an engine, then generate. Saved results appear here."}</p></div>
        : !filtered.length && !filteredUntimed.length ? <p className="cp-multitrack-note">{enabled && result.phase !== "ready" ? "No matching passages found so far." : "No matching transcript text."}</p>
          : visible.map((cue) => <button className={`cp-multitrack-cue${(!solo.size || solo.has(cue.trackId)) && frame >= cue.startFrame && frame < cue.endFrame ? " is-current" : ""}`} key={`${cue.trackId}:${cue.id}`} onClick={() => onSeek(cue.startFrame, cue.trackId)}>
            <span className="cp-multitrack-cue-meta"><strong>{cue.owner}</strong><span>{cue.timecode}</span></span><span className="cp-multitrack-cue-text">{cue.text}</span>{cue.boundary_review && <span className="cp-multitrack-note">Check processing boundary</span>}
          </button>)}
      {filtered.length > limit && <button className="btn btn-ghost cp-multitrack-more" onClick={() => setLimit(limit + 200)}>Show more ({filtered.length - limit} remaining)</button>}
      {filteredUntimed.length > 0 && <section className="cp-multitrack-untimed" aria-label="Text needing timing review"><h3>Timing needs review</h3>{visibleUntimed.map((cue) => <article key={`${cue.trackId}:${cue.id}`}><strong>{cue.owner}</strong><p>{cue.text}</p><details><summary>Timing details</summary>{cue.reason}<br />Reported: {cue.reported_timing}<br />Audio segment starts at {cue.timecode}</details></article>)}
        {filteredUntimed.length > limit && <button className="btn btn-ghost" onClick={() => setLimit(limit + 200)}>Show more untimed text</button>}</section>}
    </div>
    </div>
    <MultitrackExport document={document} person={person} />
  </aside>;
}
