# Premiere in Preview

The 2026-09-07 correction keeps the existing monitor as the picture surface. Review setup is a compact rail beside it, not a replacement workspace or a second video dialog.

## User flow

- Review shows the existing Preview monitor plus Host/Join setup. Host and Join retain their separate entered values. Camera/microphone setup is explicit.
- Connect Premiere in the monitor or transport opens inline source controls. The existing Share → Premiere via NDI menu remains available in a room.
- Preview connects privately. Starting a session does not publish it. Share Premiere with room is explicit.
- The existing speaker popover controls the locally visible program. Private and published monitoring have separate mute/volume state; conversation tracks are not replaced.
- Done during a room restores the room picture and notes. Done before hosting retains the private picture beside setup. Clip/Review navigation keeps the decoders mounted.
- Manage access replaces the expanded invitation section. Grant-only admission settings and existing invitations are unchanged. Past sessions opens Library history.

## Boundaries

`NdiProgramCoordinator` remains the source/publication authority. Local inspection never becomes a room source. `ReviewProgramSurfaces` preserves decoded surfaces by identity across publication, private inspection, and replacement. A stopped published picture and newer private frames of the same capture retain separate surfaces.

`ReviewSession` has a separate local inspection block. It disables hidden-file seeks, ranges, annotations and posting without clearing room documents, drafts or the underlying playback clock. Pending/new sources cannot claim readiness until their actual surface has decoded.

Connection diagnostics and installation/download instructions live in collapsed disclosures. All picture remains in `Monitor`; `NdiInputPanel` contains no video or volume slider. Existing room controls wrap when the monitor column is narrow, keeping the volume and theater controls reachable without changing panel widths.

## Verification scope

Automated coverage includes private/public decoder continuity, real native H.264/AAC capture decoding in Chromium, file playback continuity, restored marks/captions, installation entry, safe incoming invitations, unchanged access rules, session naming, keyboard focus, accessibility and minimum-window control bounds.

Native smoke testing uses the existing Premiere source privately. This change does not establish end-to-end latency, frame-accurate Premiere timecode, or remote-guest soak acceptance. It does not create a release DMG or claim pilot readiness.
