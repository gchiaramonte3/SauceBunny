# Native marker guest acceptance

This test app runs the production frontend, Rust session transport and native
file persistence in a second, independently identified WKWebView process.
It is not a mocked networking fixture and does not replace the installed app.

Run `SAUCE_NDI_SDK_DIR='/Library/NDI SDK for Apple' bash scripts/build-marker-guest-test.sh --debug`.
Verify the built Info.plist identifier is `com.saucebunny.marker-guest-test`
and URL schemes are empty before launching. Camera/mic preferences are seeded
off, no source is loaded automatically, and hosting/host identity access are
disabled. All test rooms and joins still require explicit UI actions.

The only IPC adapter reroutes the default library root to the fresh temporary
directory printed by the script, and blocks host identity/hosting commands.
This is necessary because a separate bundle identifier isolates app data and
WebKit storage, but production Reviews/Screenings/Casts live in Documents.
Actual read/write commands, session protocol/events, durable review commits,
and guest receipts are not replaced. Do not import this adapter in production.

Join the disposable host test room through the normal Join screen. Verify
bound names/IDs, post an explicitly opted-in timeline note, check Premiere's
pending queue, confirm one insertion, undo it, and explicitly reconcile.
Check that both host and guest receive the result. Repeat with late join and
reconnect, without duplicate insertion. Never bind or mutate an original
project. Test records stay in the temporary directory; no cleanup is automatic.

Two processes on one Mac prove real host/guest transport, not two-machine
discovery, NAT traversal, WAN performance, or sound reaching external speakers.
