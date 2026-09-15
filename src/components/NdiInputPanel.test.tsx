// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NdiDiscoveryResult } from "../bindings/NdiDiscoveryResult";
import { emptyNdiState } from "../hooks/use-ndi-input";
import { NDI_INPUT_PANEL_ID, NdiInputPanel, type NdiPreviewInput } from "./NdiInputPanel";
import type { ObsBroadcast } from "../hooks/use-obs-broadcast";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));

const input = (state = emptyNdiState()): NdiPreviewInput => ({
  program:null, state, previewProgram:null, previewState:emptyNdiState(),
  snapshot:{candidate:null,published:null,lease:null,roomSource:null,room:null,busy:null,error:null}, canShare:false,
  start:vi.fn(async()=>{}), cancelPreview:vi.fn(async()=>{}), share:vi.fn(async()=>{}),
  previewFrameDecoded:vi.fn(), previewPictureFailed:vi.fn(),
});
const discovery = (next: Partial<NdiDiscoveryResult>): NdiDiscoveryResult => ({
  bridgeCompiled:true, runtime:"ready", runtimeVersion:"6.3.2", sources:[], error:null, ...next,
});

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("saucebunny.experimentalNdi", "true");
  mocks.invoke.mockReset();
});
afterEach(cleanup);

async function mount(result: NdiDiscoveryResult, state = emptyNdiState()) {
  mocks.invoke.mockImplementation(async command=>command==="ndi_preflight" ? { ...result,pluginInstalled:true,premiereInstalled:true,premiereVersion:"26.3.2",runtimeOrigin:"bundled" } : result);
  render(<NdiInputPanel input={input(state)} onClose={vi.fn()}/>);
  await waitFor(()=>expect(mocks.invoke).toHaveBeenCalledWith("ndi_discover",{}));
}

describe("NDI preflight states", () => {
  it("uses the same receiver for Avid, Premiere and unknown senders without guessing capabilities", async () => {
    const names = ["EDIT-SUITE (Avid Media Composer)", "EDIT-SUITE (Adobe Premiere Pro)", "Camera 1"];
    mocks.invoke.mockResolvedValue(discovery({ sources: names.map(name => ({ name })) }));
    const i = input(), setup = vi.fn();
    render(<NdiInputPanel input={i} onClose={vi.fn()} onCompanionSetup={setup}/>);
    await screen.findByRole("option", { name: names[0] });
    const help = screen.getByRole("button", { name: "Avid Media Composer setup" });
    expect(help.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(help);
    expect(help.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(/Avid sequence timecode and live marker delivery are not connected/)).toBeTruthy();
    expect(screen.getByText(/other NDI receivers may view or record/)).toBeTruthy();
    expect(screen.getByText(/Avid 2026.8 fixes NDI stopping/)).toBeTruthy();
    expect(setup).not.toHaveBeenCalled();
    for (const name of names) {
      fireEvent.change(screen.getByRole("combobox", { name: "NDI source" }), { target: { value: name } });
      expect(i.start).toHaveBeenCalledTimes(names.indexOf(name));
      fireEvent.click(screen.getByRole("button", { name: "Preview source" }));
      await waitFor(() => expect((screen.getByRole("button", { name: "Preview source" }) as HTMLButtonElement).disabled).toBe(false));
    }
    expect(vi.mocked(i.start).mock.calls).toEqual(names.map(name => [name]));
    expect(mocks.invoke.mock.calls.map(([command]) => command)).toEqual(["ndi_discover"]);
    expect(i.share).not.toHaveBeenCalled();
    expect(i.cancelPreview).not.toHaveBeenCalled();
  });

  it("labels incoming and preview rates independently for fractional-rate Avid picture", async () => {
    mocks.invoke.mockResolvedValue(discovery({ sources: [] }));
    const i = input();
    i.previewProgram = { id: "avid", name: "Avid Media Composer", url: "/preview", reviewKey: "ndi:avid", local: true, ownerId: "m0" };
    i.previewState = { ...emptyNdiState(), inputWidth: 1920, inputHeight: 1080, inputFps: 24000 / 1001, outputFps: 30 };
    render(<NdiInputPanel input={i} onClose={vi.fn()}/>);
    expect(screen.getByRole("status", { name: "NDI connection" }).textContent).toContain("Source 23.98 fps · Preview 30.0 fps");
    expect(screen.queryByText(/Editor-confirmed timing/)).toBeNull();
    expect(screen.getByText(/Not shared with room refers to the Sauce Bunny session/)).toBeTruthy();
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("ndi_discover", {}));
  });

  it("keeps guest recovery in settings without offering source or room mutations", () => {
    const i=input(),close=vi.fn(),resume=vi.fn(),retry=vi.fn();
    i.program={id:"room",name:"Editor's Premiere",url:"/room",reviewKey:"ndi:room",local:false,ownerId:"host"};
    const props={input:i,onClose:close,canManageSource:false,previewVisible:false,onReconnectPicture:retry,
      recovery:{error:null,label:"Enable program audio",resume}};
    const h=render(<NdiInputPanel {...props}/>);
    expect(screen.getByRole("dialog").textContent).toContain("Editor's Premiere");
    fireEvent.click(screen.getByRole("button",{name:"Enable program audio"}));expect(resume).toHaveBeenCalledOnce();
    fireEvent.keyDown(screen.getByRole("button",{name:"Enable program audio"}),{key:"Escape"});expect(close).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button",{name:"Reconnect picture"}));expect(retry).toHaveBeenCalledOnce();
    fireEvent.focus(window);
    expect(mocks.invoke).not.toHaveBeenCalled();
    for(const name of ["Refresh sources","Preview source","Cancel preview","Share NDI with room","Premiere marker setup…"])expect(screen.queryByRole("button",{name})).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Avid Media Composer setup" })).toBeNull();
    h.rerender(<NdiInputPanel {...props} open={false}/>);
    expect(screen.queryByRole("button",{name:"Enable program audio"})).toBeNull();
    h.rerender(<NdiInputPanel {...props}/>);
    expect(screen.getByRole("button",{name:"Enable program audio"})).toBeTruthy();
    expect(i.start).not.toHaveBeenCalled();expect(i.cancelPreview).not.toHaveBeenCalled();expect(i.share).not.toHaveBeenCalled();
  });
  it("keeps source selection across reopening without leaving a closed dialog or starting media", async () => {
    mocks.invoke.mockResolvedValue(discovery({sources:[{name:"Premiere"}]}));
    const i=input(),close=vi.fn();
    const h=render(<NdiInputPanel input={i} onClose={close} open={false}/>);
    expect(document.getElementById(NDI_INPUT_PANEL_ID)).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mocks.invoke).not.toHaveBeenCalled();
    h.rerender(<NdiInputPanel input={i} onClose={close}/>);
    await waitFor(()=>expect(mocks.invoke).toHaveBeenCalledWith("ndi_discover",{}));
    const panel=document.getElementById(NDI_INPUT_PANEL_ID)!;
    expect(h.container.contains(panel)).toBe(false);
    expect(screen.getByRole("dialog",{name:"Source settings"})).toBe(panel);
    expect(screen.getByRole("heading",{name:"Source"})).toBeTruthy();
    expect(panel.getAttribute("aria-modal")).toBe("true");
    expect(document.activeElement).toBe(panel);
    fireEvent.change(screen.getByRole("combobox",{name:"NDI source"}),{target:{value:"Premiere"}});
    fireEvent.keyDown(panel,{key:"Escape"});
    expect(close).toHaveBeenCalledOnce();
    h.rerender(<NdiInputPanel input={i} onClose={close} open={false}/>);
    expect(document.getElementById(NDI_INPUT_PANEL_ID)).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    h.rerender(<NdiInputPanel input={i} onClose={close}/>);
    await waitFor(()=>expect(mocks.invoke).toHaveBeenCalledTimes(2));
    expect((screen.getByRole("combobox",{name:"NDI source"}) as HTMLSelectElement).value).toBe("Premiere");
    expect(screen.getByRole("dialog",{name:"Source settings"}).id).toBe(NDI_INPUT_PANEL_ID);
    expect(i.start).not.toHaveBeenCalled();expect(i.share).not.toHaveBeenCalled();
    expect(i.cancelPreview).not.toHaveBeenCalled();
  });

  it("only stops the candidate when Cancel preview is pressed", async () => {
    mocks.invoke.mockResolvedValue(discovery({}));
    const i=input();i.previewProgram={id:"a",name:"Premiere",url:"/preview",reviewKey:"ndi:a",local:true,ownerId:"m0"};
    const close=vi.fn();render(<NdiInputPanel input={i} onClose={close}/>);
    await waitFor(()=>expect((screen.getByRole("button",{name:"Cancel preview"}) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button",{name:"Cancel preview"}));
    await waitFor(()=>expect(i.cancelPreview).toHaveBeenCalledOnce());
    expect(i.share).not.toHaveBeenCalled();expect(close).not.toHaveBeenCalled();
  });
  it("commits the UI transition only after publication succeeds", async () => {
    mocks.invoke.mockResolvedValue(discovery({}));
    const i=input();i.previewProgram={id:"a",name:"Premiere",url:"/preview",reviewKey:"ndi:a",local:true,ownerId:"m0"};
    i.snapshot.room={generation:1,presenterEpoch:0,presenting:true,publishedId:null,publicationRevision:null,source:null};
    i.canShare=true;
    let resolve!:()=>void;i.share=vi.fn(()=>new Promise<void>(done=>{resolve=done;}));
    const close=vi.fn(),shared=vi.fn();render(<NdiInputPanel input={i} onClose={close} onShared={shared}/>);
    await waitFor(()=>expect((screen.getByRole("button",{name:"Share NDI with room"}) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button",{name:"Share NDI with room"}));
    expect(shared).not.toHaveBeenCalled();expect(close).not.toHaveBeenCalled();
    resolve();await waitFor(()=>expect(shared).toHaveBeenCalledOnce());expect(close).toHaveBeenCalledOnce();
  });
  it("leaves the room and panel alone when publication fails", async () => {
    mocks.invoke.mockResolvedValue(discovery({}));
    const i=input();i.previewProgram={id:"a",name:"Premiere",url:"/preview",reviewKey:"ndi:a",local:true,ownerId:"m0"};
    i.snapshot.room={generation:1,presenterEpoch:0,presenting:true,publishedId:null,publicationRevision:null,source:null};
    i.canShare=true;i.share=vi.fn(async()=>{throw new Error("Presentation changed");});
    const close=vi.fn(),shared=vi.fn();render(<NdiInputPanel input={i} onClose={close} onShared={shared}/>);
    await waitFor(()=>expect((screen.getByRole("button",{name:"Share NDI with room"}) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button",{name:"Share NDI with room"}));
    expect((await screen.findByRole("alert")).textContent).toContain("Presentation changed");
    expect(shared).not.toHaveBeenCalled();expect(close).not.toHaveBeenCalled();
  });
  it("keeps setup open after Preview and closes without publishing or cancelling", async () => {
    mocks.invoke.mockResolvedValue(discovery({sources:[{name:"Premiere"}]}));
    const i=input(),close=vi.fn();
    const h=render(<NdiInputPanel input={i} onClose={close}/>);
    fireEvent.change(await screen.findByRole("combobox",{name:"NDI source"}),{target:{value:"Premiere"}});
    fireEvent.click(screen.getByRole("button",{name:"Preview source"}));
    await waitFor(()=>expect(i.start).toHaveBeenCalledExactlyOnceWith("Premiere"));
    expect(close).not.toHaveBeenCalled();expect(i.share).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button",{name:"Done"}));
    expect(close).toHaveBeenCalledOnce();expect(i.cancelPreview).not.toHaveBeenCalled();
    h.rerender(<NdiInputPanel input={i} onClose={close} open={false}/>);
    expect(document.querySelector('[aria-modal="true"]')).toBeNull();
  });
  it("refreshes source discovery on returning from Premiere without checking installation here", async () => {
    await mount(discovery({sources:[]}));
    fireEvent.focus(window);
    await waitFor(()=>expect(mocks.invoke.mock.calls.filter(([command])=>command==="ndi_discover").length).toBe(2));
    expect(mocks.invoke.mock.calls.some(([command])=>command==="ndi_preflight")).toBe(false);
    expect((screen.getByRole("button",{name:"Preview source"}) as HTMLButtonElement).disabled).toBe(true);
  });
  it("distinguishes a build without the native bridge", async () => {
    await mount(discovery({bridgeCompiled:false,runtime:"missing",runtimeVersion:null,
      error:"This build has no NDI bridge."}));
    expect((await screen.findByRole("alert")).textContent).toContain("does not include the native NDI bridge");
    expect((screen.getByRole("button",{name:"Preview source"}) as HTMLButtonElement).disabled).toBe(true);
  });

  it("distinguishes missing and incompatible runtimes", async () => {
    await mount(discovery({runtime:"missing",runtimeVersion:null,error:null}));
    expect((await screen.findByRole("alert")).textContent).toContain("runtime is missing");
    cleanup();
    await mount(discovery({runtime:"incompatible",runtimeVersion:null,error:null}));
    expect((await screen.findByRole("alert")).textContent).toContain("runtime is incompatible");
  });

  it("explains zero discovery results without auto-selecting a source", async () => {
    await mount(discovery({sources:[]}));
    expect((await screen.findByText(/No NDI source found/)).textContent).toContain("Enable output in the source application");
    expect(screen.getByRole("button", { name: "Avid Media Composer setup" })).toBeTruthy();
    expect((screen.getByRole("combobox",{name:"NDI source"}) as HTMLSelectElement).disabled).toBe(true);
  });

  it("portals settings outside the sidebar and restores focus without touching media", async () => {
    mocks.invoke.mockResolvedValue(discovery({sources:[{name:"Premiere"}]}));
    const i=input(),close=vi.fn();
    i.previewProgram={id:"a",name:"Premiere",url:"/preview",reviewKey:"ndi:a",local:true,ownerId:"m0"};
    render(<button>Outside panel</button>);
    const outside=screen.getByRole("button",{name:"Outside panel"});outside.focus();
    const h=render(<NdiInputPanel input={i} onClose={close}/>);
    const panel=await screen.findByRole("dialog",{name:"Source settings"});
    expect(document.activeElement).toBe(panel);
    expect(h.container.contains(panel)).toBe(false);
    expect(panel.querySelector('video,canvas,input[type="range"]')).toBeNull();
    expect(screen.getByText(/Use the Preview speaker control/)).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("dialog",{name:"Source settings"}),{key:"Escape"});
    expect(close).toHaveBeenCalledOnce();
    h.rerender(<NdiInputPanel input={i} onClose={close} open={false}/>);
    expect(document.activeElement).toBe(outside);
    expect(i.cancelPreview).not.toHaveBeenCalled();
  });

  it("keeps Premiere installation in Settings alongside passive Avid setup", async () => {
    mocks.invoke.mockResolvedValue(discovery({}));
    const setup=vi.fn();
    render(<NdiInputPanel input={input()} onClose={vi.fn()} onCompanionSetup={setup}/>);
    fireEvent.click(screen.getByRole("button",{name:"Install or set up Premiere…"}));
    expect(setup).toHaveBeenCalledOnce();
    const panel=screen.getByRole("dialog",{name:"Source settings"});
    expect(panel.querySelector("details")).toBeNull();
    expect(screen.queryByText("Connection details")).toBeNull();
    expect(screen.queryByRole("button",{name:"Download NDI Tools for Premiere"})).toBeNull();
    expect(screen.getByText("Beta").className).toBe("cp-premiere-beta");
    expect(panel.textContent).not.toContain("Experimental");
  });

  it("treats opening Connect Premiere as discovery consent, never capture or publication", async () => {
    localStorage.removeItem("saucebunny.experimentalNdi");
    mocks.invoke.mockResolvedValue(discovery({sources:[{name:"Premiere"}]}));
    const i=input();const h=render(<NdiInputPanel input={i} open={false} onClose={vi.fn()}/>);
    expect(mocks.invoke).not.toHaveBeenCalled();
    h.rerender(<NdiInputPanel input={i} open onClose={vi.fn()}/>);
    const source=await screen.findByRole("combobox",{name:"NDI source"}) as HTMLSelectElement;
    await waitFor(()=>expect(mocks.invoke).toHaveBeenCalledWith("ndi_discover",{}));
    expect(source.value).toBe("");expect(i.start).not.toHaveBeenCalled();
    expect(i.share).not.toHaveBeenCalled();
  });

  it.each([
    [1,"Connected · Picture parked"],
    [0,"Input disconnected · Last picture retained"],
    [null,"No recent picture · Checking input"],
  ])("distinguishes a parked sequence from input loss (%s connections)",async(connectionCount,label)=>{
    mocks.invoke.mockResolvedValue(discovery({sources:[{name:"Premiere"}]}));
    const i=input();i.previewProgram={id:"a",name:"Premiere",url:"/preview",reviewKey:"ndi:a",local:true,ownerId:"m0"};
    i.previewState={...emptyNdiState(),phase:"stale",connectionCount:connectionCount as number|null};
    render(<NdiInputPanel input={i} onClose={vi.fn()}/>);
    expect((await screen.findByRole("status", { name: "NDI connection" })).textContent).toBe(label);
  });

  it("routes picture retry to the mounted monitor without cancelling or restarting input", async()=>{
    mocks.invoke.mockResolvedValue(discovery({sources:[{name:"Premiere"}]}));
    const i=input(),retry=vi.fn();i.previewProgram={id:"a",name:"Premiere",url:"/preview",reviewKey:"ndi:a",local:true,ownerId:"m0"};
    render(<NdiInputPanel input={i} onClose={vi.fn()} onReconnectPicture={retry}/>);
    fireEvent.click(await screen.findByRole("button",{name:"Reconnect picture"}));
    expect(retry).toHaveBeenCalledOnce();expect(i.start).not.toHaveBeenCalled();expect(i.cancelPreview).not.toHaveBeenCalled();
  });

  it("does not clear the active picture when its source disappears from discovery",async()=>{
    mocks.invoke.mockResolvedValue(discovery({sources:[{name:"Premiere"}]}));
    const i=input();i.previewProgram={id:"a",name:"Premiere",url:"/preview",reviewKey:"ndi:a",local:true,ownerId:"m0"};
    render(<NdiInputPanel input={i} onClose={vi.fn()}/>);
    fireEvent.change(await screen.findByRole("combobox",{name:"NDI source"}),{target:{value:"Premiere"}});
    await waitFor(()=>expect((screen.getByRole("button",{name:"Refresh sources"}) as HTMLButtonElement).disabled).toBe(false));
    mocks.invoke.mockResolvedValue(discovery({sources:[]}));
    fireEvent.click(screen.getByRole("button",{name:"Refresh sources"}));
    await screen.findByText(/No NDI source found/);
    expect(screen.getByText("Premiere",{selector:"strong"})).toBeTruthy();
    expect(i.cancelPreview).not.toHaveBeenCalled();expect(i.start).not.toHaveBeenCalled();
  });

  it("keeps basic picture format but excludes receiver counters from Preview", async () => {
    await mount(discovery({sources:[{name:"Premiere"}]}),{
      ...emptyNdiState(), sourceId:"source", phase:"live", inputWidth:1920, inputHeight:1080,
      outputFps:30, receivedFrames:1800, ndiDroppedFrames:2, encoderDroppedFrames:3,
      lastInputAgeMs:14, encodedBitrateKbps:6192,
    });
    expect((await screen.findByRole("status",{name:"NDI connection"})).textContent).toContain("1920 × 1080 · Source rate unavailable · Preview 30.0 fps");
    expect(screen.queryByText(/NDI drops/)).toBeNull();
  });

  it("rechecks on repeated Connect requests and ignores an obsolete discovery response", async () => {
    let first!: (value: NdiDiscoveryResult) => void;
    mocks.invoke.mockImplementationOnce(()=>new Promise(resolve=>{first=resolve;}));
    mocks.invoke.mockResolvedValue(discovery({sources:[{name:"Premiere B"}]}));
    const i=input(),close=vi.fn();
    const h=render(<NdiInputPanel input={i} onClose={close} refreshRequest={1}/>);
    h.rerender(<NdiInputPanel input={i} onClose={close} refreshRequest={2}/>);
    await screen.findByRole("option",{name:"Premiere B"});
    first(discovery({sources:[{name:"Premiere A"}]}));
    await waitFor(()=>expect(screen.queryByRole("option",{name:"Premiere A"})).toBeNull());
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
    expect(i.start).not.toHaveBeenCalled();expect(i.cancelPreview).not.toHaveBeenCalled();
  });

  it("selects and previews A, B, then A without publishing or closing", async () => {
    mocks.invoke.mockResolvedValue(discovery({sources:[{name:"A"},{name:"B"}]}));
    const i=input(),preview=vi.fn(),close=vi.fn();
    render(<NdiInputPanel input={i} onClose={close} onPreviewRequested={preview}/>);
    await screen.findByRole("option",{name:"A"});
    for (const name of ["A","B","A"]) {
      fireEvent.change(screen.getByRole("combobox",{name:"NDI source"}),{target:{value:name}});
      fireEvent.click(screen.getByRole("button",{name:"Preview source"}));
      await waitFor(()=>expect((screen.getByRole("button",{name:"Preview source"}) as HTMLButtonElement).disabled).toBe(false));
    }
    expect(vi.mocked(i.start).mock.calls).toEqual([["A"],["B"],["A"]]);
    expect(preview).toHaveBeenCalledTimes(3);expect(i.share).not.toHaveBeenCalled();expect(close).not.toHaveBeenCalled();
  });

  it("uses only the matching app-owned capture broadcast without taking native ownership", async () => {
    mocks.invoke.mockResolvedValue(discovery({}));
    const i = input();
    i.previewProgram = { id: "capture-a", name: "Generated editor", url: "/preview", reviewKey: "ndi:capture-a", local: true, ownerId: "m0",
      capture: { application: "generated.app", process: 10, window: 20, crop: { x: 0, y: 0, width: 1, height: 1 } } };
    const state: ObsBroadcast = { sourceId: "capture-a", status: { sourceId: "capture-a", phase: "live", attempt: 2, error: null },
      error: null, active: true, start: vi.fn(), stop: vi.fn() };
    const h = render(<NdiInputPanel input={i} onClose={vi.fn()} broadcast={state}/>);
    await screen.findByRole("dialog", { name: "Source settings" });
    expect(screen.getByRole("status", { name: "Application capture connection" })).toBeTruthy();
    expect(screen.getByRole("status", { name: "NDI broadcast" }).textContent).toContain("Broadcasting on your local network");
    expect(screen.queryByText(/source application’s NDI broadcast/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Stop broadcast" }));
    expect(state.stop).toHaveBeenCalledOnce();
    expect(state.start).not.toHaveBeenCalled();
    expect(mocks.invoke.mock.calls.some(([command]) => command.startsWith("obs_broadcast"))).toBe(false);
    h.rerender(<NdiInputPanel input={i} onClose={vi.fn()} broadcast={{ ...state, sourceId: "capture-b" }}/>);
    expect(screen.queryByRole("button", { name: "Stop broadcast" })).toBeNull();
  });
});
