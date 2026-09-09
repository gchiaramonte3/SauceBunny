import { afterEach, describe, expect, it, vi } from "vitest";
import { BridgeClient, type SocketFactory } from "./bridge-client";

const page = { offset: 0, total: 0, hasMore: false };
const status = { phase: "connected", binding: null, syncEnabled: false, automaticPlacement: false,
  pendingCount: 0, otherBindingPendingCount: 0, ledgerRevision: 0, error: null };
function socketFixture() {
  const sent: Record<string, unknown>[] = [];
  const socket = { readyState: 1, onopen: null as WebSocket["onopen"], onclose: null as WebSocket["onclose"],
    onerror: null as WebSocket["onerror"], onmessage: null as WebSocket["onmessage"], close: vi.fn(),
    send: vi.fn((value: string) => { sent.push(JSON.parse(value) as Record<string, unknown>); }) };
  const factory = vi.fn((() => socket) as SocketFactory);
  const client = new BridgeClient(factory);
  const message = (value: unknown) => socket.onmessage?.call(socket as unknown as WebSocket, { data: JSON.stringify(value) } as MessageEvent);
  const open = () => socket.onopen?.call(socket as unknown as WebSocket, {} as Event);
  async function pair() {
    const result = client.pair("ws://127.0.0.1:51700/premiere", "a".repeat(64));
    open(); message({ v: 1, id: sent[0].id, type: "snapshot", status, notes: [], page });
    await result;
  }
  return { client, socket, sent, message, open, pair, factory };
}
afterEach(() => vi.useRealTimers());

describe("authenticated command client", () => {
  it("rejects untrusted input before converting the loopback alias or opening a socket", async () => {
    const f = socketFixture();
    for (const url of ["ws://localhost:51700/premiere", "ws://127.0.0.1.evil.test:51700/premiere", "ws://example.com:51700/premiere"])
      await expect(f.client.pair(url, "a".repeat(64))).rejects.toThrow("local pairing address");
    expect(f.factory).not.toHaveBeenCalled();
  });
  it("places the pairing secret in the first message, never the URL", async () => {
    const f = socketFixture(); await f.pair();
    expect(f.factory).toHaveBeenCalledWith("ws://localhost:51700/premiere");
    expect(f.sent[0]).toMatchObject({ v: 1, type: "hello", token: "a".repeat(64) });
    expect(f.sent).toHaveLength(1); f.client.disconnect();
  });
  it("cancels an opening connection immediately without waiting for a timeout", async () => {
    const f = socketFixture(); const paired = f.client.pair("ws://127.0.0.1:51700/premiere", "a".repeat(64));
    f.client.disconnect(); await expect(paired).rejects.toThrow("cancelled");
    expect(f.socket.close).toHaveBeenCalledTimes(1); expect(f.sent).toHaveLength(0);
  });
  it("preserves a network failure instead of reporting that the user cancelled", async () => {
    const f = socketFixture(); const disconnected = vi.fn(); f.client.onDisconnect = disconnected;
    const paired = f.client.pair("ws://127.0.0.1:51700/premiere", "a".repeat(64));
    f.socket.onerror?.call(f.socket as unknown as WebSocket, {} as Event);
    await expect(paired).rejects.toThrow("Cannot reach Sauce Bunny");
    expect(disconnected.mock.calls.at(-1)?.[0]).toContain("Cannot reach Sauce Bunny");
    expect(f.socket.close).toHaveBeenCalledTimes(1);
  });
  it("preserves the opening timeout reason", async () => {
    vi.useFakeTimers(); const f = socketFixture();
    const paired = f.client.pair("ws://127.0.0.1:51700/premiere", "a".repeat(64));
    const outcome = paired.catch(error => error as Error);
    await vi.advanceTimersByTimeAsync(8000);
    expect(await outcome).toMatchObject({ message: expect.stringContaining("Local connection timed out") });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("preserves a rejected pairing acknowledgement", async () => {
    const f = socketFixture();
    const paired = f.client.pair("ws://127.0.0.1:51700/premiere", "a".repeat(64));
    f.open(); f.message({ v: 1, id: f.sent[0].id, type: "error", error: "Pairing code expired." });
    await expect(paired).rejects.toThrow("Pairing code expired");
  });
  it("does not let cancelled hello work disconnect a newer pairing", async () => {
    const first = socketFixture(), second = socketFixture();
    const factory = vi.fn().mockReturnValueOnce(first.socket).mockReturnValueOnce(second.socket);
    const client = new BridgeClient(factory);
    const oldPair = client.pair("ws://127.0.0.1:51700/premiere", "a".repeat(64));
    const cancelled = expect(oldPair).rejects.toThrow("cancelled");
    first.open();
    const newPair = client.pair("ws://127.0.0.1:51700/premiere", "b".repeat(64));
    const outcome = newPair.catch(error => error as Error);
    await cancelled;
    second.open(); second.message({ v: 1, id: second.sent[0]?.id, type: "snapshot", status, notes: [], page });
    expect(await outcome).toBeUndefined();
    expect(second.socket.close).not.toHaveBeenCalled(); client.disconnect();
  });
  it("does not transform snapshots or heartbeats into confirmations", async () => {
    vi.useFakeTimers(); const f = socketFixture(); const observer = vi.fn(); f.client.onSnapshot = observer;
    await f.pair(); await vi.advanceTimersByTimeAsync(2000);
    expect(f.sent[1]).toMatchObject({ type: "poll", offset: 0 });
    f.message({ v: 1, id: f.sent[1].id, type: "snapshot", status, notes: [], page });
    expect(f.sent.some(item => item.type === "confirm")).toBe(false); expect(observer).toHaveBeenCalledTimes(2);
    f.client.disconnect();
  });
  it("does not let an old heartbeat failure disconnect a new pairing", async () => {
    vi.useFakeTimers(); const first = socketFixture(), second = socketFixture();
    const client = new BridgeClient(vi.fn().mockReturnValueOnce(first.socket).mockReturnValueOnce(second.socket));
    const paired = client.pair("ws://127.0.0.1:51700/premiere", "a".repeat(64));
    first.open(); first.message({ v: 1, id: first.sent[0].id, type: "snapshot", status, notes: [], page });
    await paired; await vi.advanceTimersByTimeAsync(2000);
    expect(first.sent[1].type).toBe("poll");
    const next = client.pair("ws://127.0.0.1:51700/premiere", "b".repeat(64)).catch(error => error as Error);
    await vi.advanceTimersByTimeAsync(0);
    second.open(); second.message({ v: 1, id: second.sent[0]?.id, type: "snapshot", status, notes: [], page });
    expect(await next).toBeUndefined(); expect(second.socket.close).not.toHaveBeenCalled();
    client.disconnect(); expect(vi.getTimerCount()).toBe(0);
  });
  it("retains pagination for periodic polls", async () => {
    vi.useFakeTimers(); const f = socketFixture(); await f.pair();
    const next = f.client.request({ type: "poll", offset: 100 });
    f.message({ v: 1, id: f.sent[1].id, type: "snapshot", status, notes: [], page: { offset: 100, total: 150, hasMore: false } });
    await next; await vi.advanceTimersByTimeAsync(2000);
    expect(f.sent[2]).toMatchObject({ type: "poll", offset: 100 }); f.client.disconnect();
  });
  it("fails closed on an unsolicited insert response", async () => {
    const f = socketFixture(); const disconnected = vi.fn(); f.client.onDisconnect = disconnected; await f.pair();
    // Invalid or unsolicited insert packets both close the channel before any
    // Premiere adapter is called. The native note schema must also validate.
    f.message({ v: 1, id: "unsolicited", type: "insert", note: {} });
    expect(f.socket.close).toHaveBeenCalledTimes(1);
    expect(disconnected.mock.calls.at(-1)?.[0]).toContain("validation");
  });
  it("rejects outstanding work on disconnect instead of replaying it", async () => {
    const f = socketFixture(); await f.pair(); const pending = f.client.request({ type: "poll" });
    f.client.disconnect(); await expect(pending).rejects.toThrow("Disconnected");
    await expect(f.client.request({ type: "poll" })).rejects.toThrow("Pair with");
  });
});
