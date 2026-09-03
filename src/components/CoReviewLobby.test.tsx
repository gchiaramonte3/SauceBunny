// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CoReviewLobby } from "./CoReviewLobby";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => "") }));

// The lobby is a wizard: identity -> devices -> ready, and the Join card lives
// on READY. A returning user with permissions already granted lands there
// directly, which is the state this test needs and the one most guests are in.
vi.mock("../hooks/use-media-capture", () => ({
  useMediaCapture: () => ({
    permission: "granted", stream: null, choice: { cameraOff: true, micOff: true },
    devices: { cameras: [], mics: [] }, error: null,
    enable: vi.fn(), release: vi.fn(), setChoice: vi.fn(), pick: vi.fn(),
  }),
}));
vi.mock("./GreenRoomDevices", () => ({ GreenRoomDevices: () => null }));
/** The screenings the store claims exist. Mutated per test; the lobby reads it
 *  through listScreenings, which is what the unique-name rule is built on. */
const takenTitles: string[] = [];
vi.mock("../lib/screening-store", async (orig) => {
  const real = await orig<typeof import("../lib/screening-store")>();
  return {
    ...real,
    hydrateScreeningIndex: async () => {},
    listScreenings: () => takenTitles.map((title, i) => ({
      id: `s${i}`, file: `s${i}.json`, title, startedAt: i, endedAt: i + 1,
      participants: ["Ada"], segmentCount: 1, commentCount: 0, bytes: 10,
    })),
  };
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); });

const session = { role: "off", error: null, code: null, peers: [] } as never;

function mount(onJoin: (t: string, n: string) => void | Promise<void>) {
  // A saved identity is what puts the wizard past the first step.
  localStorage.setItem("saucebunny.review.author", JSON.stringify("Ada"));
  render(
    <CoReviewLobby defaultTitle="Test_2026-01-01_10-00"
      session={session}
      localSource={null as never}
      participants={[] as never}
      onStart={vi.fn()}
      onJoin={onJoin}
      onLeave={vi.fn()}
    />,
  );
}

/** Paste a code and press Join. The name comes from the saved identity. */
function join() {
  const code = screen.getByPlaceholderText(/paste a join code/i) as HTMLInputElement;
  fireEvent.change(code, { target: { value: "SAUC-ABCDE" } });
  fireEvent.click(screen.getByRole("button", { name: /^join$/i }));
}

describe("the co-review lobby's Join button", () => {
  it("comes back after a failed join", async () => {
    // The lockout: joinCoReview catches its own error and only raises a
    // notification, so neither session.role nor session.error changes — the
    // effect watching them never re-ran, and the button stayed disabled at
    // "Connecting…" until the app was quit. A wrong or expired code is the
    // ordinary first-run mistake.
    mount(async () => { throw new Error("That join code doesn't look valid"); });
    join();
    await waitFor(() => {
      const btn = screen.getByRole("button", { name: /join|connecting/i }) as HTMLButtonElement;
      expect(btn.disabled, "the Join button never came back").toBe(false);
    });
  });

  it("comes back after a join that resolves without changing session state", async () => {
    mount(async () => { /* resolves, session stays "off" */ });
    join();
    await waitFor(() => {
      const btn = screen.getByRole("button", { name: /join|connecting/i }) as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
    });
  });

  it("still passes the trimmed code and name through", async () => {
    const onJoin = vi.fn(async () => {});
    mount(onJoin);
    join();
    await waitFor(() => expect(onJoin).toHaveBeenCalledWith("SAUC-ABCDE", "Ada"));
  });
});

describe("the unique-name rule stays current", () => {
  /**
   * The lobby is kept alive under [hidden] for the life of the app, so the
   * taken titles it read at mount were the only ones it ever knew. End "Rough
   * cut" and press Start again on the restored title and a duplicate went
   * straight through - a reload blocked it correctly, which is exactly what
   * made the hole hard to see. It re-reads whenever the store announces a
   * save.
   */
  function mountHost(title: string) {
    localStorage.setItem("saucebunny.review.author", JSON.stringify("Ada"));
    localStorage.setItem("saucebunny.sessionTitle", JSON.stringify(title));
    render(
      <CoReviewLobby defaultTitle="Test_2026-01-01_10-00"
        session={session}
        localSource={null as never}
        participants={[] as never}
        onStart={vi.fn()}
        onJoin={vi.fn()}
        onLeave={vi.fn()}
      />,
    );
  }

  it("blocks a name that became taken while the lobby stayed mounted", async () => {
    takenTitles.length = 0;
    mountHost("Rough cut");
    // Nothing taken yet.
    await waitFor(() => {
      expect(screen.queryByText(/already screened a session with that name/i)).toBeNull();
    });

    // A session ends and the store announces the save.
    takenTitles.push("Rough cut");
    fireEvent(window, new CustomEvent("saucebunny:screenings-changed"));

    await waitFor(() => {
      expect(screen.getByText(/already screened a session with that name/i)).toBeTruthy();
    });
  });
});
