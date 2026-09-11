import { isRecord, type Binding } from "./protocol";
import { isPremiereBinding as isBinding } from "../../src/lib/premiere-binding";

type BindingEntry = { binding: Binding; projectPath: string };
type Delivery = { bindingId: string; state: "attempted" | "added"; markerGuid: string | null };
type Data = { version: 1; bindings: BindingEntry[]; deliveries: Record<string, Delivery> };
export type LedgerStorage = Pick<Storage, "getItem" | "setItem">;
const KEY = "saucebunny.premiere-companion.ledger.v1";

/** Private plugin storage, never transmitted. A pre-transaction record makes
 * uncertain crashes fail closed; a completed record stops Undo resurrection. */
export class MarkerLedger {
  private data: Data;
  constructor(private storage: LedgerStorage) {
    const raw = storage.getItem(KEY);
    const parsed: unknown = raw === null ? { version: 1, bindings: [], deliveries: {} } : JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.bindings)
      || !parsed.bindings.every(entry => isRecord(entry) && isBinding(entry.binding) && typeof entry.projectPath === "string")
      || !isRecord(parsed.deliveries) || !Object.values(parsed.deliveries).every(delivery =>
        isRecord(delivery) && typeof delivery.bindingId === "string" && ["attempted", "added"].includes(String(delivery.state))
        && (delivery.markerGuid === null || typeof delivery.markerGuid === "string"))) {
      throw new Error("The companion delivery ledger cannot be read. It was preserved; marker changes are blocked.");
    }
    this.data = parsed as Data;
  }
  private commit(data: Data) {
    const serialized = JSON.stringify(data);
    if (serialized.length > 2 * 1024 * 1024 || Object.keys(data.deliveries).length > 5000 || data.bindings.length > 500) {
      throw new Error("The companion ledger is full. No delivery history was discarded.");
    }
    this.storage.setItem(KEY, serialized); // Must succeed BEFORE Premiere is mutated.
    this.data = data;
  }
  bindings(): readonly BindingEntry[] { return this.data.bindings; }
  projectPath(bindingId: string): string | null {
    return this.data.bindings.find(entry => entry.binding.bindingId === bindingId)?.projectPath ?? null;
  }
  bind(binding: Binding, projectPath: string) {
    this.commit({ ...this.data, bindings: [...this.data.bindings.filter(entry => entry.binding.bindingId !== binding.bindingId), { binding, projectPath }] });
  }
  delivery(noteId: string): Delivery | null { return this.data.deliveries[noteId] ?? null; }
  attempted(noteId: string, bindingId: string) {
    this.commit({ ...this.data, deliveries: { ...this.data.deliveries, [noteId]: { bindingId, state: "attempted", markerGuid: null } } });
  }
  added(noteId: string, bindingId: string, markerGuid: string) {
    this.commit({ ...this.data, deliveries: { ...this.data.deliveries, [noteId]: { bindingId, state: "added", markerGuid } } });
  }
  notExecuted(noteId: string) {
    const deliveries = { ...this.data.deliveries };
    delete deliveries[noteId];
    this.commit({ ...this.data, deliveries });
  }
}
