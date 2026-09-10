import { expect, it } from "vitest";
import { authenticationRetry, publicFirst } from "./web-source-policy";
import { mediaDiagnostic } from "./media-diagnostics";

it("tries public YouTube first without treating lookalike hosts as YouTube", () => {
  for (const url of ["https://youtu.be/clip", "https://www.youtube.com/watch?v=clip", "https://m.youtube.com/shorts/clip"]) expect(publicFirst(url)).toBe(true);
  for (const url of ["https://youtube.com.evil.test/clip", "https://notyoutube.com", "https://example.test/?youtube.com", "invalid"]) expect(publicFirst(url)).toBe(false);
});
it.each(["403 Forbidden", "429 Too Many Requests", "Read timed out", "Permission denied", "cancelled"])(
  "never cycles authentication for %s, even with cookie advice appended", (cause) => {
    expect(authenticationRetry("https://youtu.be/clip", "safari", `${cause}; Sign in to confirm; use --cookies-from-browser`)).toBe(false);
  },
);
it("uses only a selected browser after explicit authentication failure", () => {
  expect(authenticationRetry("https://youtu.be/clip", "safari", "Sign in to confirm your age")).toBe(true);
  expect(authenticationRetry("https://youtu.be/clip", "none", "Private video")).toBe(false);
  expect(authenticationRetry("https://youtu.be/clip", "safari", "Unable to read cookies")).toBe(false);
});
it("bounds diagnostics and strips signed URLs, credentials and local paths", () => {
  const message = mediaDiagnostic("HTTP 403 https://cdn.test/media?token=secret\nAuthorization: Bearer credential\n/Users/editor/video.mp4\n" + "x".repeat(5000));
  expect(message).toContain("403");
  for (const secret of ["token=secret", "Bearer", "editor", "https:"]) expect(message).not.toContain(secret);
  expect(message.length).toBeLessThanOrEqual(1200);
});
