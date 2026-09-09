// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
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

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

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

  it("preserves native Space activation without also reaching global playback shortcuts", () => {
    const onToggleCam = vi.fn();
    const onToggleMic = vi.fn();
    render(<PeoplePanel {...base} active participants={[p("m0", "Gasper", { isSelf: true })]}
      selfCamOff selfMicMuted onToggleCam={onToggleCam} onToggleMic={onToggleMic} />);
    const globalKey = vi.fn();
    document.addEventListener("keydown", globalKey);
    try {
      for (const control of [screen.getByRole("button", { name: /Gasper,.*Participant details/ }),
        screen.getByRole("button", { name: "Turn camera on" }), screen.getByRole("button", { name: "Unmute" })]) {
        const event = new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true });
        fireEvent(control, event);
        expect(event.defaultPrevented).toBe(false);
      }
      expect(globalKey).not.toHaveBeenCalled();
      expect(onToggleCam).not.toHaveBeenCalled();
      expect(onToggleMic).not.toHaveBeenCalled();
      // Actual native Space clicks are covered by the real App browser test.
      fireEvent.click(screen.getByRole("button", { name: "Turn camera on" }));
      fireEvent.click(screen.getByRole("button", { name: "Unmute" }));
      expect(onToggleCam).toHaveBeenCalledTimes(1);
      expect(onToggleMic).toHaveBeenCalledTimes(1);
    } finally { document.removeEventListener("keydown", globalKey); }
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

  it("retains the real presenter action behind right-click", () => {
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

    fireEvent.contextMenu(peer);
    expect(document.querySelector(".cp-person-menu"), "right-click opened no menu").toBeTruthy();
    fireEvent.click(screen.getByText("Let them present"));
    expect(onMakePresenter).toHaveBeenCalledWith("m1");
  });

  it("opens self details without offering peer moderation actions", () => {
    const onToggleCam = vi.fn();
    const onToggleMic = vi.fn();
    render(
      <PeoplePanel {...base} active participants={[p("m0", "Gasper", { isSelf: true, isHost: true })]}
        canGrantPresenter onMakePresenter={() => {}} onToggleMuteForMe={() => {}} onRemovePerson={() => {}}
        selfCamOff selfMicMuted onToggleCam={onToggleCam} onToggleMic={onToggleMic} />,
    );
    fireEvent.contextMenu(document.querySelector(".cp-person.self")!);
    const menu = screen.getByRole("menu", { name: "Gasper participant details" });
    expect(within(menu).queryByRole("menuitem", { name: "Let them present" })).toBeNull();
    expect(within(menu).queryByRole("menuitem", { name: "Remove from session" })).toBeNull();
    expect(within(menu).queryByRole("menuitem", { name: /for me/ })).toBeNull();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Turn camera on" }));
    expect(onToggleCam).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: /Gasper,.*Participant details/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Unmute" }));
    expect(onToggleMic).toHaveBeenCalledTimes(1);
  });

  it("exposes simultaneous states without placing indicators or controls inside the picture mask", () => {
    render(<PeoplePanel {...base} active participants={[p("m1", "Alexandra Long Name")]}
      presenter="m1" sharingMembers={new Set(["m1"])} recordingMembers={new Set(["m1"])}
      raisedHands={new Set(["m1"])} mutedForMe={new Set(["m1"])}
      peerStates={new Map([["m1", "failed"]])} />);
    const tile = document.querySelector('[data-member-id="m1"]')!;
    const picture = tile.querySelector(".cp-person-picture")!;
    const trigger = within(tile as HTMLElement).getByRole("button", { name: /Alexandra Long Name,.*Participant details/ });
    const accessibleName = trigger.getAttribute("aria-label")!;
    for (const state of ["Presenting", "Mic muted", "No camera picture", "Sharing screen", "Recording camera and mic", "Hand raised", "Muted for me", "No connection"]) {
      expect(accessibleName).toContain(state);
    }
    expect(picture.querySelector(".cp-person-signals, .cp-person-controls, .cp-person-presenting, .cp-person-presenter-pin")).toBeNull();
    for (const signal of ["cp-person-muted", "cp-person-local-muted", "cp-person-camera", "cp-person-share", "cp-person-rec", "cp-person-hand", "cp-person-conn"]) {
      expect(tile.querySelector(`.cp-person-signals .${signal}`)).toBeTruthy();
    }
    fireEvent.click(trigger);
    const menu = screen.getByRole("menu", { name: "Alexandra Long Name participant details" });
    expect(menu.parentElement).toBe(document.body);
    expect(menu.textContent).toContain("Recording camera and mic");
  });

  it("opens by the keyboard context-menu shortcut, supports menu navigation, and returns focus", () => {
    render(<PeoplePanel {...base} active participants={[p("m1", "Jamien")]}
      canGrantPresenter onMakePresenter={() => {}} onToggleMuteForMe={() => {}} onRemovePerson={() => {}} />);
    const trigger = screen.getByRole("button", { name: /Jamien,.*Participant details/ });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "F10", shiftKey: true });
    const menu = screen.getByRole("menu");
    const items = within(menu).getAllByRole("menuitem");
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(menu, { key: "End" });
    expect(document.activeElement).toBe(items.at(-1));
    fireEvent.keyDown(menu, { key: "Home" });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps local hide/mute, handoff, and removal bound to the selected member", () => {
    const onToggleMuteForMe = vi.fn();
    const onMakePresenter = vi.fn();
    const onRemovePerson = vi.fn();
    render(<PeoplePanel {...base} active participants={[p("m1", "Jamien")]}
      canGrantPresenter onMakePresenter={onMakePresenter} onToggleMuteForMe={onToggleMuteForMe}
      onRemovePerson={onRemovePerson} />);
    const trigger = screen.getByRole("button", { name: /Jamien,.*Participant details/ });
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Hide their video for me" }));
    expect(trigger.getAttribute("aria-label")).toContain("Video hidden for me");
    fireEvent.click(trigger);
    expect(screen.getByRole("menuitem", { name: "Show their video for me" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Mute them for me" }));
    expect(onToggleMuteForMe).toHaveBeenCalledExactlyOnceWith("m1", true);
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Let them present" }));
    expect(onMakePresenter).toHaveBeenCalledExactlyOnceWith("m1");
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove from session" }));
    expect(onRemovePerson).toHaveBeenCalledExactlyOnceWith("m1", "Jamien");
  });

  it("does not invent host permissions or offer a handoff to the current presenter", () => {
    const { rerender } = render(<PeoplePanel {...base} active participants={[p("m1", "Jamien")]}
      onMakePresenter={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Jamien,.*Participant details/ }));
    expect(screen.queryByRole("menuitem", { name: "Let them present" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Remove from session" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Close details" }));
    rerender(<PeoplePanel {...base} active participants={[p("m1", "Jamien")]}
      canGrantPresenter presenter="m1" onMakePresenter={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /Jamien,.*Participant details/ }));
    expect(screen.queryByRole("menuitem", { name: "Let them present" })).toBeNull();
  });

  it("keeps the same video element through compact and theater presentation changes", () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    const stream = { getVideoTracks: () => [{ enabled: true, muted: false }], getAudioTracks: () => [] } as unknown as MediaStream;
    const props = { ...base, active: true, participants: [p("m1", "Jamien")], remoteStreams: new Map([["m1", stream]]) };
    const { rerender } = render(<PeoplePanel {...props} />);
    const video = document.querySelector("video")!;
    expect(video.srcObject).toBe(stream);
    expect(play).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Collapse the people panel to avatars" }));
    expect(document.querySelector("video")).toBe(video);
    rerender(<PeoplePanel {...props} strip />);
    expect(document.querySelector("video")).toBe(video);
    expect(document.querySelector(".cp-people.strip")).toBeTruthy();
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("clamps the portal to the viewport and dismisses on resize", () => {
    const original = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("cp-person-menu")
        ? { x: 0, y: 0, left: 0, top: 0, width: 264, height: 300, right: 264, bottom: 300, toJSON() {} }
        : original.call(this);
    });
    render(<PeoplePanel {...base} active participants={[p("m1", "Jamien")]} />);
    const trigger = screen.getByRole("button", { name: /Jamien,.*Participant details/ });
    fireEvent.contextMenu(trigger, { clientX: window.innerWidth - 1, clientY: window.innerHeight - 1 });
    const menu = screen.getByRole("menu");
    expect(menu.style.left).toBe(`${window.innerWidth - 264 - 12}px`);
    expect(menu.style.top).toBe(`${window.innerHeight - 300 - 12}px`);
    fireEvent.resize(window);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes on a second trigger click or outside click without immediately reopening", async () => {
    render(<PeoplePanel {...base} active participants={[p("m1", "Jamien")]} />);
    const trigger = screen.getByRole("button", { name: /Jamien,.*Participant details/ });
    fireEvent.click(trigger);
    await new Promise(resolve => setTimeout(resolve, 1));
    fireEvent.mouseDown(trigger);
    fireEvent.click(trigger);
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(trigger);
    await new Promise(resolve => setTimeout(resolve, 1));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
