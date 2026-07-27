/**
 * ffmpeg codec NAMES -> RFC 6381 codec strings, for MSE.
 *
 * WHY THIS EXISTS
 *
 * These are two different vocabularies and they were being used
 * interchangeably across the peer-media wire, which broke Tier B live
 * streaming for every H.264 file. The whole chain:
 *
 *   1. The host probes a local file with ffmpeg and parses the codec out of
 *      its stderr (`parse_ffmpeg_video`, media.rs). That yields ffmpeg's own
 *      name: "h264", "hevc", "aac".
 *   2. Those go straight onto the wire as `OfferFile.vcodec` / `.acodec`,
 *      whose doc comment promises RFC 6381 ("avc1.640028" / "mp4a.40.2").
 *      Nothing in between converted them.
 *   3. On the guest, MSEStreamPlayer's fast path tests
 *      `/^(avc1|avc3|h264)/i` — which MATCHES "h264" — so it takes the fast
 *      path and builds `video/mp4; codecs="h264, aac"`.
 *   4. `MediaSource.isTypeSupported` rejects that. Measured, not assumed:
 *      "h264, aac" and "h264, mp4a.40.2" are both NO; "avc1.640028,
 *      mp4a.40.2" is YES. RFC 6381 requires the four-character-code form.
 *   5. So the MIME is never set and control falls to the mediabunny probe,
 *      which reads the RAW peer route — and that route answers 405 by
 *      design, with a comment reading "the player skips the probe (codecs
 *      ride the offer)". The design assumed step 3 succeeded.
 *   6. -> onMediaError -> the download fallback, which cannot help: there is
 *      no URL to download, the file is on the other Mac.
 *
 * The conversion is one-way and lossy in the direction we need it: ffmpeg's
 * name says "H.264" but not which profile or level, and the profile/level
 * bytes are exactly what RFC 6381 encodes. So rather than fabricate one
 * string, offer several and let the platform pick — `isTypeSupported` is a
 * capability query and the init segment's own avcC is what actually governs
 * decoding, so declaring a profile/level at or above the real stream is the
 * safe direction. Candidates are ordered widest-first for that reason.
 */

/** Already an RFC 6381 string? Those start with a four-character code. */
const RFC6381 = /^(avc1|avc3|hvc1|hev1|av01|vp09|mp4a|opus|ac-3|ec-3|flac|alac)[.\s]?/i;

/**
 * RFC 6381 candidates for a video codec, most permissive first.
 *
 * H.264 leads with High@5.2 because it covers every resolution this app will
 * ever stream, including 4K, and a declaration at or above the real stream is
 * the harmless direction; the lower rungs follow for any platform that
 * refuses a level it cannot decode. HEVC needs `hvc1`, never the bare "hevc"
 * ffmpeg reports, and is listed even though WKWebView usually declines it —
 * a definite "no" here is worth much more than a malformed string, because a
 * "no" falls through to the download path cleanly.
 */
export function videoCodecCandidates(raw: string | null | undefined): string[] {
  const name = (raw ?? "").trim().toLowerCase();
  if (!name) return [];
  if (RFC6381.test(name)) return [name];
  switch (name) {
    case "h264":
    case "avc":
    case "x264":
      return ["avc1.640034", "avc1.640028", "avc1.4d401f", "avc1.42e01e"];
    case "hevc":
    case "h265":
      return ["hvc1.1.6.L153.B0", "hvc1.1.6.L93.B0"];
    case "av1":
      return ["av01.0.08M.08"];
    case "vp9":
      return ["vp09.00.10.08"];
    default:
      // ProRes, DNxHD, MPEG-2 and friends. There is no MSE codec string for
      // them, and returning a guess would claim support we do not have. An
      // empty list routes the caller to its fallback, which is correct.
      return [];
  }
}

/** RFC 6381 candidates for an audio codec, most likely first. */
export function audioCodecCandidates(raw: string | null | undefined): string[] {
  const name = (raw ?? "").trim().toLowerCase();
  if (RFC6381.test(name)) return [name];
  switch (name) {
    case "aac":
    case "aac_latm":
      // LC then HE-AAC. LC is what ffmpeg produces and what nearly every
      // delivery file carries.
      return ["mp4a.40.2", "mp4a.40.5"];
    case "opus":
      return ["opus"];
    case "ac3":
      return ["ac-3"];
    case "eac3":
      return ["ec-3"];
    case "flac":
      return ["flac"];
    case "alac":
      return ["alac"];
    default:
      // Unknown or absent: assume AAC-LC, which is what the fMP4 remux
      // produces and what the peer route serves.
      return ["mp4a.40.2"];
  }
}

/**
 * Build the MSE MIME for a peer stream, or null if the platform will not take
 * any candidate pairing.
 *
 * `isSupported` is injected rather than reaching for `MediaSource` directly so
 * this stays a pure function — the whole point is that it can be tested
 * without a media stack, and the four-step chain above was invisible precisely
 * because none of it was testable.
 */
export function peerStreamMime(
  video: string | null | undefined,
  audio: string | null | undefined,
  isSupported: (mime: string) => boolean,
): string | null {
  const vs = videoCodecCandidates(video);
  if (!vs.length) return null;
  const as = audioCodecCandidates(audio);
  for (const v of vs) {
    for (const a of as) {
      const mime = `video/mp4; codecs="${v}, ${a}"`;
      if (isSupported(mime)) return mime;
    }
  }
  return null;
}
