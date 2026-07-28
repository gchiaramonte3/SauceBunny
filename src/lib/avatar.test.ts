import { describe, expect, it } from "vitest";
import { AVATAR_SIZE, avatarCropRect, isUsableAvatar } from "./avatar";
import { MAX_AVATAR_BYTES } from "./cast";

describe("avatarCropRect", () => {
  it("centres horizontally on a landscape frame", () => {
    const { sx, size } = avatarCropRect(1920, 1080);
    expect(size).toBe(1080);
    expect(sx).toBe(420); // (1920 - 1080) / 2
  });

  it("biases the crop UPWARD, not to the centre", () => {
    // The whole point. A centred square on 16:9 lands on the middle third of
    // the picture, which for a person in shot is their chest. Faces sit high.
    const { sy } = avatarCropRect(1920, 1080);
    expect(sy).toBe(0); // square is the full height here, nothing to bias

    // Portrait, where there IS vertical overhang to distribute:
    const tall = avatarCropRect(1080, 1920);
    expect(tall.size).toBe(1080);
    expect(tall.sy).toBe(210); // (1920 - 1080) / 4, not / 2
    expect(tall.sy).toBeLessThan((1920 - 1080) / 2);
  });

  it("never crops outside the frame", () => {
    for (const [w, h] of [[1920, 1080], [1080, 1920], [640, 640], [1, 5], [5, 1], [3840, 2160]]) {
      const { sx, sy, size } = avatarCropRect(w, h);
      expect(sx).toBeGreaterThanOrEqual(0);
      expect(sy).toBeGreaterThanOrEqual(0);
      expect(sx + size).toBeLessThanOrEqual(w);
      expect(sy + size).toBeLessThanOrEqual(h);
    }
  });

  it("survives a degenerate frame rather than producing a zero-size crop", () => {
    // A 0x0 canvas is what a failed decode looks like; a size-0 drawImage
    // throws, so clamp rather than pass it on.
    expect(avatarCropRect(0, 0).size).toBe(1);
  });
});

describe("isUsableAvatar", () => {
  it("accepts an inline image inside the cap", () => {
    expect(isUsableAvatar("data:image/jpeg;base64,AAAA")).toBe(true);
  });

  it("rejects a remote URL", () => {
    // An http avatar would make opening the cast manager a network fetch, in
    // an app whose entire premise is that it makes none.
    expect(isUsableAvatar("https://example.com/face.jpg")).toBe(false);
    expect(isUsableAvatar("blob:tauri://localhost/abc")).toBe(false);
  });

  it("rejects a non-image data URL", () => {
    expect(isUsableAvatar("data:text/html;base64,PHNjcmlwdD4=")).toBe(false);
  });

  it("rejects anything over the byte cap", () => {
    const over = "data:image/jpeg;base64," + "A".repeat(MAX_AVATAR_BYTES);
    expect(isUsableAvatar(over)).toBe(false);
    const under = "data:image/jpeg;base64," + "A".repeat(MAX_AVATAR_BYTES - 100);
    expect(isUsableAvatar(under)).toBe(true);
  });

  it("rejects nothing at all", () => {
    expect(isUsableAvatar(null)).toBe(false);
    expect(isUsableAvatar(undefined)).toBe(false);
    expect(isUsableAvatar("")).toBe(false);
  });
});

describe("the size budget", () => {
  it("keeps a full cast of faces inside a sane file", () => {
    // 30 members at the cap is the worst case the cast file has to hold. If
    // either constant moves, this is the number that decides whether the
    // Documents file is still something you can open in a text editor.
    expect(30 * MAX_AVATAR_BYTES).toBeLessThan(2 * 1024 * 1024);
    expect(AVATAR_SIZE).toBe(96); // 48px in the UI, 2x for retina, no more
  });
});
