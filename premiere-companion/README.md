# Sauce Bunny Premiere companion

Beta connection and **editor-confirmed sequence marker proof** for
Premiere Pro 2026 **26.3.2**. This is not a frame-accurate automatic NDI marker
integration. No companion is needed on a reviewer's machine.

Selected project/sequence names and IDs were approved for room sharing on
September 10. The room receiving path is now wired, with private paths and
pairing data excluded. See the [current native verification status](../docs/PREMIERE-LIVE-MARKERS-2026-09-10.md)
before treating this as a fully verified end-to-end live-session feature.

## Foundation and build

This reduced React/TypeScript scaffold uses Hyperbrew's actual Bolt UXP Vite
plugin and CCX packaging pipeline. It was adapted from Bolt UXP 1.3.13,
commit `2c9c53ce9f340a841b519553514d682631fb05af`, with
`vite-uxp-plugin` pinned to 1.3.8 and Adobe's 26.3.0 TypeScript declarations.
Hyperbrew's MIT license is retained in the package. The source of truth for
the local protocol's data models is generated Rust bindings in `../src/bindings/`.

```sh
cd premiere-companion
npm ci --ignore-scripts
npm run check
npm run ccx
npm run test:package
```

Internal installer: `dist/SauceBunnyPremiere.ccx`. The verifier inspects its
manifest, host floor, permissions, license notices and absence of native code.
The desktop DMG build also includes this CCX as a resource; Settings →
Integrations → Install Premiere companion opens it in Creative Cloud.
This is not an automatic installation or a published Adobe Marketplace release.
No Premiere plugin is installed by these
commands. The developer must retain the checked-in `package-lock.json`.

`npm run dev` performs a watched build without a hot-reload socket. Load
`dist/manifest.json` with Adobe UXP Developer Tool and reload explicitly.
Bolt's template hot-reload, webview, IPC, clipboard, full filesystem, process
launch, string-code-generation and hybrid-addon permissions are deliberately
absent. The only network permission is `ws://localhost`; the client accepts
only Sauce Bunny's exact `ws://127.0.0.1:PORT/premiere` input and converts that
validated address to its localhost alias for UXP. It rejects arbitrary hostnames,
credentials and query strings. The desktop listens on IPv4 and IPv6 loopback
at one ephemeral port; the expiring secret is still required.
It does not use `fetch`, remote services or a browser fallback for Adobe APIs.

`npm run test:package` reuses the parent application's Playwright install to
exercise the actual built HTML at 280px and 340px with isolated Adobe stubs.
It checks mounting, keyboard fields, overflow and absence of unsolicited
connections. This is not a substitute for the native UXP acceptance matrix.

## Local editor workflow

### September 10 native receiving follow-up

The installed 0.1.6 companion paired with the updated desktop and received a
saved room note in a disposable project. Capture parked position then failed
before any timeline mutation. Version 0.1.7 awaits native project/sequence
lookups before reading their identity, including a repeated Save As check
across asynchronous boundaries. The regression reproduces the exact prior
undefined `toString` failure. Native capture, one insertion, Undo, and repeated
read-only reconciliation now pass in the disposable project. Check recent
markers updates completed-note status after Undo; it never inserts anything.
The desktop verification notes retain the remaining two-client acceptance gap.

### September 8 host verification

Pairing follow-up: a real, unauthenticated handshake against the running app
returned 101 for `Host: 127.0.0.1:PORT` but 403 for the companion's
`Host: localhost:PORT`. The app now accepts both exact loopback authorities on
its own port, while retaining the Origin, path, secret, expiry and single-client
checks. Real-socket regression tests cover this boundary and rejected hosts.
Companion 0.1.6 preserves network/timeout/acknowledgement errors instead of
overwriting them with “Pairing cancelled”, and a cancelled handshake cannot
disconnect a newer attempt. These changes require the updated app; replacing
the companion alone cannot fix the old app's 403. Packaged native pairing
remains an acceptance gate until a fresh code connects successfully.

Version 0.1.1 corrected the missing plugin/panel lifecycle registration. Creative
Cloud installed it and Premiere rendered the real panel instead of “create method
is not defined for plugin.” Its IP-literal network declaration was then rejected
by the native host. Version 0.1.2 switches to the validated localhost alias and is
also installed/rendering, but authenticated pairing still needs native verification.
The automation approval check stopped creation of a fresh pairing; no marker sync,
sequence binding, publication or timeline edit was performed in this verification.

Version 0.1.5 is now installed and renders one masked pairing-code field with
left-aligned labels and native controls without duplicate CSS borders. Mouse
activation with invalid text correctly shows a local parser error. Authenticated
pairing remains unverified. Native Space activation is not accepted: Premiere
started playback despite the panel's event guard; playback was stopped and the
original playhead restored. Use the mouse for Connect until this is resolved.
The matching app Settings flow passed isolated browser tests, but verification
after the approved native app restart is blocked by a main-thread Keychain wait
while checking the saved review identity. No credentials or Keychain policy
were changed. That debug app bundle contains companion 0.1.4; this standalone
package is 0.1.5. No new DMG was made for this refinement.

The package smoke test now requires matching manifest panel IDs, calls create/show/
hide/destroy hooks, verifies retained draft fields across panel reopen, and ensures
one UI root and no unsolicited connection. These checks supplement, not replace,
the native pairing and marker gates.

1. Open the CCX with Creative Cloud to review Adobe's installation prompt, or
   load the development manifest in UXP Developer Tool. Real CCX installation
   must still be verified on the target Mac; building an archive is not proof
   Adobe accepted it.
2. In Sauce Bunny Settings → Integrations, start **Pair companion**. Copy its
   **pairing code**, paste once into **Pairing code** in this panel, then choose
   **Connect**. Both the app and companion must be updated for this single-code
   flow. The code contains the loopback port, expiry and temporary secret;
   it is masked and cleared from the panel after successful connection. It is
   never placed in a URL, log or local storage. Copying explicitly writes it to
   the system clipboard; do not share it with reviewers.
3. Open a saved project, activate the sequence sending NDI, and choose **Bind
   current sequence**. Binding does not connect or share NDI video.
4. Explicitly enable **Send review notes to Premiere**. General notes remain
   general; only timeline-intent notes already saved by Sauce Bunny are queued.
5. On a pending note, activate and park its bound sequence, choose **Capture
   parked position**, then confirm **Add marker here**. The confirmation shows
   a zero-based sequence frame number and holds the exact tick-string position
   while you decide. It does not pretend the stream clock is sequence timecode.
6. Save the Premiere project as usual. An **Added to Premiere** acknowledgement
   means an undoable in-memory marker transaction, not a disk save.

After a reconnect, binding and sync authority must be restored explicitly.
The panel's private ledger restores a binding ID only for the same local
project path, project GUID, sequence GUID and timing settings. A mismatched
pending note offers **Restore captured binding**. A missing original project
or changed Save As path remains blocked; there is no active-sequence fallback.
Pending notes are paginated, and the current binding is prioritized without
discarding other sequences' notes.

## Safety boundaries

- Snapshots and heartbeats cannot insert markers. Only a matching response to
  this panel's explicit confirmation reaches the Adobe write path.
- Notes are bound to their captured project/sequence identity, never names.
  Paths remain in private plugin storage and do not cross the local bridge.
- Tick positions stay decimal strings. Frame alignment uses integer arithmetic,
  not a floating-point conversion or a fixed-latency offset.
- Every marker carries the author, note text and stable
  `[Sauce Bunny note:<identity>]` provenance. Before any creation, the adapter
  checks both provenance and the previously recorded native marker GUID.
- A private pre-transaction ledger entry must persist before the Adobe action.
  Failed storage blocks the write. Lost acknowledgement can reconcile against
  the existing marker. Known removals/Undo are not recreated.
- If a crash leaves a pre-transaction entry but no marker, the outcome remains
  uncertain. This prototype deliberately blocks another creation; do not delete
  the ledger to force a retry. Inspect Premiere and retain the saved note while
  resolving the uncertain outcome. There is no automated ambiguous recovery.
- No playhead, playback, active sequence, other markers, comments or project
  save operation is modified. Marker edits/replies/deletions and structural
  timeline-edit tracking are outside this proof.
- The ledger has a conservative capacity limit and refuses additional writes
  rather than discarding delivery history. Corrupt data is preserved.

## Required real-host acceptance

Unit tests use the published Adobe API surface with isolated mocks. They do
not prove runtime acceptance, CSS/font support or local networking in Adobe's
packaged macOS UXP host. The small panel uses Sauce Bunny tokens and neutral
controls; Nunito Sans uses the application's font token, with a native host
fallback where UXP cannot use it (especially text fields). See [DESIGN.md](DESIGN.md)
for recipes and explicit native exceptions. Do not broaden network or filesystem permissions merely to make a
failed installation test pass.

On a disposable test project, verify CCX installation, localhost pairing,
identity restoration, marker creation, Undo, lost acknowledgements, panel
hiding/docking, workspace switches, sleep and Premiere restart. Confirm marker
creation never changes playback or CTI. Exercise 23.976/24/25/29.97 DF and NDF/
30 fps and 60 fps source through the 30 fps NDI output separately.

Automatic placement remains off in both the panel and native bridge. The NDI
timing probe must establish a displayed-frame → sequence-position mapping
through encode, dropped frames and guest display before that can change.
Source Monitor output and timestamps synthesized from a wall clock are not
verified sequence anchors.

## Primary references

- [Hyperbrew Bolt UXP](https://github.com/hyperbrew/bolt-uxp)
- [Adobe Markers](https://developer.adobe.com/premiere-pro/uxp/ppro-reference/classes/markers)
- [Adobe Marker GUID](https://developer.adobe.com/premiere-pro/uxp/ppro-reference/classes/marker)
- [Project transactions, locking and Save As](https://developer.adobe.com/premiere-pro/uxp/ppro-reference/classes/project)
- [Sequence positions and timing](https://developer.adobe.com/premiere-pro/uxp/ppro-reference/classes/sequence)
- [UXP network permissions](https://developer.adobe.com/premiere-pro/uxp/resources/recipes/network/)
- [Independent CCX distribution](https://developer.adobe.com/premiere-pro/uxp/plugins/distribution/independent-distribution/)
