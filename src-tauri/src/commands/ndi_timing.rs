//! Local, opt-in observations of the native encoder input. These are NOT
//! Premiere sequence positions and must never authorize marker placement.
use std::{collections::VecDeque, sync::atomic::{AtomicU64, Ordering}, time::{Duration, Instant}};

use serde::{Deserialize, Serialize};

use crate::AppError;

pub(super) const CAPACITY: usize = 600;
#[cfg(any(sauce_ndi, test))]
pub(super) const MAX_METADATA_BYTES: usize = 2048;
#[cfg(any(sauce_ndi, test))]
pub(super) const MAX_PACKET_BYTES: usize = 16 * 1024;

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
#[serde(rename_all = "kebab-case")]
pub enum NdiTimingProbePhase { Running, Stopped, Expired, SourceStopped }

/// Raw time fields use decimal strings: NDI's signed 64-bit clock values do
/// not fit exactly in a JavaScript number. Equal fields are not frame proof.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct NdiTimingSample {
    pub probe_id: String,
    #[serde(default)]
    pub sample_sequence: u32,
    pub output_tick: Option<String>,
    pub output_timescale: u32,
    pub output_accepted: bool,
    pub input_valid: bool,
    pub input_width: u32,
    pub input_height: u32,
    pub input_rate_n: u32,
    pub input_rate_d: u32,
    pub ndi_timecode: Option<String>,
    pub ndi_timestamp: Option<String>,
    pub metadata: Option<String>,
    pub metadata_truncated: bool,
    pub metadata_invalid_utf8: bool,
    pub same_timing_as_previous_capture: bool,
    pub received_frames: String,
    pub ndi_dropped_frames: String,
    pub encoder_dropped_frames: String,
    pub last_input_age_ms: u32,
    pub stale: bool,
}

#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[ts(export, export_to = "../../src/bindings/")]
#[serde(rename_all = "camelCase")]
pub struct NdiTimingProbeResult {
    pub source_id: String,
    pub probe_id: String,
    pub phase: NdiTimingProbePhase,
    pub remaining_ms: u32,
    pub capacity: u32,
    pub overwritten_samples: u32,
    pub rejected_samples: u32,
    pub timing_verified: bool,
    pub samples: Vec<NdiTimingSample>,
}

pub(super) struct Probe {
    token: u64,
    deadline: Instant,
    phase: NdiTimingProbePhase,
    #[cfg(any(sauce_ndi, test))]
    next_sequence: u32,
    overwritten: u32,
    rejected: u32,
    samples: VecDeque<NdiTimingSample>,
}

impl Probe {
    pub(super) fn start(duration_seconds: Option<u32>, now: Instant) -> Result<Self, AppError> {
        let duration = duration_seconds.unwrap_or(30);
        if !(1..=60).contains(&duration) {
            return Err(AppError::invalid("Choose a timing capture duration from 1 to 60 seconds"));
        }
        static NEXT_TOKEN: AtomicU64 = AtomicU64::new(1);
        Ok(Self { token: NEXT_TOKEN.fetch_add(1, Ordering::Relaxed),
            deadline: now + Duration::from_secs(duration.into()), phase: NdiTimingProbePhase::Running,
            #[cfg(any(sauce_ndi, test))]
            next_sequence: 1,
            overwritten: 0, rejected: 0, samples: VecDeque::new() })
    }

    pub(super) fn token(&mut self, now: Instant) -> u64 {
        if self.phase == NdiTimingProbePhase::Running && now >= self.deadline {
            self.phase = NdiTimingProbePhase::Expired;
        }
        if self.phase == NdiTimingProbePhase::Running { self.token } else { 0 }
    }

    pub(super) fn matches(&self, id: &str) -> bool { self.token.to_string() == id }

    pub(super) fn stop(&mut self, source_stopped: bool) {
        self.phase = if source_stopped { NdiTimingProbePhase::SourceStopped } else { NdiTimingProbePhase::Stopped };
    }

    #[cfg(any(sauce_ndi, test))]
    pub(super) fn accept(&mut self, packet: &[u8], now: Instant) {
        if self.token(now) == 0 { return; }
        if packet.len() > MAX_PACKET_BYTES { self.rejected += 1; return; }
        let Ok(mut sample) = serde_json::from_slice::<NdiTimingSample>(packet) else {
            self.rejected += 1; return;
        };
        // A frame already in flight when stop/start occurs belongs to the
        // old capture. Reject it without affecting the new capture's counts.
        if !self.matches(&sample.probe_id) { return; }
        if !sample.valid() { self.rejected += 1; return; }
        sample.sample_sequence = self.next_sequence;
        self.next_sequence += 1;
        self.samples.push_back(sample);
        if self.samples.len() > CAPACITY { self.samples.pop_front(); self.overwritten += 1; }
    }

    pub(super) fn snapshot(&mut self, source_id: &str, after: Option<u32>, now: Instant) -> NdiTimingProbeResult {
        self.token(now);
        NdiTimingProbeResult {
            source_id: source_id.into(), probe_id: self.token.to_string(), phase: self.phase,
            remaining_ms: if self.phase == NdiTimingProbePhase::Running {
                self.deadline.saturating_duration_since(now).as_millis().min(u32::MAX as u128) as u32
            } else { 0 },
            capacity: CAPACITY as u32, overwritten_samples: self.overwritten, rejected_samples: self.rejected,
            timing_verified: false,
            samples: self.samples.iter().filter(|sample| after.is_none_or(|cursor|sample.sample_sequence > cursor)).cloned().collect(),
        }
    }
}

#[cfg(any(sauce_ndi, test))]
impl NdiTimingSample {
    fn valid(&self) -> bool {
        fn signed(value: &Option<String>) -> bool {
            value.as_ref().is_none_or(|v| v.len() <= 20 && v.parse::<i64>().is_ok())
        }
        self.output_timescale == 30 && signed(&self.output_tick) && signed(&self.ndi_timecode)
            && signed(&self.ndi_timestamp) && self.input_width <= 8192 && self.input_height <= 8192
            && self.metadata.as_ref().is_none_or(|v|v.len() <= MAX_METADATA_BYTES)
            && [&self.received_frames, &self.ndi_dropped_frames, &self.encoder_dropped_frames]
                .iter().all(|value|value.len() <= 20 && value.parse::<u64>().is_ok())
            && (!self.output_accepted || (self.input_valid && self.output_tick.is_some()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn packet(probe: &Probe, changes: serde_json::Value) -> Vec<u8> {
        let mut value = serde_json::json!({"probeId":probe.token.to_string(),"outputTick":"12345678901234567",
            "outputTimescale":30,"outputAccepted":true,"inputValid":true,"inputWidth":1920,"inputHeight":1080,
            "inputRateN":30000,"inputRateD":1001,"ndiTimecode":"9223372036854775807","ndiTimestamp":"17700000000000000",
            "metadata":"<frame untrusted='true' />","metadataTruncated":false,"metadataInvalidUtf8":false,
            "sameTimingAsPreviousCapture":false,"receivedFrames":"100","ndiDroppedFrames":"0",
            "encoderDroppedFrames":"0","lastInputAgeMs":0,"stale":false});
        for (key, value_change) in changes.as_object().unwrap() { value[key] = value_change.clone(); }
        serde_json::to_vec(&value).unwrap()
    }

    #[test]
    fn bounded_samples_keep_exact_raw_ticks_but_never_claim_sequence_verification() {
        let now = Instant::now(); let mut probe = Probe::start(Some(60), now).unwrap();
        let data = packet(&probe, serde_json::json!({}));
        for _ in 0..CAPACITY + 17 { probe.accept(&data, now); }
        let result = probe.snapshot("source-a", None, now);
        assert_eq!(result.samples.len(), CAPACITY); assert_eq!(result.overwritten_samples, 17);
        assert_eq!(result.samples[0].sample_sequence, 18); assert!(!result.timing_verified);
        assert_eq!(result.samples[0].ndi_timecode.as_deref(), Some("9223372036854775807"));
        assert_eq!(result.samples[0].output_tick.as_deref(), Some("12345678901234567"));
        assert_eq!(probe.snapshot("source-a", Some(615), now).samples.len(), 2);
    }

    #[test]
    fn captures_expire_and_cancel_without_being_restarted_by_old_samples() {
        let now = Instant::now(); let mut old = Probe::start(Some(1), now).unwrap();
        let old_data = packet(&old, serde_json::json!({}));
        assert_eq!(old.token(now + Duration::from_secs(1)), 0);
        old.accept(&old_data, now + Duration::from_secs(1));
        assert_eq!(old.phase, NdiTimingProbePhase::Expired); assert!(old.samples.is_empty());
        let mut next = Probe::start(None, now).unwrap(); next.accept(&old_data, now);
        assert!(!next.matches(&old.token.to_string())); assert!(next.samples.is_empty());
        next.stop(false); assert_eq!(next.token(now), 0);
        next.stop(true); assert_eq!(next.phase, NdiTimingProbePhase::SourceStopped);
    }

    #[test]
    fn untrusted_metadata_and_malformed_values_cannot_grow_the_ring() {
        let now = Instant::now(); let mut probe = Probe::start(None, now).unwrap();
        for changes in [serde_json::json!({"metadata":"a".repeat(MAX_METADATA_BYTES+1)}),
            serde_json::json!({"ndiTimestamp":"18446744073709551616"}),
            serde_json::json!({"outputTimescale":24}), serde_json::json!({"outputTick":null})] {
            probe.accept(&packet(&probe, changes), now);
        }
        probe.accept(&vec![b' '; MAX_PACKET_BYTES+1], now);
        assert_eq!(probe.rejected, 5); assert!(probe.samples.is_empty());
        assert!(Probe::start(Some(0), now).is_err()); assert!(Probe::start(Some(61), now).is_err());
    }
}
