import { describe, expect, it } from "vitest";
import { audioCodecCandidates, encodedStreamMime, peerStreamMime, videoCodecCandidates } from "./codec-strings";

/**
 * The support table below is MEASURED, not assumed. Chromium (Playwright) was
 * asked directly:
 *
 *   NO   video/mp4; codecs="h264, aac"
 *   NO   video/mp4; codecs="h264, mp4a.40.2"
 *   YES  video/mp4; codecs="avc1.640028, mp4a.40.2"
 *   YES  video/mp4; codecs="avc1.4d401f, mp4a.40.2"
 *   YES  video/mp4; codecs="avc1.42e01e, mp4a.40.2"
 *   NO   video/mp4; codecs="hevc, mp4a.40.2"
 *   NO   video/mp4; codecs="hvc1.1.6.L93.B0, mp4a.40.2"   (no HEVC in that build)
 *
 * The fake mirrors it: only a well-formed four-character-code video codec is
 * accepted, and HEVC is declined the way a typical WKWebView build declines
 * it. That last part matters — the point is not that HEVC works, it is that a
 * clean "no" reaches the fallback instead of a malformed string doing it by
 * accident.
 */
const webkitish = (mime: string): boolean => {
  const m = /codecs="([^"]+)"/.exec(mime);
  if (!m) return false;
  const [v, a] = m[1].split(",").map((s) => s.trim());
  const videoOk = /^avc[13]\.[0-9a-f]{6}$/i.test(v);
  const audioOk = /^(mp4a\.40\.[25]|opus|ac-3|ec-3|flac|alac)$/i.test(a);
  return videoOk && audioOk;
};

describe("videoCodecCandidates", () => {
  it("turns ffmpeg's bare name into RFC 6381 strings", () => {
    // This is the whole bug in one assertion: "h264" is what ffmpeg's stderr
    // says and what the peer offer carries, and it is not a codec string.
    const c = videoCodecCandidates("h264");
    expect(c.length).toBeGreaterThan(0);
    for (const s of c) expect(s).toMatch(/^avc1\.[0-9a-f]{6}$/);
  });

  it("passes an already-valid RFC 6381 string straight through", () => {
    // A WEB source's resolver already hands over the real thing, and
    // second-guessing it would throw away the true profile and level.
    expect(videoCodecCandidates("avc1.640028")).toEqual(["avc1.640028"]);
    expect(videoCodecCandidates("avc3.4d401f")).toEqual(["avc3.4d401f"]);
  });

  it("orders H.264 candidates from the widest profile/level down", () => {
    // Declaring at or above the real stream is the safe direction: the init
    // segment's avcC governs decoding, and a level too LOW is the one that
    // gets refused. So the first candidate must be the most permissive.
    const c = videoCodecCandidates("h264");
    const level = (s: string) => parseInt(s.slice(-2), 16);
    for (let i = 1; i < c.length; i += 1) {
      expect(level(c[i])).toBeLessThanOrEqual(level(c[i - 1]));
    }
  });

  it("is case- and whitespace-insensitive, because stderr parsing is untidy", () => {
    expect(videoCodecCandidates(" H264 ")).toEqual(videoCodecCandidates("h264"));
  });

  it("offers nothing for a codec MSE has no string for", () => {
    // ProRes and DNxHD have no MP4 codec parameter. Returning a guess would
    // claim support we do not have; an empty list routes to the fallback,
    // which is the correct outcome.
    for (const c of ["prores", "dnxhd", "mpeg2video", "", null, undefined]) {
      expect(videoCodecCandidates(c)).toEqual([]);
    }
  });
});

describe("audioCodecCandidates", () => {
  it("maps ffmpeg's aac to the LC codec string", () => {
    expect(audioCodecCandidates("aac")[0]).toBe("mp4a.40.2");
  });

  it("passes a valid string through", () => {
    expect(audioCodecCandidates("mp4a.40.2")).toEqual(["mp4a.40.2"]);
  });

  it("assumes AAC-LC when the audio codec is unknown or absent", () => {
    // The fMP4 remux produces AAC-LC regardless, so this is the honest
    // default rather than a guess: a missing acodec must not veto the stream.
    for (const c of [null, undefined, "", "something-weird"]) {
      expect(audioCodecCandidates(c)).toEqual(["mp4a.40.2"]);
    }
  });
});

describe("encodedStreamMime", () => {
  it("describes the ENCODER's output, not the source file", () => {
    // Every rung produces H.264 High + AAC-LC whatever went in. That is the
    // point of transcoding, and it is why the source codecs must not be used
    // to describe the stream.
    const mime = encodedStreamMime(webkitish);
    expect(mime).not.toBeNull();
    expect(webkitish(mime!)).toBe(true);
    expect(mime).toContain("avc1.");
    expect(mime).toContain("mp4a.40.2");
  });

  it("REGRESSION: a ProRes source streams once a rung is transcoding it", () => {
    // The trap the ladder walks into if the MIME keeps coming from the offer.
    // ProRes has no MP4 codec string at all, so describing the stream by its
    // SOURCE returns null, the fast path is skipped, and the fallback probe
    // reads the raw peer route -- which answers 405 by design. Dead session,
    // on exactly the sources the ladder exists to make streamable.
    expect(peerStreamMime("prores", "pcm_s16le", webkitish)).toBeNull();
    expect(encodedStreamMime(webkitish)).not.toBeNull();
  });

  it("agrees with what the Rust encoder actually emits", () => {
    // commands/rung.rs: -c:v h264_videotoolbox -profile:v high, -c:a aac.
    // If that ever changes to HEVC or Opus, this is the assertion that should
    // fail rather than a silent decode error on the guest.
    expect(encodedStreamMime(webkitish)).toBe(
      `video/mp4; codecs="${videoCodecCandidates("h264")[0]}, ${audioCodecCandidates("aac")[0]}"`,
    );
  });
});

describe("peerStreamMime", () => {
  it("REGRESSION: an ffmpeg-named peer offer produces a playable MIME", () => {
    // Exactly what a Tier B offer carries today. Before this function existed
    // the player built `codecs="h264, aac"`, isTypeSupported said no, the MIME
    // stayed unset, and the fallback probe hit the peer raw route's 405.
    const mime = peerStreamMime("h264", "aac", webkitish);
    expect(mime).not.toBeNull();
    expect(webkitish(mime!)).toBe(true);
    expect(mime).not.toContain('"h264');
  });

  it("the exact string the old code built is still rejected", () => {
    // Guards the premise. If this ever starts passing, the bug above was not
    // what we thought it was.
    expect(webkitish('video/mp4; codecs="h264, aac"')).toBe(false);
  });

  it("keeps a web resolver's real profile and level", () => {
    expect(peerStreamMime("avc1.4d401f", "mp4a.40.2", webkitish))
      .toBe('video/mp4; codecs="avc1.4d401f, mp4a.40.2"');
  });

  it("falls back down the ladder when the platform refuses the top rung", () => {
    const only = (want: string) => (m: string) => m.includes(want) && webkitish(m);
    expect(peerStreamMime("h264", "aac", only("avc1.42e01e")))
      .toBe('video/mp4; codecs="avc1.42e01e, mp4a.40.2"');
  });

  it("returns null rather than a malformed MIME when nothing is supported", () => {
    // Null is the contract the caller depends on: it means "fall through to
    // the probe/download path". A malformed string would look like success
    // and fail later, deeper, and less legibly.
    expect(peerStreamMime("prores", "pcm_s16le", webkitish)).toBeNull();
    expect(peerStreamMime("hevc", "aac", webkitish)).toBeNull();
    expect(peerStreamMime(null, "aac", webkitish)).toBeNull();
  });

  it("never asks the platform about a malformed candidate", () => {
    // Every string handed to isTypeSupported must be well-formed, so a
    // platform that logs rejections does not fill the console with our noise.
    const seen: string[] = [];
    peerStreamMime("h264", "aac", (m) => { seen.push(m); return false; });
    expect(seen.length).toBeGreaterThan(0);
    for (const m of seen) expect(m).toMatch(/^video\/mp4; codecs="[\w.]+, [\w.-]+"$/);
  });

  it("pairs every video candidate with every audio candidate before giving up", () => {
    const seen: string[] = [];
    peerStreamMime("h264", "aac", (m) => { seen.push(m); return false; });
    expect(seen.length).toBe(
      videoCodecCandidates("h264").length * audioCodecCandidates("aac").length,
    );
  });
});
