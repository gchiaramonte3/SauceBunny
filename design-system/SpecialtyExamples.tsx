import { useCallback, useId, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { GenerateButton } from "../src/components/GenerateButton";
import { StatefulButton } from "../src/components/StatefulButton";
import { IconChevronDown, IconInfo, IconMore, IconMusic, IconPlay } from "../src/components/Icons";
import { useDismiss } from "../src/hooks/use-dismiss";
import { useMenuKeys } from "../src/hooks/use-menu-keys";
import { useModalFocus } from "../src/hooks/use-modal-focus";
import { Button } from "./Button";
import { Comparison } from "./Comparison";
import type { ExampleProps } from "./example-types";
import "./specialty.css";

type DemoPhase = "idle" | "loading" | "success" | "error";

/** Actual specialty renderers with local props. No transcription jobs run. */
function GenerateExamples({ state, size }: ExampleProps) {
  const [detectSpeakers, setDetectSpeakers] = useState(true);
  const [expectedSpeakers, setExpectedSpeakers] = useState(0);
  const [phase, setPhase] = useState<DemoPhase>("idle");
  const [progress, setProgress] = useState(42);
  const [pipeline, setPipeline] = useState<"whisper" | "diarize-process" | "diarize-merge">("whisper");
  const effectivePhase = state === "busy" ? "loading" : phase;
  const busy = effectivePhase === "loading";
  const unavailable = state === "disabled";
  const idleLabel = phase === "success" ? "Generate transcript · run again"
    : phase === "error" ? "Generate transcript · retry"
      : detectSpeakers ? "Generate transcript + speakers" : "Generate transcript";
  const loadingLabel = pipeline === "diarize-process" ? "Detecting speakers…"
    : pipeline === "diarize-merge" ? "Merging speaker labels…" : `Transcribing… ${progress}%`;

  return <Comparison same currentBasis="mixed" proposedBasis="component"
    current={<div className="cp-ds-specialty-stack" data-testid="generate-specialty-current">
      <p className="cp-ds-specialty-fidelity">Actual GenerateButton. Options reproduce Sidebar markup; all values are local fixtures.</p>
      <div className="cp-source-actions cp-ds-generate-source" data-testid="generate-source-options">
        <label className="cp-toggle-row" title="Fixture only: include speaker detection after transcription">
          <input type="checkbox" checked={detectSpeakers} onChange={(event) => setDetectSpeakers(event.target.checked)} disabled={busy || unavailable} />
          <span className="lbl">Detect speakers</span>
        </label>
        {detectSpeakers && <label className="cp-toggle-row cp-ds-generate-expected">
          <span className="lbl">Expected speakers</span>
          <select className="cp-select xs cp-mini-select" value={expectedSpeakers}
            onChange={(event) => setExpectedSpeakers(Number(event.target.value))} disabled={busy || unavailable}>
            <option value={0}>Auto</option><option value={2}>2</option><option value={3}>3</option><option value={4}>4</option><option value={5}>5</option><option value={6}>6+</option>
          </select>
        </label>}
        <div data-testid="generate-primary">
          <GenerateButton className="cp-source-action" idleLabel={idleLabel} loadingLabel={loadingLabel}
            loading={busy} progress={pipeline === "whisper" ? progress : null}
            resolution={effectivePhase === "success" || effectivePhase === "error" ? effectivePhase : null}
            onClick={() => setPhase("loading")} disabled={busy || unavailable}
            title="Catalog simulation only. No model, audio, or transcript is loaded." />
        </div>
        {busy && pipeline !== "whisper" && <div className="cp-phase-track" aria-label={`Pipeline stage: ${pipeline}`}>
          <span className="step done">Whisper</span><span className="sep">→</span>
          <span className={`step ${pipeline === "diarize-merge" ? "done" : "active"}`}>Diarize</span><span className="sep">→</span>
          <span className={`step ${pipeline === "diarize-merge" ? "active" : ""}`}>Merge</span>
        </div>}
      </div>
      <fieldset className="cp-ds-specialty-demo-controls"><legend>Fixture controls</legend>
        <div className="cp-ds-specialty-actions">{(["idle", "loading", "success", "error"] as const).map((value) =>
          <Button key={value} size={size} variant="quiet" aria-pressed={phase === value} onClick={() => setPhase(value)}>{value === "idle" ? "Reset" : value === "loading" ? "Loading" : value === "success" ? "Success" : "Error"}</Button>)}</div>
        <label>Pipeline stage<select className="cp-select" value={pipeline} onChange={(event) => setPipeline(event.target.value as typeof pipeline)}>
          <option value="whisper">Transcription</option><option value="diarize-process">Speaker detection</option><option value="diarize-merge">Merge speaker labels</option>
        </select></label>
        <label>Progress · {progress}%<input type="range" min="0" max="100" value={progress} onChange={(event) => setProgress(Number(event.target.value))} aria-label="Simulated transcription progress" /></label>
      </fieldset>
      <p className="cp-ds-specialty-note" role="status">{busy ? `Simulation: ${loadingLabel}` : effectivePhase === "success" ? "Simulation completed. No transcript was created." : effectivePhase === "error" ? "Simulated failure. Reset or retry the fixture; no saved data changed." : "Click Generate to inspect the loading treatment. Nothing is sent, downloaded, or transcribed."}</p>
      <p className="cp-ds-specialty-note">Keep this full-width CTA, sparkle, green wash, progress fill, and outcome flash. The generic 30px/26px command size does not replace its geometry.</p>
    </div>}
    proposed={<div className="cp-ds-specialty-stack" data-testid="generate-specialty-states">
      <p className="cp-ds-specialty-fidelity">Actual production components. States are held for inspection, including their existing reduced-motion behavior.</p>
      <div className="cp-ds-generate-state-list">
        {(["disabled", "loading", "success", "error"] as const).map((sample) => <div key={sample} className="cp-ds-generate-state" data-testid={`generate-state-${sample}`}>
          <span className="cp-ds-specialty-state-label">{sample === "loading" ? "Loading · 67%" : sample.charAt(0).toUpperCase() + sample.slice(1)}</span>
          <GenerateButton idleLabel="Generate transcript + speakers" loadingLabel="Transcribing… 67%" loading={sample === "loading"}
            progress={67} resolution={sample === "success" || sample === "error" ? sample : null}
            disabled={sample === "disabled" || sample === "loading"} onClick={() => setPhase("idle")} title="Held catalog state; does not start a job" />
        </div>)}
      </div>
      <div className="cp-ds-stateful-samples"><h4>Shared async renderer</h4><p className="cp-ds-specialty-note">Actual StatefulButton, as used by Fetch. This is a separate renderer, not a substitute Generate CTA.</p>
        <div className="cp-ds-specialty-actions">{(["idle", "loading", "success", "error"] as const).map((sample) => <div key={sample} className="cp-ds-stateful-sample" data-testid={`stateful-state-${sample}`}>
          <span className="cp-ds-specialty-state-label">{sample}</span>
          <StatefulButton phase={sample} idleContent="Fetch" loadingLabel="" className="btn btn-ghost cp-sbtn-fetch" onClick={() => setPhase("idle")} title="Fixture only; no source will be fetched" />
        </div>)}</div>
      </div>
      <p className="cp-ds-specialty-note">Transcript-only is the existing checkbox-off label. Speaker-only work uses Tools → Detect speakers or Re-detect speakers, not another Generate-button variant.</p>
    </div>} />;
}

type MockSpeaker = { id: string; name: string; glyph: string; color: string; seconds: number; lines: number; text: string; time: string };
const SPEAKERS: MockSpeaker[] = [
  { id: "speaker-1", name: "Gasper", glyph: "GC", color: "var(--gold)", seconds: 84, lines: 3, text: "Let's try the tighter opening and hold on this reaction.", time: "00:00:12:08" },
  { id: "speaker-2", name: "Alexandra", glyph: "AM", color: "var(--novella-violet)", seconds: 36, lines: 2, text: "The pause before the reveal is working better here.", time: "00:00:26:14" },
  { id: "music", name: "Music", glyph: "music", color: "var(--fg-3)", seconds: 12, lines: 1, text: "Instrumental music.", time: "00:00:40:00" },
];
const talkTime = (seconds: number) => seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;

/** Source-markup fixture. TranscriptViewer and SpeakerRosterModal themselves
 * import persistence, native APIs, capture and undo stores, so are not mounted. */
function SpeakerExamples({ state, size }: ExampleProps) {
  const [speakersOnly, setSpeakersOnly] = useState(false);
  const [analyzedOnly, setAnalyzedOnly] = useState(false);
  const [speakers, setSpeakers] = useState(SPEAKERS);
  const [view, setView] = useState<"text" | "speakers">("speakers");
  const [expanded, setExpanded] = useState<string[]>([]);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [portalTextStyle, setPortalTextStyle] = useState<CSSProperties>({});
  const [filter, setFilter] = useState("");
  const [sort, setSort] = useState<"talk" | "name" | "order">("talk");
  const [selected, setSelected] = useState<string[]>([]);
  const [message, setMessage] = useState("All actions below affect only this specimen.");
  const uid = useId();
  const toolsRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  const fixtureRef = useRef<HTMLDivElement>(null);
  const manageRef = useRef<HTMLButtonElement>(null);
  const closeTools = useCallback(() => setToolsOpen(false), []);
  const closeModal = useCallback(() => setModalOpen(false), []);
  const openModal = useCallback(() => {
    if (fixtureRef.current) {
      // Body portals leave the catalog's enlarged-text ancestor. Carry its
      // computed tokens so the same source markup keeps the same text size.
      const computed = getComputedStyle(fixtureRef.current);
      const tokens = ["--text-2xs", "--text-xs", "--text-sm", "--text-base", "--text-md", "--text-lg", "--text-xl", "--text-2xl", "--text-3xl", "--text-4xl", "--text-5xl"];
      setPortalTextStyle(Object.fromEntries(tokens.map((token) => [token, computed.getPropertyValue(token)])) as CSSProperties);
    }
    setModalOpen(true);
  }, []);
  useDismiss(toolsRef, closeTools, toolsOpen);
  useMenuKeys(menuRef, toolsOpen, closeTools);
  useModalFocus(modalOpen, modalRef, manageRef);
  useDismiss(modalRef, closeModal, modalOpen);
  const busy = state === "busy";
  const disabled = state === "disabled";
  const glyph = (speaker: MockSpeaker) => speaker.glyph === "music" ? <IconMusic size={13} /> : speaker.glyph;
  const announce = (value: string) => setMessage(`${value} Catalog only; no transcript or playback changed.`);
  const rename = (id: string, name: string) => setSpeakers((rows) => rows.map((row) => row.id === id ? { ...row, name } : row));
  const toggleSelected = (id: string) => setSelected((ids) => ids.includes(id) ? ids.filter((other) => other !== id) : [...ids, id]);
  const shown = [...speakers].filter((speaker) => speaker.name.toLowerCase().includes(filter.toLowerCase())).sort((a, b) => sort === "name" ? a.name.localeCompare(b.name) : sort === "talk" ? b.seconds - a.seconds : 0);
  const transcriptFixtures = [
    { title: "Interview assembly", speakers: true, analyzed: true },
    { title: "Client conversation", speakers: true, analyzed: false },
    { title: "Imported captions", speakers: false, analyzed: false },
  ].filter((item) => (!speakersOnly || item.speakers) && (!analyzedOnly || item.analyzed));
  function switchView(event: KeyboardEvent<HTMLDivElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" ? "text" : event.key === "End" ? "speakers" : view === "text" ? "speakers" : "text";
    setView(next);
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-view="${next}"]`)?.focus();
  }
  const roster = <>
    <div className="cp-spk-head"><span className="cp-spk-title">Speakers</span><span className="cp-spk-badge">{speakers.length}</span>
      <button type="button" className="cp-spk-sortbtn cp-spk-casts" disabled title="Saved casts are not connected in this fixture">Casts</button>
      {modalOpen && <button type="button" className="cp-spk-x" aria-label="Close speaker fixture" onClick={closeModal}>×</button>}
    </div>
    <div className="cp-spk-tools">
      <input className="cp-input cp-spk-filter" value={filter} onChange={(event) => setFilter(event.target.value)} placeholder={`Filter ${speakers.length} speakers`} aria-label="Filter fixture speakers" />
      <div className="cp-spk-sort" role="group" aria-label="Sort fixture speakers">{(["talk", "name", "order"] as const).map((value) => <button type="button" key={value}
        className={`cp-spk-sortbtn${sort === value ? " on" : ""}`} aria-pressed={sort === value} onClick={() => setSort(value)}>{value === "talk" ? "Talk time" : value === "name" ? "Name" : "Order"}</button>)}</div>
    </div>
    <div className="cp-spk-list">{shown.map((speaker) => <div className={`cp-spk-row${selected.includes(speaker.id) ? " picked" : ""}`} key={speaker.id}>
      <input type="checkbox" className="cp-spk-check" aria-label={`Select ${speaker.name}`} checked={selected.includes(speaker.id)} onChange={() => toggleSelected(speaker.id)} />
      <button type="button" className="cp-spk-pip cp-spk-pip-btn" style={{ background: speaker.color }} aria-label={`Change ${speaker.name} colour`}
        onClick={() => { setSpeakers((rows) => rows.map((row) => row.id === speaker.id ? { ...row, color: row.color === "var(--gold)" ? "var(--novella-violet)" : "var(--gold)" } : row)); announce("Fixture colour changed."); }}>{glyph(speaker)}</button>
      <input className="cp-spk-name" value={speaker.name} aria-label={`Speaker name: ${speaker.name}`} onChange={(event) => rename(speaker.id, event.target.value)} />
      <span className="cp-spk-count" title={`${speaker.lines} turns`}>{talkTime(speaker.seconds)}</span>
      <button type="button" className="cp-spk-play" aria-label={`Play ${speaker.name}`} title="Jump to their first line, fixture only" onClick={() => announce(`Selected ${speaker.name}'s first line at ${speaker.time}.`)}><IconPlay size={11} /></button>
    </div>)}{shown.length === 0 && <p className="cp-ds-specialty-note">No speaker matches this filter.</p>}</div>
    {selected.length > 0 && <div className="cp-spk-foot"><span className="cp-spk-footcount">{selected.length} selected</span>
      <select className="cp-select cp-spk-merge" value="" aria-label="Merge selected fixture speakers" onChange={(event) => {
        const target = speakers.find((speaker) => speaker.id === event.target.value);
        if (!target) return;
        setSelected([]); announce(`Merge into ${target.name} demonstrated without removing rows.`);
      }}><option value="">Merge into…</option>{speakers.filter((speaker) => !selected.includes(speaker.id)).map((speaker) => <option value={speaker.id} key={speaker.id}>{speaker.name}</option>)}</select>
      <button type="button" className="btn btn-ghost btn-compact" onClick={() => setSelected([])}>Clear selection</button>
    </div>}
  </>;

  return <Comparison same currentBasis="markup" proposedBasis="markup" current={<div className="cp-ds-specialty-stack" ref={fixtureRef} data-testid="speakers-source-fixture">
    <p className="cp-ds-specialty-fidelity">TranscriptViewer markup and production CSS, reproduced with mock speakers. No viewer, source, or store is mounted.</p>
    <section className="cp-ds-reader-filter-fixture" aria-label="Transcript library filter fixture">
      <h4>Transcript Library · filters</h4>
      <div className="cp-reader-chips">
        <button type="button" className={`cp-reader-chip${speakersOnly ? " on" : ""}`} aria-pressed={speakersOnly} disabled={disabled}
          onClick={() => setSpeakersOnly((value) => !value)} data-testid="speaker-reader-filter">Speakers</button>
        <button type="button" className={`cp-reader-chip${analyzedOnly ? " on" : ""}`} aria-pressed={analyzedOnly} disabled={disabled}
          onClick={() => setAnalyzedOnly((value) => !value)} data-testid="speaker-reader-analyzed">Analyzed</button>
      </div>
      <ul className="cp-ds-reader-filter-results" aria-label="Filtered transcript fixtures" data-testid="speaker-reader-results">{transcriptFixtures.map((item) => <li key={item.title}>{item.title}<span>{item.speakers ? "Speaker labels" : "No speaker labels"}{item.analyzed ? " · analyzed" : ""}</span></li>)}</ul>
      <p className="cp-ds-specialty-note">Exact TranscriptReader chip classes and pressed-state behavior. Speakers filters saved transcripts; it does not start speaker detection or open Manage.</p>
    </section>
    <h4 className="cp-ds-speaker-section-title">Open transcript · tools and views</h4>
    <div className="cp-ds-speaker-toolbar">
      <div className="cp-tx-tools" ref={toolsRef}>
        <button type="button" className={`btn btn-ghost cp-tx-iconbtn${toolsOpen ? " active" : ""}`} aria-haspopup="menu" aria-expanded={toolsOpen}
          aria-controls={toolsOpen ? `${uid}-tools` : undefined} onClick={() => setToolsOpen((open) => !open)} disabled={disabled} data-testid="speaker-tools-trigger"><IconMore size={13} />Tools<IconChevronDown size={10} /></button>
        {toolsOpen && <div className="cp-tx-dl-menu" role="menu" id={`${uid}-tools`} ref={menuRef} aria-label="Transcript tools fixture">
          <button type="button" role="menuitem" disabled={busy} onClick={() => { closeTools(); announce("Speaker-only detection selected. The text is kept."); }}>{busy ? "Detecting speakers…" : "Re-detect speakers"}</button>
          <button type="button" role="menuitem" onClick={() => { closeTools(); announce("Transcript history selected."); }}>Transcript history…</button>
          <button type="button" role="menuitem" onClick={() => { closeTools(); announce("Source start timecode selected."); }}>Set source start timecode…</button>
        </div>}
      </div>
      <button type="button" className="btn btn-ghost cp-tx-iconbtn" title="Speaker insights" disabled={disabled}
        data-testid="speaker-insights-trigger" onMouseDown={(event) => event.stopPropagation()}
        onClick={() => { closeTools(); announce("Insights simulation selected. This fixture shows 3 speakers and mock talk-time totals; no analysis was run."); }}><IconInfo size={13} /><span>Insights</span></button>
      <span className="cp-ds-specialty-note">Speaker-only detection keeps the transcript text.</span>
    </div>
    <div className="cp-tx-bar" role="toolbar" aria-label="About the fixture transcript"><span className="cp-tx-bar-fact">Generated locally</span><span className="cp-tx-bar-sep" aria-hidden="true">·</span><span className="cp-tx-bar-fact">3 speakers</span>
      <button ref={manageRef} type="button" className="cp-tx-bar-btn" disabled={disabled} onClick={openModal} data-testid="speaker-manage-trigger">Manage</button>
    </div>
    <div className="cp-tx-search"><div className="cp-tx-search-mode" role="tablist" aria-label="Transcript view fixture" onKeyDown={switchView}>
      {(["text", "speakers"] as const).map((mode) => <button type="button" role="tab" key={mode} data-view={mode} tabIndex={view === mode ? 0 : -1} id={`${uid}-${mode}-tab`}
        aria-controls={`${uid}-${mode}-panel`} aria-selected={view === mode} className={`cp-tx-search-mode-btn${view === mode ? " active" : ""}`} onClick={() => setView(mode)}>{mode === "text" ? "Text" : "Speakers"}</button>)}
    </div></div>
    <div id={`${uid}-speakers-panel`} role="tabpanel" aria-labelledby={`${uid}-speakers-tab`} hidden={view !== "speakers"}>
      <div className="cp-tx-groups">{speakers.map((speaker) => <div className="cp-tx-group" key={speaker.id}>
        <button type="button" className="cp-tx-group-head" aria-expanded={expanded.includes(speaker.id)} onClick={() => setExpanded((ids) => ids.includes(speaker.id) ? ids.filter((id) => id !== speaker.id) : [...ids, speaker.id])}>
          <span className={`cp-tx-group-chev${expanded.includes(speaker.id) ? " open" : ""}`} aria-hidden="true">›</span>
          <span className="cp-tx-group-chip" style={{ background: speaker.color }} aria-hidden="true">{glyph(speaker)}</span><span className="cp-tx-group-name">{speaker.name}</span><span className="cp-tx-group-talk">{talkTime(speaker.seconds)}</span><span className="cp-tx-group-turns">{speaker.lines} {speaker.lines === 1 ? "line" : "lines"}</span>
        </button>
        {expanded.includes(speaker.id) && <div className="cp-tx-group-lines"><button type="button" className="cp-tx-group-line" onClick={() => announce(`Selected ${speaker.time}.`)}><span className="cp-tx-group-tc">{speaker.time}</span><span className="cp-tx-group-text">{speaker.text}</span></button></div>}
      </div>)}</div>
    </div>
    <div id={`${uid}-text-panel`} role="tabpanel" aria-labelledby={`${uid}-text-tab`} hidden={view !== "text"}>{speakers.map((speaker) => <div className="cp-tx-turn" key={speaker.id}>
      <div className="cp-tx-turn-head"><span className="cp-tx-speaker" style={{ background: speaker.color }} aria-hidden="true">{glyph(speaker)}</span>
        <button type="button" className="cp-tx-speaker-name" aria-label={`Rename speaker ${speaker.name}`} onClick={() => { manageRef.current?.focus(); openModal(); }}>{speaker.name}</button>
      </div><p className="cp-ds-specialty-note">{speaker.text}</p>
    </div>)}</div>
    <p className="cp-ds-specialty-note" role="status" data-testid="speaker-fixture-status">{message}</p>
  </div>} proposed={<div className="cp-ds-specialty-stack" data-testid="speakers-roster-fixture">
    <p className="cp-ds-specialty-fidelity">SpeakerRosterModal / SpeakerRosterRow markup specimen with the approved darker checkbox fill (catalog only). The inline copy is not a mounted application dialog.</p>
    <div className="cp-spk-modal cp-ds-speaker-roster-inline" data-audit-review="speaker-target-spacing">{!modalOpen && roster}</div>
    {modalOpen && <p className="cp-ds-specialty-note">The same fixture is open in its dialog. Close it to restore this inline view.</p>}
    <Button size={size} variant="quiet" onClick={() => { setSpeakers(SPEAKERS); setSelected([]); setFilter(""); announce("Fixture restored."); }}>Reset speaker fixture</Button>
    <p className="cp-ds-specialty-note">Colour chips identify speakers; names are editable; selection reveals one merge control. Play demonstrates a jump, never plays media. Cast storage, capture, and the app undo stack are deliberately excluded.</p>
    <p className="cp-ds-specialty-note">Preserved source geometry includes small roster controls. Their target-spacing exception and neutral selected-row fill need review; this fixture is not an accessibility approval.</p>
    {modalOpen && createPortal(<div className="cp-spk-backdrop cp-ds-speaker-backdrop" style={portalTextStyle}><div className="cp-spk-modal" role="dialog" aria-modal="true" aria-label="Manage speakers fixture" tabIndex={-1} ref={modalRef} data-testid="speaker-fixture-dialog" data-audit-review="speaker-target-spacing">{roster}<p className="cp-ds-specialty-note cp-ds-speaker-modal-note">Local fixture only. No changes are saved.</p></div></div>, document.body)}
  </div>} />;
}

export function SpecialtyExamples(props: ExampleProps) {
  return props.kind === "generate" ? <GenerateExamples {...props} /> : <SpeakerExamples {...props} />;
}
