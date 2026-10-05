//! `asset://`, served off the main thread.
//!
//! Tauri's own handler (tauri 2.11 `protocol/asset.rs`) opens and reads the
//! file on whichever thread the webview asks from, and WKWebView asks from
//! the MAIN thread: every range a `<video>` pulls (up to 1 MB each), and the
//! whole file when a request carries no Range. On a local disk that is a
//! millisecond. On a network volume under load (Avid NEXIS during the working
//! day) it freezes the window, and when the volume stalls the main thread
//! sits in an uninterruptible kernel wait that Force Quit cannot reach. That
//! is the freeze editors reported.
//!
//! This is the same handler (the same scope, ranges, headers and statuses),
//! registered under the same name in `lib.rs` so Tauri never installs its own,
//! with the file work moved to the blocking pool. A slow or stalled read now
//! holds up that one request, not the app. The scope is still Tauri's
//! (`asset_protocol_scope()`), so `allow_asset_read` grants work unchanged.
//!
//! One thing is tighter than Tauri's: only the app's own pages may read files.
//! Tauri answered any webview, including the media resolver's external page
//! (`commands/sniff.rs`), with that page's own origin.
use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use tauri::http::{header::*, Method, Request, Response, StatusCode};
use tauri::{Manager, Runtime, UriSchemeContext, UriSchemeResponder};

/// The most one range request reads, Tauri's cap: WebKit asks for `bytes=0-`
/// and plays from whatever comes back.
const MAX_RANGE: u64 = 1000 * 1024;

/// What sniffing the type reads from the head of the file.
const MAGIC: u64 = 8192;

pub fn handle<R: Runtime>(ctx: UriSchemeContext<'_, R>, request: Request<Vec<u8>>, responder: UriSchemeResponder) {
    // Only this lookup runs on the calling (main) thread; it never touches the disk.
    let origin = ctx.app_handle().get_webview_window(ctx.webview_label())
        .and_then(|window| window.url().ok())
        .and_then(|url| own_origin(&url));
    let app = ctx.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let response = match origin {
            None => plain(StatusCode::FORBIDDEN, "null", String::new()),
            Some(origin) => {
                let scope = app.asset_protocol_scope();
                respond(&request, &origin, |path| scope.is_allowed(path))
                    .unwrap_or_else(|error| plain(StatusCode::INTERNAL_SERVER_ERROR, &origin, error.to_string()))
            }
        };
        responder.respond(response);
    });
}

/// The origin of one of the app's own pages: `tauri://localhost` in a build,
/// the Vite server under `tauri dev`. Anything else reads nothing.
fn own_origin(url: &tauri::Url) -> Option<String> {
    let host = url.host_str()?;
    let own = url.scheme() == "tauri"
        || (tauri::is_dev() && matches!(url.scheme(), "http" | "https") && matches!(host, "localhost" | "127.0.0.1"));
    own.then(|| match url.port() {
        Some(port) => format!("{}://{host}:{port}", url.scheme()),
        None => format!("{}://{host}", url.scheme()),
    })
}

fn plain(status: StatusCode, origin: &str, text: String) -> Response<Vec<u8>> {
    let mut response = Response::new(text.into_bytes());
    *response.status_mut() = status;
    if let Ok(value) = HeaderValue::from_str(origin) { response.headers_mut().insert(ACCESS_CONTROL_ALLOW_ORIGIN, value); }
    response
}

fn read_range(file: &mut File, start: u64, end: u64) -> std::io::Result<Vec<u8>> {
    let mut buffer = Vec::with_capacity((end + 1 - start) as usize);
    file.seek(SeekFrom::Start(start))?;
    file.take(end + 1 - start).read_to_end(&mut buffer)?;
    Ok(buffer)
}

/// The answer to one request, given who may read what. Blocking: it opens and
/// reads the file, so it only ever runs on the blocking pool.
fn respond(request: &Request<Vec<u8>>, origin: &str, allowed: impl Fn(&str) -> bool) -> Result<Response<Vec<u8>>, Box<dyn std::error::Error>> {
    // The path follows the host: asset://localhost/<percent-encoded absolute path>.
    let raw = request.uri().path().get(1..).unwrap_or_default();
    let path = percent_encoding::percent_decode(raw.as_bytes()).decode_utf8_lossy().to_string();
    let response = Response::builder().header(ACCESS_CONTROL_ALLOW_ORIGIN, origin);
    if tauri::path::SafePathBuf::new(path.clone().into()).is_err() || !allowed(&path) {
        return Ok(response.status(StatusCode::FORBIDDEN).body(Vec::new())?);
    }
    let mut file = match File::open(&path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(response.status(StatusCode::NOT_FOUND).body(Vec::new())?),
        Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => return Ok(response.status(StatusCode::FORBIDDEN).body(Vec::new())?),
        Err(error) => return Err(error.into()),
    };
    let len = file.metadata()?.len();
    let mut head = Vec::with_capacity(len.min(MAGIC) as usize);
    (&mut file).take(MAGIC).read_to_end(&mut head)?;
    file.rewind()?;
    let mime = tauri::utils::mime_type::MimeType::parse(&head, &path);

    if let Some(range) = request.headers().get(RANGE).and_then(|value| value.to_str().ok()) {
        let response = response.header(ACCEPT_RANGES, "bytes").header(ACCESS_CONTROL_EXPOSE_HEADERS, "content-range");
        let unsatisfiable = || Response::builder().status(StatusCode::RANGE_NOT_SATISFIABLE).header(CONTENT_RANGE, format!("bytes */{len}")).body(Vec::new());
        let Ok(ranges) = http_range::HttpRange::parse(range, len) else { return Ok(unsatisfiable()?) };
        let ranges: Vec<(u64, u64)> = ranges.iter().filter(|range| range.length > 0)
            .map(|range| (range.start, range.start + range.length - 1))
            .filter(|&(start, end)| start < len && end < len && end >= start)
            .map(|(start, end)| (start, start + (end - start).min(MAX_RANGE - 1)))
            .collect();
        if let [(start, end)] = ranges[..] {
            let body = read_range(&mut file, start, end)?;
            return Ok(response.status(StatusCode::PARTIAL_CONTENT).header(CONTENT_TYPE, &mime)
                .header(CONTENT_RANGE, format!("bytes {start}-{end}/{len}")).header(CONTENT_LENGTH, end + 1 - start).body(body)?);
        }
        if ranges.is_empty() { return Ok(unsatisfiable()?); }
        // Only has to be absent from the bytes it separates; WebKit never asks for two ranges.
        let boundary = format!("{:x}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|time| time.as_nanos()).unwrap_or_default());
        let mut body = Vec::new();
        for (start, end) in ranges {
            write!(body, "\r\n--{boundary}\r\n{CONTENT_TYPE}: {mime}\r\n{CONTENT_RANGE}: bytes {start}-{end}/{len}\r\n\r\n")?;
            body.extend(read_range(&mut file, start, end)?);
        }
        write!(body, "\r\n--{boundary}\r\n")?;
        return Ok(response.status(StatusCode::PARTIAL_CONTENT).header(CONTENT_TYPE, format!("multipart/byteranges; boundary={boundary}")).body(body)?);
    }

    let response = response.header(CONTENT_TYPE, &mime).header(CONTENT_LENGTH, len);
    if request.method() == Method::HEAD { return Ok(response.body(Vec::new())?); }
    let body = if len <= MAGIC { head } else {
        let mut whole = Vec::with_capacity(len as usize);
        file.read_to_end(&mut whole)?;
        whole
    };
    Ok(response.body(body)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(bytes: &[u8]) -> (std::path::PathBuf, String) {
        let dir = std::env::temp_dir().join(format!("asset-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("clip one.mov");
        std::fs::write(&path, bytes).unwrap();
        // What the app sends: convertFileSrc is `asset://localhost/` + encodeURIComponent(path),
        // which escapes the slashes too.
        const URI_COMPONENT: &percent_encoding::AsciiSet = &percent_encoding::NON_ALPHANUMERIC
            .remove(b'-').remove(b'_').remove(b'.').remove(b'!').remove(b'~').remove(b'*').remove(b'\'').remove(b'(').remove(b')');
        let encoded = percent_encoding::utf8_percent_encode(&path.to_string_lossy(), URI_COMPONENT).to_string();
        (path, format!("asset://localhost/{encoded}"))
    }

    fn get(url: &str, range: Option<&str>) -> Request<Vec<u8>> {
        let mut builder = Request::builder().uri(url);
        if let Some(range) = range { builder = builder.header(RANGE, range); }
        builder.body(Vec::new()).unwrap()
    }

    #[test]
    fn a_range_comes_back_as_206_with_its_bytes_capped_at_a_megabyte() {
        let bytes: Vec<u8> = (0..2_500_000u32).map(|i| (i % 251) as u8).collect();
        let (path, url) = file(&bytes);
        let response = respond(&get(&url, Some("bytes=100-199")), "tauri://localhost", |_| true).unwrap();
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.body(), &bytes[100..200]);
        assert_eq!(response.headers()[CONTENT_RANGE], "bytes 100-199/2500000");
        assert_eq!(response.headers()[ACCESS_CONTROL_ALLOW_ORIGIN], "tauri://localhost");
        let open = respond(&get(&url, Some("bytes=0-")), "tauri://localhost", |_| true).unwrap();
        assert_eq!(open.body().len() as u64, MAX_RANGE);
        assert_eq!(open.headers()[CONTENT_RANGE], format!("bytes 0-{}/2500000", MAX_RANGE - 1));
        let past = respond(&get(&url, Some("bytes=3000000-")), "tauri://localhost", |_| true).unwrap();
        assert_eq!(past.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn a_request_with_no_range_gets_the_whole_file_and_head_gets_only_its_length() {
        let (path, url) = file(b"not much of a movie");
        let whole = respond(&get(&url, None), "tauri://localhost", |_| true).unwrap();
        assert_eq!((whole.status(), whole.body().as_slice()), (StatusCode::OK, b"not much of a movie".as_slice()));
        let head = respond(&Request::builder().method(Method::HEAD).uri(&url).body(Vec::new()).unwrap(), "tauri://localhost", |_| true).unwrap();
        assert_eq!(head.headers()[CONTENT_LENGTH], "19");
        assert!(head.body().is_empty());
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
    }

    #[test]
    fn a_path_outside_the_scope_or_missing_is_refused_with_an_empty_body() {
        let (path, url) = file(b"secret");
        let refused = respond(&get(&url, None), "tauri://localhost", |_| false).unwrap();
        assert_eq!(refused.status(), StatusCode::FORBIDDEN);
        assert!(refused.body().is_empty());
        let asked = std::cell::RefCell::new(String::new());
        respond(&get(&url, None), "tauri://localhost", |p| { *asked.borrow_mut() = p.to_string(); true }).unwrap();
        assert_eq!(*asked.borrow(), path.to_string_lossy(), "the scope was asked about a different path than the one read");
        std::fs::remove_dir_all(path.parent().unwrap()).ok();
        let missing = respond(&get(&url, None), "tauri://localhost", |_| true).unwrap();
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn only_the_apps_own_pages_may_read() {
        let origin = |url: &str| own_origin(&tauri::Url::parse(url).unwrap());
        assert_eq!(origin("tauri://localhost/index.html?window=panel").as_deref(), Some("tauri://localhost"));
        assert_eq!(origin("https://www.youtube.com/watch?v=x"), None);
        assert_eq!(origin("about:blank"), None);
    }
}
