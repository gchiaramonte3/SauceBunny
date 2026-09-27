/**
 * Transcript Editor prototype: which panel lives in which column, as tabs.
 *
 * The window is four columns over the timeline. Each column holds any number
 * of panels as tabs and shows one at a time. Panels move between columns by
 * dragging a tab or from the tab's menu; the edit is the one panel that stays
 * in its column, because that column is the one that fills the window.
 * Sources are panels too, so several can be open at once, one tab each.
 *
 * Pure, so every move can be tested without a DOM.
 */

export type TeColumn = "left" | "source" | "record" | "right";
export type TeDock = Record<TeColumn, { tabs: string[]; active: string | null }>;

export const teColumns: TeColumn[] = ["left", "source", "record", "right"];
export const teColumnNames: Record<TeColumn, string> = { left: "Left panel", source: "Source panel", record: "Edit panel", right: "Right panel" };

/** The edit fills the window; everything else can go anywhere. */
export const TE_PINNED = "edit";
export const sourceTab = (source: string) => `source:${source}`;
export const isSourceTab = (tab: string) => tab.startsWith("source:");
/** Panels that can be closed and opened again. The edit, the library and the inspector are always there. */
export const isClosable = (tab: string) => isSourceTab(tab) || tab === "ask";

export function defaultDock(): TeDock {
  return {
    left: { tabs: ["library"], active: "library" },
    source: { tabs: [sourceTab("mg3")], active: sourceTab("mg3") },
    record: { tabs: [TE_PINNED], active: TE_PINNED },
    right: { tabs: ["inspector", "ask"], active: "inspector" },
  };
}

export function columnOf(dock: TeDock, tab: string): TeColumn | null {
  return teColumns.find((column) => dock[column].tabs.includes(tab)) ?? null;
}

/** Take a tab out of its column; the column shows its neighbour instead. */
function without(dock: TeDock, tab: string): TeDock {
  const column = columnOf(dock, tab);
  if (!column) return dock;
  const { tabs, active } = dock[column];
  const index = tabs.indexOf(tab);
  const rest = tabs.filter((item) => item !== tab);
  return { ...dock, [column]: { tabs: rest, active: active === tab ? rest[Math.min(index, rest.length - 1)] ?? null : active } };
}

/** Move a tab to a column (at `index`, or the end) and show it there. */
export function moveTab(dock: TeDock, tab: string, to: TeColumn, index?: number): TeDock {
  const from = columnOf(dock, tab);
  if (!from || (tab === TE_PINNED && to !== "record")) return dock;
  const rest = without(dock, tab);
  const tabs = [...rest[to].tabs];
  const at = index == null ? tabs.length : Math.max(0, Math.min(tabs.length, from === to && index > dock[to].tabs.indexOf(tab) ? index - 1 : index));
  tabs.splice(at, 0, tab);
  return { ...rest, [to]: { tabs, active: tab } };
}

export function activate(dock: TeDock, tab: string): TeDock {
  const column = columnOf(dock, tab);
  return column ? { ...dock, [column]: { ...dock[column], active: tab } } : dock;
}

export function closeTab(dock: TeDock, tab: string): TeDock {
  return isClosable(tab) ? without(dock, tab) : dock;
}

/**
 * Show a panel, opening it if it is closed. A new source joins the column
 * that already holds sources, so they collect as tabs side by side.
 */
export function openTab(dock: TeDock, tab: string, fallback: TeColumn): TeDock {
  if (columnOf(dock, tab)) return activate(dock, tab);
  const sibling = isSourceTab(tab) ? teColumns.find((column) => dock[column].tabs.some(isSourceTab)) : undefined;
  const to = sibling ?? fallback;
  return { ...dock, [to]: { tabs: [...dock[to].tabs, tab], active: tab } };
}

/** The column beside this one, for moving a tab with the keyboard. */
export function neighbour(column: TeColumn, direction: -1 | 1): TeColumn | null {
  return teColumns[teColumns.indexOf(column) + direction] ?? null;
}
