import { Fragment } from "react";
import type { AafCueWord } from "../bindings/AafCueWord";
import { UNSURE_CONFIDENCE } from "../lib/multitrack";
import type { CueLabels } from "../lib/multitrack-ownership";

/**
 * A cue's text in the AAF Audio reader. When the recognizer measured its words
 * (Parakeet), the ones it was unsure of carry a dotted underline, so a
 * misheard name stands out before it reaches a string out. Plain text
 * otherwise: no words, or every word confident.
 */
export function MultitrackCueText({ text, words, labels }: { text: string; words?: AafCueWord[]; labels?: CueLabels }) {
  const unsure = words?.some((word) => word.confidence < UNSURE_CONFIDENCE);
  const bleed = !!labels && [...labels.values()].some((word) => word.label === "bleed");
  if (!unsure && !bleed) return <span className="cp-multitrack-cue-text">{text}</span>;
  // Words as the recognizer measured them, or the text split on spaces: the
  // resolver indexes words the same way, so a label lands on its own word.
  const parts = words ?? text.split(/\s+/).filter(Boolean).map((word) => ({ text: word, confidence: 1 }));
  return <span className="cp-multitrack-cue-text">{parts.map((word, index) => {
    const heard = labels?.get(index)?.label === "bleed", doubt = word.confidence < UNSURE_CONFIDENCE;
    const className = [heard ? "cp-multitrack-word-bleed" : "", doubt ? "cp-multitrack-word-unsure" : ""].filter(Boolean).join(" ");
    return <Fragment key={index}>{index ? " " : ""}{className ? <span className={className} title={heard ? "Heard on another mic" : "The recognizer was unsure of this word"}>{word.text}</span> : word.text}</Fragment>;
  })}</span>;
}
