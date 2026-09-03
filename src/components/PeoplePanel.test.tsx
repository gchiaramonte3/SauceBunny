// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { PeoplePanel, type Participant } from "./PeoplePanel";

// The panel subscribes to the green-room capture on mount. That path reaches
// getUserMedia through lib/media-devices, which jsdom has no answer for, and
// none of it is what these tests are about.
vi.mock("../hooks/use-media-capture", () => ({
  getSessionCapture: () => null,
  subscribeSessionCapture: () => () => {},
}));

/**
 * The roster live region.
 *
 * Every control in this panel is labelled, which covers "what is this" but
 * not "something changed". In a co-review session the roster is the one
 * thing that moves without you touching anything, so a screen reader user
 * had to go and check whether anyone had arrived. The app already announces
 * that a peer sent an emoji; this is the same courtesy for the peer.
 *
 * The three ways a naive version of this gets it wrong, one test each:
 * announcing the room you just walked into, announcing yourself, and
 * announcing a stale roster after a rejoin.
 */
const p = (id: string, name: string, extra: Partial<Participant> = {}): Participant => ({
  id, name, color: "#6d52ed", isHost: id === "m0", isSelf: false, ...extra,
});

const region = () => screen.getByRole("status").textContent;

const base = {
  remoteStreams: new Map(), peerStates: new Map(),
  sharingMembers: new Set<string>(), shareStream: null,
  raisedHands: new Set<string>(), reactionFlashes: new Map(),
} as const;

describe("PeoplePanel roster announcements", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("says nothing about the room you just walked into", () => {
    // Entering a session that already has two people in it is not two
    // arrivals. The first roster is a baseline.
    render(<PeoplePanel {...base} active participants={[p("m0", "Nika"), p("m1", "Ada")]} />);
    expect(region()).toBe("");
  });

  it("announces someone arriving", () => {
    const { rerender } = render(
      <PeoplePanel {...base} active participants={[p("m0", "Nika")]} />,
    );
    rerender(<PeoplePanel {...base} active participants={[p("m0", "Nika"), p("m1", "Ada")]} />);
    expect(region()).toBe("Ada joined the session");
  });

  it("announces someone leaving, by name, after they are gone", () => {
    // The name has to survive the person: once they drop off `participants`
    // there is nowhere left to look it up, which is why the baseline keeps
    // names and not just ids.
    const { rerender } = render(
      <PeoplePanel {...base} active participants={[p("m0", "Nika"), p("m1", "Ada")]} />,
    );
    rerender(<PeoplePanel {...base} active participants={[p("m0", "Nika")]} />);
    expect(region()).toBe("Ada left the session");
  });

  it("coalesces a simultaneous join and leave into one sentence", () => {
    // A polite region announces only its latest value, so two setState calls
    // in a tick would drop the first event silently.
    const { rerender } = render(
      <PeoplePanel {...base} active participants={[p("m0", "Nika"), p("m1", "Ada")]} />,
    );
    rerender(<PeoplePanel {...base} active participants={[p("m0", "Nika"), p("m2", "Bo")]} />);
    expect(region()).toBe("Bo joined the session. Ada left the session");
  });

  it("counts a crowd instead of listing it", () => {
    const { rerender } = render(<PeoplePanel {...base} active participants={[p("m0", "Nika")]} />);
    rerender(
      <PeoplePanel
        {...base}
        active
        participants={[p("m0", "Nika"), p("m1", "Ada"), p("m2", "Bo"), p("m3", "Cy")]}
      />,
    );
    expect(region()).toBe("3 people joined the session");
  });

  it("never announces you", () => {
    // Your own tile appears the moment you enter. "You joined the session"
    // is noise at best and confusing at worst.
    const { rerender } = render(<PeoplePanel {...base} active participants={[p("m0", "Nika")]} />);
    rerender(
      <PeoplePanel
        {...base}
        active
        participants={[p("m0", "Nika"), p("m9", "You", { isSelf: true })]}
      />,
    );
    expect(region()).toBe("");
  });

  it("does not replay the last session's roster on a rejoin", () => {
    // This panel stays MOUNTED between sessions - it is a stable sibling of
    // <main> so entering a room never remounts the player. Without a reset on
    // leave, the next session diffs against the last one and announces a
    // departure and an arrival that never happened.
    const { rerender } = render(
      <PeoplePanel {...base} active participants={[p("m0", "Nika"), p("m1", "Ada")]} />,
    );
    rerender(<PeoplePanel {...base} active={false} participants={[]} />);
    rerender(<PeoplePanel {...base} active participants={[p("m0", "Nika"), p("m2", "Bo")]} />);
    expect(region()).toBe("");
  });

  it("keeps the region present and polite so changes are read, not found", () => {
    render(<PeoplePanel {...base} active participants={[p("m0", "Nika")]} />);
    const el = screen.getByRole("status");
    // A region that only appears WITH content is unreliable: some screen
    // readers miss the insertion. It ships empty and gets filled.
    expect(el.getAttribute("aria-live")).toBe("polite");
    expect(el.className).toContain("cp-visually-hidden");
  });
});

// ── One mic, one truth ──────────────────────────────────────────────────
//
// A real session showed a mic BUTTON reading live while a mute GLYPH two
// pixels below it read muted. They were computed from unrelated sources: the
// button from the persisted intent flag, the glyph from the audio track. On
// your own tile the track is a WebAudio destination track whose `.muted` is
// permanently false and which never fires mute/unmute, and muting flips
// `enabled` in place - so the glyph froze at its first reading and could
// never re-converge with the button.

// COVERAGE NOTE, stated because a break-test proved it: the assertions below
// pin the GLYPH half of the fix (the self tile renders no second indicator).
// The other half - `micMuted = p.isSelf ? selfMicMuted : trackMicMuted` - now
// feeds only the speaking glow, and reverting it to the track source does NOT
// fail these tests. Driving `speaking` needs a live AudioContext RMS loop that
// jsdom cannot provide, so that half is deliberately unguarded rather than
// falsely covered. If you touch it, check by hand that a muted self tile does
// not glow while you talk.
describe("the self tile's mic state", () => {
  // This file renders into a shared document; without this the previous
  // test's tile (and its open menu) is still in the DOM.
  beforeEach(() => { document.body.innerHTML = ""; vi.clearAllMocks(); });

  it("shows exactly ONE mic indicator, and it follows the control", () => {
    const self = p("m0", "Gasper", { isSelf: true, isHost: true });
    const { rerender } = render(
      <PeoplePanel {...base} active participants={[self]} selfMicMuted onToggleMic={() => {}}
        selfCamOff={false} onToggleCam={() => {}} />,
    );
    // Muted: the button says so. The separate glyph must not exist at all -
    // it is what used to contradict the button.
    expect(screen.getByLabelText("Unmute")).toBeTruthy();
    expect(document.querySelectorAll(".cp-person.self .cp-person-muted")).toHaveLength(0);

    // Unmute: the button flips. Under the old code the glyph stayed red here
    // for the rest of the session.
    rerender(
      <PeoplePanel {...base} active participants={[self]} selfMicMuted={false} onToggleMic={() => {}}
        selfCamOff={false} onToggleCam={() => {}} />,
    );
    expect(screen.getByLabelText("Mute")).toBeTruthy();
    expect(document.querySelectorAll(".cp-person.self .cp-person-muted")).toHaveLength(0);
  });
});

describe("a peer's tile", () => {
  beforeEach(() => { document.body.innerHTML = ""; });

  it("carries no control buttons over their face", () => {
    render(
      <PeoplePanel {...base} active participants={[p("m0", "Gasper", { isSelf: true, isHost: true }), p("m1", "Jamien")]}
        canGrantPresenter onMakePresenter={() => {}} onToggleMuteForMe={() => {}}
        onRemovePerson={() => {}} selfCamOff={false} selfMicMuted={false}
        onToggleCam={() => {}} onToggleMic={() => {}} />,
    );
    // The three hover buttons and the button that floated over the picture.
    expect(document.querySelectorAll(".cp-person-ctl.remote")).toHaveLength(0);
    expect(document.querySelectorAll(".cp-person-grant")).toHaveLength(0);
    expect(screen.queryByText("Let them present"), "the grant button is back on the tile").toBeNull();
  });

  it("puts every per-person action behind right-click", async () => {
    const onMakePresenter = vi.fn();
    render(
      <PeoplePanel {...base} active participants={[p("m0", "Gasper", { isSelf: true, isHost: true }), p("m1", "Jamien")]}
        canGrantPresenter onMakePresenter={onMakePresenter} onToggleMuteForMe={() => {}}
        onRemovePerson={() => {}} selfCamOff={false} selfMicMuted={false}
        onToggleCam={() => {}} onToggleMic={() => {}} />,
    );
    const tiles = document.querySelectorAll(".cp-person");
    const peer = [...tiles].find((t) => !t.classList.contains("self"))!;
    expect(document.querySelector(".cp-person-menu")).toBeNull();

    const { fireEvent } = await import("@testing-library/react");
    fireEvent.contextMenu(peer);
    expect(document.querySelector(".cp-person-menu"), "right-click opened no menu").toBeTruthy();
    fireEvent.click(screen.getByText("Let them present"));
    expect(onMakePresenter).toHaveBeenCalledWith("m1");
  });

  it("offers nothing on your OWN tile", async () => {
    render(
      <PeoplePanel {...base} active participants={[p("m0", "Gasper", { isSelf: true, isHost: true })]}
        canGrantPresenter onMakePresenter={() => {}} onToggleMuteForMe={() => {}}
        selfCamOff={false} selfMicMuted={false} onToggleCam={() => {}} onToggleMic={() => {}} />,
    );
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.contextMenu(document.querySelector(".cp-person.self")!);
    expect(document.querySelector(".cp-person-menu"), "you can act on yourself").toBeNull();
  });
});
