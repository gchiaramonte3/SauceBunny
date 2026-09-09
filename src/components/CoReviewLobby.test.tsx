// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { CoReviewLobby } from "./CoReviewLobby";
import { hydrateScreeningIndex } from "../lib/screening-store";

const mocks = vi.hoisted(() => ({
  cap: {
    permission: "granted", stream: null as MediaStream | null,
    choice: { cameraOff: true, micMuted: false }, devices: { cameras: [], mics: [] }, error: null,
    acquire: vi.fn(), release: vi.fn(), setEnabled: vi.fn(),
  },
  devices: vi.fn(),
  titles: [] as string[],
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../hooks/use-media-capture", () => ({ useMediaCapture: () => mocks.cap }));
vi.mock("./GreenRoomDevices", () => ({ GreenRoomDevices: (props: { onContinue: () => void }) => {
  mocks.devices();
  return <section aria-label="Camera and microphone"><button onClick={props.onContinue}>Continue</button></section>;
} }));
vi.mock("../lib/screening-store", async (orig) => {
  const real = await orig<typeof import("../lib/screening-store")>();
  return { ...real, hydrateScreeningIndex: vi.fn(async () => {}),
    listScreenings: () => mocks.titles.map((title, i) => ({
      id: "s" + i, file: "s" + i + ".json", title, startedAt: i, endedAt: i + 1,
      participants: ["Ada"], segmentCount: 1, commentCount: 0, bytes: 10,
    })),
  };
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.titles.length = 0;
  mocks.cap.permission = "granted";
  mocks.cap.stream = null;
  mocks.cap.choice = { cameraOff: true, micMuted: false };
  vi.mocked(hydrateScreeningIndex).mockResolvedValue();
  vi.mocked(invoke).mockImplementation(async (command) => {
    if (command === "list_review_grants") return [{ id: "grant", label: "Dana", revoked: false, lastSeenAt: null }];
    if (command === "review_invited_only") return true;
    if (command === "review_code") return "SAUC-HOST";
    if (command === "create_review_grant") return { label: "New reviewer", secret: "one-time-secret" };
    return null;
  });
});
afterEach(() => { cleanup(); localStorage.clear(); });
const session = { role: "off", error: null, code: null, peers: [] } as never;
function mount(extra: Partial<Parameters<typeof CoReviewLobby>[0]> = {}, returning = true) {
  if (returning) localStorage.setItem("saucebunny.review.author", JSON.stringify("Ada"));
  const props = { defaultTitle: "Review", session, localSource: false, participants: [],
    onStart: vi.fn(), onJoin: vi.fn(async () => {}), onLeave: vi.fn(), ...extra };
  return { ...render(<CoReviewLobby {...props} />), props };
}
const titleInput = () => screen.getByRole("textbox", { name: "Session name" }) as HTMLInputElement;
const start = () => screen.getByRole("button", { name: "Start session" }) as HTMLButtonElement;
function join() {
  fireEvent.click(screen.getByRole("tab", { name: "Join a session" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Join code" }), { target: { value: "  SAUC-ABCDE  " } });
  fireEvent.click(screen.getByRole("button", { name: "Join" }));
}

describe("compact Review setup", () => {
  it("keeps Premiere independent of identity, device permission, and room entry", async () => {
    mocks.cap.permission = "denied";
    const connect = vi.fn();
    const { props } = mount({ onConnectPremiere: connect }, false);
    expect(screen.getByRole("region", { name: "Session setup" })).toBeTruthy();
    expect(screen.queryByRole("main")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Preview Premiere…" }));
    expect(connect).toHaveBeenCalledOnce();
    expect(props.onStart).not.toHaveBeenCalled(); expect(props.onJoin).not.toHaveBeenCalled();
    expect(mocks.cap.acquire).not.toHaveBeenCalled(); expect(mocks.devices).not.toHaveBeenCalled();
    await waitFor(() => expect(start().disabled).toBe(true));
  });
  it("returns to an existing private preview without implying publication", () => {
    const connect = vi.fn();
    mount({ onConnectPremiere: connect, premierePreviewName: "Editor Premiere" });
    expect(screen.getByText("Premiere ready · Not shared").title).toBe("Editor Premiere");
    fireEvent.click(screen.getByRole("button", { name: "Preview Premiere…" }));
    expect(connect).toHaveBeenCalledOnce();
  });
  it("shows actual inactive devices and mounts their editor only on Change", () => {
    mount();
    expect(screen.getByText("Camera off · Microphone off")).toBeTruthy();
    expect(mocks.devices).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Change…" }));
    expect(screen.getByRole("region", { name: "Camera and microphone" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.queryByRole("region", { name: "Camera and microphone" })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Change…" }));
  });
  it("selects one form and retains both inputs while switching", async () => {
    mount();
    await waitFor(() => expect(start().disabled).toBe(false));
    fireEvent.change(titleInput(), { target: { value: "Grade pass" } });
    expect(screen.queryByRole("textbox", { name: "Join code" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Join a session" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Join code" }), { target: { value: "SAUC-SAVED" } });
    expect(screen.queryByRole("textbox", { name: "Session name" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Host a session" }));
    expect(titleInput().value).toBe("Grade pass");
    fireEvent.click(screen.getByRole("tab", { name: "Join a session" }));
    expect((screen.getByRole("textbox", { name: "Join code" }) as HTMLInputElement).value).toBe("SAUC-SAVED");
  });
  it("supports arrow and Home/End selection with keyboard focus", () => {
    mount();
    const host = screen.getByRole("tab", { name: "Host a session" });
    const guest = screen.getByRole("tab", { name: "Join a session" });
    host.focus(); fireEvent.keyDown(host, { key: "ArrowRight" });
    expect(document.activeElement).toBe(guest); expect(guest.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(guest, { key: "Home" });
    expect(document.activeElement).toBe(host);
    fireEvent.keyDown(host, { key: "End" });
    expect(document.activeElement).toBe(guest);
  });
  it("selects and prefills an arrived link without joining or acquiring devices", () => {
    const consumed = vi.fn();
    const { props } = mount({ initialCode: "SAUC-RECEIVED", onInitialCodeUsed: consumed });
    expect(screen.getByRole("tab", { name: "Join a session" }).getAttribute("aria-selected")).toBe("true");
    expect((screen.getByRole("textbox", { name: "Join code" }) as HTMLInputElement).value).toBe("SAUC-RECEIVED");
    expect(screen.getByText(/Your review link is ready/)).toBeTruthy();
    expect(consumed).toHaveBeenCalledOnce(); expect(props.onJoin).not.toHaveBeenCalled();
    expect(mocks.cap.acquire).not.toHaveBeenCalled(); expect(mocks.devices).not.toHaveBeenCalled();
  });
  it("navigates to the Library history without mounting a growing shelf", () => {
    const history = vi.fn(); mount({ onOpenSessionHistory: history });
    fireEvent.click(screen.getByRole("button", { name: "Past sessions in Library" }));
    expect(history).toHaveBeenCalledOnce(); expect(document.querySelector(".cp-screenings")).toBeNull();
  });
  it("hides review links from onboarding without resetting invitations or policy", async () => {
    const { props, rerender } = mount();
    const details = screen.getByText("Manage access").closest("details")!;
    await waitFor(() => expect((screen.getByLabelText(/Only let people in through a link/) as HTMLInputElement).checked).toBe(true));
    expect(details.open).toBe(false);
    expect(details.hidden).toBe(true);
    expect(screen.queryByRole("textbox", { name: "Who is this for" })).toBeNull();
    expect(screen.getByText("Dana")).toBeTruthy();
    expect(vi.mocked(invoke).mock.calls.some(([c]) => c === "set_review_invited_only")).toBe(false);
    rerender(<CoReviewLobby {...props} session={{ role: "host", code: "SAUC-HOST", error: null, peers: [] } as never} />);
    expect(details.hidden).toBe(false);
    details.open = true;
    fireEvent.change(screen.getByRole("textbox", { name: "Who is this for" }), { target: { value: "New reviewer" } });
    fireEvent.click(screen.getByRole("button", { name: "Make a link" }));
    await screen.findByText("New reviewer");
    details.open = false; details.open = true;
    expect(screen.getByRole("button", { name: "Copy link" })).toBeTruthy();
    expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === "create_review_grant")).toHaveLength(1);
  });
  it("retains a newly issued one-time secret through room entry and exit", async () => {
    const { props, rerender } = mount({ session: { role: "host", code: "SAUC-HOST", error: null, peers: [] } as never });
    const details = screen.getByText("Manage access").closest("details")!;
    details.open = true;
    fireEvent.change(screen.getByRole("textbox", { name: "Who is this for" }), { target: { value: "New reviewer" } });
    fireEvent.click(screen.getByRole("button", { name: "Make a link" }));
    await screen.findByText("New reviewer");
    const grantPanel = document.querySelector(".cp-grants");
    rerender(<CoReviewLobby {...props} session={{ role: "host", code: "SAUC-HOST", error: null, peers: [] } as never} />);
    expect(document.querySelector(".cp-grants")).toBe(grantPanel);
    expect(screen.getByRole("button", { name: "Copy link" })).toBeTruthy();
    rerender(<CoReviewLobby {...props} session={session} />);
    expect(document.querySelector(".cp-grants")).toBe(grantPanel);
    expect(screen.queryByRole("button", { name: "Copy link" })).toBeNull();
    rerender(<CoReviewLobby {...props} session={{ role: "host", code: "SAUC-HOST", error: null, peers: [] } as never} />);
    expect(screen.getByRole("button", { name: "Copy link" })).toBeTruthy();
    expect(vi.mocked(invoke).mock.calls.filter(([c]) => c === "review_code")).toHaveLength(1);
  });
});

describe("Join recovers", () => {
  it("after a rejected attempt", async () => {
    mount({ onJoin: async () => { throw new Error("Wrong code"); } }); join();
    await waitFor(() => expect((screen.getByRole("button", { name: "Join" }) as HTMLButtonElement).disabled).toBe(false));
  });
  it("after an attempt resolved without changed session state", async () => {
    mount(); join();
    await waitFor(() => expect((screen.getByRole("button", { name: "Join" }) as HTMLButtonElement).disabled).toBe(false));
  });
  it("passes the trimmed code and name", async () => {
    const { props } = mount(); join();
    await waitFor(() => expect(props.onJoin).toHaveBeenCalledWith("SAUC-ABCDE", "Ada"));
  });
});

describe("session names", () => {
  it("suggests the next free name on entry instead of reopening on an error", async () => {
    mocks.titles.push("Nika Test 5", "Nika Test 6");
    localStorage.setItem("saucebunny.sessionTitle", JSON.stringify("Nika Test 5"));
    const { props } = mount();
    await waitFor(() => expect(titleInput().value).toBe("Nika Test 7"));
    expect(start().disabled).toBe(false); expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(start()); expect(props.onStart).toHaveBeenCalledWith("Nika Test 7");
  });
  it("does not overwrite typing when history hydration completes late", async () => {
    let finish!: () => void;
    vi.mocked(hydrateScreeningIndex).mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    mocks.titles.push("Review"); mount();
    fireEvent.change(titleInput(), { target: { value: "My new title" } });
    finish();
    await waitFor(() => expect(start().disabled).toBe(false));
    expect(titleInput().value).toBe("My new title");
  });
  it("blocks an intentional duplicate and offers a one-click suggestion", async () => {
    mocks.titles.push("Review"); const { props } = mount();
    await waitFor(() => expect(titleInput().value).toBe("Review 2"));
    fireEvent.change(titleInput(), { target: { value: " review " } });
    expect(start().disabled).toBe(true);
    fireEvent.keyDown(titleInput(), { key: "Enter" }); expect(props.onStart).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Use “review 2”" }));
    expect(start().disabled).toBe(false);
  });
  it("cannot bypass duplicate protection with a blank field and taken default", async () => {
    mocks.titles.push("Review"); const { props } = mount();
    await waitFor(() => expect(titleInput().value).toBe("Review 2"));
    fireEvent.change(titleInput(), { target: { value: "" } });
    expect(start().disabled).toBe(true);
    fireEvent.keyDown(titleInput(), { key: "Enter" }); expect(props.onStart).not.toHaveBeenCalled();
  });
  it("protects a user-edited name that becomes taken while mounted", async () => {
    mount(); await waitFor(() => expect(start().disabled).toBe(false));
    fireEvent.change(titleInput(), { target: { value: "Rough cut" } });
    mocks.titles.push("Rough cut"); fireEvent(window, new CustomEvent("saucebunny:screenings-changed"));
    await waitFor(() => expect(start().disabled).toBe(true));
    expect(titleInput().value).toBe("Rough cut");
  });
  it("advances an untouched suggestion when another screening is saved", async () => {
    mount(); await waitFor(() => expect(start().disabled).toBe(false));
    mocks.titles.push("Review"); fireEvent(window, new CustomEvent("saucebunny:screenings-changed"));
    await waitFor(() => expect(titleInput().value).toBe("Review 2"));
    expect(start().disabled).toBe(false);
  });
});
