# Sauce Bunny + Premiere companion: internal test

Requires Apple Silicon, macOS 14+, Premiere Pro 2026 version 26.3.2 or newer,
and Creative Cloud Desktop for the `.ccx` installer. This is a beta
local proof, not a public release or validated automatic marker workflow.

## Install

1. Quit your currently running Sauce Bunny after saving work. Open the test
   DMG and copy Sauce Bunny into Applications. This does not erase reviews,
   preferences or cached media. Keep your previous installer for rollback.
2. Open Sauce Bunny. In Settings → About, check the build number matches the
   supplied DMG filename.
3. In Settings → Integrations, click **Install Premiere companion…**. Approve
   the installation in Creative Cloud. You can instead open the separate
   `SauceBunnyPremiere.ccx` file. If Adobe rejects the package, retain the error
   message; do not disable host security settings to force it through.
4. Open **Sauce Bunny** from Premiere's UXP Plugins menu.
5. In the updated Sauce Bunny Settings → Integrations, choose **Pair companion…**,
   then **Copy pairing code**. Paste once into **Pairing code** in the Premiere
   panel, then choose **Connect**. If you still see two separate fields in
   Settings, update Sauce Bunny as well as the companion. The private code
   expires after five minutes; never share it with reviewers.
6. Activate the intended Premiere sequence and choose **Bind current sequence**.
   Marker sync is separate from NDI picture sharing and stays opt-in.

The companion uses the same Sauce Bunny palette and control recipes. Native
UXP may use the host font in text fields or when Nunito Sans is unavailable.

## What this build can test

- Installing and opening the companion, narrow panel layout and keyboard focus.
- Local pairing/disconnect/re-pair and exact project/sequence binding.
- The existing NDI picture flow and the opt-in diagnostic timing probe.
- Existing playback, reviews, transcription and session UI regressions.

## Important limits

- **Live-room receiving is wired, with native acceptance in progress.** Share
  the explicitly bound live input, then select Send this note to Premiere.
  Only selected project/sequence names and IDs are shared; paths and pairing
  codes stay private. Ordinary general comments do not become markers.
- **Automatic frame placement is disabled.** NDI frame timing is not verified
  Premiere sequence timecode. Pending marker records, when present, require
  the editor to capture a parked position and confirm placement.
- Real Premiere plugin installation and marker transactions still require
  testing. Use a disposable project for the first marker test. An inserted
  marker does not save the project; save normally in Premiere. Undo stays
  under Premiere's control.
- This DMG is for internal testing. Its release notes state whether it is
  notarized. No public upload or deployment is performed by the build process.

NDI Tools supplies the Premiere output plugin; the Sauce Bunny companion does
not replace it. Reviewers do not need the companion or NDI SDK. Consult the
in-app Premiere setup section for the official NDI Tools installer link.
