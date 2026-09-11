// @vitest-environment jsdom
import { cleanup,fireEvent,render,screen } from "@testing-library/react";
import { afterEach,expect,it,vi } from "vitest";
import { Transport } from "./Transport";
import type { ComponentProps } from "react";
afterEach(cleanup);
const props=():ComponentProps<typeof Transport>=>({
  status:"loaded",isPlaying:false,fps:24,durationTc:"00:01:00:00",captionsOn:false,snapshotBusy:false,canSnapshot:true,
  volume:1,muted:true,playbackRate:1.5,playbackRateSupported:true,
  onPlayToggle:vi.fn(),onStep:vi.fn(),onMarkIn:vi.fn(),onMarkOut:vi.fn(),onClearMarks:vi.fn(),onToggleCaptions:vi.fn(),
  onSnapshot:vi.fn(),onVolumeChange:vi.fn(),onMutedChange:vi.fn(),onPlaybackRateChange:vi.fn(),
  roomControls:<button>Microphone</button>,
});
it("keeps the same transport structure while live and restores file controls afterwards",()=>{
  const p=props();const h=render(<Transport {...p}/>);
  const sides=Array.from(h.container.querySelectorAll(".cp-transport-side,.cp-transport-center"));
  h.rerender(<Transport {...p} liveInput="Premiere A" liveController="premiere"/>);
  expect(Array.from(h.container.querySelectorAll(".cp-transport-side,.cp-transport-center"))).toEqual(sides);
  expect(screen.getByText("Live").title).toContain("Playback controlled in Premiere");
  expect(screen.getByText("Live").className).toBe("cp-source-status");
  expect(screen.getByText("Live").tagName).toBe("SPAN");
  expect(screen.getByText("Live").tabIndex).toBe(-1);
  expect(screen.getByText("Live").getAttribute("role")).toBeNull();
  expect(screen.getByText("Timeline timecode unavailable").parentElement).toBe(screen.getByText("Playback controlled in Premiere").parentElement);
  expect(h.container.querySelector(".cp-transport-side.left .cp-tc")).toBeNull();
  expect(screen.queryByText(p.durationTc)).toBeNull();
  for(const name of ["Play","Step back one frame","Step forward one frame","Mark in","Mark out","Clear in/out","Save frame as image","Captions","Playback speed: 1×"]){
    expect(screen.queryByRole("button",{name}),name).toBeNull();
  }
  expect(p.onPlayToggle).not.toHaveBeenCalled();expect(p.onStep).not.toHaveBeenCalled();expect(p.onMarkIn).not.toHaveBeenCalled();
  expect((screen.getByRole("button",{name:"Microphone"}) as HTMLButtonElement).disabled).toBe(false);
  h.rerender(<Transport {...p}/>);
  expect(screen.getByText(p.durationTc)).toBeTruthy();
  expect(h.container.querySelector(".cp-transport-side.left .cp-tc")).toBeTruthy();
  expect(h.container.querySelector(".cp-source-status")).toBeNull();
  fireEvent.click(screen.getByRole("button",{name:"Play"}));expect(p.onPlayToggle).toHaveBeenCalledOnce();
  expect((screen.getByRole("button",{name:"Playback speed: 1.5×"}) as HTMLButtonElement).disabled).toBe(false);
});

it("keeps a source disclosure and the single volume control usable beside passive live status",()=>{
  const p=props(),open=vi.fn();
  const sourceControls=<button type="button" className="cp-toolbar-disclosure cp-connect-premiere"
    aria-expanded={false} aria-controls="source-test-panel" onClick={open}>Premiere</button>;
  const h=render(<Transport {...p} status="empty" roomControls={undefined}
    liveInput="Premiere A" liveController="premiere" sourceControls={sourceControls}/>);
  const trigger=screen.getByRole("button",{name:"Premiere"});
  expect((trigger as HTMLButtonElement).disabled).toBe(false);
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(trigger.getAttribute("aria-controls")).toBe("source-test-panel");
  fireEvent.click(trigger);
  expect(open).toHaveBeenCalledOnce();
  expect(p.onPlayToggle).not.toHaveBeenCalled();expect(p.onStep).not.toHaveBeenCalled();
  expect(h.container.querySelectorAll(".cp-volume")).toHaveLength(1);
  expect(trigger.previousElementSibling?.classList.contains("cp-volume")).toBe(true);
  expect(h.container.querySelector(".cp-transport-side.left")?.contains(trigger)).toBe(false);
  expect((h.container.querySelector(".cp-volume > button") as HTMLButtonElement).disabled).toBe(false);
  expect(screen.getByRole("region",{name:"Playback transport"}).style.pointerEvents).toBe("auto");
});

it("keeps a presenter's live source passive without inventing Premiere control ownership",()=>{
  render(<Transport {...props()} liveInput="Alex's shared picture"/>);
  const status=screen.getByText("Live");
  expect(status.title).toBe("Alex's shared picture · Playback controlled by the presenter");
  expect(status.className).toBe("cp-source-status");
});

it.each(["Avid Media Composer", "Unknown NDI sender"])("leaves %s playback at the source without inventing timeline timing", name => {
  const p = props();
  const h = render(<Transport {...p} liveInput={name} liveController="ndi"/>);
  expect(screen.getByText("Live").title).toBe(`${name} · Playback controlled at source`);
  expect(screen.getByText("Timeline timecode unavailable").parentElement).toBe(screen.getByText("Playback controlled at source").parentElement);
  expect(screen.queryByRole("button", { name: "Play" })).toBeNull();
  expect(h.container.querySelectorAll(".cp-volume")).toHaveLength(1);
  expect(p.onPlayToggle).not.toHaveBeenCalled();
});
