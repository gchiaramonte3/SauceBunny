// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it } from "vitest";
import { TabStrip } from "./TabStrip";

afterEach(cleanup);

/** The strip as String Outs uses it: closing the chosen tab moves to its right-hand neighbour. */
function Strip({ initial, first }: { initial: string[]; first: string }) {
  const [tabs, setTabs] = useState(initial), [selected, setSelected] = useState(first);
  const close = (id: string) => {
    const at = tabs.indexOf(id), rest = tabs.filter((tab) => tab !== id);
    setTabs(rest);
    if (id === selected) setSelected(rest[at] ?? rest[at - 1] ?? "");
  };
  return <TabStrip tabs={tabs.map((id) => ({ id, label: id }))} selected={selected} onSelect={setSelected} onClose={close} label="Open" noun="tabs" panelId="panel" />;
}

it("Delete closes the focused tab, and focus lands on the tab chosen in its place", () => {
  render(<Strip initial={["Scene", "Rosa", "Dev"]} first="Rosa" />);
  const rosa = screen.getByRole("tab", { name: "Rosa" });
  rosa.focus();
  fireEvent.keyDown(rosa, { key: "Delete" });
  expect(screen.queryByRole("tab", { name: "Rosa" })).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Dev" }));
  expect(screen.getByRole("tab", { name: "Dev" }).getAttribute("aria-selected")).toBe("true");
});

it("Delete on a tab that is not the chosen one closes that tab, not the chosen one", () => {
  render(<Strip initial={["Scene", "Rosa", "Dev"]} first="Rosa" />);
  const scene = screen.getByRole("tab", { name: "Scene" });
  scene.focus();
  fireEvent.keyDown(scene, { key: "Backspace" });
  expect(screen.getAllByRole("tab").map((tab) => tab.textContent?.replace("×", ""))).toEqual(["Rosa", "Dev"]);
  expect(screen.getByRole("tab", { name: "Rosa" }).getAttribute("aria-selected")).toBe("true");
});

it("with no tab chosen the first still takes the tab stop, and the x says what it closes", () => {
  render(<Strip initial={["Scene", "Rosa"]} first="" />);
  expect(screen.getAllByRole("tab").map((tab) => tab.tabIndex)).toEqual([0, -1]);
  const close = screen.getByRole("tab", { name: "Rosa" }).querySelector<HTMLElement>(".cp-tabstrip-close")!;
  expect(close.title).toBe("Close Rosa");
  fireEvent.click(close);
  expect(screen.queryByRole("tab", { name: "Rosa" })).toBeNull();
});
