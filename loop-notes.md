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

### Pending a fact CI did not record: the single `#[allow]` looks stale

`src-tauri/src/commands/download.rs:678` carries
`#[allow(clippy::unnecessary_map_or)]`, justified by the crate's declared
`rust-version = "1.77.2"` against `is_none_or` stabilising in 1.82 — the lint
used to suggest an API the MSRV forbids.

Removed it locally and clippy said nothing. Under **clippy 0.1.95** the lint is
MSRV-aware and no longer suggests `is_none_or` below 1.82, so the allow is doing
no work. The lint fixed itself.

Not removed, because removing it is only safe if CI's clippy is at least that
new, and **CI never printed its toolchain**, so there was no way to know. That
gap is now closed: the `cargo-check` job runs `rustc --version && cargo clippy
--version` before the lint step. Once a run records a version ≥ 0.1.95, delete
the attribute and its comment; if the runner is older, keep both and this note
explains why.

### Closed off, so nobody re-checks

- **No `[features]` section and zero `cfg(feature = …)` sites**, so
  `--all-features` would widen clippy's coverage by nothing. That avenue is
  genuinely empty rather than untried.
- Every other `cfg` gate is `cfg(unix)` or `cfg(target_os = "macos")`, both true
  on the CI runner, so all of that code is compiled and linted.
- **A clippy run that reports zero twice in a row proves nothing** — the second
  is cached and re-emits no diagnostics for an unchanged crate. Every baseline
  in this loop was taken after `touch src/lib.rs` or `cargo clean -p`.
