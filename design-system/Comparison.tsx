import type { ReactNode } from "react";

type Basis = "component" | "markup" | "schematic" | "mixed";
const captions: Record<Basis, string> = {
  component: "Production component · fixture props",
  markup: "Source-markup fixture",
  schematic: "Illustrative fixture · see sources",
  mixed: "Components + fixture markup",
};

export function Comparison({ current, proposed, same = false, related = false, currentBasis = "schematic", proposedBasis }: {
  current: ReactNode; proposed: ReactNode; same?: boolean; related?: boolean; currentBasis?: Basis; proposedBasis?: Basis;
}) {
  return <div className="cp-ds-comparison">
    <section className="cp-ds-specimen" data-ds-example="current" data-ds-basis={currentBasis} aria-label="Current pattern reference">
      <h3>Current <span>{captions[currentBasis]}</span></h3>
      <div className="cp-ds-sample">{current}</div>
    </section>
    <section className="cp-ds-specimen" data-ds-example="proposed" data-ds-basis={proposedBasis ?? (same || related ? "schematic" : "proposal")} aria-label={related ? "Related examples" : same ? "Retained pattern" : "Proposed pattern"}>
      <h3>{related ? "Related examples" : same ? "Keep" : "Proposed"} <span>{proposedBasis ? captions[proposedBasis] : related ? "Companion patterns, not a replacement" : same ? "Pattern to preserve · illustrative" : "Catalog only, not applied"}</span></h3>
      <div className="cp-ds-sample">{proposed}</div>
    </section>
  </div>;
}
