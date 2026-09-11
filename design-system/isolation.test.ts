// @vitest-environment node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { catalogEntries } from "./catalog-data";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const catalog = resolve(root, "design-system");
const testFile = /\.(?:spec|test|browser)\.[cm]?[jt]sx?$/;
const fixtureFile = (file: string) => /\.[jt]sx?$/.test(file) && !testFile.test(file) && !/\.config\.[jt]s$/.test(file);
function filesWithin(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) return [];
    return entry.isDirectory() ? filesWithin(path) : [path];
  });
}
function importsOf(path: string, runtimeOnly = false): string[] {
  const source = readFileSync(path, "utf8");
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const imports: string[] = [];
  const visit = (node: ts.Node) => {
    if (runtimeOnly && ts.isImportDeclaration(node) && (node.importClause?.isTypeOnly ||
      (!node.importClause?.name && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings)
      && node.importClause.namedBindings.elements.length > 0 && node.importClause.namedBindings.elements.every(binding => binding.isTypeOnly)))) return;
    if (runtimeOnly && ts.isExportDeclaration(node) && node.isTypeOnly) return;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) imports.push(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) imports.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(tree); return imports;
}

// Every production import is deliberately reviewed, including its runtime dependencies.
const allowedProduction = new Set([
  "src/components/Icons", "src/components/Tooltip", "src/components/CollapsibleSection", "src/components/VolumeControl",
  "src/components/GenerateButton", "src/components/StatefulButton", "src/assets/saucebunny.svg",
  "src/hooks/use-dismiss", "src/hooks/use-menu-keys", "src/hooks/use-modal-focus",
  "src/components/ClipTagIndicator", "src/lib/finder-tags",
  // Controlled count only; dependencies are Icons and shared menu/dismiss hooks.
  "src/components/ExpectedSpeakersMenu",
  // Passive status/readout only: React types and scoped CSS, no clock/store/controller.
  "src/components/NdiPreviewHeader",
  // Passive Avid instructions: React local disclosure state + the already
  // reviewed CollapsibleSection/Icons; no native, storage or media imports.
  "src/components/AvidNdiSetup",
]);
const pureHelpers = [...allowedProduction].flatMap(path => [".tsx", ".ts"].map(extension => resolve(root, path + extension)).filter(existsSync));

describe("the design catalog cannot become a second application", () => {
  it("has a separate HTML entry, absent from the production entry and source imports", () => {
    const html = readFileSync(resolve(root, "design-system.html"), "utf8");
    expect(html).toMatch(/type=["']module["']/);
    expect(html).toMatch(/design-system\//);
    expect(html).not.toMatch(/src\/["']?(?:main|App)\.[jt]sx/);
    expect(readFileSync(resolve(catalog, "main.tsx"), "utf8")).toMatch(/if\s*\(import\.meta\.env\.DEV\)/);
    const productionHtml = readFileSync(resolve(root, "index.html"), "utf8");
    expect(productionHtml).not.toMatch(/design-system|design-catalog/);
    const production = filesWithin(resolve(root, "src")).filter(file => /\.[jt]sx?$/.test(file) && !testFile.test(file));
    expect(production.length).toBeGreaterThan(100);
    const importingCatalog = production.flatMap(file => importsOf(file)
      .filter(specifier => /(?:design-system|design-catalog)/.test(specifier))
      .map(specifier => relative(root, file) + ": " + specifier));
    expect(importingCatalog).toEqual([]);
  });

  it("imports only fixture code, styles, React and explicitly allowed pure production helpers", () => {
    const files = [...filesWithin(catalog).filter(fixtureFile), ...pureHelpers];
    expect(files.length).toBeGreaterThan(1);
    const bad: string[] = [];
    for (const file of files) for (const specifier of importsOf(file, true)) {
      if (/^(?:react(?:-dom)?(?:\/.*)?|@fontsource\/nunito-sans(?:\/.*)?)$/.test(specifier)) continue;
      if (!specifier.startsWith(".")) { bad.push(relative(root, file) + ": " + specifier); continue; }
      const target = resolve(dirname(file), specifier);
      if (target.startsWith(catalog + "/")) continue;
      const normalized = relative(root, target).replace(/\.[cm]?[jt]sx?$/, "");
      if (target.startsWith(resolve(root, "src/styles") + "/") && /\.css$/.test(target)) continue;
      if (allowedProduction.has(normalized)) continue;
      bad.push(relative(root, file) + ": " + specifier);
    }
    expect(bad, "Do not import App, stores, runtime media, native APIs or production controllers into the catalog").toEqual([]);
  });

  it("contains no persistence, network, native or capture calls in its executable fixtures", () => {
    const files = [...filesWithin(catalog).filter(fixtureFile), ...pureHelpers];
    const prohibited = /(?:^|\.)(?:fetch|invoke|getUserMedia|getDisplayMedia|setItem|removeItem|writeText|openDatabase|sendBeacon)$/;
    const bad: string[] = [];
    for (const file of files) {
      const tree = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
          const call = node.expression.getText(tree);
          if (prohibited.test(call) || /(?:^|\.)(?:WebSocket|EventSource|XMLHttpRequest|RTCPeerConnection|AudioContext)$/.test(call)
            || /(?:^|\.)(?:indexedDB|localStorage|sessionStorage|clipboard)\./.test(call)) bad.push(relative(root, file) + ":" + (tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1) + " " + call);
        }
        ts.forEachChild(node, visit);
      };
      visit(tree);
    }
    expect(bad).toEqual([]);
  });
});

describe("recursive design source inventory", () => {
  it("keeps source annotations rooted in existing repository files", () => {
    expect(catalogEntries).toHaveLength(20);
    expect(new Set(catalogEntries.map(entry => entry.id)).size).toBe(20);
    const references = catalogEntries.flatMap(entry => entry.sources);
    expect(references.length).toBeGreaterThanOrEqual(75);
    for (const source of references) {
      expect(source.path).toMatch(/^(?:src|docs)\//);
      expect(source.path).not.toContain("..");
      expect(readFileSync(resolve(root, source.path), "utf8").length, source.path).toBeGreaterThan(0);
      expect(source.note.length, source.path).toBeGreaterThan(0);
    }
  });
  it("keeps specialty components real and guidance discoverable", () => {
    const specialty = readFileSync(resolve(catalog, "SpecialtyExamples.tsx"), "utf8");
    expect(specialty).toMatch(/import.*GenerateButton.*src\/components\/GenerateButton/);
    expect(specialty).toContain("<GenerateButton");
    expect(specialty).toContain("Generate transcript + speakers");
    const command = readFileSync(resolve(catalog, "CommandExamples.tsx"), "utf8");
    expect(command).toContain("<StatefulButton");
    for (const file of filesWithin(catalog).filter(fixtureFile)) {
      expect(readFileSync(file, "utf8"), relative(root, file)).not.toMatch(/<button\s[^>]*className=["'][^"']*cp-gen-btn/);
    }
    for (const file of ["AGENTS.md", "CLAUDE.md", "README.md", "CONTRIBUTING.md"]) {
      const source = readFileSync(resolve(root, file), "utf8");
      expect(source, file).toContain("docs/DESIGN.md");
      expect(source, file).toContain("docs/DESIGN-CATALOG.md");
      expect(source, file).toContain("docs/DESIGN-SYSTEM-AUDIT.md");
    }
    expect(readFileSync(resolve(root, "docs/DESIGN-SYSTEM-AUDIT.md"), "utf8").length).toBeGreaterThan(1000);
  });
  it("reports production source sites including nested component directories, without catalog fixtures", () => {
    const text = execFileSync(process.execPath, [resolve(root, "scripts/design-catalog-audit.mjs"), "--json"], { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    const report = JSON.parse(text) as {
      schemaVersion: number; interpretation: string; sourceHash: string;
      sources: { tsx: string[]; css: string[] }; summary: { tsxFiles: number; cssFiles: number; jsxSites: number };
      roles: Record<string, { files: string[]; count: number; locations: { file: string; line: number }[] }>;
      families: Record<string, { count: number }>;
    };
    expect(report.schemaVersion).toBe(1);
    expect(report.sourceHash).toMatch(/^[a-f0-9]{64}$/);
    expect(report.interpretation).toContain("not rendered instances or compliance");
    expect(report.summary.tsxFiles).toBe(report.sources.tsx.length);
    expect(report.summary.cssFiles).toBe(report.sources.css.length);
    expect(report.summary.jsxSites).toBeGreaterThan(1000);
    expect(report.sources.tsx).toContain("src/components/transcript/HistoryPopover.tsx");
    expect(report.sources.tsx).toContain("src/components/review/PasteNotesModal.tsx");
    expect(report.roles.menu.files).toContain("src/components/transcript/HistoryPopover.tsx");
    expect(report.families.fields.count).toBeGreaterThan(30);
    expect(report.families.tabs.count).toBeGreaterThan(5);
    expect([...report.sources.tsx, ...report.sources.css].some(path => /design-system|\.(?:test|spec)\./.test(path))).toBe(false);
    for (const role of Object.values(report.roles)) for (const location of role.locations) expect(location.line).toBeGreaterThan(0);
  });
});
