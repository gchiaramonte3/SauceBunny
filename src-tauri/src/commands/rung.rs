//! The Tier B quality ladder, host side.
//!
//! The guest picks a rung (it is the only place starvation can be observed —
//! see `src/lib/stream-rung.ts`) and the host encodes to it. This module is the
//! host's half: the same ladder table, and the ffmpeg arguments that realise a
//! rung.
//!
//! WHY THIS EXISTS AT ALL. Until now `serve_media_substream` served `-c copy`,
//! so a guest pulled the source bitrate verbatim. A 60 Mbit/s delivery master
//! over a home uplink stalls and stays stalled, with no mechanism to recover —
//! the plan called this out as R9/3e and it has been the live behaviour.
//!
//! Two things fall out of encoding that are worth naming, because neither is
//! "adaptive quality" and both are bugs the ladder fixes:
//!
//!   * **`-c copy` cannot serve a ProRes master at all.** ffmpeg refuses with
//!     "Could not find tag for codec prores in stream #0" — and it does so
//!     AFTER the host has already written `{"ok":true}` to the wire, so the
//!     guest sees a successful header followed by zero bytes and waits out its
//!     20s watchdog before failing into a download that cannot happen. Every
//!     rung transcodes, so a rung makes Tier B work for non-H.264 sources for
//!     the first time.
//!   * **A re-encode changes what `epoch` means.** Input `-ss` does an
//!     *accurate* seek on a transcode and discards frames before the seek
//!     point, whereas on `-c copy` it hands back the keyframe at or before it.
//!     `probe_stream_epoch` answers the copy question. Measured on a 1080p30
//!     file with a 2s GOP at `start=11.0`: the probe says 10.0, `-c copy`
//!     really does start at 10.0, and the encode starts at 11.0. The guest
//!     assigns `epoch` to `SourceBuffer.timestampOffset`, so using the probe's
//!     answer on an encoded rung shifts the entire buffer one GOP early — up
//!     to ten seconds on the very delivery masters R9 warns about, silently,
//!     because a constant offset never trips a drift check. See
//!     `epoch_for_rung`.
//!
//! Everything here is pure and unit-tested. The arguments were verified
//! against the bundled ffmpeg 8.1: the 720 rung encodes 19s of 1080p in 1.44s
//! (~13x realtime) and lands at 1.80 Mbps, matching the design's measured
//! figure.

use super::media::PlaybackColorClass;

/// One rung of the ladder.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Rung {
    pub height: u32,
    pub video_kbps: u32,
    pub audio_kbps: u32,
}

/// The ladder, widest first.
///
/// MUST stay identical to `RUNGS` in `src/lib/stream-rung.ts`. The guest sends
/// a height and the host looks it up here; if the two tables disagree the
/// guest's bandwidth model is describing a stream nobody is sending. There is
/// a test asserting the exact numbers on each side.
///
/// Audio holds at 96k on the bottom rung rather than dropping to 64k, because
/// in a review tool intelligibility outranks picture. Cut video first.
pub(crate) const RUNGS: [Rung; 4] = [
    Rung { height: 1080, video_kbps: 4500, audio_kbps: 128 },
    Rung { height: 720, video_kbps: 2500, audio_kbps: 128 },
    Rung { height: 540, video_kbps: 1200, audio_kbps: 96 },
    Rung { height: 360, video_kbps: 600, audio_kbps: 96 },
];

/// Look up a rung by height. `None` for anything not on the ladder, which the
/// caller must treat as "source passthrough" rather than as an error — the
/// wire is untyped and a peer on a different build may send anything.
pub(crate) fn rung_for(height: u32) -> Option<Rung> {
    RUNGS.iter().copied().find(|r| r.height == height)
}

/// The `-vf` chain for a rung, branching on the source's colour.
///
/// The three branches mirror `playback_video_quality_args` in media.rs rather
/// than inventing new ones: the 10-bit dither branch exists because undithered
/// swscale truncation reintroduced sky banding that had already been fixed
/// once, and the HDR branch exists because without it HDR renders washed-out
/// grey. Both are mandatory, not cosmetic.
///
/// HDR scales BEFORE tonemapping. That ordering is measured (0.76s vs 1.41s),
/// because the expensive zscale then runs at the rung's height instead of the
/// source's. Scaling in the PQ domain is technically less correct and
/// invisible at proxy bitrates.
pub(crate) fn rung_filter_chain(height: u32, class: PlaybackColorClass) -> String {
    let scale = format!("scale=-2:{height}");
    match class {
        PlaybackColorClass::Sdr8 => scale,
        PlaybackColorClass::Sdr10 => format!(
            "zscale=min=bt709:m=bt709:dither=error_diffusion,format=yuv420p,{scale}"
        ),
        PlaybackColorClass::Hdr => format!(
            "{scale},\
             zscale=tin=smpte2084:pin=bt2020:min=bt2020nc:t=linear:npl=100,\
             tonemap=hable:desat=0,\
             zscale=p=bt709:t=bt709:m=bt709:r=tv:dither=error_diffusion,\
             format=yuv420p"
        ),
    }
}

/// Every ffmpeg argument that follows `-i <input>` for a rung.
///
/// Split out from the spawn so it can be asserted without running anything.
/// `class` is the source's colour classification; `None` means the probe
/// failed, in which case we still encode (falling back to the SDR-8 chain)
/// rather than refuse — a failed probe must not take the session down.
pub(crate) fn rung_output_args(rung: Rung, class: Option<PlaybackColorClass>) -> Vec<String> {
    let class = class.unwrap_or(PlaybackColorClass::Sdr8);
    let vb = format!("{}k", rung.video_kbps);
    let bufsize = format!("{}k", rung.video_kbps * 2);
    let ab = format!("{}k", rung.audio_kbps);

    let mut a: Vec<String> = vec![
        // `0:a:0?` — the `?` makes audio optional. A silent source must still
        // stream; without it ffmpeg exits and the guest waits out a watchdog.
        "-map".into(), "0:v:0".into(),
        "-map".into(), "0:a:0?".into(),
        "-vf".into(), rung_filter_chain(rung.height, class),
        // Hardware encode. Same choice the local playback prep makes; libx264
        // cannot hold this many realtime streams on the host's machine while
        // the host is also using the app.
        "-c:v".into(), "h264_videotoolbox".into(),
        "-profile:v".into(), "high".into(),
        "-pix_fmt".into(), "yuv420p".into(),
        "-b:v".into(), vb.clone(),
        "-maxrate".into(), vb,
        "-bufsize".into(), bufsize,
        // VideoToolbox defaults to a quality target, which lets a complex
        // scene blow through the rung's budget — the one thing a rung exists
        // to prevent. macOS 13+; the app floor is 14.
        "-constant_bit_rate".into(), "1".into(),
        "-realtime".into(), "1".into(),
        "-prio_speed".into(), "1".into(),
        // 2s GOP at 30fps. Also what makes R9 moot on an encoded rung: seek
        // granularity stops being the source's keyframe interval (which we do
        // not control and which is 10s on some delivery masters) and becomes
        // ours.
        "-g".into(), "60".into(),
        // No B-frames: they add reorder delay for no benefit at these
        // bitrates, and this is a live stream someone is scrubbing.
        "-bf".into(), "0".into(),
        "-c:a".into(), "aac".into(),
        "-b:a".into(), ab,
        "-ac".into(), "2".into(),
    ];

    // Tag the output as bt709. Only meaningful after a tonemap, but harmless
    // otherwise and cheaper than branching twice.
    if class == PlaybackColorClass::Hdr {
        a.extend([
            "-colorspace".into(), "bt709".into(),
            "-color_primaries".into(), "bt709".into(),
            "-color_trc".into(), "bt709".into(),
        ]);
    }

    a.extend([
        // Same muxing contract as the `-c copy` path: absolute timestamps and
        // a 90kHz video timescale, so the guest's clock math is unchanged.
        "-copyts".into(),
        "-muxpreload".into(), "0".into(),
        "-muxdelay".into(), "0".into(),
        "-video_track_timescale".into(), "90000".into(),
        "-movflags".into(), "frag_keyframe+empty_moov+default_base_moof".into(),
        // Decouples fragment cadence from the GOP so the first bytes arrive in
        // ~0.34s instead of waiting a full 2s group.
        "-frag_duration".into(), "200000".into(),
        "-f".into(), "mp4".into(),
        "pipe:1".into(),
    ]);
    a
}

/// Ceiling applied while the host is doing something expensive of its own.
///
/// The host's Mac is not a server. Whisper and the diarizer saturate the same
/// CPU and Neural Engine a VideoToolbox encode wants, and the person running
/// them started that work FIRST and is sitting there watching it. A review
/// session arriving afterwards should not quietly halve the speed of a
/// transcription someone is waiting on.
///
/// 540 rather than the floor: still perfectly legible for reviewing a cut,
/// and roughly a fifth of the 1080 rung's pixel rate.
pub(crate) const BUSY_HOST_MAX_HEIGHT: u32 = 540;

/// Pure (unit-tested): lower a requested rung while the host is busy.
///
/// Deliberately one-directional — it can only ever make the encode CHEAPER.
/// A guest that asked for 360 keeps 360; a guest that asked for 1080 while the
/// host is transcribing gets 540 rather than a refusal, because a smaller
/// picture is a far better answer than a dead session.
///
/// Passthrough (`None`) is left alone: `-c copy` costs the host almost
/// nothing, so there is nothing to protect it from.
pub(crate) fn clamp_for_host_load(rung: Option<Rung>, host_busy: bool) -> Option<Rung> {
    let r = rung?;
    if !host_busy || r.height <= BUSY_HOST_MAX_HEIGHT {
        return Some(r);
    }
    rung_for(BUSY_HOST_MAX_HEIGHT).or(Some(r))
}

/// The `epoch` the guest should apply for a given rung, or `None` to fall back
/// to probing the source.
///
/// On an encoded rung the answer is just `start`, because input `-ss` seeks
/// accurately and the first output frame lands in `[start, start + 1 frame)`.
/// On passthrough it is unknowable without reading the file, so the caller
/// probes. Returning `Some` here also removes an ffprobe spawn from the seek
/// critical path, which is the hot path when someone is scrubbing.
pub(crate) fn epoch_for_rung(rung: Option<Rung>, start: f64) -> Option<f64> {
    rung.map(|_| start)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args_of(height: u32, class: PlaybackColorClass) -> Vec<String> {
        rung_output_args(rung_for(height).unwrap(), Some(class))
    }

    /// Value following `flag`, or None.
    fn val<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
        args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1)).map(|s| s.as_str())
    }

    #[test]
    fn the_ladder_matches_the_typescript_table_exactly() {
        // src/lib/stream-rung.ts RUNGS. If these drift, the guest's model
        // describes a stream nobody is sending. Written out longhand rather
        // than derived, so a change to either side has to be made twice on
        // purpose.
        assert_eq!(
            RUNGS,
            [
                Rung { height: 1080, video_kbps: 4500, audio_kbps: 128 },
                Rung { height: 720, video_kbps: 2500, audio_kbps: 128 },
                Rung { height: 540, video_kbps: 1200, audio_kbps: 96 },
                Rung { height: 360, video_kbps: 600, audio_kbps: 96 },
            ]
        );
    }

    #[test]
    fn the_ladder_descends() {
        for w in RUNGS.windows(2) {
            assert!(w[1].height < w[0].height, "heights must descend");
            assert!(w[1].video_kbps < w[0].video_kbps, "video bitrate must descend");
        }
    }

    #[test]
    fn audio_never_drops_below_96k() {
        // Deliberate: a reviewer who cannot make out a word has lost the
        // session; one looking at soft 360p has not.
        for r in RUNGS {
            assert!(r.audio_kbps >= 96, "{r:?} would sacrifice intelligibility");
        }
    }

    #[test]
    fn an_unknown_height_is_passthrough_not_a_panic() {
        // The wire is untyped; a peer on another build can send anything.
        assert!(rung_for(999).is_none());
        assert!(rung_for(0).is_none());
        assert!(rung_for(721).is_none());
        assert_eq!(rung_for(720).unwrap().video_kbps, 2500);
    }

    #[test]
    fn the_bitrate_is_actually_capped_not_merely_targeted() {
        // VideoToolbox defaults to a quality target, so without all three of
        // these a complex scene blows straight through the rung's budget --
        // which is the single thing the rung exists to prevent.
        let a = args_of(720, PlaybackColorClass::Sdr8);
        assert_eq!(val(&a, "-b:v"), Some("2500k"));
        assert_eq!(val(&a, "-maxrate"), Some("2500k"));
        assert_eq!(val(&a, "-bufsize"), Some("5000k"));
        assert_eq!(val(&a, "-constant_bit_rate"), Some("1"));
    }

    #[test]
    fn audio_is_optional_so_a_silent_source_still_streams() {
        // Without the `?` ffmpeg exits on a video-only file, and the guest
        // sits through its 20s watchdog before failing.
        let a = args_of(720, PlaybackColorClass::Sdr8);
        assert!(a.windows(2).any(|w| w[0] == "-map" && w[1] == "0:a:0?"));
    }

    #[test]
    fn every_rung_scales_to_its_own_height() {
        for r in RUNGS {
            let a = rung_output_args(r, Some(PlaybackColorClass::Sdr8));
            assert_eq!(val(&a, "-vf"), Some(format!("scale=-2:{}", r.height).as_str()));
        }
    }

    #[test]
    fn ten_bit_gets_dithered_rather_than_truncated() {
        // The banding bug this branch exists for was fixed once already in the
        // local playback path; a plain -pix_fmt yuv420p here would bring it
        // back on the peer path only, where nobody would look for it.
        let vf = val(&args_of(720, PlaybackColorClass::Sdr10), "-vf").unwrap().to_string();
        assert!(vf.contains("dither=error_diffusion"), "{vf}");
        assert!(vf.contains("scale=-2:720"), "{vf}");
    }

    #[test]
    fn hdr_scales_before_it_tonemaps() {
        // Measured 0.76s vs 1.41s the other way round, because the expensive
        // zscale then runs at 720p instead of at source resolution.
        let vf = val(&args_of(720, PlaybackColorClass::Hdr), "-vf").unwrap().to_string();
        let scale = vf.find("scale=-2:720").expect("must scale");
        let tonemap = vf.find("tonemap=").expect("must tonemap");
        assert!(scale < tonemap, "scale must come first: {vf}");
    }

    #[test]
    fn hdr_tags_its_output_bt709() {
        // Without the tags a player has no way to know the tonemap happened,
        // and renders the result as though it were still PQ.
        let a = args_of(720, PlaybackColorClass::Hdr);
        assert_eq!(val(&a, "-colorspace"), Some("bt709"));
        assert_eq!(val(&a, "-color_trc"), Some("bt709"));
        // ...and an SDR encode does not carry them, because there is nothing
        // to declare.
        assert_eq!(val(&args_of(720, PlaybackColorClass::Sdr8), "-colorspace"), None);
    }

    #[test]
    fn a_failed_colour_probe_still_encodes() {
        // Refusing here would turn a probe hiccup into a dead session. SDR-8
        // is the safe assumption: it is what the overwhelming majority of
        // sources are, and the worst case is an unnecessary conversion.
        let a = rung_output_args(rung_for(720).unwrap(), None);
        assert_eq!(val(&a, "-vf"), Some("scale=-2:720"));
        assert_eq!(val(&a, "-c:v"), Some("h264_videotoolbox"));
    }

    #[test]
    fn the_muxing_contract_matches_the_copy_path() {
        // The guest's clock math is shared between the two, so a rung must not
        // change the timeline shape - only the picture.
        let a = args_of(540, PlaybackColorClass::Sdr8);
        assert!(a.iter().any(|x| x == "-copyts"));
        assert_eq!(val(&a, "-video_track_timescale"), Some("90000"));
        assert_eq!(val(&a, "-movflags"), Some("frag_keyframe+empty_moov+default_base_moof"));
        assert_eq!(a.last().map(String::as_str), Some("pipe:1"));
    }

    #[test]
    fn the_gop_is_ours_which_is_what_retires_r9() {
        // On -c copy the seek granularity is the source's keyframe interval,
        // which we do not control and which is 10s on some delivery masters.
        // Encoding makes it 2s by construction.
        assert_eq!(val(&args_of(360, PlaybackColorClass::Sdr8), "-g"), Some("60"));
        assert_eq!(val(&args_of(360, PlaybackColorClass::Sdr8), "-bf"), Some("0"));
    }

    #[test]
    fn epoch_is_the_seek_point_on_a_rung_and_unknown_on_passthrough() {
        // The measured bug: probe_stream_epoch answers the -c copy question
        // (keyframe at or before start). An encode seeks accurately, so using
        // the probe's answer shifts the whole SourceBuffer one GOP early.
        assert_eq!(epoch_for_rung(rung_for(720), 11.0), Some(11.0));
        assert_eq!(epoch_for_rung(rung_for(360), 0.0), Some(0.0));
        assert_eq!(epoch_for_rung(None, 11.0), None); // caller must probe
    }

    #[test]
    fn a_busy_host_caps_the_rung_without_refusing_the_guest() {
        // The person running a transcription started it first and is waiting
        // on it. A review session that arrives afterwards should not halve
        // their speed — but a smaller picture beats a dead session, so this
        // lowers rather than refuses.
        assert_eq!(clamp_for_host_load(rung_for(1080), true), rung_for(540));
        assert_eq!(clamp_for_host_load(rung_for(720), true), rung_for(540));
    }

    #[test]
    fn the_cap_only_ever_makes_the_encode_cheaper() {
        // A guest already below the ceiling must not be dragged UP to it —
        // that would spend more host CPU precisely when there is none spare.
        assert_eq!(clamp_for_host_load(rung_for(360), true), rung_for(360));
        assert_eq!(clamp_for_host_load(rung_for(540), true), rung_for(540));
    }

    #[test]
    fn an_idle_host_serves_whatever_was_asked_for() {
        for r in RUNGS {
            assert_eq!(clamp_for_host_load(Some(r), false), Some(r));
        }
    }

    #[test]
    fn passthrough_is_never_capped() {
        // `-c copy` costs the host almost nothing, so there is nothing to
        // protect it from — and silently turning a passthrough request into an
        // ENCODE would spend CPU the cap exists to save.
        assert_eq!(clamp_for_host_load(None, true), None);
        assert_eq!(clamp_for_host_load(None, false), None);
    }

    #[test]
    fn args_carry_no_shell_metacharacters() {
        // These are passed as an argv array, never a shell string, but the
        // filter chains are the one place a stray quote would be easy to add.
        for r in RUNGS {
            for class in [PlaybackColorClass::Sdr8, PlaybackColorClass::Sdr10, PlaybackColorClass::Hdr] {
                for a in rung_output_args(r, Some(class)) {
                    assert!(!a.contains('"') && !a.contains('\'') && !a.contains(';'), "{a}");
                }
            }
        }
    }

    #[test]
    fn the_probe_type_is_reachable_from_here() {
        // Guards the pub(crate) visibility this module depends on: if media.rs
        // makes these private again, this stops compiling rather than someone
        // copying the filter chains into a second place.
        let p = super::super::media::PlaybackColorProbe::default();
        let _ = super::super::media::classify_playback_color(&p);
    }
}
