// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { cueIndexOfNode, newSpeakerTag, paintCueRange, selectionCharRange, selectionToCueRange } from "./cue-selection";

/** A stand-in for the rendered transcript: cue spans with text nodes inside. */
function makeTranscript(n: number): HTMLElement {
  const root = document.createElement("div");
  for (let i = 0; i < n; i += 1) {
    const span = document.createElement("span");
    span.className = "cp-tx-cue";
    span.dataset.cueIdx = String(i);
    span.append(document.createTextNode(`cue ${i} words `));
    root.append(span);
  }
  document.body.append(root);
  return root;
}

function selectAcross(root: HTMLElement, from: number, to: number): void {
  const a = root.querySelector(`[data-cue-idx="${from}"]`)!.firstChild!;
  const b = root.querySelector(`[data-cue-idx="${to}"]`)!.firstChild!;
  // setBaseAndExtent, not createRange: a Range is always normalised
  // start-before-end, so building one from a backwards drag silently
  // collapses it and the reversed case never gets exercised. Anchor and focus
  // preserve the direction the user actually dragged, which is what
  // selectionToCueRange reads.
  //
  // Offsets are deliberately PARTIAL at both ends — the real case, and the
  // one that has to snap outward to whole cues.
  document.getSelection()!.setBaseAndExtent(a, 2, b, 3);
}

beforeEach(() => { document.body.innerHTML = ""; document.getSelection()?.removeAllRanges(); });

describe("selectionToCueRange", () => {
  it("maps a partial selection out to whole cues", () => {
    // The snap is the design: a cue is the atom that carries a timestamp and
    // there is no sub-cue timing to split on.
    const root = makeTranscript(6);
    selectAcross(root, 1, 3);
    expect(selectionToCueRange(document.getSelection(), root)).toEqual({ from: 1, to: 3 });
  });

  it("normalises a bottom-to-top drag", () => {
    // Nobody selects in one direction only.
    const root = makeTranscript(6);
    selectAcross(root, 4, 2);
    expect(selectionToCueRange(document.getSelection(), root)).toEqual({ from: 2, to: 4 });
  });

  it("handles a selection inside ONE cue", () => {
    const root = makeTranscript(3);
    selectAcross(root, 1, 1);
    expect(selectionToCueRange(document.getSelection(), root)).toEqual({ from: 1, to: 1 });
  });

  it("refuses a collapsed selection", () => {
    // A plain click is not a lasso. Without this, clicking a cue would offer
    // to reassign it, which is not what a click means anywhere else.
    const root = makeTranscript(3);
    const r = document.createRange();
    r.setStart(root.querySelector('[data-cue-idx="1"]')!.firstChild!, 2);
    r.collapse(true);
    const sel = document.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);
    expect(selectionToCueRange(document.getSelection(), root)).toBeNull();
  });

  it("refuses a selection that touches no cue at all", () => {
    // A stray drag over the speaker chip or the timecode must not silently
    // reassign whatever happens to be nearby.
    const root = makeTranscript(3);
    const stray = document.createElement("p");
    stray.append(document.createTextNode("not a cue"));
    document.body.append(stray);
    const r = document.createRange();
    r.selectNodeContents(stray);
    const sel = document.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);
    expect(selectionToCueRange(document.getSelection(), root)).toBeNull();
  });

  it("survives one end overshooting past the last cue", () => {
    // A drag that runs off the end of a paragraph resolves one endpoint to
    // the container. Falling back to the end that DID resolve keeps an
    // ordinary sloppy drag working.
    const root = makeTranscript(4);
    const r = document.createRange();
    r.setStart(root.querySelector('[data-cue-idx="2"]')!.firstChild!, 1);
    r.setEnd(root, root.childNodes.length);
    const sel = document.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(r);
    expect(selectionToCueRange(document.getSelection(), root)).toEqual({ from: 2, to: 2 });
  });

  it("returns null for no selection and no root", () => {
    expect(selectionToCueRange(null, null)).toBeNull();
  });
});

describe("cueIndexOfNode", () => {
  it("walks up from a text node to its cue", () => {
    const root = makeTranscript(3);
    const text = root.querySelector('[data-cue-idx="2"]')!.firstChild!;
    expect(cueIndexOfNode(text, root)).toBe(2);
  });

  it("stops at the root rather than escaping the transcript", () => {
    const root = makeTranscript(1);
    const outside = document.createElement("span");
    document.body.append(outside);
    expect(cueIndexOfNode(outside, root)).toBeNull();
  });
});

describe("paintCueRange", () => {
  it("repaints the highlight to the snapped range", () => {
    // Without this the user lassos half a sentence, the action quietly widens
    // to whole cues, and the result does not match what they saw — the single
    // most likely way this feature would feel untrustworthy.
    const root = makeTranscript(5);
    selectAcross(root, 1, 3);
    paintCueRange({ from: 1, to: 3 }, root);
    const sel = document.getSelection()!;
    expect(sel.toString()).toBe("cue 1 words cue 2 words cue 3 words ");
  });
});

describe("newSpeakerTag", () => {
  it("mints letters, never digits", () => {
    // speakerColorIndex reads the first NUMBER out of a tag, so a minted
    // SPEAKER_09 would take colour slot 9 AND collide with a real ninth
    // speaker that a later re-detect may genuinely produce.
    const tag = newSpeakerTag([]);
    expect(tag).toBe("CAST_A");
    expect(tag).not.toMatch(/\d/);
  });

  it("skips tags already in use", () => {
    expect(newSpeakerTag(["CAST_A", "CAST_B"])).toBe("CAST_C");
  });

  it("keeps going past Z for a big cast", () => {
    const taken = Array.from({ length: 26 }, (_, i) => `CAST_${String.fromCharCode(65 + i)}`);
    expect(newSpeakerTag(taken)).toBe("CAST_AA");
  });

  it("never collides with a diarizer tag", () => {
    // merge_diarization_into_srt only ever emits SPEAKER_NN.
    for (let i = 0; i < 40; i += 1) {
      const taken = Array.from({ length: i }, (_, k) => newSpeakerTag(Array.from({ length: k }, (_, j) => `CAST_${j}`)));
      expect(newSpeakerTag(taken)).toMatch(/^CAST_[A-Z]+$/);
    }
  });
});

describe("selectionCharRange", () => {
  /** One cue whose text is exactly what a Whisper -ml 84 line looks like:
   *  two people's words in one box. */
  function oneCue(text: string): HTMLElement {
    const root = document.createElement("div");
    const span = document.createElement("span");
    span.dataset.cueIdx = "0";
    span.append(document.createTextNode(text));
    root.append(span);
    document.body.append(root);
    return root;
  }

  const TEXT = "I agree completely no I do not";

  it("reads the offsets of a phrase inside one cue", () => {
    const root = oneCue(TEXT);
    const t = root.querySelector('[data-cue-idx="0"]')!.firstChild!;
    document.getSelection()!.setBaseAndExtent(t, 19, t, 30);
    expect(selectionCharRange(document.getSelection(), root))
      .toEqual({ cueIdx: 0, from: 19, to: 30 });
  });

  it("normalises a backwards drag", () => {
    const root = oneCue(TEXT);
    const t = root.querySelector('[data-cue-idx="0"]')!.firstChild!;
    document.getSelection()!.setBaseAndExtent(t, 30, t, 19);
    expect(selectionCharRange(document.getSelection(), root))
      .toEqual({ cueIdx: 0, from: 19, to: 30 });
  });

  it("counts through search highlighting rather than around it", () => {
    // highlightMatch wraps a hit in <mark>, splitting one text node into
    // three. Summing node lengths would read the offset relative to whichever
    // fragment the selection landed in, and the cut would land somewhere else
    // entirely — visible only when a search happens to be active.
    const root = document.createElement("div");
    const span = document.createElement("span");
    span.dataset.cueIdx = "0";
    span.innerHTML = 'I agree <mark>completely</mark> no I do not';
    root.append(span);
    document.body.append(root);
    const tail = span.lastChild!; // " no I do not"
    document.getSelection()!.setBaseAndExtent(tail, 1, tail, 12);
    expect(selectionCharRange(document.getSelection(), root))
      .toEqual({ cueIdx: 0, from: 19, to: 30 });
  });

  it("refuses a selection that crosses cues — that is the whole-cue case", () => {
    const root = makeTranscript(3);
    selectAcross(root, 0, 2);
    expect(selectionCharRange(document.getSelection(), root)).toBeNull();
    // …and the whole-cue reader still handles it.
    expect(selectionToCueRange(document.getSelection(), root)).toEqual({ from: 0, to: 2 });
  });

  it("refuses a whole-cue selection, which needs no cut", () => {
    const root = oneCue(TEXT);
    const t = root.querySelector('[data-cue-idx="0"]')!.firstChild!;
    document.getSelection()!.setBaseAndExtent(t, 0, t, TEXT.length);
    expect(selectionCharRange(document.getSelection(), root)).toBeNull();
  });

  it("refuses a collapsed selection or no root", () => {
    const root = oneCue(TEXT);
    const t = root.querySelector('[data-cue-idx="0"]')!.firstChild!;
    document.getSelection()!.setBaseAndExtent(t, 5, t, 5);
    expect(selectionCharRange(document.getSelection(), root)).toBeNull();
    expect(selectionCharRange(null, root)).toBeNull();
    expect(selectionCharRange(document.getSelection(), null)).toBeNull();
  });
});
