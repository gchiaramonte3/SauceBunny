//! Coalesce matching acquisitions, including failures, without persisting URLs.
use std::{collections::HashMap, future::Future, sync::{Arc, Mutex}, time::{Duration, Instant}};
type Outcome<T> = Option<(Instant, Result<T, crate::AppError>)>;
type Slot<T> = Arc<tokio::sync::Mutex<Outcome<T>>>;
pub struct AcquisitionGate<T> { slots: Mutex<HashMap<String, Slot<T>>> }
impl<T: Clone> Default for AcquisitionGate<T> { fn default() -> Self { Self { slots: Mutex::new(HashMap::new()) } } }
impl<T: Clone> AcquisitionGate<T> {
    pub async fn run<F: Future<Output = Result<T, crate::AppError>>>(&self, key: String, operation: impl FnOnce() -> F) -> Result<T, crate::AppError> {
        let slot = {
            let mut slots = self.slots.lock().map_err(|_| crate::AppError::internal("Acquisition gate unavailable"))?;
            if !slots.contains_key(&key) && slots.len() >= 32 {
                slots.retain(|_, slot| Arc::strong_count(slot) > 1);
                if slots.len() >= 32 { return Err(crate::AppError::internal("Too many pending source acquisitions")); }
            }
            slots.entry(key).or_default().clone()
        };
        let mut state = slot.lock().await;
        if let Some((at, result)) = &*state {
            // Coalesce a burst; respect a server rate-limit for at least a minute.
            // No automatic retry is scheduled when this cache expires.
            let delay = if result.as_ref().err().is_some_and(|e| e.to_string().contains("429")) { 60 } else { 2 };
            if at.elapsed() < Duration::from_secs(delay) { return result.clone(); }
        }
        let result = operation().await;
        *state = Some((Instant::now(), result.clone()));
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test] async fn duplicate_requests_share_one_result_including_failure() {
        let gate = AcquisitionGate::<u32>::default();
        let count = std::sync::atomic::AtomicUsize::new(0);
        let run = || gate.run("source-target".into(), || async {
            count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            tokio::task::yield_now().await;
            Err(crate::AppError::Network("HTTP 429".into()))
        });
        let (a, b) = tokio::join!(run(), run());
        assert!(a.is_err() && b.is_err());
        assert_eq!(count.load(std::sync::atomic::Ordering::SeqCst), 1);
    }
}
