import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import type { AafDocument } from "../bindings/AafDocument";
import type { AafDocumentSummary } from "../bindings/AafDocumentSummary";
import { formatError } from "../lib/error-format";
import { sequenceLabels } from "../lib/multitrack";

type Props = { exclude: string[]; onAdd: (document: AafDocument) => void; onError: (message: string) => void };

/**
 * Add an AAF Audio sequence to the edit as another source. Its people join
 * the lanes they already have, by name, so Rosa's mic in every sequence plays
 * on Rosa's lane.
 */
export function EditAddSource({ exclude, onAdd, onError }: Props) {
  const [saved, setSaved] = useState<AafDocumentSummary[]>([]);
  useEffect(() => {
    let live = true;
    invoke<AafDocumentSummary[]>("aaf_list").then((items) => { if (live) setSaved(items); }).catch(() => undefined);
    return () => { live = false; };
  }, []);
  const choices = saved.filter((item) => !exclude.includes(item.id));
  const labels = useMemo(() => sequenceLabels(saved), [saved]);
  return <select className="cp-select cp-te-add-source" aria-label="Add a sequence" value="" disabled={!choices.length}
    title={choices.length ? "Add an AAF Audio sequence to cut from" : "Every AAF Audio sequence is already in this edit"}
    onChange={(event) => {
      const id = event.target.value;
      if (id) invoke<AafDocument>("aaf_open", { documentId: id }).then(onAdd).catch((cause: unknown) => onError(formatError(cause)));
    }}>
    <option value="" disabled>Add sequence…</option>
    {choices.map((item) => <option key={item.id} value={item.id}>{labels.get(item.id) ?? item.name}</option>)}
  </select>;
}
