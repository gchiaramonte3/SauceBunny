import { describe, expect, it } from "vitest";
import { offlineCopy, offlineFileCopy } from "./media-offline";

describe("what an offline root or file says", () => {
  it("tells a drive that is not connected from a folder that moved, and offers only steps that can help", () => {
    expect(offlineCopy("driveOffline", "NEXIS")).toMatchObject({ title: "NEXIS is not connected", locate: true, retry: false });
    expect(offlineCopy("missing", null)).toMatchObject({ title: "This folder was moved or renamed", locate: true, retry: true });
    expect(offlineCopy("notResponding", "NEXIS")).toMatchObject({ title: "NEXIS is not responding", retry: true });
    expect(offlineCopy("noAccess", null)).toMatchObject({ locate: false, retry: true });
    expect(offlineFileCopy("driveOffline", "NEXIS", "A001.mov").body).toContain("Connect it");
    expect(offlineFileCopy("missing", null, "A001.mov").body).toContain("stays in Continue");
  });
});
