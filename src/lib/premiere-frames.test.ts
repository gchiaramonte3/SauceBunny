import { describe, expect, it } from "vitest";
import { forgetPremiereFrame, lastPremiereFrame, recordPremiereFrame } from "./premiere-frames";
describe("last presented NDI sample", () => {
  it("keeps only the newest confirmed sample and copies it at read time", () => {
    recordPremiereFrame("stream", "decoder1", 1, 30);
    const frozen = lastPremiereFrame("stream");
    recordPremiereFrame("stream", "decoder1", 99, 300);
    expect(frozen?.mediaSeconds).toBe(1);
    expect(lastPremiereFrame("stream")?.mediaSeconds).toBe(99);
  });
  it("an old decoder teardown cannot erase the replacement frame", () => {
    recordPremiereFrame("stream", "decoder2", 2, 60);
    forgetPremiereFrame("stream", "decoder1");
    expect(lastPremiereFrame("stream")?.frameId).toBe("decoder2:60");
    forgetPremiereFrame("stream", "decoder2");
    expect(lastPremiereFrame("stream")).toBeNull();
  });
  it("a source change has no frame until that source decodes", () => {
    recordPremiereFrame("a", "decoder", 10, 300);
    expect(lastPremiereFrame("b")).toBeNull();
    recordPremiereFrame("a", "decoder", NaN, 300);
    expect(lastPremiereFrame("a")?.mediaSeconds).toBe(10);
  });
});
