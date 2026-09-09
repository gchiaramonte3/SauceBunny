# Companion design contract

The Premiere panel uses the application's [design system](../docs/DESIGN.md),
not Adobe Spectrum or a new theme. Its stylesheet imports the actual
`src/styles/tokens.css`; values are not copied into a second palette.

## Adopted recipes

- Neutral dark surfaces, Nunito Sans first, existing 11px body / 12px command
  / 13px section / 18px panel-title roles, and loaded 400/600/700 weights.
- Normal commands use the app's raised/hover/pressed bevel tokens; primary
  commands use neutral `--bg-4`, never a green or violet CTA. Labels stay in
  sentence case. Buttons have a 30px minimum height, grow for wrapping labels,
  and retain a 24px minimum width.
- A 13px native checkbox sits in a clickable 30px-minimum label, with dark
  `--bg-5` accent and white check where the host supports accent-color.
- Browser focus is white and brightens the existing control border. Only the small
  checkbox adds an outside outline; fields/buttons must not grow double rings.
  Disabled controls are explicitly disabled; passive connection text is not
  a command. Error text uses `--danger-text`.
- Names, notes and commands wrap in a 280px docked panel, including enlarged
  text. Content scrolls vertically. No animation, added media or automatic
  connection is introduced by this visual layer.

## Native UXP exceptions

The native host paints built-in input/button chrome. Inside UXP only, remove
the CSS border, bevel, background and padding that otherwise overlay a second
outline. Keep the real native controls and their keyboard/focus behavior.
The browser fixture retains the application bevel recipe; it cannot verify
Adobe's internal control painting. Native focus uses Adobe's own treatment,
including its blue highlight. Labels explicitly align left in both.

Pairing is one masked field and one Connect command. Settings copies a single
versioned code containing loopback port, expiry and secret. Pasting never
connects automatically. Hide empty note/binding controls until connected,
but retain queued notes after disconnect. Never show raw endpoint/secret
fields or add decorative icons/dividers to the connection form.

UXP is not Chromium. Adobe documents that text edit fields cannot override
font-family; missing families fall back to the host font. Nunito Sans is
requested through the same app token, but exact font parity requires a host
that has that family available. We do not silently install a system font,
load remote fonts, or claim a browser screenshot proves native font rendering.
[Adobe font-family reference](https://developer.adobe.com/premiere-pro/uxp/uxp-api/reference-css/styles/font-family)

The manifest explicitly enables Adobe's `CSSNextSupport: ["boxShadow"]` for
the shared bevel recipe. Borders/gradients remain useful if the host omits
shadow or outline paint. CSS variables are supported; browser-only niceties
such as accent-color and overflow-wrap need the actual Premiere host gate.
No framework or broad webview/network permission is added.
[Adobe CSS support](https://developer.adobe.com/premiere-pro/uxp/uxp-api/changelog3-p)

## Verification

`npm run check` runs type, behavior and design contracts. `npm run ccx` checks
the manifest and package. `npm run test:package` exercises the built panel at
280/340px, normal/enlarged text, disconnected/connected/pending/error states,
keyboard focus, hit areas and no automatic connection with isolated host
fixtures. These are browser checks, not a real Premiere or VoiceOver sign-off.

September 8 native 0.1.5 verification confirmed the masked single field, left
alignment, reduced chrome and mouse-activated invalid-code feedback. Native
keyboard acceptance remains open: Space activated Premiere playback despite
the React event guard. Playback was stopped and the original playhead restored.
Use the mouse for Connect while this host-keyboard issue remains unresolved.

No Generate, Speaker, Export or transport controls belong in this companion;
their specialized app recipes remain untouched. Installation does not enable
NDI sharing or automatic marker placement.
