// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import type { NdiPreflightResult } from "../bindings/NdiPreflightResult";
import { emptyNdiState } from "../hooks/use-ndi-input";
import { NDI_LINKS, NdiAttribution, PremiereSetup, PremiereSetupLinks } from "./PremiereSetup";
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
const ready: NdiPreflightResult = {
  bridgeCompiled: true, runtime: "ready", runtimeVersion: "6.3.2", runtimeOrigin: "bundled",
  premiereInstalled: true, premiereVersion: "26.3.2", pluginInstalled: true, error: null,
};
beforeEach(() => { mocks.invoke.mockReset(); mocks.invoke.mockResolvedValue(ready); });
afterEach(cleanup);
describe("Premiere one-time setup", () => {
  it("owns receiver diagnostics in Settings, including separate drop counters", async () => {
    render(<PremiereSetup telemetry={{...emptyNdiState(),sourceId:"ndi-test",phase:"live",inputWidth:1920,inputHeight:1080,
      outputFps:30,receivedFrames:1800,ndiDroppedFrames:2,encoderDroppedFrames:3,lastInputAgeMs:14,encodedBitrateKbps:6192}}/>);
    const details = screen.getByRole("button", { name: "Connection details" });
    expect(details.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(details);
    expect(details.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(/NDI drops 2 · encoder drops 3/).textContent).toContain("6,192 kbps");
    await screen.findByText(/Premiere output plugin found/);
    expect(mocks.invoke.mock.calls.every(([command])=>command==="ndi_preflight")).toBe(true);
  });
  it("does not initialize NDI or download anything merely to display links", () => {
    render(<><PremiereSetupLinks /><NdiAttribution /></>);
    expect(mocks.invoke).not.toHaveBeenCalled();
    expect(screen.getByText(/Reviewers do not need this/)).toBeTruthy();
  });
  it("opens only the clicked official installer or fallback", async () => {
    render(<PremiereSetupLinks />);
    fireEvent.click(screen.getByRole("button", { name: "Download NDI Tools for Premiere" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("open_external_url", { url: NDI_LINKS.installer }));
    fireEvent.click(screen.getByRole("button", { name: "NDI Tools website" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("open_external_url", { url: NDI_LINKS.tools }));
    expect(mocks.invoke).toHaveBeenCalledTimes(2);
  });
  it("provides the required NDI information link", async () => {
    render(<NdiAttribution />); fireEvent.click(screen.getByRole("button", { name: "About NDI" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledWith("open_external_url", { url: NDI_LINKS.information }));
  });
  it("does not describe installed plugins as a working picture", async () => {
    render(<PremiereSetup />);
    await waitFor(() => expect(screen.getByRole("status", { name: "NDI installation" }).textContent).toBe("Premiere output plugin found"));
    expect(screen.getByText(/Installation alone does not confirm a working picture/)).toBeTruthy();
    expect(screen.getByText(/included with Sauce Bunny/)).toBeTruthy();
    expect(mocks.invoke).toHaveBeenCalledWith("ndi_preflight");
    expect(mocks.invoke).not.toHaveBeenCalledWith("ndi_start", expect.anything());
  });
  it("rechecks on returning from the installer without starting a receiver", async () => {
    mocks.invoke.mockResolvedValueOnce({ ...ready, pluginInstalled: false }); render(<PremiereSetup />);
    await waitFor(() => expect(screen.getByRole("status", { name: "NDI installation" }).textContent).toBe("Premiere output plugin not found"));
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(screen.getByRole("status", { name: "NDI installation" }).textContent).toBe("Premiere output plugin found"));
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(mocks.invoke).toHaveBeenCalledTimes(3));
    expect(mocks.invoke.mock.calls.every(([command]) => command === "ndi_preflight")).toBe(true);
  });
  it("coalesces focus checks and ignores a result after closing", async () => {
    let finish!: (value: NdiPreflightResult) => void;
    mocks.invoke.mockReturnValue(new Promise(resolve => { finish = resolve; }));
    const panel = render(<PremiereSetup />);
    fireEvent(window, new Event("focus")); fireEvent(window, new Event("focus"));
    const retry = screen.getByRole("button", { name: "Check again" });
    expect(retry.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(retry); fireEvent.click(retry);
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
    panel.unmount(); await act(async () => { finish(ready); });
    fireEvent(window, new Event("focus")); expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });
  it.each([true, false])("does not retain a stale installation claim after a failed recheck (installed=%s)", async pluginInstalled => {
    mocks.invoke.mockResolvedValueOnce({ ...ready, pluginInstalled });
    render(<PremiereSetup />);
    const status = screen.getByRole("status", { name: "NDI installation" });
    await waitFor(() => expect(status.textContent).toBe(pluginInstalled ? "Premiere output plugin found" : "Premiere output plugin not found"));
    mocks.invoke.mockRejectedValueOnce({ kind: "Io", data: "Cannot inspect the Premiere output plugin: permission denied" });
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(status.textContent).toBe("Installation status unavailable"));
    expect(screen.getByRole("alert").textContent).toContain("Could not check Premiere setup");
    expect(screen.getByRole("alert").textContent).toContain("permission denied");
    expect(screen.queryByText(/The plugin is installed/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(status.textContent).toBe("Premiere output plugin found"));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(mocks.invoke.mock.calls.every(([command]) => command === "ndi_preflight")).toBe(true);
  });
  it("ignores an obsolete missing-plugin response after a newer setup check succeeds", async () => {
    let finish!: (value: NdiPreflightResult) => void;
    mocks.invoke.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    render(<StrictMode><PremiereSetup /></StrictMode>);
    await waitFor(() => expect(screen.getByRole("status", { name: "NDI installation" }).textContent).toBe("Premiere output plugin found"));
    await act(async () => { finish({ ...ready, pluginInstalled: false }); });
    expect(screen.getByRole("status", { name: "NDI installation" }).textContent).toBe("Premiere output plugin found");
  });
  it("keeps installation and runtime availability separate", async () => {
    mocks.invoke.mockResolvedValueOnce({ ...ready, runtime: "incompatible", error: "NDI runtime initialization failed" });
    render(<PremiereSetup />);
    await waitFor(() => expect(screen.getByRole("status", { name: "NDI installation" }).textContent).toBe("Premiere output plugin found"));
    expect(screen.getByRole("alert").textContent).toBe("NDI runtime initialization failed");
  });
  it("shows missing-bridge and browser errors without asking users for the SDK", async () => {
    mocks.invoke.mockResolvedValueOnce({ ...ready, bridgeCompiled: false, runtime: "missing" }); render(<PremiereSetup />);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Install a build with NDI support"));
    mocks.invoke.mockRejectedValueOnce(new Error("Browser unavailable"));
    fireEvent.click(screen.getByRole("button", { name: "Download NDI Tools for Premiere" }));
    expect(await screen.findByText(/Could not open the download/)).toBeTruthy();
  });
});
