# Avid waveform cache (`.awf`) — research

**Status (2026-09-28):** the file format is decoded from five real files and
parses end to end. The one thing still unknown is **which media ID Avid keys
an entry on**, and one matched sample settles it (see "Settling the key").
Nothing here is implemented.

**Why it matters:** AAF Audio builds a track's waveform overview by decoding
every file its mic uses ([linked_audio.rs](../src-tauri/src/commands/aaf/linked_audio.rs)).
On a 99-mic, 3h39m AAF over NEXIS the original per-minute build measured
**223 ffmpeg launches and ~115 s per track, one track at a time, about 3
hours for the sequence**, at ~515 ms a launch whatever the content. Builds
now stream one ffmpeg per clip, two tracks at a time (Phase 6), but they
still read every byte of every clip over the network. Avid has usually drawn
these waveforms already, and reading its cache reads almost nothing.

There is no public documentation. Avid's knowledge base says only that the
`WaveformCache` folder lives in the project, arrived with Media Composer 7,
and may be deleted to force a rebuild.

## Where it lives

| Project kind | Path |
|---|---|
| Local | `<Project>/WaveformCache/` |
| Shared (NEXIS) | `<Project>/AvidSharedData/<seat>/WaveformCache/`, one folder per workstation seat |

Each folder holds four files, one per zoom level, named by **samples per
peak**: `WaveformCache_256x.awf`, `_16384x`, `_65536x`, `_262144x`.

## Layout (little-endian)

### File header, 33 bytes

An empty cache file is exactly this header and nothing else.

| Offset | Type | Value |
|---|---|---|
| 0 | u16 | `19`, the magic's length |
| 2 | 19 bytes | `WaveformCacheFileID` |
| 21 | u32 | `2100` in every file seen (format version) |
| 25 | u32 | `2048` / `1024` / `512` / `512` by level. Meaning unconfirmed: it is not the chunk size seen at 16384x |
| 29 | u32 | Samples per peak: `256` / `16384` / `65536` / `262144`, matching the filename |

### Records, repeated to end of file

An 85-byte header, then the peak data.

| Offset | Type | Value |
|---|---|---|
| +0 | u32 | `1000` (constant in all 71 records seen) |
| +4 | u32 | `100` (constant) |
| +8 | 32 bytes | SMPTE UMID of the media: **the lookup key** |
| +40 | u16 | `2` (constant; likely "sound") |
| +42 | u16 | Channel / track number (`1`, `2`) |
| +44 | u32 | Sample rate (`48000`) |
| +48 | u32 | `1` |
| +52 | u32 | `1` |
| +56 | 16 bytes | Opaque ID, constant per media (a hash? unknown) |
| +72 | u32 | First peak index, from the start of the media |
| +76 | u32 | Peak count |
| +80 | u8 | `0` (flag) |
| +81 | u32 | Data bytes, always `count × 4` |
| +85 | … | `count` pairs of `(i16 min, i16 max)` |

**Verified:** every file parses exactly to its end. Each (UMID, channel) is a
run of contiguous chunks starting at peak 0, and peak count × samples per peak
gives the same media length at both populated levels (236.6 s at 256x and at
16384x). Chunks hold 2,048 peaks at 256x and 64 at 16384x.

## Why it fits what we already draw

Our overview is **256-sample min/max buckets** of the top 16 bits of the
24-bit PCM, written into a pyramid (`peaks-v2`,
[peaks.rs](../src-tauri/src/commands/aaf/peaks.rs)). That is the same
resolution and value range as Avid's finest level, so a 256x hit could fill
our pyramid directly, with no resampling. Both should be raw media without
clip gain; confirm this against one clip that has clip gain applied.

A clip that starts off a 256-sample boundary lands up to 255 samples (5.3 ms)
out. That's invisible in a drawing and harmless to speech analysis
([speech.rs](../src-tauri/src/speech.rs) works in the same buckets).

## Unknowns

1. **Master clip or media file?** The local sample holds ONE UMID with
   channels 1 and 2. Avid audio MXF is one mono file per channel, each with
   its own file ID, so a single ID carrying two channels points at the master
   clip (or at an AMA-linked stereo file). That's suggestive, not proof.
   The AAF model already has both IDs (each clip's `master_id` and its
   source's `mob_id`), so either answer works once it's known.
2. **Match on the material number, not all 32 bytes.** Byte 7 of the UMID
   label (the version byte) is `00` in one sample and `01` in another, and
   our AAF IDs use `05`. Match on bytes 16–31 plus the channel.
3. **The +25 header field and the 16-byte ID** aren't needed for reading.
   If the ID turns out to be derivable, it would let us reject stale entries.
4. **Coverage.** Avid writes only what an editor has displayed at that zoom
   level. A seat's cache may cover a fraction of a sequence, and several
   seats may each cover a different part. Real cache sizes on NEXIS are
   unmeasured; the one NEXIS sample was 198 bytes.
5. **Media Composer writes these while it runs.** A reader must tolerate a
   truncated last record and must never lock or write the files.

## Settling the key

This needs one matched pair: cache entries alongside the media they describe.

- **On the NEXIS seat:** open the target sequence in Media Composer with
  waveforms on, let them draw, then copy that seat's four `.awf` files. Their
  UMIDs are compared against the AAF's `master_id`s and source `mob_id`s.
- **Or locally:** in a local test project, show waveforms on clips whose MXFs
  are on disk, then compare the new UMIDs with each MXF's file package UMID
  (which [mxf_header.rs](../src-tauri/src/commands/aaf/mxf_header.rs)
  already reads) and with the bin's master clip.

## Proposed integration

- **Read-only, and only when asked.** The user points at the Avid project
  folder once, because the AAF doesn't record where the project lives. The
  choice is remembered with the document's existing path mappings. Every
  seat's `WaveformCache` under `AvidSharedData` is read; nothing is written.
- **Index once.** Walk record headers, seeking past the data, and key the
  index by file size and mtime so it's rebuilt only when Avid changes the
  file. Store the index in the app cache.
- **Per clip:** the peak index is `source_start_sample / 256`; take the peaks
  covering the clip's source range and place them at its timeline position.
- **Gaps stay honest.** A clip with no coverage stays undrawn, or is built
  from media for just that range if the user asks. The Pipeline log says
  where each overview came from (Avid's cache, and which seat, or built).
- **Fixtures are synthetic.** Tests generate `.awf` files; real cache files
  from productions stay out of the repository.
