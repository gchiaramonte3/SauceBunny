//! Public native-service checks. These do not capture or request permission.
use sauce_bunny_lib::obs;

#[test]
fn runtime_presence_is_not_silently_reported_as_capture_success() {
    let state = obs::obs_preflight();
    assert_eq!(state.available, state.error.is_none());
}

#[tokio::test]
async fn invalid_application_cannot_start_discovery() {
    for application in ["", "--all", "/Applications/Editor.app", "com.editor\n"] {
        assert!(obs::obs_windows(application.into()).await.is_err());
    }
}

#[test]
fn raw_output_requires_an_existing_capture_and_never_starts_one_implicitly() {
    for id in ["", "--all", "../../file", "00000000000000000000000000000000"] {
        assert!(obs::begin_raw_output(id).is_err());
        assert!(obs::prepare_raw_output(id).is_err());
        assert!(obs::begin_broadcast(id).is_err());
    }
}
