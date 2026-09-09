# Premiere marker bridge — implementation and remaining gates

Status: **experimental local proof, not end-to-end room delivery or automatic placement**.
The initial proof did not change Premiere or build a DMG. A subsequent user-
requested packaging pass includes the CCX in the internal-test DMG and aligns
the panel with the [companion design contract](../premiere-companion/DESIGN.md).
Premiere projects/configuration remain untouched. Existing checkout changes
were preserved.

## Implemented

- A separate Bolt UXP / React / TypeScript companion targeting Premiere Pro
  2026, 26.3.2. Build instructions and host acceptance details are in
  [the companion README](../premiere-companion/README.md).
- A native loopback WebSocket bridge, separate from the media proxy. Pairing
  is explicit, time-limited, authenticated, single-client, and revocable.
  Reading status does not start a listener or NDI capture. The secret stays
  out of URLs, persistent frontend preferences and logs.
- Generated Rust/TypeScript binding, note, marker-state and pairing types.
  Project paths never cross the bridge; the companion retains them privately
  to detect Save As / moved-project ambiguity.
- A durable native marker ledger with immutable review/version/comment and
  project/sequence binding identity. Dispatch is saved before Adobe receives
  an insertion request; native marker GUID acknowledgements are saved before
  delivery is reported. Retried requests cannot redirect the original note.
- The companion creates a sequence Comment marker only after **Capture parked
  position → Add marker here**. It preserves precise tick strings, uses an
  undoable Adobe transaction, does not move the playhead, and does not save
  the Premiere project. Recorded removals and Undo are not silently reversed.
- A last-displayed-frame sample per NDI decoder, collected from decoded-frame
  callbacks only on the visible active surface. New note typing, drawing and
  dictation latch a copy. Hidden replacement decoders cannot replace it.
  Source, receiver stream and decoder-frame identities remain distinct.
- Additive optional `ReviewComment.premiere` metadata. General notes, manual
  timecodes, file notes and replies do not implicitly become markers. A
  sequence's current CTI is never substituted for a reviewer's earlier frame.
- The review-to-native handoff observes successful **document and index**
  writes, not an optimistic UI mutation. A failed handoff keeps the saved
  review as retry material. Already recorded notes are not re-sent as edits.
- Settings → Integrations contains pairing, a local CCX install action,
  explicit input association and diagnostic capture. Preview gains only a
  passive marker-status line and a **Marker setup…** action in its existing
  Premiere inspector. Existing monitor, audio and transport stay mounted.
- Bounded opt-in [NDI timing diagnostics](NDI-TIMING-PROBE.md). Raw NDI fields
  and metadata remain local observations, not verified sequence positions.
- Native ledger revisions prevent unchanged heartbeats from fetching the
  entire queue or rescanning all review documents. Guest/unknown room roles
  cannot enqueue local editor work before native session state is known.

## Permission gate: room metadata

The room-context wiring was blocked by the implementation safety check because
it would share project/sequence **names and identifiers** with other participants.
User confirmation was requested; no permission response had arrived when this
document was written. Do not infer approval from these implementation notes.

`src/lib/premiere-permissions.ts` therefore keeps room markers disabled. No
Premiere context is broadcast. Review snapshots omit local Premiere anchors;
new or retried marker-intent room submissions are held with an explicit error,
not silently rewritten or discarded. Local review documents retain their data.
The composer does not offer new room-marker intent while this gate is closed.

After approval, the remaining room integration is:

1. Send a versioned, host-stamped context for the published NDI review/source,
   with the exact selected binding. Never send paths or pairing secrets.
2. Include it in targeted late-join snapshots; reset it with native room/source
   and presenter generations. Accept it only from the actual host, in the
   current session/source. Do not make heartbeats transport/marker commands.
3. Let each reviewer's composer capture its own displayed sample at note start.
   Detached panels need an explicit main-monitor snapshot handoff; no borrowed
   hidden-file clock or assumed shared JavaScript module state.
4. Relay durable marker receipts so guests can distinguish waiting from added,
   without treating a Premiere transaction as a saved project.
5. Test two real desktops and the exact room/source switching and retry paths
   before calling live-session marker delivery complete.

The current private-preview note restrictions remain unchanged. This milestone
does not invent a separate solo live-review document or unblock room notes
while a different private picture is being inspected.

## Build and install the local companion

```sh
npm --prefix premiere-companion ci
npm --prefix premiere-companion run check
npm --prefix premiere-companion run ccx
```

The internal artifact is `premiere-companion/dist/SauceBunnyPremiere.ccx`.
The desktop DMG builder now verifies and includes it at
`Contents/Resources/companion/SauceBunnyPremiere.ccx`. **Install Premiere
companion…** opens this fixed resource with macOS; the user/Creative Cloud
handles installation. Developer builds can fall back to the fixed local
artifact. No fabricated public download URL or silent installation is used.

## Verification and limits

- Companion: 26 isolated tests and a packaged-HTML browser smoke at 280/340px.
- Native bridge: 29 focused tests, including authentication/expiry, queue
  restart, duplicate identity, lost acknowledgements, Undo tombstones,
  pagination and unchanged-heartbeat behavior; strict Clippy and licenses pass.
- NDI: 34 focused tests in both SDK-free and SDK-enabled builds. Synthetic
  30/60fps tests preserve fixed 1080p30 H.264/stereo AAC and recover from a
  four-second interruption. These are generated senders, not Premiere.
- Frontend tests cover note-start latching (including dictation), sequence
  switching, immutable ticks, retired-decoder teardown, receiver replacement,
  durable handoff, unknown/guest roles, retry and stale refresh responses.
- Full application verification: TypeScript and strict ESLint passed; 3,461
  frontend tests passed (2 skipped); the SDK-enabled Rust suite passed 465
  tests (20 opt-in tests ignored). Browser checks passed the 2 new companion
  setup cases at 1100×700 and 1680×1020, plus 10 existing People/NDI cases;
  3 opt-in real-media browser cases were not run.
- Final targeted rerun: 25 Premiere/catalog-isolation tests passed, including
  the added local-anchor/wire-omission privacy regression. TypeScript and
  strict ESLint passed again after native binding generation. A temporary
  production frontend build passed isolation checks for all 65 artifacts.

Still required: actual packaged UXP localhost acceptance; native transactions
in a disposable Premiere project; dock/hide/workspace/sleep/restart behavior;
Source Monitor takeover; precise overlay-vs-received-frame comparisons at all
requested rates; and real guest/display mapping. **Automatic placement is off
in both native and plugin code, even if a supplied anchor says verified.**

Recovery is deliberately conservative. A lost private UXP binding ledger or
changed project path cannot be repaired by matching a sequence name. Ambiguous
pre-transaction crashes remain held rather than risking Undo resurrection.
Review replay inherits the existing hydration cap (1,000 docs / 64 MB); reviews
outside that boot working set require explicit loading/recovery. Nothing is
deleted to enforce the native queue or private-ledger limits.

Marker edits, replies, deletion sync, structural-edit tracking, automatic NDI
sequence-time mapping, remote transport and approval workflows are not added.
