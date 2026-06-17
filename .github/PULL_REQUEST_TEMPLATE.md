## What & why

## Checks

- [ ] `npx tsc --noEmit`
- [ ] `npm test`
- [ ] `cd src-tauri && cargo test --lib`
- [ ] `cd swift-sidecar && swift build` (if Swift touched)
- [ ] Build-ID bumped in BOTH `src/lib/build-id.ts` and `src-tauri/src/commands/system.rs` (if the invoke surface changed)

## Manual smoke-test performed

Describe what you exercised in the running app (playback / transcript / export …).
