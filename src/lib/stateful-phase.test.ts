import { describe, it, expect } from "vitest";
import { fetchButtonPhase } from "./stateful-phase";

describe("fetchButtonPhase", () => {
  it("passes an explicit success/error flash through regardless of status", () => {
    // The success flash outlives the optimistic mount (status already "loaded").
    expect(fetchButtonPhase("success", "loaded")).toBe("success");
    expect(fetchButtonPhase("error", "loaded")).toBe("error");
    expect(fetchButtonPhase("error", "error")).toBe("error");
    // A settled flash wins even over a concurrent import going "fetching".
    expect(fetchButtonPhase("success", "fetching")).toBe("success");
  });

  it("maps an explicit loading OR a local-import 'fetching' status to loading", () => {
    expect(fetchButtonPhase("loading", "loaded")).toBe("loading");
    // URL fetch mounts optimistically to "loaded" but drives fetchPhase itself.
    expect(fetchButtonPhase("loading", "empty")).toBe("loading");
    // Local import only flips status → still shows the spinner (no explicit phase).
    expect(fetchButtonPhase("idle", "fetching")).toBe("loading");
  });

  it("is idle when nothing is in flight", () => {
    expect(fetchButtonPhase("idle", "empty")).toBe("idle");
    expect(fetchButtonPhase("idle", "loaded")).toBe("idle");
    expect(fetchButtonPhase("idle", "error")).toBe("idle");
  });
});
