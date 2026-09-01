import { useCallback, useEffect, useState } from "react";
import {
  addCustomColumn, customValue, loadCustomColumns, loadCustomValues,
  pruneCustomValues, removeCustomColumn, renameCustomColumn, repathCustomValues,
  saveCustomColumns, saveCustomValues, setCustomValue,
  type CustomColumn, type CustomValues,
} from "../lib/custom-columns";

/** The width a new custom column is born with. Wide enough for a scene
 *  number or a name, narrow enough that adding one does not shove the
 *  built-in columns off the pane. */
export const CUSTOM_COL_WIDTH = 110;

/**
 * The stateful half of Avid-style bin columns. The rules live in
 * lib/custom-columns.ts; this owns the two stores and the write-through.
 *
 * Deliberately NOT merged into useListColumns. That hook is about the SHAPE
 * of a list - width, order, visibility - and knows nothing about what a
 * column means; a custom column is just another key to it, which is exactly
 * why it can be resized and reordered with no new machinery. Keeping the two
 * apart is what preserves that.
 */
export function useCustomColumns() {
  const [columns, setColumns] = useState<CustomColumn[]>(loadCustomColumns);
  const [values, setValues] = useState<CustomValues>(loadCustomValues);

  useEffect(() => { saveCustomColumns(columns); }, [columns]);
  useEffect(() => { saveCustomValues(values); }, [values]);

  const add = useCallback((label: string) => {
    setColumns((prev) => addCustomColumn(prev, label));
  }, []);

  const rename = useCallback((id: string, label: string) => {
    setColumns((prev) => renameCustomColumn(prev, id, label));
  }, []);

  /**
   * Delete a column and everything typed into it.
   *
   * The prune is computed from `next` OUTSIDE the values updater rather than
   * inside it. An updater that reached for the other piece of state would be
   * reading a value it was not given, which is the impurity
   * pure-updater-contract exists to stop - and it would also be wrong here,
   * since it would run against whatever `columns` happened to be closed over.
   */
  const remove = useCallback((id: string) => {
    const next = removeCustomColumn(columns, id);
    setColumns(next);
    setValues((prev) => pruneCustomValues(prev, next));
  }, [columns]);

  const setValue = useCallback((path: string, id: string, text: string) => {
    setValues((prev) => setCustomValue(prev, path, id, text));
  }, []);

  const valueFor = useCallback(
    (path: string, id: string) => customValue(values, path, id),
    [values],
  );

  /** Follow a file that was renamed, so its metadata goes with it. */
  const repath = useCallback((from: string, to: string) => {
    setValues((prev) => repathCustomValues(prev, from, to));
  }, []);

  return { columns, add, rename, remove, valueFor, setValue, repath };
}
