import { captureElement } from "./viewer-capture";

/**
 * "Show them what I am watching."
 *
 * A guest without the file waits on a transfer. This puts a picture in front
 * of them in about a second by tapping the presenter's own monitor and pushing
 * it down the WebRTC mesh that already carries camera and screen share, so two
 * people can talk about the same frame while the bytes are still moving.
 *
 * IT IS A BRIDGE, NOT A DELIVERY MECHANISM. CLAUDE.md requires playback to
 * come from a local copy or a fixed, known-quality stream, because a reviewer
 * judging a grade has to see compression that is in the source and not in the
 * transport. This is a real-time encode that degrades to fit the link, so it
 * is exactly what that rule excludes as a playback surface. It is acceptable
 * only while it is announced as a live view and only while the real file is on
 * its way. Anything that presents it as the source is a bug.
 *
 * Pure, with the DOM and the mesh injected, following ShareController next
 * door - the machine is unit-tested and the seams are where the untestable
 * parts live.
 */

export type ViewerShareState = "off" | "live";

export type ViewerShareDeps = {
  /** The monitor's current element, from PlayerHandle.getCaptureElement. */
  getElement: () => HTMLMediaElement | HTMLCanvasElement | null;
  setOverride: (track: MediaStreamTrack | null) => void;
  setAudioOverride: (track: MediaStreamTrack | null) => void;
  /** Tell the room, so the guest's tile can say what it is showing. */
  announce: (on: boolean) => void;
  onChange: (state: ViewerShareState) => void;
  log: (tag: "warn" | "err", message: string) => void;
};

export class ViewerShareController {
  private state: ViewerShareState = "off";
  constructor(private deps: ViewerShareDeps) {}

  getState(): ViewerShareState { return this.state; }

  /**
   * Start, or report honestly that we cannot.
   *
   * Returns false rather than throwing when there is nothing to capture: the
   * caller's response is the same either way (offer the file instead), and an
   * engine that simply has no frame yet is not an error worth a dialog.
   */
  start(): boolean {
    if (this.state === "live") return true;
    const cap = captureElement(this.deps.getElement());
    if (!cap) {
      this.deps.log("warn", "Nothing to capture yet: the monitor has no frame to share.");
      return false;
    }
    this.deps.setOverride(cap.video);
    // Audio only when the engine actually produced some. The canvas path has
    // none - mediabunny schedules its sound through Web Audio rather than an
    // element - and pushing null here would silence the presenter's MIC as
    // well, since the mesh treats an override of null as "use the camera
    // track" only when there is no override set at all.
    if (cap.audio) this.deps.setAudioOverride(cap.audio);
    this.state = "live";
    this.deps.announce(true);
    this.deps.onChange("live");
    return true;
  }

  /**
   * Stop, and hand the senders back to the camera and mic.
   *
   * The captured TRACKS are deliberately not stopped. Repeated
   * `captureStream()` calls on one media element return the same stream in
   * some engines, so stopping its tracks can leave a later share holding
   * permanently ended ones - a share that starts, reports success and shows
   * black. Clearing the override is enough: with nothing referencing the
   * track, nothing encodes it.
   */
  stop(): void {
    if (this.state === "off") return;
    this.state = "off";
    this.deps.setOverride(null);
    this.deps.setAudioOverride(null);
    this.deps.announce(false);
    this.deps.onChange("off");
  }

  /**
   * The source changed under a live share.
   *
   * Re-capture rather than carry on: the old element belongs to a source
   * nobody is watching any more, and in the engines that reuse an element it
   * would keep sending the NEW picture under the OLD announcement. If the new
   * source cannot be captured this stops cleanly instead of freezing on the
   * last frame, which would look like a working share of a stalled video.
   */
  resync(): void {
    if (this.state !== "live") return;
    const cap = captureElement(this.deps.getElement());
    if (!cap) {
      this.deps.log("warn", "The new source cannot be shared live; stopping the live view.");
      this.stop();
      return;
    }
    this.deps.setOverride(cap.video);
    if (cap.audio) this.deps.setAudioOverride(cap.audio);
  }
}
