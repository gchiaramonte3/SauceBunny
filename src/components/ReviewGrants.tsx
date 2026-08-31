import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { formatError } from "../lib/error-format";
import { reviewInviteMessage } from "../lib/review-link";
import { IconCircleX } from "./Icons";
import type { GrantSummary } from "../bindings/GrantSummary";
import type { NewGrant } from "../bindings/NewGrant";

/**
 * Links issued to named people, and the button that takes one back.
 *
 * The thing this replaces was a single code that never expired and could only
 * be withdrawn by resetting the identity, which invalidated every code at
 * once. It also let whoever held it choose the name their notes were signed
 * with. A grant fixes both: the label is the host's, and one link can be
 * revoked while the others keep working.
 *
 * The secret is shown ONCE. It is never stored in readable form, so there is
 * no "copy again" - which is worth saying on screen rather than letting
 * someone discover it.
 */

/** ts-rs maps Rust's u64 to bigint, which is right - these are millisecond
 *  timestamps and Number would silently round past 2^53. Converted here, at
 *  the one place a date is turned into words, rather than widened at the
 *  boundary. */
function when(ms: bigint | null): string {
  if (!ms) return "never used";
  const days = Math.floor((Date.now() - Number(ms)) / 86_400_000);
  if (days <= 0) return "used today";
  if (days === 1) return "used yesterday";
  return `used ${days} days ago`;
}

export function ReviewGrants({ code }: {
  /** The current join code, which the link is built around. Null when no
   *  session is running: a link is useless without one, and saying so beats
   *  handing someone a link that cannot work. */
  code: string | null;
}) {
  const [grants, setGrants] = useState<GrantSummary[] | null>(null);
  const [label, setLabel] = useState("");
  const [invitedOnly, setInvitedOnly] = useState(false);
  const [justMade, setJustMade] = useState<{ label: string; secret: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setGrants(await invoke<GrantSummary[]>("list_review_grants"));
      setInvitedOnly(await invoke<boolean>("review_invited_only"));
    } catch (e) { setError(formatError(e)); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  const create = async () => {
    setError(null);
    try {
      const made = await invoke<NewGrant>("create_review_grant", { label });
      setJustMade({ label: made.label, secret: made.secret });
      setLabel("");
      await refresh();
    } catch (e) { setError(formatError(e)); }
  };

  const [removed, setRemoved] = useState<string | null>(null);
  const revoke = async (id: string, label: string) => {
    setError(null);
    try {
      // Returns how many live connections it closed, so the confirmation can
      // say what actually happened rather than "done".
      const closed = await invoke<number>("revoke_review_grant", { id });
      setRemoved(closed > 0
        ? `${label} was disconnected and the link no longer works.`
        : `${label}'s link no longer works.`);
      await refresh();
    } catch (e) { setError(formatError(e)); }
  };

  const copyLink = async (secret: string) => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(reviewInviteMessage(code, secret));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch { /* clipboard unavailable */ }
  };

  const live = (grants ?? []).filter((g) => !g.revoked);

  return (
    <section className="cp-grants">
      <h2 className="cp-grants-title">Review links</h2>
      <p className="cp-grants-hint">
        A link is issued to one person and wears the name you give it, so their notes are
        signed with it rather than with whatever they type. You can take one back without
        touching the others.
      </p>

      <div className="cp-grants-new">
        <label className="cp-grants-field">
          <span className="cp-grants-field-label">Who is this for</span>
          <input
            className="cp-grants-input"
            value={label}
            maxLength={60}
            placeholder="Dana at Novella"
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && label.trim()) void create(); }}
          />
        </label>
        <button type="button" className="btn btn-ghost" disabled={!label.trim()} onClick={() => void create()}>
          Make a link
        </button>
      </div>

      {justMade && (
        <div className="cp-grants-made" role="status">
          <p className="cp-grants-made-line">
            Link for <strong>{justMade.label}</strong>. This is the only time it can be copied.
          </p>
          {code ? (
            <button type="button" className="btn btn-ghost" onClick={() => void copyLink(justMade.secret)}>
              {copied ? "Copied" : "Copy link"}
            </button>
          ) : (
            <p className="cp-grants-made-line">
              Start a session and the link will work. It is saved either way.
            </p>
          )}
        </div>
      )}

      {error && <p className="cp-grants-error" role="alert">{error}</p>}
      {removed && <p className="cp-grants-made-line" role="status">{removed}</p>}

      {grants && grants.length > 0 && (
        <ul className="cp-grants-list">
          {grants.map((g) => (
            <li key={g.id} className={"cp-grants-row" + (g.revoked ? " revoked" : "")}>
              <span className="cp-grants-row-label">{g.label}</span>
              <span className="cp-grants-row-when">{g.revoked ? "withdrawn" : when(g.lastSeenAt)}</span>
              {!g.revoked && (
                <button
                  type="button"
                  className="cp-grants-revoke"
                  aria-label={`Withdraw the link for ${g.label}`}
                  title={`Withdraw the link for ${g.label}`}
                  onClick={() => void revoke(g.id, g.label)}
                >
                  <IconCircleX size={13} />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {/* The strict rule, off by default. On, the lobby's join code stops
          working too, which is the point and is worth saying plainly. */}
      <label className="cp-grants-strict">
        <input
          type="checkbox"
          checked={invitedOnly}
          onChange={(e) => {
            const on = e.target.checked;
            setInvitedOnly(on);
            void invoke("set_review_invited_only", { on }).catch((err) => setError(formatError(err)));
          }}
        />
        <span>
          Only let people in through a link. Turns off the join code as well, so nobody can
          reach you without one of the {live.length === 1 ? "link" : "links"} above.
        </span>
      </label>
    </section>
  );
}
