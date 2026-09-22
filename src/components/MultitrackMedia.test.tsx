// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { multitrackGroupFixture } from "../test/multitrack-fixture";
import { MultitrackMedia } from "./MultitrackMedia";
const mocks=vi.hoisted(()=>({invoke:vi.fn(),open:vi.fn()}));
vi.mock("@tauri-apps/api/core",()=>({invoke:mocks.invoke}));
vi.mock("@tauri-apps/plugin-dialog",()=>({open:mocks.open}));
beforeEach(()=>{ vi.clearAllMocks(); mocks.invoke.mockResolvedValue(undefined); });
afterEach(cleanup);
function fixture() {
  const doc=multitrackGroupFixture();
  doc.manifest.graph!.sources=[{id:"source-0",mob_id:"source-mob",slot_id:1,channel:0,channels:1,sample_rate:48000,sample_width:3,sample_count:96000,descriptor:"PCMDescriptor",status:"offline",locators:["file:///Volumes/Offline%20Audio/roll.mxf"],ancestors:[]}];
  return doc;
}
it("canceling Locate does not invoke resolution or change document media", async()=>{
  mocks.open.mockResolvedValue(null); const busy=vi.fn();
  render(<MultitrackMedia document={fixture()} onBusy={busy}/>);
  fireEvent.click(screen.getByRole("button",{name:"Locate media folder…"}));
  await waitFor(()=>expect(busy).toHaveBeenLastCalledWith(false));
  expect(mocks.invoke).not.toHaveBeenCalled(); expect(screen.getByText(/0\/1 available/)).toBeTruthy();
});
it("Stop invalidates a late relink response and keeps committed state", async()=>{
  const doc=fixture(); let finish!:(value:typeof doc)=>void;
  mocks.invoke.mockImplementation(command=>command==="aaf_resolve_media"?new Promise(resolve=>{finish=resolve;}):Promise.resolve());
  render(<MultitrackMedia document={doc}/>);
  fireEvent.click(screen.getByRole("button",{name:"Refresh availability"}));
  await waitFor(()=>expect(mocks.invoke).toHaveBeenCalledWith("aaf_resolve_media",expect.objectContaining({documentId:doc.id,path:null})));
  fireEvent.click(screen.getByRole("button",{name:"Stop"}));
  const next=structuredClone(doc); next.manifest.graph!.sources[0].resolved={path:"/tmp/roll.mxf",fingerprint:"a".repeat(64),stream_index:0,size:1,modified_ms:1};
  await act(async()=>finish(next));
  expect(screen.getByText(/0\/1 available/)).toBeTruthy(); expect(mocks.invoke).toHaveBeenCalledWith("cancel_job",expect.anything());
});
it("file choice is scoped to the source, and native mismatches stay actionable",async()=>{
  mocks.open.mockResolvedValue("/chosen/roll.wav"); mocks.invoke.mockRejectedValue({kind:"Invalid",data:"Media format does not match this AAF source"});
  render(<MultitrackMedia document={fixture()}/>);
  fireEvent.click(screen.getByRole("button",{name:"Locate file…",hidden:true}));
  await waitFor(()=>expect(screen.getByRole("alert").textContent).toContain("does not match"));
  expect(mocks.invoke).toHaveBeenCalledWith("aaf_resolve_media",expect.objectContaining({sourceId:"source-0",path:"/chosen/roll.wav"}));
});
it("keeps source-specific relink diagnostics inside its existing disclosure",async()=>{
  const doc=fixture(); doc.manifest.graph!.sources[0].resolution_note="2 matching files found. Use Locate file to choose the intended copy.";
  render(<MultitrackMedia document={doc}/>);
  const note=screen.getByText(/2 matching files found/);
  expect(note.closest("details")?.open).toBe(false);
  fireEvent.click(note.closest("details")!.querySelector("summary")!);
  expect(note.closest("details")?.open).toBe(true);
  expect(mocks.invoke).not.toHaveBeenCalled();
});
