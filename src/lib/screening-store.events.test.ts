// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import {
  saveScreening, listScreenings, resetScreeningStoreForTests, SCREENINGS_CHANGED,
} from "./screening-store";
import { newScreening } from "./screening";

const LIB = "/docs/Sauce Bunny/Transcripts";

describe("a saved screening announces itself", () => {
  /**
   * The lobby enforces "every screening gets its own name" against a list it
   * reads ONCE, and it is kept alive under [hidden] for the life of the app.
   * Without an announcement that list went stale the moment a session ended:
   * end "Rough cut", press Start again on the restored title, and a second
   * "Rough cut" went straight through. Reloading blocked it correctly, which
   * is what made the hole hard to see.
   */
  const wire = (files: Map<string, string>) =>
    vi.mocked(invoke).mockImplementation(async (cmd: string, args?: unknown) => {
      const a = args as { path?: string; text?: string } | undefined;
      if (cmd === "default_transcript_library_path") return LIB;
      if (cmd === "read_text_file_capped") {
        const hit = files.get(a?.path ?? "");
        if (hit === undefined) throw new Error("ENOENT");
        return hit;
      }
      if (cmd === "write_text_to_path") { files.set(a?.path ?? "", a?.text ?? ""); return null; }
      return null;
    });

  it("fires SCREENINGS_CHANGED once the index write has landed", async () => {
    resetScreeningStoreForTests();
    wire(new Map());
    const seen: string[] = [];
    const onChange = () => seen.push(listScreenings().map((r) => r.title).join(","));
    window.addEventListener(SCREENINGS_CHANGED, onChange);
    try {
      await saveScreening(newScreening("code-1", "Rough cut", "host"));
      // Fired, and by the time it fires the new title is already readable -
      // a listener that re-reads on this event must not see the old list.
      expect(seen).toEqual(["Rough cut"]);
    } finally {
      window.removeEventListener(SCREENINGS_CHANGED, onChange);
    }
  });

  it("stays silent when the write fails, because nothing was taken", async () => {
    resetScreeningStoreForTests();
    vi.mocked(invoke).mockImplementation(async (cmd: string) => {
      if (cmd === "default_transcript_library_path") return LIB;
      if (cmd === "read_text_file_capped") throw new Error("ENOENT");
      if (cmd === "write_text_to_path") throw new Error("disk full");
      return null;
    });
    let fired = 0;
    const onChange = () => { fired++; };
    window.addEventListener(SCREENINGS_CHANGED, onChange);
    try {
      await expect(saveScreening(newScreening("code-2", "Never landed", "host"))).rejects.toThrow();
      expect(fired, "a name that was never written must not be reported as taken").toBe(0);
    } finally {
      window.removeEventListener(SCREENINGS_CHANGED, onChange);
    }
  });
});
