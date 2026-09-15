//! Explicit internal packaged-main test. Compiled out of ordinary builds.
//! Observes one existing private display source; never selects, starts, stops,
//! publishes or changes permissions for that source. Results contain numbers only.
use std::{collections::HashMap, sync::{Arc, Mutex, OnceLock, atomic::{AtomicBool, Ordering}}, time::Duration};
use serde::Serialize;
use tauri::{AppHandle, WebviewWindow};
use crate::AppError;
use super::super::{ndi::{self, Program}, session};

#[path = "audio_acceptance_io.rs"]
mod observation;
#[path = "audio_acceptance_spectrum.rs"]
mod spectrum;
use spectrum::ObsAudioSpectrum;

#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct ObsAudioAcceptanceReport {
    pub system_audio: bool,
    pub verdict: String,
    pub capture: ObsAudioSpectrum,
    pub reference: ObsAudioSpectrum,
}
#[derive(Clone, Debug, Serialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, export_to = "../../src/bindings/")]
pub struct ObsAudioAcceptanceStatus {
    pub attempt: String,
    pub phase: String,
    pub error: Option<String>,
    pub report: Option<ObsAudioAcceptanceReport>,
}
struct Entry { state: ObsAudioAcceptanceStatus, cancel: Arc<AtomicBool>, active: bool }
#[derive(Default)]
struct Registry { entries: HashMap<String, Entry>, quarantined: bool }
const MAX_ATTEMPTS: usize = 64;
impl Registry {
    fn reserve(&mut self, attempt: &str) -> Result<Arc<AtomicBool>, &'static str> {
        if self.quarantined { return Err("cleanup_unconfirmed"); }
        if self.entries.contains_key(attempt) { return Err("attempt_already_used"); }
        if self.entries.values().any(|entry|entry.active) { return Err("measurement_busy"); }
        if self.entries.len() >= MAX_ATTEMPTS { return Err("diagnostic_attempt_limit"); }
        let cancel = Arc::new(AtomicBool::new(false));
        self.entries.insert(attempt.to_owned(), Entry { cancel: cancel.clone(), active: true,
            state: ObsAudioAcceptanceStatus { attempt: attempt.to_owned(), phase: "running".into(), error: None, report: None } });
        Ok(cancel)
    }
    fn cancel(&mut self, attempt: &str) -> Result<(), &'static str> {
        if let Some(entry) = self.entries.get_mut(attempt) { entry.cancel.store(true, Ordering::Release); }
        else {
            if self.entries.len() >= MAX_ATTEMPTS { return Err("diagnostic_attempt_limit"); }
            // Never evict cancellation tombstones within this internal run.
            // Cancel arriving before Start cannot create a delayed capture.
            self.entries.insert(attempt.to_owned(), Entry { cancel: Arc::new(AtomicBool::new(true)), active: false,
                state: ObsAudioAcceptanceStatus { attempt: attempt.to_owned(), phase: "cancelled".into(), error: None, report: None } });
        }
        Ok(())
    }
    fn finish(&mut self, attempt: &str, result: Result<ObsAudioAcceptanceReport, &'static str>) {
        let Some(entry) = self.entries.get_mut(attempt) else { return; };
        entry.active = false;
        if result.as_ref().err() == Some(&"cleanup_unconfirmed") {
            self.quarantined = true;
            entry.state.phase = "failed".into(); entry.state.error = Some("cleanup_unconfirmed".into());
        } else if entry.cancel.load(Ordering::Acquire) {
            entry.state.phase = "cancelled".into();
        } else {
            match result {
                Ok(report) => { entry.state.phase = "complete".into(); entry.state.report = Some(report); }
                Err(error) => { entry.state.phase = "failed".into(); entry.state.error = Some(error.into()); }
            }
        }
    }
}
fn registry() -> &'static Mutex<Registry> {
    static VALUE: OnceLock<Mutex<Registry>> = OnceLock::new();
    VALUE.get_or_init(||Mutex::new(Registry::default()))
}
fn validate(window: &WebviewWindow, attempt: &str) -> Result<(), AppError> {
    if window.label() != "main" || !super::valid_display_uuid(attempt) {
        return Err(AppError::invalid("Invalid internal audio test request"));
    }
    Ok(())
}
fn selected(program: &Arc<Program>) -> Result<bool, &'static str> {
    if !ndi::find_program(&program.id).is_some_and(|current|Arc::ptr_eq(&current, program)) || !program.encoded_ready() {
        return Err("private_preview_unavailable");
    }
    if !super::broadcast::acceptance_idle() { return Err("stop_broadcast_before_test"); }
    program.acceptance_display_audio().ok_or("private_display_preview_required")
}

#[tauri::command]
pub fn obs_audio_acceptance_start(app: AppHandle, window: WebviewWindow, id: String, attempt: String) -> Result<(), AppError> {
    validate(&window, &attempt)?;
    observation::packaged_tool(&["saucebunny-capture", "saucebunny-capture-aarch64-apple-darwin"]).map_err(AppError::invalid)?;
    if !ndi::valid_program_id(&id) { return Err(AppError::invalid("Invalid selected preview")); }
    let program = ndi::find_program(&id).ok_or_else(||AppError::invalid("Select an existing private display preview"))?;
    selected(&program).map_err(AppError::invalid)?;
    let cancel = registry().lock().map_err(|_|AppError::internal("Audio test state unavailable"))?
        .reserve(&attempt).map_err(AppError::invalid)?;
    // Admission/cancel ownership is held before the task can suspend or spawn.
    tauri::async_runtime::spawn(async move {
        let result = measure(app, window, program, &attempt, cancel).await;
        if let Ok(mut registry) = registry().lock() { registry.finish(&attempt, result); }
    });
    Ok(())
}
#[tauri::command]
pub fn obs_audio_acceptance_read(window: WebviewWindow, attempt: String) -> Result<ObsAudioAcceptanceStatus, AppError> {
    validate(&window, &attempt)?;
    registry().lock().map_err(|_|AppError::internal("Audio test state unavailable"))?.entries.get(&attempt)
        .map(|entry|entry.state.clone()).ok_or_else(||AppError::invalid("Unknown audio test attempt"))
}
#[tauri::command]
pub fn obs_audio_acceptance_cancel(window: WebviewWindow, attempt: String) -> Result<(), AppError> {
    validate(&window, &attempt)?;
    registry().lock().map_err(|_|AppError::internal("Audio test state unavailable"))?
        .cancel(&attempt).map_err(AppError::invalid)
}
/// App shutdown only cancels observers/reference children, never their source.
pub fn cancel_all() {
    if let Ok(mut registry) = registry().lock() {
        registry.quarantined = true;
        for entry in registry.entries.values() { entry.cancel.store(true, Ordering::Release); }
    }
}

async fn owned_window(window: WebviewWindow) -> Result<u32, &'static str> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let owner = window.clone();
    window.run_on_main_thread(move || {
        // The handle comes from this actual app's main WebviewWindow. No title
        // matching, broad discovery or renderer-supplied window/PID is involved.
        let result = owner.ns_window().ok().filter(|pointer|!pointer.is_null()).and_then(|pointer| {
            let object = pointer.cast::<objc2::runtime::AnyObject>();
            let visible: bool = unsafe { objc2::msg_send![object, isVisible] };
            let number: isize = unsafe { objc2::msg_send![object, windowNumber] };
            visible.then(||u32::try_from(number).ok()).flatten().filter(|number|*number > 0)
        }).ok_or("own_window_unavailable");
        let _ = sender.send(result);
    }).map_err(|_| "own_window_unavailable")?;
    tokio::time::timeout(Duration::from_secs(2), receiver).await
        .map_err(|_| "own_window_unavailable")?.map_err(|_| "own_window_unavailable")?
}
fn verdict(system_audio: bool, capture: &ObsAudioSpectrum, reference: &ObsAudioSpectrum) -> &'static str {
    // Without actual capturable own-window sound, absence in the production
    // stream says nothing about exclusion (autoplay could have been blocked).
    // A reference may include the external source too; its purpose is a
    // positive own-tone control, not a second implementation of isolation.
    let reference_verified = reference.frames == 240_000 && reference.sample_rate == 48_000 &&
        reference.channels.len() == 2 && reference.channels.iter().enumerate().all(|(channel, metrics)| {
            let own = metrics.minimum_tone[2 + channel];
            own.is_finite() && own > 0.004
        });
    let accepted = if system_audio { spectrum::isolated(capture, 0) } else { spectrum::silent(capture) };
    if !reference_verified { "inconclusive" } else if accepted { "passed" } else { "failed" }
}
async fn measure(app: AppHandle, window: WebviewWindow, program: Arc<Program>, attempt: &str,
    cancel: Arc<AtomicBool>) -> Result<ObsAudioAcceptanceReport, &'static str> {
    if cancel.load(Ordering::Acquire) { return Err("cancelled"); }
    if session::ndi_room_generation(&app).await.is_some() { return Err("leave_session_before_test"); }
    let own = owned_window(window).await?;
    let system_audio = selected(&program)?;
    if cancel.load(Ordering::Acquire) { return Err("cancelled"); }
    let work = async { tokio::join!(observation::capture_audio(program.clone(), cancel.clone()),
        observation::reference_audio(own, attempt, cancel.clone())) };
    tokio::pin!(work);
    let mut interval = tokio::time::interval(Duration::from_millis(100));
    let (capture, reference) = loop {
        tokio::select! {
            result = &mut work => break result,
            _ = interval.tick() => {
                if selected(&program) != Ok(system_audio) || session::ndi_room_generation(&app).await.is_some() {
                    cancel.store(true, Ordering::Release);
                }
            }
        }
    };
    // Both branches have confirmed their child cleanup before reaching here.
    // One unconfirmed cleanup outranks cancellation or an otherwise good sample.
    if capture.as_ref().err() == Some(&"cleanup_unconfirmed") || reference.as_ref().err() == Some(&"cleanup_unconfirmed") {
        return Err("cleanup_unconfirmed");
    }
    if cancel.load(Ordering::Acquire) { return Err("cancelled"); }
    let captured = capture?;
    let reference = reference?;
    tokio::task::spawn_blocking(move || {
        let capture = spectrum::analyze(&captured)?;
        let reference = spectrum::analyze(&reference)?;
        Ok(ObsAudioAcceptanceReport { system_audio, verdict: verdict(system_audio, &capture, &reference).into(), capture, reference })
    }).await.map_err(|_| "analysis_unavailable")?
}

#[cfg(test)]
mod tests {
    use super::*;
    fn metrics(pair: Option<usize>) -> ObsAudioSpectrum {
        ObsAudioSpectrum { frames:240_000, sample_rate:48_000, channels:(0..2).map(|channel| {
            let mut tones = [0.0;4]; if let Some(pair) = pair { tones[pair * 2 + channel] = 0.01; }
            spectrum::ObsAudioChannelMetrics { rms:if pair.is_some() { 0.007 } else { 0.0 },
                longest_quiet_ms:if pair.is_some() { 0.02 } else { 5000.0 }, minimum_tone:tones, maximum_tone:tones }
        }).collect() }
    }
    #[test]
    fn a_silent_or_incomplete_reference_never_proves_self_audio_exclusion() {
        let external = metrics(Some(0)); let silence = metrics(None);
        assert_eq!(verdict(true, &external, &silence), "inconclusive");
        assert_eq!(verdict(false, &silence, &silence), "inconclusive");
        let mut own = metrics(Some(1));
        assert_eq!(verdict(true, &external, &own), "passed");
        assert_eq!(verdict(false, &silence, &own), "passed");
        assert_eq!(verdict(true, &silence, &own), "failed");
        assert_eq!(verdict(false, &external, &own), "failed");
        own.channels[1].minimum_tone[3] = 0.0;
        assert_eq!(verdict(true, &external, &own), "inconclusive");
        own.channels[1].minimum_tone[3] = f64::INFINITY;
        assert_eq!(verdict(true, &external, &own), "inconclusive");
    }
    #[test]
    fn own_reference_is_a_positive_control_not_a_second_isolation_test() {
        let external = metrics(Some(0)); let mut own = metrics(Some(1));
        for channel in 0..2 {
            own.channels[channel].minimum_tone[channel] = 0.01;
            own.channels[channel].maximum_tone[channel] = 0.01;
        }
        assert_eq!(verdict(true, &external, &own), "passed");
        own.frames -= 1;
        assert_eq!(verdict(true, &external, &own), "inconclusive");
    }
    #[test]
    fn cancellation_before_start_is_a_permanent_bounded_tombstone() {
        let mut registry = Registry::default();
        registry.cancel("first").unwrap();
        assert_eq!(registry.reserve("first").unwrap_err(), "attempt_already_used");
        assert_eq!(registry.entries["first"].state.phase, "cancelled");
        for index in 1..MAX_ATTEMPTS { registry.cancel(&index.to_string()).unwrap(); }
        assert_eq!(registry.reserve("fresh").unwrap_err(), "diagnostic_attempt_limit");
    }
    #[test]
    fn only_exact_attempt_cancels_and_capacity_waits_for_cleanup() {
        let mut registry = Registry::default();
        let running = registry.reserve("first").unwrap();
        registry.cancel("other").unwrap();
        assert!(!running.load(Ordering::Acquire));
        registry.cancel("first").unwrap();
        assert!(running.load(Ordering::Acquire));
        assert_eq!(registry.reserve("second").unwrap_err(), "measurement_busy");
        registry.finish("first", Err("cancelled"));
        assert_eq!(registry.entries["first"].state.phase, "cancelled");
        assert!(registry.reserve("second").is_ok());
    }
    #[test]
    fn unconfirmed_cleanup_quarantines_the_harness_even_when_cancelled() {
        let mut registry = Registry::default();
        registry.reserve("first").unwrap(); registry.cancel("first").unwrap();
        registry.finish("first", Err("cleanup_unconfirmed"));
        assert_eq!(registry.entries["first"].state.phase, "failed");
        assert_eq!(registry.reserve("second").unwrap_err(), "cleanup_unconfirmed");
    }
}
