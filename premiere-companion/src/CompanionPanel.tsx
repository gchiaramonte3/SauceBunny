import { useEffect, useState, type KeyboardEvent } from "react";
import { Companion } from "./companion";
import { PendingNote } from "./PendingNote";
import { sameBinding } from "./protocol";
import { parsePremierePairingCode } from "../../src/lib/premiere-pairing-code";

export function CompanionPanel({ companion }: { companion: Companion }) {
  const [snapshot, setSnapshot] = useState(companion.snapshot());
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => companion.subscribe(setSnapshot), [companion]);
  const binding = snapshot.status?.binding;
  const pending = snapshot.notes.filter(note => !["added", "removed_in_premiere"].includes(note.status));
  const completed = snapshot.notes.filter(note => ["added", "removed_in_premiere"].includes(note.status));
  async function run(work: () => Promise<void>) {
    setError(""); setBusy(true);
    try { await work(); } catch (reason) { setError(reason instanceof Error ? reason.message : "The operation could not finish."); }
    finally { setBusy(false); }
  }
  const commandKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || ![" ", "Enter"].includes(event.key)) return;
    const target = event.target as HTMLButtonElement;
    if (target.tagName !== "BUTTON") return;
    event.preventDefault(); event.stopPropagation();
    if (event.type === "keydown" && !event.repeat && !target.disabled) target.click();
  };
  return <main className="cp-companion" aria-label="Sauce Bunny Premiere companion"
    onKeyDownCapture={commandKey} onKeyUpCapture={commandKey}>
    <header className="cp-companion-header"><h1>Sauce Bunny</h1><span className="cp-companion-beta">Beta</span></header>
    <p className="cp-companion-muted">Review notes for your Premiere timeline.</p>
    <section className="cp-companion-section" aria-labelledby="connection-heading">
      <h2 id="connection-heading">{snapshot.connected ? "Connected to Sauce Bunny" : "Connect to Sauce Bunny"}</h2>
      {!snapshot.connected && <>
        <p className="cp-companion-muted">In Sauce Bunny Settings → Integrations, choose Pair companion, then Copy pairing code.</p>
        <label className="cp-companion-pair-field"><span>Pairing code</span>
          <input id="pair-code" type="password" value={code} onChange={event => { setCode(event.target.value); setError(""); }}
            placeholder="Paste pairing code" disabled={busy} autoComplete="off" spellCheck={false} aria-describedby="pair-help" />
        </label>
        <button className="cp-companion-primary" aria-busy={busy} disabled={busy || !code.trim()} onClick={() => { void run(async () => {
          const pairing = parsePremierePairingCode(code);
          await companion.pair(pairing.url, pairing.token); setCode("");
        }); }}>
          {busy ? "Connecting…" : "Connect"}
        </button>
        <p id="pair-help" className="cp-companion-muted">One paste. This private code expires after five minutes.</p>
      </>}
      <p role="status" className="cp-companion-muted">{snapshot.connected ? "Local connection only · Video sharing stays separate." : snapshot.message}</p>
      {(snapshot.connected || busy) && <button onClick={() => companion.disconnect()}>Disconnect</button>}
      {error && <p className="cp-companion-error" role="alert">{error}</p>}
    </section>
    {snapshot.connected && <section className="cp-companion-section" aria-labelledby="binding-heading">
      <h2 id="binding-heading">Bound sequence</h2>
      {binding ? <><p className="cp-companion-identity">{binding.sequenceName}</p><p className="cp-companion-muted">{binding.projectName}</p></>
        : <p className="cp-companion-muted">Activate the sequence that is sending the NDI picture, then bind it here.</p>}
      <button disabled={busy} onClick={() => { void run(() => companion.bind()); }}>Bind current sequence</button>
      <label className="cp-companion-toggle">
        <input type="checkbox" checked={snapshot.status?.syncEnabled ?? false} disabled={busy || !binding}
          onChange={event => { const enabled = event.target.checked; void run(() => companion.setSync(enabled)); }} />
        <span>Send review notes to Premiere</span>
      </label>
      <p className="cp-companion-muted">Editor-confirmed placement only. NDI frame timing is not yet verified. Binding does not connect or share video.</p>
    </section>}
    {(snapshot.connected || snapshot.notes.length > 0) && <section className="cp-companion-section" aria-labelledby="notes-heading">
      <h2 id="notes-heading">Pending notes{snapshot.status ? ` · ${snapshot.status.pendingCount}` : ""}</h2>
      {pending.length === 0 && <p className="cp-companion-muted">Queued timeline notes appear here. General notes stay in Sauce Bunny. Room delivery is not enabled in this local proof.</p>}
      {pending.map(note => <PendingNote key={note.id} note={note} companion={companion}
        connected={snapshot.connected} bound={sameBinding(binding ?? null, note.request.anchor.binding)}
        enabled={snapshot.connected && !!snapshot.status?.syncEnabled && !busy} />)}
      {snapshot.page.total > 100 && <div>
        <button disabled={!snapshot.connected || busy || snapshot.page.offset === 0}
          onClick={() => { void run(() => companion.page(snapshot.page.offset - 100)); }}>Previous notes</button>
        <button disabled={!snapshot.connected || busy || !snapshot.page.hasMore}
          onClick={() => { void run(() => companion.page(snapshot.page.offset + 100)); }}>Next notes</button>
      </div>}
      {snapshot.status && snapshot.status.pendingCount > pending.length && <p className="cp-companion-muted">Showing {pending.length} pending notes. More appear as this batch is handled.</p>}
    </section>}
    {completed.length > 0 && <section className="cp-companion-section" aria-labelledby="recent-heading">
      <h2 id="recent-heading">Recent deliveries</h2>
      {completed.map(note => <p key={note.id}><strong>{note.request.author}</strong>: {note.status === "added" ? "Added to Premiere" : "Removed in Premiere; will not be recreated"}</p>)}
    </section>}
    {snapshot.connected && <p className="cp-companion-muted">Save your project in Premiere after adding markers. Undo is preserved.</p>}
  </main>;
}
