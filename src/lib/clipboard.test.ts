// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./clipboard";

afterEach(() => { vi.unstubAllGlobals(); });

describe("copyText", () => {
  it("starts the write in the click, before the text exists, so WebKit keeps the permission", async () => {
    const write = vi.fn(async () => undefined), writeText = vi.fn(async () => undefined);
    class Item { constructor(public items: Record<string, Promise<Blob>>) {} }
    vi.stubGlobal("ClipboardItem", Item);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { write, writeText } });
    let finish!: (text: string) => void;
    const pending = copyText(new Promise<string>((done) => { finish = done; }));
    // Synchronously: the write is already under way while the text is still being built.
    expect(write).toHaveBeenCalledTimes(1);
    finish("Diagnostics");
    await pending;
    const [[item]] = write.mock.calls as unknown as [[Item[]]];
    expect(await (await item[0].items["text/plain"]).text()).toBe("Diagnostics");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("writes a ready string directly", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await copyText("ready");
    expect(writeText).toHaveBeenCalledWith("ready");
  });
});
