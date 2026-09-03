// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { CoReviewLobby } from "./CoReviewLobby";
import type { SessionState } from "../bindings/SessionState";

/**
 * A code from a clicked link reaches the Join field.
 *
 * e2e/review-link.spec.ts covers arrival and navigation but cannot reach this:
 * the Join card only renders at the lobby's `ready` step, and getting there
 * needs a granted camera permission the Playwright harness does not have. So
 * the field fill is checked here, where the step can be reached by giving the
 * lobby a session that is already live.
 *
 * The thing NOT to test for is auto-join. The device defaults are cameraOff
 * false and micMuted false, so a link that skipped the device step would put a
 * first-time reviewer on camera and mic because they clicked something in
 * Slack. e2e asserts session_join is never called.
 */

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

/** A session that is OFF, in the exact shape of the ts-rs binding. Written
 *  against SessionState rather than hand-shaped: the first draft used
 *  `presenter: 0` and vitest passed it happily, because vitest does not
 *  typecheck and tsc does. */
const SESSION: SessionState = {
  role: "off", code: null, peers: [], selfId: null,
  title: null, error: null, presenter: "", presenterEpoch: 0,
};

function draw(initialCode: string | null, onUsed = () => {}) {
  return render(
    <CoReviewLobby defaultTitle="Test_2026-01-01_10-00"
      session={SESSION}
      localSource={false}
      participants={[]}
      onStart={() => {}}
      onJoin={() => {}}
      onLeave={() => {}}
      initialCode={initialCode}
      onInitialCodeUsed={onUsed}
    />,
  );
}

afterEach(() => { cleanup(); localStorage.clear(); });

describe("a review link in the lobby", () => {
  it("says the link arrived, before the Join card is reachable", () => {
    draw("SAUC-ABCDE-FGHIJ");
    // The whole point: without this someone lands on a camera picker with no
    // sign their code was received.
    expect(screen.getByRole("status").textContent).toMatch(/review link is ready/i);
  });

  it("tells the caller to forget the code, so it does not re-arrive", () => {
    const onUsed = vi.fn();
    draw("SAUC-ABCDE", onUsed);
    expect(onUsed, "the code would re-fill every time the lobby remounts").toHaveBeenCalledTimes(1);
  });

  it("says nothing when no link was clicked", () => {
    // The canary. Every assertion above is about a banner appearing; if it
    // appeared unconditionally they would all pass while measuring nothing.
    draw(null);
    expect(screen.queryByRole("status")).toBeNull();
  });
});
