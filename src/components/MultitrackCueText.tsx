import { Fragment } from "react";
import type { AafCueWord } from "../bindings/AafCueWord";
import { UNSURE_CONFIDENCE } from "../lib/multitrack";

/**
 * A cue's text in the AAF Audio reader. When the recognizer measured its words
 * (Parakeet), the ones it was unsure of carry a dotted underline, so a
 * misheard name stands out before it reaches a string out. Plain text
 * otherwise: no words, or every word confident.
 */
export function MultitrackCueText({ text, words }: { text: string; words?: AafCueWord[] }) {
  if (!words?.some((word) => word.confidence < UNSURE_CONFIDENCE)) return <span className="cp-multitrack-cue-text">{text}</span>;
  return <span className="cp-multitrack-cue-text">{words.map((word, index) => <Fragment key={index}>{index ? " " : ""}
    {word.confidence < UNSURE_CONFIDENCE ? <span className="cp-multitrack-word-unsure" title="The recognizer was unsure of this word">{word.text}</span> : word.text}
  </Fragment>)}</span>;
}
