import type { MediaState } from "../bindings/MediaState";

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

/**
 * The same, for one file the person tried to open. A file that cannot be
 * reached stays where it is listed (Continue used to drop it, which threw away
 * every file on a drive that simply was not mounted yet).
 */
export function offlineFileCopy(state: Exclude<MediaState, "online">, volume: string | null, title: string): { title: string; body: string } {
  switch (state) {
    case "driveOffline":
      return { title: `${volume ?? "Its drive"} is not connected`, body: `"${title}" is on ${volume ?? "a drive"} that is not connected. Connect it and open it again.` };
    case "notResponding":
      return { title: `${volume ?? "Its drive"} is not responding`, body: `"${title}" is on a drive that did not answer. Try again in a moment.` };
    case "noAccess":
      return { title: "Sauce Bunny cannot read this file", body: `Allow access to "${title}" in System Settings, Privacy and Security, Files and Folders.` };
    case "missing":
      return { title: "File not found", body: `"${title}" was moved, renamed or deleted. It stays in Continue; if its folder is in the Library, Locate the folder to reconnect it.` };
  }
}

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
