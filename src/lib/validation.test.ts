import { describe, expect, it } from "vitest";
import {
  hostnameOf,
  isLikelyVideoUrl,
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
