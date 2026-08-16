import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * The native menubar, across the two files that decide whether an item works.
 *
 * Rust builds the menu (`MenuItem::with_id(app, "toggle_queue", …)`) and, for
 * anything it does not handle itself, emits `menu:<id>` to the main window.
 * React binds each id back to a handler. Neither side names the other: Rust
 * formats the event name at runtime and React interpolates it, so there is no
 * shared literal, nothing to type-check, and no error if an id exists on only
 * one side.
 *
 * The failure is a menu item that opens, highlights, closes — and does nothing.
 * No log line, no rejected promise, no crash. Precisely the shape of the
 * `llm-log` channel that was emitted to nobody, and of the two sidecars that
 * shipped undocumented: each file internally consistent, the gap only visible
 * in the comparison.
 *
 * Nothing is wrong today. This keeps it that way, because adding a menu item
 * is a one-line change in Rust that is easy to make and easy to leave halfway.
 */

const ROOT = resolve(__dirname, "../..");
const rust = readFileSync(join(ROOT, "src-tauri/src/lib.rs"), "utf8");
const app = readFileSync(join(ROOT, "src/App.tsx"), "utf8");

/** Every item the menubar offers. */
const defined = [...rust.matchAll(/MenuItem::with_id\(app,\s*"([a-z_]+)"/g)].map((m) => m[1]);

/** Ids Rust resolves itself, without React — currently the external URLs. */
const nativelyHandled = new Set(
  [...rust.matchAll(/"([a-z_]+)"\s*=>\s*Some\("https/g)].map((m) => m[1]),
);

/** Ids React binds a handler to. */
const bound = new Set([...app.matchAll(/bind\(\s*"([a-z_]+)"/g)].map((m) => m[1]));

describe("the native menu surface", () => {
  it("read both sides", () => {
    expect(defined.length, "no MenuItem::with_id found — the matcher broke").toBeGreaterThan(8);
    expect(bound.size, "no bind() calls found — the matcher broke").toBeGreaterThan(5);
    expect(nativelyHandled.size, "no natively-handled ids found").toBeGreaterThan(0);
  });

  it("gives every menu item a handler", () => {
    const dead = defined.filter((id) => !bound.has(id) && !nativelyHandled.has(id));
    expect(dead, "menu items that click into nothing").toEqual([]);
  });

  it("binds no handler for a menu item that does not exist", () => {
    // The other direction: a rename in Rust leaves React listening for
    // `menu:<old-id>`, which nothing will ever emit.
    const ghosts = [...bound].filter((id) => !defined.includes(id));
    expect(ghosts, "bound in React with no matching menu item").toEqual([]);
  });

  it("keeps the natively-handled ids out of React's table", () => {
    // Handling one in both places would open the URL twice.
    const both = [...nativelyHandled].filter((id) => bound.has(id));
    expect(both, "handled in Rust AND bound in React").toEqual([]);
  });

  it("still emits menu:<id> for everything it does not handle itself", () => {
    // The contract above only means anything while Rust actually forwards.
    expect(rust).toMatch(/emit\(&format!\("menu:\{\}", id\)/);
  });
});
