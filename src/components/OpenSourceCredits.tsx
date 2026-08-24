import { invoke } from "@tauri-apps/api/core";
import { OPEN_SOURCE_CREDITS, fundableCredits } from "../lib/open-source";
import { IconHeart, IconLink } from "./Icons";

/**
 * "Built on" — the projects this app is a shell over, and how to pay them.
 *
 * Streamlined on purpose: one row per project, the name and who maintains
 * it, one line saying what it actually does HERE (not what it is in
 * general), and a Sponsor link where the project publishes one. No logos,
 * no cards, no separate donations screen - it reads as a list because it is
 * one, and it sits under the About facts rather than competing with them.
 *
 * Links open in the user's browser through `open_external_url`, which
 * validates the scheme in Rust. Nothing here is fetched, so the pane costs
 * nothing on a machine that is offline.
 */
export function OpenSourceCredits() {
  const open = (url: string) => {
    invoke("open_external_url", { url }).catch(() => { /* ignore */ });
  };
  const fundable = fundableCredits();

  return (
    <section className="cp-credits" aria-labelledby="cp-credits-title">
      <div className="cp-credits-head">
        <h3 id="cp-credits-title" className="cp-credits-title">Built on</h3>
        <p className="cp-credits-sub">
          Most of this app is other people's work, and most of it is maintained
          by one or two of them. {fundable.length} of these take sponsorship.
        </p>
      </div>
      <ul className="cp-credits-list">
        {OPEN_SOURCE_CREDITS.map((c) => (
          <li key={c.name} className="cp-credit">
            <div className="cp-credit-main">
              <button
                type="button"
                className="cp-credit-name"
                onClick={() => open(c.url)}
                title={c.url}
              >
                {c.name}
                <IconLink size={11} />
              </button>
              {c.by && <span className="cp-credit-by">{c.by}</span>}
              <span className="cp-credit-lic">{c.license}</span>
            </div>
            <p className="cp-credit-role">{c.role}</p>
            {c.fund && (
              <button
                type="button"
                className="cp-credit-fund"
                onClick={() => open(c.fund!)}
                title={c.fund}
                aria-label={`Sponsor ${c.name}`}
              >
                <IconHeart size={12} />
                Sponsor
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
