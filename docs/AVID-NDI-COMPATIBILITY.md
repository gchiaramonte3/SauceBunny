# Avid NDI compatibility proof

2026-09-11 · implementation candidate, **not an Avid compatibility certification**.

## Scope

One shared NDI receiver, decoder, volume control and commenting sidebar.
The existing gear dialog now includes passive Avid setup help. NDI entry points
and recovery messages no longer assume every sender is Premiere. The Premiere
companion and installation controls remain separate and explicitly labeled.

The receiver still converts to a fixed **30-fps H.264 preview**, up to
1920×1080, with 48-kHz stereo AAC. The dialog distinguishes input FPS from
measured preview FPS. This change does not claim native frame-rate preservation,
frame-accurate sequence timing or measured end-to-end latency. Interlaced and
anamorphic sources require separate visual verification.

## Installed environment and open gate

- Media Composer application version: `24.12.0.58720`.
- OpenIO_NDI exists under `/Library/Application Support/Avid/AVX2_Plug-ins/`;
  its executable contains arm64 and x86_64 architectures. Presence does not
  establish licensing, output enablement, or a working signal.
- The shared receiver loads NDI SDK runtime `6.3.2.0` and discovers the installed
  Premiere transmitter. No Avid source was discovered.
- Avid stops at **“Login required for Media Composer | First. Please quit and
  login to Avid Link and relaunch Media Composer | First.”** No license, trial,
  account, project or timeline was changed.

Actual Avid picture, continuous audio, cadence, reconnects and raw timing are
therefore **pending**, not passed. Avid sign-in/licensing and a disposable test
sequence are needed. Synthetic NDI tests cannot substitute for this gate.

## Setup and privacy

Use Media Composer's installer NewTek NDI option if absent; do not install
Premiere's Mercury Transmit plugin for Avid. In Avid, right-click HW/SW, select
NewTek NDI/OpenIO_NDI and enable output. Play or park inside a sequence. Use
Ethernet where possible. In Sauce Bunny, open the gear beside volume, refresh,
choose the exact source and explicitly preview it. Audio uses the existing
speaker control; room sharing is a separate action.

**Not shared is a room-publication status.** It does not stop or privatize
Avid's LAN broadcast. Other NDI receivers may view or record it. Use test media
suitable for that network. Guest settings still permit only local playback
recovery, not discovery, capture or publication.

## Repeatable receive-only diagnostic

`scripts/probe-ndi-source.sh` compiles the production `ndi_bridge.mm` with a
diagnostic consumer. It never advertises a sender, changes an editor or publishes
a room. Requires the developer NDI SDK and Apple compiler, not another end-user
installation dependency.

```sh
SAUCE_NDI_SDK_DIR='/Library/NDI SDK for Apple' bash scripts/probe-ndi-source.sh list
SAUCE_NDI_SDK_DIR='/Library/NDI SDK for Apple' bash scripts/probe-ndi-source.sh capture 'EXACT DISCOVERED TEST SOURCE' 30
```

The new private temporary directory contains `program.mp4` and
`observations.json`. Capture is limited to 1–60 seconds and 64 MiB; the report
retains at most 600 timing observations and 120 status samples. A missing chosen
source cannot fall through to another source. Existing output files are not
overwritten. Ctrl-C stops the probe without stopping the sender.

Clocks remain decimal strings and `timingVerified` is always false. Raw metadata
may contain private sender text. Keep diagnostics local and redact before
sharing; do not commit captured editorial media to GitHub.

## Actual Avid acceptance matrix (pending activation)

### Completed non-Avid evidence

- Full baseline verification passed before edits. Final full verification also
  passed: 3,696 frontend tests, 504 Rust tests and 365 browser tests, plus the
  TypeScript, lint, Clippy, Swift and license gates. Existing skips remain.
- Catalog verification passed all 33 browser cases and its isolation and
  production-build exclusion checks. Final Avid alignment/scroll checks passed
  separately at normal and 125% text after the visual adjustment.
- Existing native 24/1 synthetic smoke passed: stall/recovery, concurrent
  discovery/receiver teardown, startup placeholder, raster changes, bounded raw
  timing and contiguous H.264/stereo AAC timestamps.
- Existing 30000/1001 continuous synthetic smoke passed, followed by three
  sustained browser-decoder jitter runs. No latency correction seeks occurred;
  longest measured quiet/frozen interval in the final run was approximately
  65 ms. This is synthetic Chromium evidence, not audible Avid/WKWebView proof.
- Avid/unknown/Premiere source selection uses the same receiver callback and
  does not start capture merely by opening setup or choosing a source. Browser
  dialog geometry, preserved sidebar, focus return and spacing pass at the
  desktop minimum, normal/125% text, and wider layouts.
- The new receive-only probe passed a real synthetic-source capture with its
  600-observation retention bound. Negative checks passed for an absent exact
  source (no fallback capture of Premiere), invalid duration, missing runtime
  and existing-output protection.

Use a disposable sequence with moving frame counter, independent L/R tones and
known start TC. Record Avid version, project raster/rate, runtime and app revision.

1. Park, play for at least 60 seconds, pause, scrub and replay. Check picture,
   retained frame, raster/aspect, L/R routing and audible continuity in packaged
   WKWebView, not only an encoded file. Check 23.976/24, 25 and 29.97/30 as available.
   Distinguish expected 30-fps conversion from unexpected stalls.
2. Refresh discovery, close/reopen the gear and switch sidebar tabs while playing.
   Verify decoder, notes/drafts and audio remain intact.
3. Toggle Avid HW/SW output at least five times; disconnect/reconnect the source
   and retry the local decoder separately. Compare with an independent NDI receiver.
4. Collect bounded timing samples while parked, playing, scrubbing, changing start
   TC and switching test sequences. Compare visible Avid TC against raw clocks and
   metadata. UTC/repeated clocks are not timeline position. Verify identity and
   timebase before enabling any automatic timecode or marker feature.
5. Verify private preview never appears in a Sauce Bunny room, then explicit
   share/stop with consenting participants. LAN visibility is separate.

Avid **2026.8** fixes MCCET-6170 (NDI stopping after repeated HW/SW toggles).
That does not prove every failure on 24.12 has this cause. Compare sender versions
and another receiver before changing Sauce Bunny. Do not upgrade the editor or
disturb working projects as a diagnostic shortcut.

## Separate capabilities

Automatic Avid sequence timecode and live marker delivery are **not implemented**.
General/manual-timecode notes and existing Avid marker-file export remain available.
The Premiere companion uses explicit bindings, never an inferred NDI sender name.

A future Avid companion needs separately verified Media Composer Extensions SDK
access, project/sequence identity, timebase mapping and consent. Do not adapt
Premiere tick values or send Avid notes into an unrelated Premiere sequence. NDI
picture/audio alone provides no verified editorial position or marker API.

## Primary references

- [Avid NDI installation](https://kb.avid.com/pkb/articles/en_US/Knowledge/How-to-install-NewTek-NDI-and-SRT-Plugins-in-Media-Composer)
- [Avid setup and LAN visibility](https://resources.avid.com/SupportFiles/attach/Media_Composer_Editing_Guide_2021.x.pdf)
- [Avid 2026.8 fixes](https://resources.avid.com/SupportFiles/attach/Media_Composer/2026/2026.8/Media_Composer_v2026.8_ReadMe.pdf)
- [NDI frame types and clock semantics](https://docs.ndi.video/all/developing-with-ndi/sdk/frame-types)
- [Media Composer Extensions](https://connect.avid.com/media_composer_extensions.html)
