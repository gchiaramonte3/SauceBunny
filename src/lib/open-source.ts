/**
 * What Sauce Bunny is built on, and where to pay for it.
 *
 * This app is a thin shell over other people's work: a demuxer, a decoder,
 * an extractor, a speech model runner. Most of it is maintained by one or
 * two people, often unpaid. Naming them in an About pane is the least an
 * app that ships their binaries can do; giving a working way to fund them
 * is the useful half.
 *
 * EVERY `fund` URL here comes from the dependency's OWN metadata (npm's
 * `funding` field) or its published project page, not from a guess. A
 * donation link that goes to the wrong person is worse than none - the
 * money leaves and does not arrive - so an entry with no funding route
 * says so instead of inventing one.
 */

export type OpenSourceCredit = {
  name: string;
  /** One line: what this app actually uses it for. */
  role: string;
  /** Project home or source. */
  url: string;
  /** Where to sponsor, when the project publishes a route. */
  fund?: string;
  /** Who to thank, when it is a person rather than a foundation. */
  by?: string;
  /** SPDX-ish, matching THIRD-PARTY-LICENSES.md. */
  license: string;
};

/**
 * Ordered by how much of this app's behaviour each one is responsible for,
 * not alphabetically: someone scanning this should meet the projects doing
 * the heavy lifting first.
 */
export const OPEN_SOURCE_CREDITS: readonly OpenSourceCredit[] = [
  {
    name: "mediabunny",
    by: "Vanilagy",
    role: "Frame-accurate decode, scrubbing, thumbnails and local clip export, in TypeScript. The reason this app can cut without shelling out to ffmpeg.",
    url: "https://mediabunny.dev/",
    fund: "https://github.com/sponsors/Vanilagy",
    license: "MPL-2.0",
  },
  {
    name: "turbores",
    by: "Vanilagy",
    role: "The WASM ProRes decoder behind @mediabunny/prores, roughly 3x faster than ffmpeg on 4K 422 HQ.",
    url: "https://github.com/Vanilagy/turbores",
    fund: "https://github.com/sponsors/Vanilagy",
    license: "MPL-2.0",
  },
  {
    name: "yt-dlp",
    role: "Resolves and downloads web sources, and pulls their captions.",
    url: "https://github.com/yt-dlp/yt-dlp",
    fund: "https://github.com/sponsors/yt-dlp",
    license: "Unlicense",
  },
  {
    name: "FFmpeg",
    role: "Remuxes web streams for playback, cuts clips losslessly, and extracts audio.",
    url: "https://ffmpeg.org/",
    fund: "https://ffmpeg.org/donations.html",
    license: "GPL (this build)",
  },
  {
    name: "whisper.cpp",
    by: "Georgi Gerganov",
    role: "Runs Whisper locally for transcription, with no cloud and no account.",
    url: "https://github.com/ggml-org/whisper.cpp",
    fund: "https://github.com/sponsors/ggerganov",
    license: "MIT",
  },
  {
    name: "llama.cpp",
    by: "Georgi Gerganov",
    role: "Runs the local model behind the AI Summary tab.",
    url: "https://github.com/ggml-org/llama.cpp",
    fund: "https://github.com/sponsors/ggerganov",
    license: "MIT",
  },
  {
    name: "Tauri",
    role: "The desktop shell: a native window, a Rust core, and no bundled browser.",
    url: "https://tauri.app/",
    fund: "https://opencollective.com/tauri",
    license: "MIT / Apache-2.0",
  },
  {
    name: "iroh",
    role: "The QUIC peer-to-peer transport co-review sessions run over.",
    url: "https://www.iroh.computer/",
    license: "MIT / Apache-2.0",
  },
  {
    name: "Vite",
    role: "Builds and serves the frontend.",
    url: "https://vite.dev/",
    fund: "https://github.com/vitejs/vite?sponsor=1",
    license: "MIT",
  },
  {
    name: "React",
    role: "The UI layer, and the reconciler every one of this app's stores is written to work with.",
    url: "https://react.dev/",
    license: "MIT",
  },
  {
    name: "perfect-freehand",
    by: "Steve Ruiz",
    role: "Turns pointer input into the annotation strokes you draw over a frame.",
    url: "https://github.com/steveruizok/perfect-freehand",
    license: "MIT",
  },
  {
    name: "Nunito Sans",
    by: "Vernon Adams and contributors",
    role: "The typeface, self-hosted through Fontsource.",
    url: "https://fonts.google.com/specimen/Nunito+Sans",
    fund: "https://github.com/sponsors/ayuhito",
    license: "OFL-1.1",
  },
];

/** The subset with a working funding route, for the "support them" list. */
export function fundableCredits(
  credits: readonly OpenSourceCredit[] = OPEN_SOURCE_CREDITS,
): OpenSourceCredit[] {
  return credits.filter((c) => !!c.fund);
}

/**
 * Sauce Bunny itself.
 *
 * The "Built on" list named every project this app stands on and left the
 * app the one thing on that page with no entry of its own - which read as
 * an oversight, because it was one.
 *
 * `fund` is null, and that is a checked fact rather than a placeholder:
 * https://github.com/sponsors/gchiaramonte3 redirects to the plain profile,
 * which is what GitHub serves when an account has not enrolled in Sponsors.
 * A Sponsor button pointing there would quietly land people on a profile
 * page with nothing to click, which is the failure the note at the top of
 * this file is about. To turn it on: enrol the account, add a
 * `.github/FUNDING.yml`, and set this to the sponsors URL - the button
 * appears on its own.
 */
export const SAUCE_BUNNY = {
  name: "Sauce Bunny",
  repo: "https://github.com/gchiaramonte3/SauceBunny",
  license: "MIT",
  fund: null as string | null,
};
