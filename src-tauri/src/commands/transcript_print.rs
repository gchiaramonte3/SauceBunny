//! Read-only, script-disabled transcript print preview. No files, media, IPC
//! grants, external navigation or automatic printer submission.
use crate::AppError;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};
use tauri::{webview::PageLoadEvent, AppHandle, WebviewUrl, WebviewWindowBuilder};

#[cfg(target_os = "macos")]
mod native_pdf {
    use super::*;
    use objc2::{define_class, msg_send, sel, rc::Retained, runtime::{AnyObject, ProtocolObject}, MainThreadMarker, MainThreadOnly};
    use objc2_app_kit::{NSPrintInfo, NSPrintOperation, NSPrintingPaginationMode, NSPrintJobSavingURL, NSPrintSaveJob};
    use objc2_foundation::{NSObject, NSObjectProtocol, NSString, NSURL, NSSize, NSRect, NSPoint};
    type Sender = tokio::sync::oneshot::Sender<Result<(), AppError>>;

    define_class!(
        // SAFETY: NSObject has no additional subclass requirements.
        #[unsafe(super = NSObject)]
        #[thread_kind = MainThreadOnly]
        struct PdfPrintDelegate;
        unsafe impl NSObjectProtocol for PdfPrintDelegate {}
        impl PdfPrintDelegate {
            // SAFETY: This is the documented AppKit print completion signature.
            #[unsafe(method(printOperationDidRun:success:contextInfo:))]
            fn completed(&self, _operation: &NSPrintOperation, success: bool, context: *mut std::ffi::c_void) {
                // The context retains this delegate until AppKit's single completion.
                // SAFETY: Only render() creates this pointer, once per operation.
                let context = unsafe { Box::from_raw(context.cast::<Completion>()) };
                let result = if success { Ok(()) } else { Err(AppError::internal("PDF export did not finish. The destination file was not changed.")) };
                let _ = context.sender.send(result);
            }
        }
    );
    struct Completion { _delegate: Retained<PdfPrintDelegate>, sender: Sender }

    // WebKit's synchronous runOperation() treats an unresolved page count as
    // NSIntegerMax. Use its asynchronous, separate-thread print path so page
    // geometry arrives over WebKit IPC before any pages are rendered.
    pub(super) fn render(view: tauri::webview::PlatformWebview, path: &str, sender: Sender) {
        let Some(main) = MainThreadMarker::new() else {
            let _ = sender.send(Err(AppError::internal("PDF printing requires the main thread")));
            return;
        };
    // SAFETY: with_webview runs on the main thread and owns the live WKWebView.
    // Selectors and dictionary keys are public AppKit/WebKit APIs; the only
    // destination is our private staging file, never the final user file.
    unsafe {
        let info = NSPrintInfo::new();
        info.setPaperSize(NSSize::new(612.0, 792.0));
        info.setTopMargin(54.0); info.setBottomMargin(54.0);
        info.setLeftMargin(54.0); info.setRightMargin(54.0);
        info.setHorizontalPagination(NSPrintingPaginationMode::Fit);
        info.setVerticalPagination(NSPrintingPaginationMode::Automatic);
        info.setJobDisposition(NSPrintSaveJob);
        let url = NSURL::fileURLWithPath(&NSString::from_str(path));
        info.dictionary().setObject_forKey(&url, ProtocolObject::from_ref(NSPrintJobSavingURL));
        let webview = &*(view.inner() as *const AnyObject);
        let window: Option<Retained<objc2_app_kit::NSWindow>> = msg_send![webview, window];
        let Some(window) = window else {
            let _ = sender.send(Err(AppError::internal("The PDF preview window is unavailable")));
            return;
        };
        let operation: Retained<NSPrintOperation> = msg_send![webview, printOperationWithPrintInfo: &*info];
        if let Some(print_view) = operation.view() {
            print_view.setFrame(NSRect::new(NSPoint::new(0.0, 0.0), NSSize::new(780.0, 900.0)));
        }
        operation.setCanSpawnSeparateThread(true);
        operation.setShowsPrintPanel(false);
        operation.setShowsProgressPanel(false);
        let delegate: Retained<PdfPrintDelegate> = msg_send![PdfPrintDelegate::alloc(main), init];
        let context = Box::new(Completion { _delegate: delegate.clone(), sender });
        operation.runOperationModalForWindow_delegate_didRunSelector_contextInfo(
            &window, Some(&delegate), Some(sel!(printOperationDidRun:success:contextInfo:)), Box::into_raw(context).cast());
    }
    }
}

/// Resolve only after a complete PDF has been atomically written. Print remains
/// a separate command; cancelling Save As never reaches this command.
#[tauri::command]
pub async fn export_transcript_pdf(app: AppHandle, html: String, path: String) -> Result<(), AppError> {
    // AppKit has one current print operation. Fail clearly instead of nesting
    // simultaneous exports and mixing their page geometry or completion.
    static PDF_EXPORT: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(1);
    let _permit = PDF_EXPORT.try_acquire().map_err(|_| AppError::invalid("A PDF export is already in progress"))?;
    let destination = std::path::Path::new(&path);
    if !destination.is_absolute() || destination.extension().and_then(|s| s.to_str()).map(|s| s.eq_ignore_ascii_case("pdf")) != Some(true) {
        return Err(AppError::invalid("Choose an absolute PDF filename in Save As"));
    }
    let (url, html) = print_document(&html)?;
    let allowed = url.clone(); let printable = url.clone();
    let serial = NEXT_PRINT_WINDOW.fetch_add(1, Ordering::Relaxed);
    let staging = std::env::temp_dir().join(format!("saucebunny-pdf-{}-{serial}", std::process::id()));
    // create_dir (not create_dir_all) refuses a pre-existing staging directory.
    std::fs::create_dir(&staging).map_err(|e| AppError::internal(e.to_string()))?;
    struct Staging(std::path::PathBuf);
    impl Drop for Staging { fn drop(&mut self) { let _ = std::fs::remove_file(self.0.join("transcript.pdf")); let _ = std::fs::remove_dir(&self.0); } }
    let _cleanup = Staging(staging.clone());
    let pdf = staging.join("transcript.pdf"); let output = pdf.to_string_lossy().to_string();
    let (send, mut receive) = tokio::sync::oneshot::channel();
    let pending = Arc::new(Mutex::new(Some(send)));
    let pending_page = Arc::clone(&pending);
    let window = WebviewWindowBuilder::new(&app, format!("transcript-pdf-{serial}"), WebviewUrl::External(blank_url()?))
        .title("Export transcript PDF").inner_size(780.0, 900.0).visible(false).disable_javascript()
        .on_navigation(move |url| url.as_str() == "about:blank" || is_print_document(url, &allowed))
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .on_page_load(move |window, payload| {
            if payload.event() != PageLoadEvent::Finished || !is_print_document(payload.url(), &printable) { return; }
            let sender = pending_page.lock().ok().and_then(|mut p| p.take());
            if let Some(sender) = sender {
                let output = output.clone();
                // A dispatch error drops the sender, so receive also fails.
                // Leave WebKit's load callback before starting an AppKit print
                // operation; printing needs subsequent WebKit IPC delivery.
                tauri::async_runtime::spawn(async move {
                    let _ = window.with_webview(move |view| native_pdf::render(view, &output, sender));
                });
            }
        }).build().map_err(|e| AppError::internal(e.to_string()))?;
    load_print_document(&window, html, url).await?;
    let received = match tokio::time::timeout(std::time::Duration::from_secs(30), &mut receive).await {
        Ok(result) => result,
        Err(_) => {
            // Only time out a renderer that has not started. Never remove its
            // staging file or destroy WebKit while an active print is writing.
            let not_started = pending.lock().map(|mut p| p.take().is_some()).unwrap_or(false);
            if not_started {
                let _ = window.close();
                return Err(AppError::internal("The PDF preview could not load. Try again or export plain text."));
            }
            receive.await
        }
    };
    let result = received.map_err(|_| AppError::internal("The PDF renderer could not start"));
    let _ = window.close(); result??;
    let bytes = std::fs::read(&pdf).map_err(|e| AppError::internal(format!("Could not read the completed PDF: {e}")))?;
    if bytes.len() < 100 || !bytes.starts_with(b"%PDF-") { return Err(AppError::internal("The PDF renderer did not produce a valid document")); }
    super::system::write_bytes_impl(&path, &bytes, false, false, true)?;
    Ok(())
}

static NEXT_PRINT_WINDOW: AtomicU64 = AtomicU64::new(1);

fn print_document(html: &str) -> Result<(tauri::Url, String), AppError> {
    if html.len() > 32 * 1024 * 1024 || !html.contains("<head>") {
        return Err(AppError::invalid(
            "Transcript print document is invalid or too large",
        ));
    }
    let mut nonce = [0u8; 32];
    getrandom::getrandom(&mut nonce).map_err(|e| AppError::internal(format!("Could not secure the print document: {e}")))?;
    let nonce = hex::encode(nonce);
    let html = html.replacen("<head>", "<head><meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; form-action 'none'; base-uri 'none'\">", 1);
    let url = tauri::Url::parse(&format!("saucebunny-print://document/{nonce}/"))
        .map_err(|e| AppError::internal(e.to_string()))?;
    Ok((url, html))
}

fn is_print_document(url: &tauri::Url, expected: &tauri::Url) -> bool {
    url == expected
}

fn blank_url() -> Result<tauri::Url, AppError> {
    tauri::Url::parse("about:blank").map_err(|error| AppError::internal(error.to_string()))
}

async fn load_print_document(window: &tauri::WebviewWindow, html: String, url: tauri::Url) -> Result<(), AppError> {
    // Load the already restricted HTML directly. Tauri rewrites data URLs into
    // unescaped HTML; CSS '#' and source text can then truncate the document.
    // This private base URL is an identity only: no protocol serves it, no
    // filesystem permission or IPC capability is granted to print windows.
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let result = window.with_webview(move |view| {
        use objc2::{msg_send, rc::Retained, runtime::AnyObject};
        use objc2_foundation::{NSString, NSURL};
        // SAFETY: with_webview dispatches to the main thread. Public WebKit API;
        // both NSString arguments stay alive for the duration of the call.
        unsafe {
            let webview = &*(view.inner() as *const AnyObject);
            let Some(base) = NSURL::URLWithString(&NSString::from_str(url.as_str())) else {
                let _ = sender.send(Err(AppError::internal("WebKit could not open the private print document")));
                return;
            };
            let _: Option<Retained<AnyObject>> = msg_send![webview, loadHTMLString: &*NSString::from_str(&html), baseURL: &*base];
        }
        let _ = sender.send(Ok(()));
    });
    if let Err(error) = result { let _ = window.close(); return Err(AppError::internal(error.to_string())); }
    let result = receiver.await.map_err(|_| AppError::internal("The print document could not be loaded")).and_then(|result| result);
    if result.is_err() { let _ = window.close(); }
    result
}

#[tauri::command]
pub async fn print_transcript(app: AppHandle, html: String) -> Result<(), AppError> {
    let (url, html) = print_document(&html)?;
    let allowed = url.clone();
    let printable = url.clone();
    let (send, receive) = tokio::sync::oneshot::channel();
    let pending = Arc::new(Mutex::new(Some(send)));
    let label = format!("transcript-print-{}", NEXT_PRINT_WINDOW.fetch_add(1, Ordering::Relaxed));
    let window = WebviewWindowBuilder::new(&app, label, WebviewUrl::External(blank_url()?))
        .title("Transcript · Print / Save as PDF")
        .inner_size(780.0, 900.0)
        .disable_javascript()
        .on_navigation(move |url| url.as_str() == "about:blank" || is_print_document(url, &allowed))
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .on_page_load(move |window, payload| {
            if payload.event() != PageLoadEvent::Finished || !is_print_document(payload.url(), &printable) {
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
    load_print_document(&window, html, url).await?;
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
        let (url, html) = print_document("<!doctype html><html><head><title>Test</title><style>body{color:#111}</style></head><body>Transcript #1 100% café 東京</body></html>").unwrap();
        assert_eq!(url.scheme(), "saucebunny-print");
        assert!(html.find("default-src 'none'").unwrap() < html.find("<title>").unwrap());
        assert!(html.contains("form-action 'none'"));
        assert!(html.contains("body{color:#111}"));
        assert!(html.contains("Transcript #1 100% café 東京"));
        assert!(print_document("missing head").is_err());
    }

    #[test]
    fn only_the_private_print_document_can_start_printing() {
        let (url, _) = print_document("<html><head></head><body>Transcript</body></html>").unwrap();
        assert!(is_print_document(&url, &url));
        assert!(!is_print_document(&print_document("<head></head>").unwrap().0, &url));
        let remote = tauri::Url::parse("https://example.invalid").unwrap();
        assert!(!is_print_document(&remote, &url));
        assert!(!is_print_document(&blank_url().unwrap(), &url));
    }
}
