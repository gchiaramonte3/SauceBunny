//! Read-only, script-disabled transcript print preview. No files, media, IPC
//! grants, external navigation or automatic printer submission.
use crate::AppError;
use base64::Engine;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};
use tauri::{webview::PageLoadEvent, AppHandle, WebviewUrl, WebviewWindowBuilder};

static NEXT_PRINT_WINDOW: AtomicU64 = AtomicU64::new(1);

fn print_url(html: &str) -> Result<tauri::Url, AppError> {
    if html.len() > 32 * 1024 * 1024 || !html.contains("<head>") {
        return Err(AppError::invalid(
            "Transcript print document is invalid or too large",
        ));
    }
    let html = html.replacen("<head>", "<head><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; form-action 'none'; base-uri 'none'\">", 1);
    let encoded = base64::engine::general_purpose::STANDARD.encode(html);
    tauri::Url::parse(&format!("data:text/html;base64,{encoded}"))
        .map_err(|e| AppError::internal(e.to_string()))
}

#[tauri::command]
pub async fn print_transcript(app: AppHandle, html: String) -> Result<(), AppError> {
    let url = print_url(&html)?;
    let allowed = url.clone();
    let printable = url.clone();
    let (send, receive) = tokio::sync::oneshot::channel();
    let pending = Arc::new(Mutex::new(Some(send)));
    let label = format!("transcript-print-{}", NEXT_PRINT_WINDOW.fetch_add(1, Ordering::Relaxed));
    let window = WebviewWindowBuilder::new(&app, label, WebviewUrl::External(url))
        .title("Transcript · Print / Save as PDF")
        .inner_size(780.0, 900.0)
        .disable_javascript()
        .on_navigation(move |url| url == &allowed)
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .on_page_load(move |window, payload| {
            if payload.event() != PageLoadEvent::Finished || payload.url() != &printable {
                return;
            }
            if let Ok(mut pending) = pending.lock() {
                if let Some(send) = pending.take() {
                    let _ = send.send(
                        window.print().map_err(|e| AppError::internal(e.to_string())),
                    );
                }
            }
        })
        .build()
        .map_err(|e| AppError::internal(e.to_string()))?;
    match tokio::time::timeout(std::time::Duration::from_secs(30), receive).await {
        Ok(Ok(Ok(()))) => Ok(()),
        result => {
            let _ = window.close();
            match result {
                Ok(Ok(Err(error))) => Err(error),
                _ => Err(AppError::internal(
                    "The transcript print preview could not open. Try exporting plain text.",
                )),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn print_content_is_local_and_restricted_before_user_content() {
        let url = print_url("<!doctype html><html><head><title>Test</title></head><body>Transcript</body></html>").unwrap();
        assert_eq!(url.scheme(), "data");
        let decoded = base64::engine::general_purpose::STANDARD
            .decode(url.as_str().split_once(',').unwrap().1)
            .unwrap();
        let html = String::from_utf8(decoded).unwrap();
        assert!(html.find("default-src 'none'").unwrap() < html.find("<title>").unwrap());
        assert!(html.contains("form-action 'none'"));
        assert!(print_url("missing head").is_err());
    }
}
