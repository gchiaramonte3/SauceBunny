import { useId, useState } from "react";
import { CaptureAudioOption, CaptureRegionEditor, CaptureSourceGrid, CaptureSourceTabs,
  captureRegionValid, type CaptureRegion, type CaptureSourceItem } from "../src/components/CaptureSourcePicker";

/** Generated artwork only: these fixtures never enumerate or capture a device. */
function fixture(label: string, width: number, height: number) {
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#1E1D20"/><rect x="30" y="30" width="${width - 60}" height="${height - 90}" rx="8" fill="#403F46"/><text x="50%" y="50%" fill="#F5F5F7" text-anchor="middle" font-family="sans-serif" font-size="32">${label}</text><path d="M30 ${height - 35}H${width - 30}" stroke="#7146BD" stroke-width="12"/></svg>`)}`;
}
const screenImage = fixture("Screen fixture", 1000, 600);
const screens: CaptureSourceItem[] = [{ id: "display-1", label: "Studio display", description: "1000 × 600 · fixture", thumbnail: screenImage },
  { id: "display-2", label: "Portrait display", description: "600 × 1000 · fixture", thumbnail: fixture("Portrait fixture", 600, 1000) }];
const windows: CaptureSourceItem[] = [{ id: "window-1", label: "Composer", description: "Avid Media Composer · Window 101", thumbnail: fixture("Composer fixture", 1000, 600) },
  { id: "window-2", label: "Composer", description: "Avid Media Composer · Window 102", thumbnail: fixture("Second window fixture", 1000, 400) },
  { id: "window-3", label: "Source monitor", description: "Window 103 · unavailable thumbnail", thumbnail: null }];

export function CapturePickerExamples() {
  const [tab, setTab] = useState("screens");
  const [selected, setSelected] = useState<string | null>(null);
  const [crop, setCrop] = useState<CaptureRegion | null>(null);
  const [audio, setAudio] = useState(false);
  const [shared, setShared] = useState(false);
  const panelId = useId();
  const tabs = [{ id: "ndi", label: "NDI", panelId }, { id: "screens", label: "Screen", panelId },
    { id: "windows", label: "Window", panelId }, { id: "portion", label: "Region", panelId }];
  const sources = tab === "windows" ? windows : screens;
  const source = sources.find(item => item.id === selected);
  const width = selected === "display-2" ? 600 : 1000, height = selected === "display-2" ? 1000 : 600;
  return <section className="cp-ds-preview-proposed" aria-label="Shared capture picker fixtures" data-testid="capture-picker-example">
    <h3 className="cp-ds-fixture-title">Production components · Capture source picker</h3>
    <p className="cp-ds-fixture-caption">Controlled production components with generated fixture images. Selection, region and audio stay local to this example. No devices, permission checks or captures are used.</p>
    <div style={{ display: "grid", gap: "var(--s-3)" }}>
      <CaptureSourceTabs tabs={tabs} selected={tab} label="Fixture source type"
        onSelect={value => { setTab(value); setSelected(null); setCrop(null); setAudio(false); setShared(false); }}/>
      <div id={panelId} role="tabpanel" aria-label={tabs.find(item => item.id === tab)?.label}>
        {tab === "ndi" ? <p className="cp-ds-fixture-caption">NDI source selection stays in this same settings dialog. Device discovery is not run in the catalog.</p>
          : tab === "portion" && source ? <CaptureRegionEditor key={source.id} thumbnail={source.thumbnail ?? null}
          label={source.label} width={width} height={height} crop={crop} onChange={setCrop}/>
          : <CaptureSourceGrid sources={sources} selectedId={selected} onSelect={value => { setSelected(value); setShared(false); }}/>} 
      </div>
      <CaptureAudioOption checked={audio} onChange={setAudio} disabled={tab === "ndi" || !source}
        label={tab === "windows" ? "Include application audio" : "Include system audio"}
        description={tab === "windows" ? "Fixture option only; no sound is captured."
          : "Includes other apps' sound. Hides Sauce Bunny's windows and excludes its playback audio. Microphone stays separate."}/>
      <div className="cp-ds-inline"><button type="button" className="btn btn-ghost btn-compact"
        onClick={() => { setSelected(null); setCrop(null); setShared(false); }}>Cancel selection</button>
      <button type="button" className="btn btn-compact" disabled={tab === "ndi" || !source || (tab === "portion" && !captureRegionValid(crop, width, height))}
        onClick={() => setShared(true)}>Simulate Preview</button></div>
      <p className="cp-ds-fixture-caption" role="status">{shared ? `Private preview simulated: ${source?.label}. Nothing is shared.` : source ? `${source.label} selected. Nothing is shared.` : "Choose a source. Nothing is shared."}</p>
    </div>
  </section>;
}
