//! Timecode as an editor reads and types it: `HH:MM:SS:FF`, with `;` before
//! the frames for drop frame (29.97 and 59.94 skip two or four frame numbers
//! a minute, except every tenth minute). Frames here are absolute timecode
//! frames, so a sequence's own start (`manifest.start_frame`) is already in.

fn dropped(fps: u32, drop: bool) -> i64 {
    if drop && fps.is_multiple_of(30) { i64::from(fps / 15) } else { 0 }
}

/// `frames` as timecode at a whole-number `fps`.
pub fn format(frames: i64, fps: u32, drop: bool) -> String {
    let fps = fps.max(1);
    let rate = i64::from(fps);
    let skip = dropped(fps, drop);
    let mut count = frames.max(0);
    if skip > 0 {
        let per_ten = rate * 600 - skip * 9;
        let per_minute = rate * 60 - skip;
        let (tens, rest) = (count / per_ten, count % per_ten);
        count += skip * 9 * tens + if rest > skip { skip * ((rest - skip) / per_minute) } else { 0 };
    }
    let (hours, minutes, seconds, frame) = (count / (rate * 3600), count / (rate * 60) % 60, count / rate % 60, count % rate);
    format!("{hours:02}:{minutes:02}:{seconds:02}{}{frame:02}", if skip > 0 { ';' } else { ':' })
}

/// Timecode typed as `HH:MM:SS:FF` (or with `;` or `.` before the frames) to
/// frames. `None` for anything else, or a frame number drop frame skips.
pub fn parse(text: &str, fps: u32, drop: bool) -> Option<i64> {
    let parts: Vec<i64> = text.trim().split([':', ';', '.']).map(|part| part.trim().parse().ok()).collect::<Option<_>>()?;
    let [hours, minutes, seconds, frame] = parts.as_slice() else { return None };
    let rate = i64::from(fps.max(1));
    if [*hours, *minutes, *seconds, *frame].iter().any(|value| *value < 0) || *minutes > 59 || *seconds > 59 || *frame >= rate { return None; }
    let skip = dropped(fps, drop);
    if skip > 0 && *seconds == 0 && *frame < skip && minutes % 10 != 0 { return None; }
    let total_minutes = hours * 60 + minutes;
    Some(((hours * 3600 + minutes * 60 + seconds) * rate + frame) - skip * (total_minutes - total_minutes / 10))
}

/// The whole-number timecode rate of an edit rate (23.976 counts as 24).
pub fn rate_of(numerator: u32, denominator: u32) -> u32 {
    (f64::from(numerator) / f64::from(denominator.max(1))).round().max(1.0) as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_drop_counts_every_frame() {
        assert_eq!(format(86_400, 24, false), "01:00:00:00");
        assert_eq!(format(86_400 + 24 * 61 + 5, 24, false), "01:01:01:05");
        assert_eq!(parse("01:01:01:05", 24, false), Some(86_400 + 24 * 61 + 5));
    }

    #[test]
    fn drop_frame_skips_two_numbers_a_minute_except_every_tenth() {
        // 29.97 DF: one hour is 107,892 frames.
        assert_eq!(format(107_892, 30, true), "01:00:00;00");
        assert_eq!(format(1_800, 30, true), "00:01:00;02");
        assert_eq!(format(17_982, 30, true), "00:10:00;00");
        for frames in [0, 1_799, 1_800, 17_981, 17_982, 107_892, 250_000] {
            assert_eq!(parse(&format(frames, 30, true), 30, true), Some(frames), "{frames}");
        }
        assert_eq!(parse("00:01:00;00", 30, true), None);
    }

    #[test]
    fn rejects_what_is_not_timecode() {
        assert_eq!(parse("1:00", 24, false), None);
        assert_eq!(parse("01:00:00:24", 24, false), None);
        assert_eq!(rate_of(24_000, 1_001), 24);
        assert_eq!(rate_of(30_000, 1_001), 30);
    }
}
