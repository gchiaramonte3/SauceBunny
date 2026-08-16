// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_CLOUD_MODEL, cloudChat, deleteApiKey, hasApiKey,
  loadAiProvider, loadCloudModel, setAiProvider, setApiKey, setCloudModel,
} from "./ai-provider";

const h = vi.hoisted(() => ({
  calls: [] as Array<{ cmd: string; args: unknown }>,
  /**
   * Parks cloud_chat so a test can abort mid-flight.
   *
   * The promise and its resolver are created TOGETHER, before the call, and
   * the mock only awaits it. An earlier version had the mock construct the
   * promise and assign the resolver over a placeholder no-op, which leaves a
   * window: release before that assignment resolves nothing and the awaited
   * call hangs to the test timeout. That flaked once in a full-suite run and
   * never again in fourteen — the kind of race that is easier to read than to
   * reproduce.
   */
  gate: null as null | { wait: Promise<void>; release: () => void },
}));

function deferred() {
  let release!: () => void;
  const wait = new Promise<void>((res) => { release = res; });
  return { wait, release };
}

vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args?: unknown) => {
    h.calls.push({ cmd, args });
    if (cmd === "cloud_chat" && h.gate) await h.gate.wait;
    return cmd === "has_api_key" ? true : "reply";
  },
}));

/**
 * The switch between "everything stays on your Mac" and "call a third party".
 *
 * CLAUDE.md's rule is that local Qwen stays the DEFAULT and the app works
 * fully with zero cloud config. That promise lives in one function here, and
 * the way it keeps it is worth pinning: `loadAiProvider` WHITELISTS the two
 * cloud ids and returns "local" for everything else. Corrupt storage, a value
 * from a newer build, a localStorage that throws — all fail closed, toward the
 * private path. A blacklist would fail the other way, and silently.
 *
 * The abort path is the other thing tested here, because it costs money: a
 * cancelled run must not reach the provider, and one cancelled mid-flight must
 * tell Rust to drop the request so the provider stops generating and billing.
 */

beforeEach(() => {
  localStorage.clear();
  h.calls.length = 0;
  h.gate = null;
});
afterEach(() => vi.restoreAllMocks());

describe("loadAiProvider fails closed", () => {
  it("defaults to local with nothing stored", () => {
    expect(loadAiProvider()).toBe("local");
  });

  it("returns local for any value it does not recognise", () => {
    // A typo, a rename, a value written by a newer build, junk from a bad
    // settings import. Every one of these must stay local.
    for (const junk of ["", "cloud", "Anthropic", "openai ", "gemini", "true", "{}", "local"]) {
      localStorage.setItem("saucebunny.ai.provider", junk);
      expect(loadAiProvider(), `"${junk}" must not select a cloud provider`).toBe("local");
    }
  });

  it("honours the two ids it does recognise", () => {
    for (const p of ["anthropic", "openai"] as const) {
      setAiProvider(p);
      expect(loadAiProvider()).toBe(p);
    }
  });

  it("returns local when localStorage itself throws", () => {
    // Private browsing, a locked profile, a quota-exceeded read path. The
    // failure mode must be privacy-preserving, not a crash and not a cloud call.
    //
    // The spy targets localStorage itself. Written against Storage.prototype
    // it intercepted nothing — this suite runs on the plain-object stub from
    // test-setup.ts — so it asserted the empty-storage path and would have
    // passed with the try/catch deleted.
    const spy = vi.spyOn(localStorage, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(loadAiProvider()).toBe("local");
    spy.mockRestore();
  });

  it("survives a storage that refuses writes", () => {
    const spy = vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceeded");
    });
    expect(() => setAiProvider("anthropic")).not.toThrow();
    spy.mockRestore();
  });
});

describe("cloud model ids", () => {
  it("falls back to the shipped default", () => {
    expect(loadCloudModel("anthropic")).toBe(DEFAULT_CLOUD_MODEL.anthropic);
    expect(loadCloudModel("openai")).toBe(DEFAULT_CLOUD_MODEL.openai);
  });

  it("keeps the two providers' models apart", () => {
    setCloudModel("anthropic", "claude-opus-4-8");
    expect(loadCloudModel("anthropic")).toBe("claude-opus-4-8");
    expect(loadCloudModel("openai")).toBe(DEFAULT_CLOUD_MODEL.openai);
  });

  it("treats a cleared field as 'use the default', not as an empty model", () => {
    // An empty model id would reach the provider as a request for "".
    setCloudModel("openai", "   ");
    expect(loadCloudModel("openai")).toBe(DEFAULT_CLOUD_MODEL.openai);
    setCloudModel("openai", "  gpt-4o-mini  ");
    expect(loadCloudModel("openai")).toBe("gpt-4o-mini");
  });
});

describe("the API key stays in the Keychain", () => {
  it("offers no way to read it back", async () => {
    // Deliberately absent from this module's surface: set, check, delete only.
    const surface = await import("./ai-provider");
    expect(Object.keys(surface).some((k) => /^get.*key/i.test(k))).toBe(false);
  });

  it("routes every key operation to Rust", async () => {
    await setApiKey("anthropic", "sk-ant-secret");
    await hasApiKey("openai");
    await deleteApiKey("anthropic");
    expect(h.calls.map((c) => c.cmd)).toEqual(["set_api_key", "has_api_key", "delete_api_key"]);
    // And never near localStorage.
    expect(JSON.stringify(localStorage)).not.toContain("sk-ant-secret");
  });
});

describe("cloudChat", () => {
  it("sends the provider's currently chosen model", async () => {
    setCloudModel("anthropic", "claude-opus-4-8");
    await cloudChat("anthropic", "sys", [{ role: "user", content: "hi" }]);
    const args = h.calls.find((c) => c.cmd === "cloud_chat")!.args as { args: Record<string, unknown> };
    expect(args.args.model).toBe("claude-opus-4-8");
    expect(args.args.provider).toBe("anthropic");
  });

  it("mints no cancel id when no signal was given", async () => {
    await cloudChat("openai", "sys", []);
    const args = h.calls.find((c) => c.cmd === "cloud_chat")!.args as { args: Record<string, unknown> };
    expect(args.args.request_id).toBeNull();
  });

  it("never starts a request that was already aborted", async () => {
    // Costs real money otherwise: the run is cancelled before it begins, so it
    // must not reach the provider at all.
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(cloudChat("openai", "sys", [], ctrl.signal)).rejects.toThrow(/abort/i);
    expect(h.calls.some((c) => c.cmd === "cloud_chat")).toBe(false);
  });

  it("tells Rust to drop a request aborted mid-flight", async () => {
    // Stopping the UI is not enough — the provider keeps generating, and
    // billing, until the connection closes (r142).
    h.gate = deferred();
    const ctrl = new AbortController();
    const pending = cloudChat("anthropic", "sys", [], ctrl.signal);
    await vi.waitFor(() => expect(h.calls.some((c) => c.cmd === "cloud_chat")).toBe(true));

    const sent = h.calls.find((c) => c.cmd === "cloud_chat")!.args as { args: Record<string, unknown> };
    ctrl.abort();
    await vi.waitFor(() => expect(h.calls.some((c) => c.cmd === "cloud_chat_cancel")).toBe(true));

    const cancel = h.calls.find((c) => c.cmd === "cloud_chat_cancel")!.args as { requestId: string };
    expect(cancel.requestId, "cancelled a different request than it started").toBe(sent.args.request_id);

    h.gate.release();
    await pending;
  });
});
