import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * The Tauri plugin set is exactly the three CLAUDE.md declares, and the two it
 * ejected stay ejected.
 *
 * This is the one plugin rule with a SECURITY reason rather than a size reason,
 * and CLAUDE.md states it plainly: `opener:default` bundles `reveal_item_in_dir`,
 * which takes a `Vec<PathBuf>` and — unlike its two siblings — performs no scope
 * check. Granting that permission handed the renderer an unscoped
 * reveal-any-path-in-Finder for a command the app never called. A plugin added
 * back by a future `cargo add`, or a capability file that grants a namespace
 * nothing depends on, is not visible in review: it is one line in a manifest.
 *
 * `verify:packaged` checks "no ejected plugin grant survived" in a BUILT bundle,
 * which is the right place for a final check and the wrong place for a fast one —
 * it needs a full `tauri build` first. This is the same claim at the source, in a
 * second.
 *
 * Both halves are derived from CLAUDE.md rather than hard-coded here, so the doc
 * and the guard cannot drift: the allowed set is the line under
 * "### Plugins (Tauri)", the forbidden set is every plugin named after the
 * "Ejected in r152" marker.
 *
 * COMMENTS ARE STRIPPED FIRST, and that is not incidental tidiness. The first
 * run of this guard failed on a comment in Cargo.toml that EXPLAINS the
 * ejection - prose naming the forbidden crate, read as the crate itself. That is
 * the fifth time in this codebase a scanner has mistaken a description of a
 * thing for the thing: `role="dialog"` inside a querySelector string,
 * `useModalFocus` inside a commented-out call, `.cp-ql-scrim` inside a CSS
 * comment, `globSync` inside its own explanation, and now this. Any new scanner
 * here should strip comments before it believes a match.
 */

const ROOT = resolve(__dirname, "../..");
const claude = readFileSync(join(ROOT, "CLAUDE.md"), "utf8");

/** Split the Plugins section into what is allowed and what was ejected. */
function declaredSets(): { allowed: string[]; forbidden: string[] } {
  const start = claude.indexOf("### Plugins (Tauri)");
  const ejected = claude.indexOf("Ejected in r152", start);
  // The section ends at the next heading after the ejection paragraph.
  const end = claude.indexOf("\n---", ejected);
  const names = (s: string) => [...new Set([...s.matchAll(/tauri-plugin-([a-z-]+)/g)].map((m) => m[1]))];
  return {
    allowed: names(claude.slice(start, ejected)),
    forbidden: names(claude.slice(ejected, end === -1 ? undefined : end)),
  };
}

const { allowed, forbidden } = declaredSets();

/**
 * Strip comments so a manifest that DOCUMENTS an ejected plugin is not read as
 * depending on one. TOML comments run from `#` to end of line; JSON has none,
 * but `//` appears in Tauri capability files often enough to be worth handling.
 */
function decomment(line: string): string {
  const t = line.trimStart();
  if (t.startsWith("#") || t.startsWith("//")) return "";
  return line.split("#")[0];
}

/** Every file that could reintroduce a plugin. */
function manifests(): Array<{ file: string; text: string }> {
  const out = [
    { file: "src-tauri/Cargo.toml", text: readFileSync(join(ROOT, "src-tauri/Cargo.toml"), "utf8") },
    { file: "package.json", text: readFileSync(join(ROOT, "package.json"), "utf8") },
  ];
  const capDir = join(ROOT, "src-tauri/capabilities");
  for (const f of readdirSync(capDir)) {
    if (f.endsWith(".json")) {
      out.push({ file: `src-tauri/capabilities/${f}`, text: readFileSync(join(capDir, f), "utf8") });
    }
  }
  return out;
}

/** Crate-level plugin deps, from the [dependencies] side of Cargo.toml. */
function cargoPlugins(): string[] {
  const toml = readFileSync(join(ROOT, "src-tauri/Cargo.toml"), "utf8");
  return [...new Set(
    [...toml.matchAll(/^tauri-plugin-([a-z-]+)\s*=/gm)].map((m) => m[1]),
  )];
}

describe("the declared plugin set", () => {
  it("is readable from CLAUDE.md at all", () => {
    // Canary. Both lists are parsed out of prose, and prose gets rewritten. An
    // empty `allowed` would make the first assertion below vacuous, and an empty
    // `forbidden` would make the second one guard nothing at all.
    expect(allowed.length, "no plugins parsed from the Plugins section").toBeGreaterThan(2);
    expect(forbidden.length, "no ejected plugins parsed - the r152 marker moved").toBeGreaterThan(1);
    expect(cargoPlugins().length, "no plugin deps found in Cargo.toml").toBeGreaterThan(0);
    // The two sets must be disjoint, or the doc is contradicting itself.
    expect(allowed.filter((p) => forbidden.includes(p)),
      "a plugin is listed as both allowed and ejected").toEqual([]);
  });

  it("matches what Cargo.toml actually depends on", () => {
    const deps = cargoPlugins();
    const undeclared = deps.filter((p) => !allowed.includes(p));
    const missing = allowed.filter((p) => !deps.includes(p));
    expect(undeclared, "plugin dependencies CLAUDE.md does not declare").toEqual([]);
    // The other direction too: a doc that lists a plugin nobody depends on sends
    // the next reader looking for code that is not there.
    expect(missing, "CLAUDE.md declares plugins that are not dependencies").toEqual([]);
  });
});

describe("the ejected plugins", () => {
  it("appear in no manifest, with the offending file named", () => {
    const hits: string[] = [];
    for (const { file, text } of manifests()) {
      text.split("\n").forEach((raw, i) => {
        const line = decomment(raw);
        for (const p of forbidden) {
          // Both spellings: the Rust crate and the JS package.
          if (line.includes(`tauri-plugin-${p}`) || line.includes(`@tauri-apps/plugin-${p}`)) {
            hits.push(`${file}:${i + 1}  ${raw.trim()}`);
          }
        }
      });
    }
    expect(hits, "an ejected Tauri plugin is back in a manifest").toEqual([]);
  });

  it("hold no capability grant, which is the part that was dangerous", () => {
    // A grant is what actually exposes a command to the renderer. `opener:default`
    // was the specific mistake: it carried reveal_item_in_dir, unscoped, for a
    // command the app never called.
    const hits: string[] = [];
    const capDir = join(ROOT, "src-tauri/capabilities");
    for (const f of readdirSync(capDir).filter((n) => n.endsWith(".json"))) {
      const text = readFileSync(join(capDir, f), "utf8");
      text.split("\n").forEach((line, i) => {
        for (const p of forbidden) {
          // Permission namespaces drop the `tauri-plugin-` prefix: `opener:default`.
          if (new RegExp(`"${p}:[a-z-]+"`).test(line)) {
            hits.push(`src-tauri/capabilities/${f}:${i + 1}  ${line.trim()}`);
          }
        }
      });
    }
    expect(hits, "a capability grants an ejected plugin's permission").toEqual([]);
  });

  it("are absent from Cargo.lock, so no transitive path pulls them back", () => {
    // The ejection was worth 34 packages out of the lockfile. A dependency that
    // quietly depends on one of these would undo that without touching
    // Cargo.toml, and nothing else in the repo would notice.
    const lock = readFileSync(join(ROOT, "src-tauri/Cargo.lock"), "utf8");
    const back = forbidden.filter((p) =>
      lock.split("\n").map(decomment).some((l) => l.includes(`name = "tauri-plugin-${p}"`)));
    expect(back, "an ejected plugin is back in Cargo.lock via a transitive dep").toEqual([]);
  });
});
