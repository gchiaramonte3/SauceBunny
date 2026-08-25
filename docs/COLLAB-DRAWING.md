# Collaborative drawing — research and decision

Four parallel passes over the capture path, the session bus, the data model
and storage, then a synthesis. Spot-verified by hand before filing.

## DECISION (owner's call, taken 2026-08-25)

**The live drawing surface is EPHEMERAL. Only a posted comment persists.**

Two people may draw on the frame at once during a session; whoever posts
turns the room's strokes into one ordinary comment, attributed to them, and
everything else evaporates when the session ends.

Why, in order of weight:

1. The stored `annotation` is a WRITE-ONCE field on a single comment
   (`review.ts`). Making strokes durable per author means making annotations
   addressable entities, which breaks the whole-comment merge, the export
   path and undo at the same time.
2. "Post" is already this app's word for *this becomes a durable note with an
   author*. A surface that persisted silently would make the Post button
   mean nothing.
3. It is the reversible choice. The stroke ops already carry `id`, `author`
   and `at`, so persistence remains available later at no cost - whereas
   shipping persistence first would be very hard to walk back.

NOT YET IMPLEMENTED below this line.

---

# DOCUMENT 1 — Collaborative drawing in a live co-review session

Repo verified at HEAD `3fc77b1`. Every line below was re-read at that commit; where a research pass disagreed with the tree, the tree wins and the disagreement is listed at the end.

## 1. What happens today

**Local capture.** A stroke lives in a ref, never state. `AnnotationOverlay.tsx:302` pushes each point on pointermove; `AnnotationOverlay.tsx:290-301` expands `getCoalescedEvents()` so one delivered move can push 2-8 OS samples. `norm()` (`AnnotationOverlay.tsx:234-245`) returns `[x, y, pressure]` as unrounded doubles, pressure pinned to `0.5` for anything not a pen. Shapes are sampled, not described: ellipse is always 49 points (`draw-tools.ts:100-103`), a rectangle steps every 0.01 normalised units per edge with a floor of 8 (`draw-tools.ts:83-91`), arrow is 5 (`draw-tools.ts:119`).

**Commit.** `onUp` fires `onChange` once (`AnnotationOverlay.tsx:314`) into App-local `reviewDraft` (`App.tsx:3863`), rendered on the local monitor only (`App.tsx:4058-4059`).

**Crossing the wire — one line.** `ReviewPanel.tsx:897`:

```ts
annotation: hasDrawing ? draft : null,
```

That comment goes to `dispatchUndoable` → `onSessionOp` (`ReviewPanel.tsx:679`) → `postSessionOp` (`use-co-review.ts:517-527`) → `sendSessionMsg({ kind: "reviewOp", op: JSON.stringify(op), from: "" })`. Rust treats `op` as an opaque `String` (`session.rs:220-226`), stamps `from`, relays (`session.rs:1470`). **Nothing upstream of `ReviewPanel.tsx:897` reaches another machine.** Not a point, not the pen colour, not "someone is drawing".

**A second, coarser path.** `sanitizeDocForWire` (`review.ts:158-164`) strips `sourceKey` and per-version `path` and touches nothing else, so every stored annotation re-crosses on every full-doc broadcast: source change (`use-co-review.ts:792-796`) and every rise in peer count (`use-co-review.ts:840-850`), fanned to **all** peers, not just the newcomer. Both call sites `.catch(() => {})` against a command that rejects >2 MiB lines (`session.rs:67`, `session.rs:699`). A guest who gets no doc is told nothing.

**Rendering.** Monitor shows exactly one overlay: the ternary at `Monitor.tsx:555-567`. The read-only branch, `ProximityAnnotation` (`Monitor.tsx:189-207`), keeps the **single nearest** drawing by `Math.abs(a.time - playheadSec)` (`Monitor.tsx:197-200`) inside `ANNOT_PROX_WINDOW = 0.6` (`Monitor.tsx:183`). Two people annotating the same frame today: one is silently invisible, tie broken by doc order from `annotationsOf` (`review.ts:997-1002`).

## 2. What is already built and wired to nothing

`src/lib/draw-ops.ts` (135 lines) is a complete, tested multi-user drawing model:

- `DrawStroke = AnnotationStrokes["strokes"][number] & { id, author, at }` (`draw-ops.ts:28-35`) — a strict superset of the stored shape.
- `DrawOp = strokeAdd | strokeErase` (`draw-ops.ts:37-43`), folded by `applyDrawOp` into a 2P-Set with tombstones that survive a late add (`draw-ops.ts:67-84`).
- Deterministic paint order `at` then `id` (`draw-ops.ts:62-64`) — the file's own header (`draw-ops.ts:22-24`) correctly identifies order, not convergence, as the hard part.
- Relay envelope riding the **existing** `reviewOp` message as an opaque tagged string (`draw-ops.ts:106-121`), chosen specifically so an old peer hands it to `applyReviewOp`, which no-ops on unknown shapes.
- `attributeDrawOp` re-stamps `author` from the host-identified sender (`draw-ops.ts:133-135`).

`useCoReview` holds `liveDraw` state (`use-co-review.ts:390`), applies inbound relays (`use-co-review.ts:536-539`), exposes `postDrawOp` (`use-co-review.ts:394-397`), and returns both (`use-co-review.ts:1285`). **`grep -rn "liveDraw\|postDrawOp" src/` outside that one file returns zero hits.** App's destructure (`App.tsx:3737-3749`) takes neither. There is no `DrawState → AnnotationStrokes` flatten anywhere.

So: the model shipped, the transport shipped, the UI never connected. The remaining work is a view-layer problem and a plumbing problem, not a protocol problem.

## 3. What NOT to build, and why

**Do not build a shared whiteboard.** That means making an annotation an addressable entity with its own persisted ops. It breaks four things at once:

- `annotation` is a write-once field on one comment (`review.ts:79`), constructed in exactly two places (`review.ts:341`, `ReviewPanel.tsx:897`). No `ReviewOp` variant (`review.ts:477-486`) reads or writes it; `edit` changes `body` only.
- `mergeReviewDoc` picks the **whole comment** by recency (`review.ts:695-730`) — there is no per-stroke merge in the persisted path, only in the ephemeral 2P-Set.
- Exports reach through `c.annotation?.labels` (`review.ts:1021-1027`); the proximity fade is a 1:1 comment→drawing map (`review.ts:997-1002`); undo reverses an add by deleting the entire comment (`review.ts:553`).

**Do not add a new Rust `SessionMsg` variant for strokes.** It costs a `ts-rs` binding regen, a build-ID bump in both `build-id.ts` and `commands/system.rs`, and — the real cost — an older peer receiving an unknown `kind` logs an error line and continues (`session.rs:1562+`, host `session.rs:939+`). At 15 Hz that is a log flood. The shipped envelope (`draw-ops.ts:106-112`) degrades to silence instead.

**Do not add a WebRTC data channel.** `grep -rn "createDataChannel\|RTCDataChannel" src/` returns nothing; WebRTC is confined to the webcam/mic mesh over iroh signalling (`session.rs:166`). Live strokes are kilobytes per second on a link that already carries them.

**Do not persist stroke ids, authors and tombstones.** ~60 bytes of metadata per stroke plus a never-shrinking tombstone list, to fix a conflict unreachable in today's product shape (one author attaches a drawing at post time; nobody edits a posted annotation).

## 4. The smallest genuinely useful step

**A shared scratch surface, before anyone posts.** Two people point at the same frame at once; whoever posts turns the room's strokes into one ordinary comment; everything else evaporates with the session. That is exactly what `use-co-review.ts:382-389` already documents as the intent.

Three things stand between here and that:

1. `Monitor.tsx:555-567` renders one overlay. It must render a **stack**.
2. `liveDraw`/`postDrawOp` are not destructured (`App.tsx:3737-3749`).
3. No flatten function exists.

Note what is **not** on that list: the wire format, the CRDT, the attribution hardening, the relay. Those are done.

## 5. Data model

Keep `AnnotationStrokes` (`review.ts:31-56`) exactly as it is. Keep `DrawStroke` a strict superset (`draw-ops.ts:28-35`) so the flatten is a field-drop and can never be a lossy re-encode. Write it once, in `draw-ops.ts`, with tests:

```ts
export function flattenDrawState(state: DrawState, labels?: AnnotationLabel[]): AnnotationStrokes
```

Sort by `order` (`draw-ops.ts:62`), drop `id`/`author`/`at`, carry `labels` through — dropping that field is the bug `AnnotationOverlay.tsx:311-314` already warns about.

**Ownership keys on the member id, never the display name.** `attributeDrawOp` is called with `nameForMember(m.from)` (`use-co-review.ts:537`), which falls back to the literal `"Someone"`, and colour is a hash of that name (`review.ts:792-795`). Two guests called "Dan" produce identically tinted, indistinguishable strokes. Change `DrawStroke.author` to carry the member id and resolve the name at render, or add `by: string` alongside it. This is a change to a file nobody imports yet — it is free today and expensive after the first ship.

**Size.** Round at capture. `norm()` (`AnnotationOverlay.tsx:242-244`) and the coalesced branch (`AnnotationOverlay.tsx:295-300`) emit unrounded doubles; `shapePoints` (`draw-tools.ts:60-121`) emits arbitrary lerps for what are 49 or ~141 samples of an exact curve. Round x/y to 4 decimals (0.38 px at 4K) and emit a 2-tuple whenever `pointerType !== "pen"`. Both shapes are already legal — the type's first branch **is** `[number, number]` (`review.ts:47`) and the renderer already defaults `pt[2] ?? 0.5`. Measured by pass 2: 9,871 → 3,528 bytes on a 220-point stroke. No schema change, no migration, safe on every older peer, and it shrinks the live feed, the reviewOp line and the join-time snapshot simultaneously.

**Add the cap that does not exist.** The only length checks in the whole drawing path are emptiness guards (`AnnotationOverlay.tsx:314`). Put `MAX_ANNOTATION_BYTES` in `review.ts` next to `annotationHasContent` (`review.ts:58-61`) and enforce it in `onUp`. A refused stroke that says so beats a guest who silently never receives the doc.

## 6. Wire format

Unchanged from what shipped: `{ kind: "reviewOp", op: JSON.stringify({ t: "draw", op }) }` (`use-co-review.ts:396`). Rust needs no edit.

Two additions:

**Carry the frame.** Add `at` in *source seconds* to the relay envelope (distinct from `DrawStroke.at`, which is a wall clock for paint order — `draw-ops.ts:33-34`). Receivers' playheads are chased to a 2 Hz heartbeat (`use-co-review.ts:891`); a stroke painted over the wrong frame is worse than no stroke. Gate painting on the receiver's playhead being within `ANNOT_PROX_WINDOW` (`Monitor.tsx:183`) of it.

**Pace the sender.** There is no rate limiter anywhere in `session.rs` — only `MAX_MSG_BYTES` per line (`session.rs:67`), which is a size cap, not a rate limit. Batch points at 10-15 Hz. For scale: transport is 2 Hz (`use-co-review.ts:891`), presence 2.86 Hz (`use-co-review.ts:917`). A 15 Hz batched feed at 4dp is ~2.5-3 KB/s per drawer, ~7-9 KB/s host fan-out at four people — defensible against CLAUDE.md's "kilobytes of control traffic through n0's public relay was an accepted cost", but 7x the current busiest sender in *message rate*, and every message is a `from_str`, a Tauri event, and a React state update on each receiver.

**Skip live drawing on a relayed session.** CLAUDE.md already caps a relayed session at the lowest rung and keeps no copy; a 15 Hz feed through n0's public relay is the same bargain that rule refuses.

## 7. Storage

**Nothing new on disk.** Live strokes are ephemeral by construction (`use-co-review.ts:382-389`). A posted comment stores the flattened annotation in the review doc exactly as today: `~/Documents/Sauce Bunny/Reviews/<slug>-<hash>.json`, compact (`review-store.ts:321`), atomic, debounced 500 ms (`review-store.ts:57`).

**Do not put drawings in the screening record.** It holds `commentIds` only (`screening.ts:39`) by design; independently, screening docs are pretty-printed (`screening-store.ts:254`, ~1.69x) and read-capped at 4 MiB with a null return on failure (`screening-store.ts:229`), so a drawing-carrying screening would silently stop opening.

**Three latent storage hazards drawings make reachable** (all verified, none urgent):

- `MAX_HYDRATE_BYTES = 64 MiB` / `MAX_HYDRATE_DOCS = 1000` (`review-store.ts:66-67`) leave an over-budget doc **empty in memory**; a later edit makes it non-empty, so it dodges the `emptyOverContent` guard and trips only `shrinking` (`review-store.ts:332`), writes a `.bak`, and overwrites. The `.bak` is the only recovery and is overwritten by the next such event.
- Erase becomes the dangerous op: removing one ~25 KB annotation from a 50 KB doc is a >50% shrink, so ordinary editing routinely enters the read-back branch (`review-store.ts:334-338`); if the file is missing or iCloud-evicted, the write defers with no re-arm and never lands for the rest of the session.
- Every save re-serializes the whole doc and allocates a second full copy purely to count bytes (`review-store.ts:321-324`), every 500 ms of typing anywhere in the doc.

**The version stamp does not work and should be fixed before you rely on it.** `ReviewIndexFile` is typed `{ version: 1; ... }` (`review-store.ts:173`) and written as the literal `1` (`review-store.ts:204`); it never reads `STORE_SCHEMA_VERSION`. Same in `cast-store.ts:247`, `screening-store.ts:260`, `transcript-project-store.ts:74`, `web-collection-store.ts:118`. Bumping the constant changes only the read side. `store-version-contract.test.ts` checks that a stamping file *mentions* `futureVersionIn`, never that the stamped value equals the constant.

## 8. Phases, with exact files

**Phase 0 — free size win, ship alone (half a day).**
`AnnotationOverlay.tsx:242-244` and `:295-300`: round to 4dp, emit 2-tuple for non-pen. `draw-tools.ts:60` (`p()`): round there too. No schema change, no wire change, no migration. Existing tests in `draw-tools.test.ts` cover the shape functions.

**Phase 1 — the layer stack. Ship this even if live drawing never lands.**
`Monitor.tsx:555-567`: replace the ternary with local overlay on top plus N pointer-transparent read-only overlays beneath. `Monitor.tsx:189-207`: `ProximityAnnotation` returns *every* annotation inside `ANNOT_PROX_WINDOW`, each with its own opacity and `color`, instead of the single nearest. `App.tsx:4787` and `App.tsx:3936` already carry per-annotation `color` from `annotationsOf` (`review.ts:1002`). Today two people annotating the same frame silently hides one of them; this is a bug fix on its own. Watch `e2e/card-unity.spec.ts`-style geometry specs and `src/lib/scrim-layer-contract.test.ts` for layer assumptions.

**Phase 2 — plumb what already exists (small).**
Add `liveDraw, postDrawOp` to the destructure at `App.tsx:3737-3749`. Feed `postDrawOp` from `AnnotationOverlay.tsx:314`'s `onUp` (and, batched, from `:278-304`'s `onMove`). Render `liveDraw` as the remote layers from Phase 1, grouped by author. Key on member id per §5. Drop a layer when its `add` op arrives — the committed annotation takes over via the existing proximity path — or after a ~5s idle TTL, the same shape as the ghost-cursor prune.

**Phase 3 — flatten and post.**
`flattenDrawState` in `draw-ops.ts` with tests in `draw-ops.test.ts`. `ReviewPanel.tsx:880-897`: when a session is live and `liveDraw` is non-empty, post `flattenDrawState(liveDraw)` instead of `draft`. Reset `liveDraw` to `EMPTY_DRAW_STATE` (`draw-ops.ts:52`) on post.

**Phase 4 — the safety work.**
`MAX_ANNOTATION_BYTES` in `review.ts` enforced at `AnnotationOverlay.tsx:311-314`. Sender-side pacing in `postDrawOp` (`use-co-review.ts:394-397`) plus a per-sender floor next to the Reaction relay (`session.rs:1010`-ish). Route the swallowed oversize error at `use-co-review.ts:796` and `:850` to `appendLog`/`pushNotification` — the room deserves to know a guest is looking at an empty review.

**Performance note that spans Phases 1-2.** `redraw()` clears and repaints every stroke through `getStroke()` and a fresh `Path2D` on every pointermove (`AnnotationOverlay.tsx:129-178`, clear at `:135`, called from `:270` and `:304`). That is already O(total points) per input event locally. Sharing one canvas with remote authors multiplies it by the number of concurrent drawers at *their* send rate. One canvas per remote author is why the layer stack is Phase 1 and not an afterthought.

## 9. Disagreements between the passes

| Claim | Verdict |
|---|---|
| Pass 1: "`src/lib/draw-tools.ts` does not exist; all drawing lives in `AnnotationOverlay.tsx`" | **Wrong.** `draw-tools.ts` (122 lines) and `draw-ops.ts` (135 lines) both exist with test files. Pass 1 ran against a different checkout, whose `src/lib` has neither. **Believe passes 2 and 4.** Every pass-1 line number in `review.ts`, `ReviewPanel.tsx`, `use-co-review.ts` and `Monitor.tsx` is off by tens to hundreds of lines. |
| Pass 1: "the anchor is read at submit — a live bug; fix it first" | **Already fixed.** `anchorSec` latches on the first keystroke and on entering draw mode (`ReviewPanel.tsx:263-276`), submit uses `anchorSec ?? playheadAt()` (`ReviewPanel.tsx:889`), and App pauses playback when the pen or label tool turns on (`App.tsx:5045-5054`, `App.tsx:5064-5067`). The rationale comment at `ReviewPanel.tsx:252-262` describes exactly the bug pass 1 reported. **Believe the tree.** Drop that recommendation. |
| Pass 1: "add a new Rust `SessionMsg::StrokeLive` variant modelled on `Reaction`" vs pass 2: "the wire format already ships on `reviewOp` with zero Rust changes" | **Believe pass 2.** `draw-ops.ts:106-121` + `use-co-review.ts:396` are live code, and the envelope was chosen precisely so old peers ignore it rather than log-flood. Pass 1's design is sound in the abstract and worse here. |
| Pass 1: "~41 B/point, no coalescing" vs pass 2: "~44 B/point, coalescing inflates the count" | **Believe pass 2.** `AnnotationOverlay.tsx:290-301` expands `getCoalescedEvents()` deliberately (rationale at `:278-284`), so a slow, careful tracing gesture — a reviewer circling a detail — is the worst case, not the best. |
| Both passes: "no `DrawState → AnnotationStrokes` flatten exists" | **Confirmed.** No such function anywhere. |
| Pass 1: "`ProximityAnnotation` picks a single winner; two drawings can never both appear" | **Confirmed at HEAD** (`Monitor.tsx:197-200`). This is the one pass-1 finding that is both correct and load-bearing, and it is the reason Phase 1 leads. |

## 10. Decisions only you can make

1. **Is live drawing a scratch surface or a shared artifact?** Everything above assumes scratch: it dies with the session and one person's post turns it into one ordinary comment. If a session's drawings must survive independently on each guest's machine, the answer is the reviewDoc snapshot that already crosses the wire — not a second copy, and not a whiteboard.
2. **Whose name is on a jointly-drawn comment?** One person presses post. Today `author` is a single string (`review.ts:79`, stamped at `review.ts:1075`). `drawAuthors()` exists (`draw-ops.ts:92-98`) and is unused. Options: sole poster; poster with "drawn with X and Y" in the body; or a new `contributors` field — which is a schema change and, per §7, the version stamp does not currently protect one.
3. **Can you erase a peer's stroke live?** `strokeErase` (`draw-ops.ts:74-79`) is implemented and addresses any id, including someone else's. Undo is already scoped to your own (`lastStrokeBy`, `draw-ops.ts:101-104`). Erase is not. Symmetric erase is friendlier in a room of four and is the first step toward the whiteboard.
4. **Does live drawing run on a relayed session?** My recommendation is no, on the same reasoning that caps relayed media. This is a product call about who is in the room and where they are.
5. **How many concurrent drawers do you design for?** Two is a conversation. Five is a canvas performance problem (`AnnotationOverlay.tsx:129-178`) and a legibility problem — five tinted layers over one frame at 0.6s proximity is not readable, whatever the transport can carry.
6. **Should the annotation cap refuse or degrade?** A hard `MAX_ANNOTATION_BYTES` refuses a stroke mid-gesture. A decimating cap silently simplifies it. Both are honest; only one is visible.
