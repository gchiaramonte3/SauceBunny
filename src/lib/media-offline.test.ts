import { describe, expect, it } from "vitest";
import { fileDifferences, offlineCopy } from "./media-offline";

describe("what an offline root or file says", () => {
  it("tells a drive that is not connected from a folder that moved, and offers only steps that can help", () => {
    expect(offlineCopy("driveOffline", "NEXIS")).toMatchObject({ title: "NEXIS is not connected", locate: true, retry: false });
    expect(offlineCopy("missing", null)).toMatchObject({ title: "This folder was moved or renamed", locate: true, retry: true });
    expect(offlineCopy("notResponding", "NEXIS")).toMatchObject({ title: "NEXIS is not responding", retry: true });
    expect(offlineCopy("noAccess", null)).toMatchObject({ locate: false, retry: true });
  });
});

describe("how a located file differs from the one that went offline", () => {
  it("matches on name and, when known, on length to half a second", () => {
    expect(fileDifferences({ path: "/old/A001.mov", durationSeconds: 61 }, { path: "/new/A001.mov", duration: 61.3 })).toEqual([]);
    expect(fileDifferences({ path: "/old/A001.mov" }, { path: "/new/A001.mov", duration: 99 }), "an unknown length cannot differ").toEqual([]);
    expect(fileDifferences({ path: "/old/A001.mov", durationSeconds: 61 }, { path: "/new/A001_v2.mov", duration: 75 }))
      .toEqual(["Name: A001_v2.mov (was A001.mov)", "Length: 01:15 (was 01:01)"]);
    expect(fileDifferences({ path: "/old/Cafe\u0301.mov" }, { path: "/new/Caf\u00e9.mov", duration: null }), "two spellings of one name").toEqual([]);
  });
});
