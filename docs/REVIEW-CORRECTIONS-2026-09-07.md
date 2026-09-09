# Review / Premiere correction batch

Scope: the September 7 evening screenshot report. No DMG, timeline editing,
automatic room publication, approval-workflow change, or removal of user media.

## Implemented

- Hide drawing no longer immediately repaints through proximity. Automatic pin
  release stays distinct from explicit hiding; saved notes/drafts remain intact.
  Preparation-banner background no longer intercepts drawing-control clicks.
- Reactions and composer emoji escape scrolling/stacking containers. Menus remain
  viewport-contained and keyboard accessible. Composer tools wrap; Post stays visible
  and uses the approved green action fill when enabled.
- Compact People preserves the 72px rail, 48px picture and external presenter pin.
  Camera/mic icons and controls hide there; participant details and the room toolbar
  retain state/actions. Expanded and theater controls remain available.
- Transcript right-click supports non-destructive Remove from library and confirmed
  Move to Trash. The native command accepts only regular absolute SRT/VTT paths,
  rejects folders/symlinks/media, and uses Finder Trash. Source videos and sidecars
  stay untouched. Partial failures keep failed entries available for retry.
- Expected speakers uses the production keyboard radio menu with deep-violet
  selection, demonstrated in the isolated catalog.
- Review links no longer appear in onboarding. Active-host access management,
  link-only policy and pending one-time secrets are preserved, not reset.
- Empty Preview is a restrained flat tonal surface with no gradient banding.
- Live-note labels use the normal application type scale. Share with room is
  visible beside private room preview and green only when actionable, with a
  three-cycle pulse disabled by reduced motion. Sharing remains an explicit act.
- Premiere monitor uses incoming dimensions rather than forced 16:9. The existing
  single Clip volume component and Settings-based diagnostics remain in use.
- The transport explicitly reports unavailable timeline timecode. It never displays
  an NDI/system/encoder timestamp as a Premiere sequence position.

## Verification and remaining gates

Frontend tests, production-component browser tests, catalog checks and a native
transcript-only Trash integration test cover this batch. Test results are recorded
in DESIGN-SYSTEM-AUDIT.md. The one generated SRT used for native verification is
recoverable in Finder Trash; no user transcript or footage was removed.

Still open, not claimed fixed:

1. Run the updated application against the user's Premiere sender and verify actual
   speaker output, scrubbing smoothness, parked-frame recovery, and host/guest audio.
   The user approved restarting Sauce Bunny on September 8. The refreshed local
   debug app bundle was launched and its executable matched the tested binary.
   Live inspection confirmed private NDI picture at 1280 × 720, the restored four
   drawer tabs, Beta label, Settings → Integrations setup shortcut, and the single
   volume control unmuted at 100%. No room was started or source published.
   Initial parked diagnostics showed one received frame and increasing input age.
   A subsequent playback-only test advanced Premiere Sequence 03 from 00:00:41:15
   to 00:01:02:00: Sauce Bunny received changed pictures and cleared its parked
   status. Playback was stopped and the original 00:00:41:15 position restored;
   no sequence edits or Premiere settings changes were made. Audible output,
   perceived smoothness and guest audio remain unverified. Still screenshots and
   synthetic stereo decoding do not prove those requirements.
2. Premiere timeline timecode transfer and displayed-frame mapping are not available
   in the current companion protocol. Editor-confirmed marker placement remains the
   safe path. A verified frame anchor, not a sampled current playhead, is required
   before automatic note placement can be enabled. Room-marker consent remains gated.
3. The native encoder keeps one raster for a capture. Changes of sequence aspect
   during that capture can still be letterboxed by the encoder. Verify initial
   portrait/landscape fit separately from seamless mid-capture format changes.

Do not close these real-media gates on CSS screenshots or mocked telemetry alone.
