// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { VolumeControl } from "./VolumeControl";
afterEach(cleanup);

it("a positive slider adjustment unmutes the existing audio control", () => {
  const volume=vi.fn(),mute=vi.fn();
  render(<VolumeControl volume={0.68} muted onVolumeChange={volume} onMutedChange={mute}/>);
  const trigger=screen.getByRole("button",{name:"Volume (muted)"});
  expect(trigger.title).toBe("Volume controls (muted)");
  fireEvent.click(trigger);
  fireEvent.change(screen.getByRole("slider",{name:"Volume"}),{target:{value:"72"}});
  expect(volume).toHaveBeenCalledWith(0.72);expect(mute).toHaveBeenCalledWith(false);
});

it("zero volume stays silent, and Escape restores the speaker button's focus", () => {
  const mute=vi.fn();
  render(<VolumeControl volume={0.68} muted onVolumeChange={vi.fn()} onMutedChange={mute}/>);
  const trigger=screen.getByRole("button",{name:"Volume (muted)"});
  fireEvent.click(trigger);
  const slider=screen.getByRole("slider",{name:"Volume"});slider.focus();
  fireEvent.change(slider,{target:{value:"0"}});
  expect(mute).not.toHaveBeenCalled();
  fireEvent.keyDown(slider,{key:"Escape"});
  expect(document.activeElement).toBe(trigger);
  expect(screen.queryByRole("slider")).toBeNull();
});
