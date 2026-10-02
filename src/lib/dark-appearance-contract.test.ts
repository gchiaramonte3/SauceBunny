import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
describe("dark appearance independent of the macOS preference", () => {
  it("declares dark controls before the application stylesheet loads", () => {
    expect(read("index.html")).toMatch(/name="color-scheme" content="dark"/);
    expect(read("src/styles/base.css")).toMatch(/color-scheme:\s*only dark/);
  });
  it("pins the app and its first native window to dark appearance", () => {
    const config = JSON.parse(read("src-tauri/tauri.conf.json"));
    expect(config.app.windows.length).toBeGreaterThan(0);
    expect(config.app.windows.every((window: { theme?: string }) => window.theme === "Dark")).toBe(true);
    expect(read("src-tauri/src/lib.rs")).toContain("app.set_theme(Some(tauri::Theme::Dark))");
  });
});
