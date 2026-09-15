//! Numeric oracle for the generated acceptance fixtures, never arbitrary audio.
//! Mirrors `scripts/obs-audio-spectrum.mjs` over exactly five seconds of PCM.

use serde::Serialize;

const SAMPLE_RATE: u32 = 48_000;
const FRAMES: usize = 5 * SAMPLE_RATE as usize;
const CHANNELS: usize = 2;
const FRAME_BYTES: usize = CHANNELS * std::mem::size_of::<f32>();
const BLOCK_FRAMES: usize = 4_800; // 100 ms; every fixture tone has whole cycles.
const FREQUENCIES: [f64; 4] = [440.0, 660.0, 880.0, 1_320.0];
const QUIET_AMPLITUDE: f64 = 0.0001;
const UNWANTED_AMPLITUDE: f64 = 0.0003;

#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct ObsAudioChannelMetrics {
    pub rms: f64,
    pub longest_quiet_ms: f64,
    /// Tone order: 440, 660, 880, 1320 Hz. Extrema span every 100 ms window.
    pub minimum_tone: [f64; 4],
    pub maximum_tone: [f64; 4],
}

#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct ObsAudioSpectrum {
    pub frames: u32,
    pub sample_rate: u32,
    /// Stereo channel order: left, right.
    pub channels: Vec<ObsAudioChannelMetrics>,
}

/// Accept only 48 kHz stereo interleaved f32LE with all 240,000 frames present.
pub(super) fn analyze(pcm: &[u8]) -> Result<ObsAudioSpectrum, &'static str> {
    if pcm.len() != FRAMES * FRAME_BYTES {
        return Err("Expected exactly five seconds of 48 kHz stereo float PCM");
    }

    // Reuse the direct Fourier basis across all windows and both channels.
    // This keeps the same magnitude calculation as the JS fixture oracle.
    let basis: Vec<[(f64, f64); 4]> = (0..BLOCK_FRAMES)
        .map(|frame| {
            FREQUENCIES.map(|frequency| {
                let phase = std::f64::consts::TAU * frequency * frame as f64
                    / f64::from(SAMPLE_RATE);
                let (sin, cos) = phase.sin_cos();
                (cos, sin)
            })
        })
        .collect();
    let mut channels = Vec::with_capacity(CHANNELS);
    for channel in 0..CHANNELS {
        let offset = channel * std::mem::size_of::<f32>();
        let mut samples = Vec::with_capacity(FRAMES);
        let mut sum_squares = 0.0;
        let mut quiet_frames = 0usize;
        let mut longest_quiet = 0usize;
        for frame in pcm.chunks_exact(FRAME_BYTES) {
            let sample = f64::from(f32::from_le_bytes([
                frame[offset],
                frame[offset + 1],
                frame[offset + 2],
                frame[offset + 3],
            ]));
            if !sample.is_finite() {
                return Err("Non-finite decoded audio");
            }
            samples.push(sample);
            sum_squares += sample * sample;
            quiet_frames = if sample.abs() < QUIET_AMPLITUDE {
                quiet_frames + 1
            } else {
                0
            };
            longest_quiet = longest_quiet.max(quiet_frames);
        }

        let mut minimum_tone = [f64::INFINITY; 4];
        let mut maximum_tone = [0.0_f64; 4];
        for block in samples.chunks_exact(BLOCK_FRAMES) {
            let mut real = [0.0_f64; 4];
            let mut imaginary = [0.0_f64; 4];
            for (sample, tones) in block.iter().zip(&basis) {
                for (index, (cos, sin)) in tones.iter().enumerate() {
                    real[index] += sample * cos;
                    imaginary[index] += sample * sin;
                }
            }
            for index in 0..FREQUENCIES.len() {
                let magnitude = 2.0 * real[index].hypot(imaginary[index])
                    / BLOCK_FRAMES as f64;
                minimum_tone[index] = minimum_tone[index].min(magnitude);
                maximum_tone[index] = maximum_tone[index].max(magnitude);
            }
        }
        channels.push(ObsAudioChannelMetrics {
            rms: (sum_squares / FRAMES as f64).sqrt(),
            longest_quiet_ms: longest_quiet as f64 * 1_000.0 / f64::from(SAMPLE_RATE),
            minimum_tone,
            maximum_tone,
        });
    }
    Ok(ObsAudioSpectrum {
        frames: FRAMES as u32,
        sample_rate: SAMPLE_RATE,
        channels,
    })
}

fn valid(spectrum: &ObsAudioSpectrum) -> bool {
    spectrum.frames == FRAMES as u32
        && spectrum.sample_rate == SAMPLE_RATE
        && spectrum.channels.len() == CHANNELS
        && spectrum.channels.iter().all(|channel| {
            std::iter::once(&channel.rms)
                .chain(std::iter::once(&channel.longest_quiet_ms))
                .chain(&channel.minimum_tone)
                .chain(&channel.maximum_tone)
                .all(|value| value.is_finite() && *value >= 0.0)
        })
}

pub(super) fn isolated(spectrum: &ObsAudioSpectrum, pair: usize) -> bool {
    pair < 2
        && valid(spectrum)
        && spectrum.channels.iter().enumerate().all(|(index, channel)| {
            let wanted = pair * CHANNELS + index;
            channel.longest_quiet_ms < 5.0
                && channel.minimum_tone[wanted] > 0.004
                && channel
                    .maximum_tone
                    .iter()
                    .enumerate()
                    .all(|(tone, magnitude)| tone == wanted || *magnitude < UNWANTED_AMPLITUDE)
        })
}

pub(super) fn silent(spectrum: &ObsAudioSpectrum) -> bool {
    valid(spectrum)
        && spectrum.channels.iter().all(|channel| {
            channel.rms < QUIET_AMPLITUDE
                && channel
                    .maximum_tone
                    .iter()
                    .all(|magnitude| *magnitude < UNWANTED_AMPLITUDE)
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pcm(mut sample: impl FnMut(usize, usize) -> f32) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(FRAMES * FRAME_BYTES);
        for frame in 0..FRAMES {
            for channel in 0..CHANNELS {
                bytes.extend_from_slice(&sample(frame, channel).to_le_bytes());
            }
        }
        bytes
    }

    fn tone(frame: usize, frequency: f64) -> f32 {
        (0.01 * (std::f64::consts::TAU * frequency * frame as f64
            / f64::from(SAMPLE_RATE))
        .sin()) as f32
    }

    fn pair_pcm(pair: usize) -> Vec<u8> {
        pcm(|frame, channel| tone(frame, FREQUENCIES[pair * CHANNELS + channel]))
    }

    #[test]
    fn each_generated_stereo_pair_is_isolated() {
        for pair in 0..2 {
            let spectrum = analyze(&pair_pcm(pair)).unwrap();
            assert_eq!(spectrum.frames, 240_000);
            assert_eq!(spectrum.sample_rate, 48_000);
            assert_eq!(spectrum.channels.len(), 2);
            assert!(isolated(&spectrum, pair));
            assert!(!isolated(&spectrum, 1 - pair));
            assert!(!silent(&spectrum));
            for (index, channel) in spectrum.channels.iter().enumerate() {
                let wanted = pair * CHANNELS + index;
                assert!((channel.rms - 0.01 / 2.0_f64.sqrt()).abs() < 1e-8);
                assert!((channel.minimum_tone[wanted] - 0.01).abs() < 1e-8);
                assert!((channel.maximum_tone[wanted] - 0.01).abs() < 1e-8);
            }
        }
    }

    #[test]
    fn a_competing_pair_in_one_window_fails_isolation() {
        let bytes = pcm(|frame, channel| {
            let selected = tone(frame, FREQUENCIES[channel]);
            if frame >= FRAMES - BLOCK_FRAMES {
                selected + tone(frame, FREQUENCIES[2 + channel]) * 0.1
            } else {
                selected
            }
        });
        let spectrum = analyze(&bytes).unwrap();
        for (channel, metrics) in spectrum.channels.iter().enumerate() {
            assert!(metrics.minimum_tone[channel] > 0.004);
            assert!(metrics.maximum_tone[2 + channel] > 0.0009);
        }
        assert!(!isolated(&spectrum, 0));
        assert!(!isolated(&spectrum, 1));
        assert!(!silent(&spectrum));
    }

    #[test]
    fn swapped_channels_fail_for_each_pair() {
        for pair in 0..2 {
            let spectrum = analyze(&pcm(|frame, channel| {
                tone(frame, FREQUENCIES[pair * CHANNELS + 1 - channel])
            }))
            .unwrap();
            assert!(!isolated(&spectrum, pair));
            assert!(!silent(&spectrum));
        }
    }

    #[test]
    fn one_weak_window_fails_even_when_whole_capture_rms_is_high() {
        let spectrum = analyze(&pcm(|frame, channel| {
            let gain = if frame >= FRAMES - BLOCK_FRAMES { 0.2 } else { 1.0 };
            tone(frame, FREQUENCIES[channel]) * gain
        }))
        .unwrap();
        assert!(spectrum.channels.iter().all(|channel| channel.rms > 0.004));
        assert!((spectrum.channels[0].minimum_tone[0] - 0.002).abs() < 1e-8);
        assert!(!isolated(&spectrum, 0));
    }

    #[test]
    fn silence_has_zero_energy_and_a_five_second_quiet_gap() {
        let spectrum = analyze(&vec![0; FRAMES * FRAME_BYTES]).unwrap();
        assert!(silent(&spectrum));
        assert!(!isolated(&spectrum, 0));
        assert!(!isolated(&spectrum, 1));
        for channel in spectrum.channels {
            assert_eq!(channel.rms, 0.0);
            assert_eq!(channel.longest_quiet_ms, 5_000.0);
            assert_eq!(channel.minimum_tone, [0.0; 4]);
            assert_eq!(channel.maximum_tone, [0.0; 4]);
        }
    }

    #[test]
    fn silence_requires_low_rms_outside_the_fixture_frequencies_too() {
        let spectrum = analyze(&pcm(|frame, _| tone(frame, 2_000.0))).unwrap();
        assert!(spectrum.channels.iter().all(|channel| {
            channel.maximum_tone.iter().all(|magnitude| *magnitude < UNWANTED_AMPLITUDE)
        }));
        assert!(!silent(&spectrum));
    }

    #[test]
    fn a_short_tone_burst_is_not_silent_even_when_capture_rms_is_low() {
        let spectrum = analyze(&pcm(|frame, channel| {
            if frame >= FRAMES - BLOCK_FRAMES {
                tone(frame, FREQUENCIES[channel]) * 0.04
            } else {
                0.0
            }
        }))
        .unwrap();
        assert!(spectrum.channels.iter().all(|channel| channel.rms < QUIET_AMPLITUDE));
        assert!(spectrum.channels[0].maximum_tone[0] > UNWANTED_AMPLITUDE);
        assert!(!silent(&spectrum));
    }

    #[test]
    fn short_dropouts_are_measured_across_window_and_capture_edges() {
        let gap_frames = 1_008; // 21 ms can retain sufficient tone in a 100 ms window.
        for gap_start in [0, BLOCK_FRAMES - 300, FRAMES - gap_frames] {
            let spectrum = analyze(&pcm(|frame, channel| {
                if (gap_start..gap_start + gap_frames).contains(&frame) {
                    0.0
                } else {
                    tone(frame, FREQUENCIES[channel])
                }
            }))
            .unwrap();
            for (channel, metrics) in spectrum.channels.iter().enumerate() {
                assert!(metrics.minimum_tone[channel] > 0.004);
                assert!(metrics.longest_quiet_ms >= 21.0);
            }
            assert!(!isolated(&spectrum, 0));
        }
    }

    #[test]
    fn malformed_and_non_five_second_pcm_is_rejected() {
        let expected = FRAMES * FRAME_BYTES;
        for size in [0, 1, expected - 1, expected - FRAME_BYTES, expected + 1, expected + FRAME_BYTES] {
            assert!(analyze(&vec![0; size]).is_err(), "accepted {size} bytes");
        }
    }

    #[test]
    fn non_finite_samples_in_either_channel_or_at_either_edge_are_rejected() {
        for value in [f32::NAN, f32::INFINITY, f32::NEG_INFINITY] {
            for frame in [0, FRAMES - 1] {
                for channel in 0..CHANNELS {
                    let mut bytes = vec![0; FRAMES * FRAME_BYTES];
                    let offset = frame * FRAME_BYTES + channel * 4;
                    bytes[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
                    assert!(analyze(&bytes).is_err());
                }
            }
        }
    }

    #[test]
    fn classification_fails_closed_for_invalid_metadata_and_pair() {
        let spectrum = analyze(&pair_pcm(0)).unwrap();
        assert!(!isolated(&spectrum, 2));
        assert!(!isolated(&spectrum, usize::MAX));
        let mut invalid = spectrum.clone();
        invalid.frames -= 1;
        assert!(!isolated(&invalid, 0));
        assert!(!silent(&invalid));
        invalid = spectrum.clone();
        invalid.sample_rate = 44_100;
        assert!(!isolated(&invalid, 0));
        invalid = spectrum.clone();
        invalid.channels.clear();
        assert!(!isolated(&invalid, 0));
        assert!(!silent(&invalid));
        invalid = spectrum.clone();
        invalid.channels[1].maximum_tone[3] = f64::NAN;
        assert!(!isolated(&invalid, 0));
        assert!(!silent(&invalid));
    }

    #[test]
    fn isolation_thresholds_are_strict() {
        let spectrum = analyze(&pair_pcm(0)).unwrap();
        let mut boundary = spectrum.clone();
        boundary.channels[0].minimum_tone[0] = 0.004;
        assert!(!isolated(&boundary, 0));
        boundary = spectrum.clone();
        boundary.channels[0].maximum_tone[1] = UNWANTED_AMPLITUDE;
        assert!(!isolated(&boundary, 0));
        boundary = spectrum;
        boundary.channels[1].longest_quiet_ms = 5.0;
        assert!(!isolated(&boundary, 0));
    }
}
