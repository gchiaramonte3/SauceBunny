import { describe, it, expect, beforeEach } from "vitest";
import {
  speakerFingerprint,
  seedSpeakerOverridesFromFingerprint,
  linkSpeakerOverridesToFingerprint,
} from "./speaker-identity";
import { speakerOverridesKey } from "../components/transcript/helpers";

function installLocalStorage(): Map<string, string> {
  const store = new Map<string, string>();
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); },
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() { return store.size; },
  } as Storage;
  return store;
}

const NAMES = JSON.stringify({ global: { SPEAKER_00: "Alice" }, turn: {}, aliases: {}, colors: {}, turnTag: {} });

let fs: Map<string, string>;
beforeEach(() => { fs = installLocalStorage(); });

describe("speakerFingerprint", () => {
  it("is stable for the same source and null without metadata", () => {
    const a = speakerFingerprint("My Clip.mp4", 123.4, 1920, 1080, 5000);
    const b = speakerFingerprint("My Clip.mp4", 123.4, 1920, 1080, 5000);
    expect(a).toBe(b);
    expect(a).not.toBeNull();
    expect(speakerFingerprint(null, null)).toBeNull(); // source-less transcript
  });
});

describe("seed + link round trip", () => {
  it("re-transcribing the same source at a NEW path restores the names", () => {
    const fp = speakerFingerprint("Clip.mp4", 60, 1920, 1080, 100);
    // Old transcript: user renamed a speaker → path key holds names.
    fs.set(speakerOverridesKey("/tx/2026-06/Clip.srt"), NAMES);
    linkSpeakerOverridesToFingerprint("/tx/2026-06/Clip.srt", fp); // mirror to fp index

    // Re-transcribe → brand new path, empty. Seed from the fingerprint.
    const seeded = seedSpeakerOverridesFromFingerprint("/tx/2026-07/Clip.srt", fp);
    expect(seeded).toBe(true);
    expect(fs.get(speakerOverridesKey("/tx/2026-07/Clip.srt"))).toBe(NAMES);
  });

  it("never clobbers names already on the new path", () => {
    const fp = speakerFingerprint("Clip.mp4", 60);
    linkSpeakerOverridesToFingerprint("/a.srt", fp); // fp index empty (a.srt has no names)
    fs.set(speakerOverridesKey("/a.srt"), NAMES);
    linkSpeakerOverridesToFingerprint("/a.srt", fp);

    const other = JSON.stringify({ global: { SPEAKER_00: "Bob" }, turn: {}, aliases: {}, colors: {}, turnTag: {} });
    fs.set(speakerOverridesKey("/b.srt"), other); // b already has its own names
    expect(seedSpeakerOverridesFromFingerprint("/b.srt", fp)).toBe(false);
    expect(fs.get(speakerOverridesKey("/b.srt"))).toBe(other); // untouched
  });

  it("migrates pre-bridge names to the fp index on first link", () => {
    const fp = speakerFingerprint("Clip.mp4", 60)!;
    fs.set(speakerOverridesKey("/legacy.srt"), NAMES); // existed before the bridge
    linkSpeakerOverridesToFingerprint("/legacy.srt", fp);
    // A same-source transcript elsewhere now resolves.
    expect(seedSpeakerOverridesFromFingerprint("/elsewhere.srt", fp)).toBe(true);
  });

  it("clearing all names removes the fp entry (deleted names don't resurrect)", () => {
    const fp = speakerFingerprint("Clip.mp4", 60);
    fs.set(speakerOverridesKey("/x.srt"), NAMES);
    linkSpeakerOverridesToFingerprint("/x.srt", fp);
    // User clears every name → path key emptied/removed.
    fs.delete(speakerOverridesKey("/x.srt"));
    linkSpeakerOverridesToFingerprint("/x.srt", fp);
    // A new same-source transcript must NOT get the deleted names back.
    expect(seedSpeakerOverridesFromFingerprint("/y.srt", fp)).toBe(false);
  });

  it("no fingerprint (source-less) is a safe no-op", () => {
    expect(seedSpeakerOverridesFromFingerprint("/z.srt", null)).toBe(false);
    linkSpeakerOverridesToFingerprint("/z.srt", null); // must not throw
  });
});
