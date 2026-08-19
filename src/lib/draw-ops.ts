import type { AnnotationStrokes } from "./review";

/**
 * Multi-user drawing, and why this is NOT yjs.
 *
 * A finished stroke is IMMUTABLE. Nobody reshapes someone else's line
 * mid-flight the way two people retype the same sentence — you draw another
 * one, or you erase one. So a shared drawing is a grow-only set of strokes
 * plus a set of tombstones: a 2P-Set, the simplest CRDT there is, and it
 * converges under plain union with no library, no binary update protocol and
 * no awareness channel.
 *
 * yjs earns its weight on concurrent mutation of a shared SEQUENCE — text,
 * arrays where two peers edit the same element. That is not this. Bringing it
 * in would add a large dependency and a second sync mechanism beside the
 * ReviewOp relay that already carries every other collaborative change in the
 * app, to solve a problem the relay's own rules already solve: idempotent adds
 * by id, sets rather than toggles, and a deterministic tiebreak. The one place
 * a CRDT text type would genuinely pay is collaborative editing of a comment
 * BODY, which today is single-author with LWW and fine for a room of four.
 *
 * What actually needs care is not convergence but ORDER: paint order decides
 * what covers what, and two peers must agree on it. Hence `at` + `id` as a
 * total order every replica computes identically.
 */

/** A stroke as it travels between peers. */
export type DrawStroke = AnnotationStrokes["strokes"][number] & {
  /** Stable identity: makes an add idempotent and an erase addressable. */
  id: string;
  /** Display name of whoever drew it, for attribution in a shared session. */
  author: string;
  /** Author's wall clock at draw time. Paint order, not causality. */
  at: number;
};

export type DrawOp =
  /** Idempotent by `stroke.id` — a replayed add is a no-op, never a duplicate. */
  | { t: "strokeAdd"; stroke: DrawStroke }
  /** Tombstone. Erasing something you have not received yet must still win when
   *  it arrives, so the tombstone is kept rather than filtered against the
   *  current set — otherwise a late add resurrects an erased stroke. */
  | { t: "strokeErase"; id: string; at: number };

/** The replicated drawing state for one annotation. */
export type DrawState = {
  strokes: DrawStroke[];
  /** Erased stroke ids. Kept even when the stroke has not arrived. */
  erased: string[];
};

export const EMPTY_DRAW_STATE: DrawState = { strokes: [], erased: [] };

/**
 * Total order every replica computes the same way.
 *
 * Time first so drawing later paints on top, then the id purely to break a
 * same-millisecond tie — two machines CAN stamp the same instant, and without
 * a tiebreak the two peers would paint them in opposite orders and disagree
 * about which colour is on top.
 */
function order(a: DrawStroke, b: DrawStroke): number {
  return a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Apply one op. Pure, idempotent, and order-independent. */
export function applyDrawOp(state: DrawState, op: DrawOp): DrawState {
  switch (op.t) {
    case "strokeAdd": {
      if (state.erased.includes(op.stroke.id)) return state;      // tombstoned
      if (state.strokes.some((s) => s.id === op.stroke.id)) return state; // replay
      return { ...state, strokes: [...state.strokes, op.stroke].sort(order) };
    }
    case "strokeErase": {
      if (state.erased.includes(op.id)) return state;
      return {
        strokes: state.strokes.filter((s) => s.id !== op.id),
        erased: [...state.erased, op.id],
      };
    }
    default:
      return state;
  }
}

/** Fold a batch — the join used when a peer sends its whole drawing on catch-up. */
export function mergeDrawOps(state: DrawState, ops: DrawOp[]): DrawState {
  return ops.reduce(applyDrawOp, state);
}

/** Everyone who has drawn on this annotation, in first-stroke order. */
export function drawAuthors(state: DrawState): string[] {
  const seen: string[] = [];
  for (const s of [...state.strokes].sort(order)) {
    if (!seen.includes(s.author)) seen.push(s.author);
  }
  return seen;
}

/** Undo removes only YOUR most recent stroke — never a peer's. */
export function lastStrokeBy(state: DrawState, author: string): DrawStroke | null {
  const mine = state.strokes.filter((s) => s.author === author).sort(order);
  return mine.length ? mine[mine.length - 1] : null;
}

// ── relay envelope ───────────────────────────────────────────────────────────
// Draw ops ride the EXISTING `reviewOp` session message, whose payload is an
// opaque string the Rust relay never inspects — the same trick the source
// verdict used to ship with zero Rust changes. The tag keeps them apart, and a
// peer on an older build hands the object to applyReviewOp, which documents
// that unknown op shapes return the doc unchanged. So an old client ignores
// live drawing instead of breaking on it.

export type DrawRelay = { t: "draw"; op: DrawOp };

export function isDrawRelay(x: unknown): x is DrawRelay {
  if (typeof x !== "object" || x === null) return false;
  const o = x as { t?: unknown; op?: { t?: unknown } };
  if (o.t !== "draw" || typeof o.op !== "object" || o.op === null) return false;
  return o.op.t === "strokeAdd" || o.op.t === "strokeErase";
}

/**
 * Stamp the op with the sender the HOST identified, never the name the payload
 * claims.
 *
 * The relay is payload-agnostic, so a peer can put anything in the envelope.
 * Trusting `stroke.author` would let anyone draw on the frame signed as someone
 * else — the same hole the review-op path already closes by attributing from
 * the host-stamped member id, and it matters more here because a drawing has no
 * body text to give the impersonation away.
 */
export function attributeDrawOp(op: DrawOp, author: string): DrawOp {
  return op.t === "strokeAdd" ? { ...op, stroke: { ...op.stroke, author } } : op;
}
