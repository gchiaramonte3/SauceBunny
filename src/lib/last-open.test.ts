// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { LAST_AAF_DOCUMENT, pickResume, recallLast, rememberLast } from "./last-open";

const items = [{ id: "a", at: 1 }, { id: "b", at: 3 }, { id: "c", at: 2 }];
const at = (item: { at: number }) => item.at;

describe("reopening where the user left off", () => {
  beforeEach(() => localStorage.clear());

  it("reopens the last one while it still exists", () => {
    expect(pickResume("c", items, at)).toBe("c");
  });
  it("falls back to the most recently changed when the last one is gone or was never recorded", () => {
    expect(pickResume("deleted", items, at)).toBe("b");
    expect(pickResume(null, items, at)).toBe("b");
  });
  it("has nothing to reopen on a first run, which is when onboarding shows", () => {
    expect(pickResume(null, [], at)).toBeNull();
  });
  it("remembers and forgets", () => {
    rememberLast(LAST_AAF_DOCUMENT, "doc-1");
    expect(recallLast(LAST_AAF_DOCUMENT)).toBe("doc-1");
    rememberLast(LAST_AAF_DOCUMENT, null);
    expect(recallLast(LAST_AAF_DOCUMENT)).toBeNull();
  });
});
