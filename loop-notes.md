# loop-notes.md

Things a loop found and deliberately did **not** change, with the reason. A
loop's mandate is narrow; this file is where the things outside it go so they
are neither silently done nor silently lost.

---

## Loop 1 — clippy warnings to zero

**Outcome: the goal was already met.** `cargo clippy --all-targets -- -D warnings`
exits 0 from a cleaned crate, and that is real rather than suppressed: no
crate-level `allow`, no `clippy.toml`, no `[lints]` section, and exactly one
`#[allow(clippy::…)]` in the tree — at its site, justified by the declared MSRV
of 1.77.2 against `is_none_or` stabilising in 1.82. No warning clusters existed
to fix, so no iteration of the fix loop ever ran.

The one actionable item was the loop's closing instruction, and it found a real
gap: CI ran `cargo clippy -- -D warnings` **without `--all-targets`**, so the
~264 unit tests in `#[cfg(test)]` modules had never been linted. Fixed in
`dc8f3c7`.

### Declined: two `#[cfg(not(target_os = "macos"))]` blocks

`src-tauri/src/commands/system.rs` — the non-macOS arms of
`av_permission_status()` (returns all-`authorized`) and `read_clipboard_text()`
(returns `""`).

On macOS these never compile, so clippy never lints them **and rustc never type
checks them**. Since macOS is the only platform this app supports and CI's only
runner, that is permanently true: the two blocks could rot into
non-compiling code and nothing in the repo would notice. By the letter of
CLAUDE.md — "No dead code", "No Windows/Linux builds" — they are dead.

Not removed, because that is a decision about whether the crate should still
build on a non-macOS machine, not a lint fix, and a linting loop is the wrong
authority for it. Both stubs are eight lines total and trivially correct, so
the practical rot risk today is near zero.

To decide: if the crate is meant to stay `cargo check`-able off macOS, keep
them and accept that they are unverified. If not, delete both and let a
non-macOS build fail honestly at the missing function.

### Resolved: the last `#[allow]` in the crate is gone

`src-tauri/src/commands/download.rs` carried
`#[allow(clippy::unnecessary_map_or)]`, justified by the crate's declared
`rust-version = "1.77.2"` against `is_none_or` stabilising in 1.82 — the lint
used to suggest an API the MSRV forbids.

Removing it locally produced no warning: clippy became MSRV-aware and stopped
suggesting `is_none_or` below 1.82. The lint fixed itself. The blocker was that
deleting the attribute is only safe if CI's clippy is at least that new, and the
workflow had never printed its toolchain — so the version step went in first,
and the next run recorded **rustc 1.97.1 / clippy 0.1.97**, newer than the 0.1.95
the behaviour was observed on. Attribute deleted; `src-tauri/src` now contains
zero `#[allow]` of any kind.

The comment stayed, trimmed. Its core claim — use `map_or(true, …)` rather than
`is_none_or` because of the MSRV — is still true and still the reason the code
is shaped that way. Only the sentence about needing an attribute was stale.

### Closed off, so nobody re-checks

- **No `[features]` section and zero `cfg(feature = …)` sites**, so
  `--all-features` would widen clippy's coverage by nothing. That avenue is
  genuinely empty rather than untried.
- Every other `cfg` gate is `cfg(unix)` or `cfg(target_os = "macos")`, both true
  on the CI runner, so all of that code is compiled and linted.
- **A clippy run that reports zero twice in a row proves nothing** — the second
  is cached and re-emits no diagnostics for an unchanged crate. Every baseline
  in this loop was taken after `touch src/lib.rs` or `cargo clean -p`.
