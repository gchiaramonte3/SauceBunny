// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it } from "vitest";
import { EditSplits } from "./EditSplits";

function Editor({ side = true, source = true }: { side?: boolean; source?: boolean }) {
  return <div className="cp-te" data-testid="editor"><div className="cp-te-panes"><EditSplits side={side} source={source} /></div></div>;
}
const editor = () => screen.getByTestId("editor");

afterEach(cleanup);
beforeEach(() => localStorage.clear());

it("draws three keyboard dividers and hands their sizes to the stylesheet", () => {
  render(<Editor />);
  const dividers = screen.getAllByRole("separator");
  expect(dividers.map((item) => item.getAttribute("aria-label"))).toEqual(["Resize Ask, Inspector and History", "Resize the source", "Resize the timeline"]);
  for (const item of dividers) {
    expect(item.tabIndex).toBe(0);
    expect(item.getAttribute("title")).toBe("Drag to resize · arrow keys to nudge · Home to reset");
  }
  expect(editor().style.getPropertyValue("--te-side-w")).toBe("320px");
  expect(editor().style.getPropertyValue("--te-source-w")).toBe("340px");
  // The timeline keeps its share of the page until a height is chosen.
  expect(editor().style.getPropertyValue("--te-lower-h")).toBe("");
  fireEvent.keyDown(screen.getByRole("separator", { name: "Resize the source" }), { key: "ArrowRight", shiftKey: true });
  expect(editor().style.getPropertyValue("--te-source-w")).toBe("372px");
  expect(localStorage.getItem("saucebunny.stringOuts.sourceWidth")).toBe("372");
  fireEvent.keyDown(screen.getByRole("separator", { name: "Resize the timeline" }), { key: "ArrowUp" });
  expect(editor().style.getPropertyValue("--te-lower-h")).toBe("288px");
  // Double-click is the reset: back to the share of the page, nothing stored.
  fireEvent.doubleClick(screen.getByRole("separator", { name: "Resize the timeline" }));
  expect(editor().style.getPropertyValue("--te-lower-h")).toBe("");
  expect(localStorage.getItem("saucebunny.stringOuts.timelineHeight")).toBeNull();
});

it("a hidden pane has no divider, and a hidden side takes no room", () => {
  render(<Editor side={false} source={false} />);
  expect(screen.getAllByRole("separator").map((item) => item.getAttribute("aria-label"))).toEqual(["Resize the timeline"]);
  expect(editor().style.getPropertyValue("--te-side-w")).toBe("0px");
});
