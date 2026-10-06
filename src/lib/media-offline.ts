import type { MediaState } from "../bindings/MediaState";
import { secondsToClock } from "./timecode";
import { pathKey } from "./repath";

/**
 * What to tell the person about something that cannot be reached, by why
 * (docs/RECONNECT-MEDIA-SPEC-2026-10-05.md). The point is the difference
 * between a drive that is not connected, which needs no searching at all, and
 * a folder that moved, which does. Shared by Home's offline row and the
 * Library sidebar so the two never say different things about one root.
 */
export type OfflineCopy = {
  title: string;
  hint: string;
  /** Locate folder… is worth offering: the item may be somewhere else. */
  locate: boolean;
  /** Retry is worth offering: asking again may give a different answer. */
  retry: boolean;
};

export function offlineCopy(state: Exclude<MediaState, "online">, volume: string | null): OfflineCopy {
  switch (state) {
    case "driveOffline":
      return { title: `${volume ?? "This drive"} is not connected`,
        hint: "It comes back by itself when the drive is connected.", locate: true, retry: false };
    case "missing":
      return { title: "This folder was moved or renamed",
        hint: "Locate it to reconnect everything in it: posters, marks, transcripts and Continue follow.", locate: true, retry: true };
    case "notResponding":
      return { title: `${volume ?? "This drive"} is not responding`,
        hint: "Sauce Bunny asks again when the drive changes or you come back to the window.", locate: true, retry: true };
    case "noAccess":
      return { title: "Sauce Bunny cannot read this folder",
        hint: "Allow it in System Settings, Privacy and Security, Files and Folders, then try again.", locate: false, retry: true };
  }
}

/**
 * How a located file differs from the one that went offline, in words, or
 * nothing when it matches. A same-named re-export is a different cut, and its
 * review notes and marks may not apply, so a difference is shown and needs a
 * click; it is never silently accepted. Duration is compared only when it was
 * known, to half a second (containers round differently).
 */
export function fileDifferences(expected: { path: string; durationSeconds?: number | null },
  found: { path: string; duration: number | null }): string[] {
  const name = (path: string) => pathKey(path).split("/").pop() ?? path;
  const out: string[] = [];
  if (name(expected.path) !== name(found.path)) out.push(`Name: ${name(found.path)} (was ${name(expected.path)})`);
  const was = expected.durationSeconds, now = found.duration;
  if (was != null && was > 0 && now != null && Math.abs(now - was) > 0.5) {
    const clock = (seconds: number) => secondsToClock(seconds, { padMinutes: true, forceHours: Math.max(was, now) >= 3600 });
    out.push(`Length: ${clock(now)} (was ${clock(was)})`);
  }
  return out;
}
