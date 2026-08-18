import { describe, expect, it } from "vitest";
import {
  hostnameOf,
  isLikelyVideoUrl,
  looksLikeExtractorRot,
  needsCookiesError,
  needsJsRuntimeError,
  normalizeUrl,
  prettyHost,
  youTubeVideoId,
} from "./validation";

describe("normalizeUrl", () => {
  it("adds https:// when the scheme is missing", () => {
    expect(normalizeUrl("youtube.com/watch?v=abc")).toBe("https://youtube.com/watch?v=abc");
  });
  it("leaves schemed URLs alone and trims whitespace", () => {
    expect(normalizeUrl("  https://vimeo.com/123  ")).toBe("https://vimeo.com/123");
  });
});

describe("isLikelyVideoUrl", () => {
  it("accepts normal video pages", () => {
    expect(isLikelyVideoUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe(true);
    expect(isLikelyVideoUrl("https://vimeo.com/76979871")).toBe(true);
  });
  it("rejects empties and non-URLs", () => {
    expect(isLikelyVideoUrl("")).toBe(false);
    expect(isLikelyVideoUrl("hello world")).toBe(false);
  });
});

describe("youTubeVideoId", () => {
  it("extracts from watch, short, and shorts URLs", () => {
    expect(youTubeVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(youTubeVideoId("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
  });
  it("returns null for non-YouTube URLs", () => {
    expect(youTubeVideoId("https://vimeo.com/123")).toBeNull();
  });
});

describe("prettyHost", () => {
  it("names known sites", () => {
    expect(prettyHost("www.reddit.com")).toBe("Reddit");
    expect(prettyHost("youtu.be")).toBe("YouTube");
    expect(prettyHost("x.com")).toBe("X");
  });

  // r85 review: exact-host matching produced sign-in prompts for "Old"
  // (old.reddit.com) and "Mobile" (mobile.twitter.com).
  it("matches known sites on any subdomain", () => {
    expect(prettyHost("old.reddit.com")).toBe("Reddit");
    expect(prettyHost("mobile.twitter.com")).toBe("X");
    expect(prettyHost("m.youtube.com")).toBe("YouTube");
  });

  it("capitalizes the first label of unknown hosts", () => {
    expect(prettyHost("media.example.org")).toBe("Media");
  });
});

describe("hostnameOf", () => {
  it("extracts the hostname, tolerating missing scheme", () => {
    expect(hostnameOf("https://www.youtube.com/watch?v=x")).toContain("youtube.com");
    expect(hostnameOf("vimeo.com/123")).toContain("vimeo.com");
  });
});

describe("looksLikeExtractorRot", () => {
  // Real-world yt-dlp breakage strings from stale-extractor incidents.
  const rot = [
    "ERROR: [youtube] dQw4w9WgXcQ: Unable to extract initial player response; please report this issue on https://github.com/yt-dlp/yt-dlp/issues",
    "ERROR: [youtube] abc12345678: Unable to extract yt initial data",
    "ERROR: [youtube] abc12345678: Unable to extract player version",
    "WARNING: [youtube] abc12345678: unable to extract player js url",
    "ERROR: [youtube] xyz: nsig extraction failed: Some formats may be missing (caused by JSInterpreter error)",
    "WARNING: [youtube] abc: Signature extraction failed: Some formats may be missing",
    "ERROR: [youtube] abc12345678: Precondition check failed.",
    "ERROR: [youtube] abc: Requested format is not available. Use --list-formats for a list of available formats",
    "ERROR: [youtube] abc12345678: Failed to extract any player response",
    "ERROR: unable to download video data: HTTP Error 403: Forbidden (https://rr3---sn-p5qlsnzy.googlevideo.com/videoplayback?expire=...)",
    "ERROR: [youtube] dQw4w9WgXcQ: fragment 3 not found, unable to continue: HTTP Error 403: Forbidden",
  ];
  it("matches the classic stale-extractor signatures", () => {
    for (const s of rot) expect(looksLikeExtractorRot(s), s).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(looksLikeExtractorRot("UNABLE TO EXTRACT INITIAL PLAYER RESPONSE")).toBe(true);
    expect(looksLikeExtractorRot("NSIG EXTRACTION FAILED")).toBe(true);
  });

  const genuinelyUnavailable = [
    "ERROR: [youtube] abc12345678: Video unavailable",
    "ERROR: [youtube] abc12345678: Private video. Sign in if you've been granted access to this video",
    "ERROR: [youtube] abc12345678: This video is private",
    "ERROR: [youtube] abc12345678: This video has been removed for violating YouTube's Terms of Service",
    "ERROR: [youtube] abc12345678: Video unavailable. This video has been removed by the uploader",
    "ERROR: [youtube] abc12345678: Sign in to confirm your age. This video may be inappropriate for some users.",
  ];
  it("never fires for genuinely-unavailable videos", () => {
    for (const s of genuinelyUnavailable) expect(looksLikeExtractorRot(s), s).toBe(false);
  });

  it("requires YouTube/CDN context for an HTTP 403", () => {
    expect(looksLikeExtractorRot("HTTP Error 403: Forbidden")).toBe(false);
    expect(looksLikeExtractorRot("ERROR: [vimeo] 76979871: Unable to download webpage: HTTP Error 403: Forbidden")).toBe(false);
    expect(looksLikeExtractorRot("HTTP Error 403: Forbidden while fetching https://rr1.googlevideo.com/videoplayback")).toBe(true);
  });

  it("ignores unrelated failures", () => {
    expect(looksLikeExtractorRot("")).toBe(false);
    expect(looksLikeExtractorRot("Unsupported URL: https://example.com/page")).toBe(false);
    expect(looksLikeExtractorRot("The Internet connection appears to be offline.")).toBe(false);
    expect(looksLikeExtractorRot("Command create_clip not found")).toBe(false);
    expect(looksLikeExtractorRot("ffmpeg exited with code 1")).toBe(false);
  });

  // NON-OVERLAP CONTRACT: the auth/cookies flow (validation.ts
  // needsCookiesError → YouTubeAuthModal) owns its error class. Every
  // message it claims must NOT be claimed by the rot matcher — even when a
  // rot signature appears in the same text — because a sign-in wall is
  // fixed by connecting a browser, not by updating yt-dlp.
  const authOwned = [
    "ERROR: [youtube] abc: Sign in to confirm you're not a bot. Use --cookies-from-browser or --cookies for the authentication.",
    "Sign in to confirm you're not a bot",
    "YouTube auth: reconnect your browser in Settings → Web sources",
    "ERROR: [reddit] xyz: Account authentication is required. Use --cookies-from-browser or --cookies to pass your login.",
    "This site requires you to be signed in — connect a browser and Sauce Bunny reuses those cookies",
    // Composites: a rot signature is PRESENT, auth context still wins.
    "nsig extraction failed — sign in to confirm you're not a bot",
    "Unable to extract player response. Use --cookies-from-browser or --cookies for the authentication.",
  ];
  it("cedes every auth-flow match to the sign-in flow (auth wins over rot)", () => {
    for (const s of authOwned) {
      expect(needsCookiesError(s), `needsCookiesError should claim: ${s}`).toBe(true);
      expect(looksLikeExtractorRot(s), `rot must NOT claim: ${s}`).toBe(false);
    }
  });
});

describe("extractor rot, with the source URL as context", () => {
  // Verbatim from a user report of the breakage that prompted this: yt-dlp
  // names no host, so a check against the message alone can never match it.
  const REAL = "ERROR: unable to download video data: HTTP Error 403: Forbidden";
  const YT = "https://www.youtube.com/watch?v=PZbkF-15ObM";

  it("matches the real-world 403 once the URL is supplied", () => {
    expect(looksLikeExtractorRot(REAL, YT), "the commonest YouTube failure went unoffered").toBe(true);
  });

  it("did NOT match on the message alone, which is the bug being fixed", () => {
    // Kept as a statement of the old behaviour: the message carries no host,
    // so without context there is nothing to key on and no offer appeared.
    expect(looksLikeExtractorRot(REAL)).toBe(false);
  });

  it("still refuses a 403 that has nothing to do with YouTube", () => {
    // A permissions refusal from someone's own server is not fixed by updating
    // yt-dlp, and offering that would be the dead-end this file exists to avoid.
    expect(looksLikeExtractorRot(REAL, "https://files.example.com/a.mp4")).toBe(false);
    expect(looksLikeExtractorRot("HTTP Error 403: Forbidden", null)).toBe(false);
  });

  it("takes context from the message when it has it, URL or not", () => {
    expect(looksLikeExtractorRot("HTTP Error 403 on googlevideo.com/videoplayback")).toBe(true);
  });

  it("treats a bare download failure as rot only in a YouTube context", () => {
    expect(looksLikeExtractorRot("unable to download video data", YT)).toBe(true);
    expect(looksLikeExtractorRot("unable to download video data", "https://vimeo.com/1")).toBe(false);
  });
});

describe("a missing JS runtime is its own class", () => {
  const WARN =
    "WARNING: [youtube] No supported JavaScript runtime could be found. Only deno is enabled by default; " +
    "YouTube extraction without a JS runtime has been deprecated";

  it("is recognised", () => {
    expect(needsJsRuntimeError(WARN)).toBe(true);
  });

  it("is NOT extractor rot, because no yt-dlp version fixes it", () => {
    // The runtime is a separate program. Offering "Update yt-dlp & retry" here
    // would be a repair that provably cannot repair — the same shape as a
    // stable update that returns the version already installed.
    expect(looksLikeExtractorRot(WARN, "https://www.youtube.com/watch?v=x")).toBe(false);
  });

  it("wins even when a rot signature shares the text", () => {
    const both = `${WARN}\nERROR: unable to download video data: HTTP Error 403: Forbidden`;
    expect(looksLikeExtractorRot(both, "https://www.youtube.com/watch?v=x"),
      "sent to an update that cannot help").toBe(false);
  });

  it("does not fire on ordinary errors", () => {
    for (const s of ["", "HTTP Error 403: Forbidden", "Video unavailable", "some js parse error"]) {
      expect(needsJsRuntimeError(s), JSON.stringify(s)).toBe(false);
    }
  });
});
