import { describe, expect, it } from "vitest";
import {
  hostnameOf,
  isLikelyVideoUrl,
  looksLikeExtractorRot,
  needsCookiesError,
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
