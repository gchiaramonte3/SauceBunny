#!/usr/bin/env node
/** Read-only source inventory for the design catalog. Counts source sites,
 * not rendered instances or compliance. Nested component folders are included.
 * Usage: node scripts/design-catalog-audit.mjs [--json]
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import ts from "typescript";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EXCLUDE = /(?:^|[/\\])(?:node_modules|__tests__|fixtures)(?:[/\\]|$)|\.(?:test|spec)\.[cm]?[jt]sx?$/;
const FAMILY_ROLES = {
  tabs: ["tab", "tablist", "tabpanel"], menus: ["menu", "menuitem", "menuitemradio", "menuitemcheckbox"],
  choices: ["radio", "radiogroup", "switch", "checkbox"], dialogs: ["dialog", "alertdialog"],
  statuses: ["status", "alert", "progressbar"], lists: ["list", "listitem", "listbox", "option", "grid", "row", "cell", "table"],
  navigation: ["navigation", "tree", "treeitem"], splitters: ["separator"], tooltips: ["tooltip"],
};

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const path = join(dir, entry.name);
    if (EXCLUDE.test(path) || entry.isSymbolicLink()) return [];
    return entry.isDirectory() ? walk(path) : [path];
  });
}
function textValue(attribute) {
  const value = attribute?.initializer;
  if (value && ts.isStringLiteral(value)) return value.text;
  if (value && ts.isJsxExpression(value) && value.expression && ts.isStringLiteralLike(value.expression)) return value.expression.text;
  return null;
}
function classLiterals(attribute) {
  const output = new Set();
  const visit = node => {
    if (ts.isStringLiteralLike(node)) for (const token of node.text.split(/\s+/)) if (/^(?:cp-|btn(?:-|$))/.test(token)) output.add(token);
    ts.forEachChild(node, visit);
  };
  if (attribute?.initializer) visit(attribute.initializer);
  return [...output].sort();
}
function add(index, key, site) {
  const entry = index[key] ??= { count: 0, locations: [] };
  entry.count++; entry.locations.push(site);
}
function sorted(index) {
  return Object.fromEntries(Object.keys(index).sort().map(key => [key, {
    ...index[key], files: [...new Set(index[key].locations.map(site => site.file))].sort(),
  }]));
}
/** A small prelude scanner: quotes/comments/functions cannot manufacture a
 * rule boundary. Kept dependency-free beyond the existing TypeScript parser. */
function cssPreludes(source) {
  const clean = source.replace(/\/\*[\s\S]*?\*\//g, comment => comment.replace(/[^\n]/g, " "));
  const found = []; let start = 0, quote = "", parentheses = 0;
  for (let index = 0; index < clean.length; index++) {
    const char = clean[index];
    if (quote) { if (char === "\\") index++; else if (char === quote) quote = ""; continue; }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === "(") parentheses++;
    if (char === ")") parentheses = Math.max(0, parentheses - 1);
    if (parentheses) continue;
    if (char === "{") {
      const raw = clean.slice(start, index), selector = raw.trim();
      if (selector) found.push({ selector, offset: start + raw.indexOf(selector) });
      start = index + 1;
    } else if (char === "}" || char === ";") start = index + 1;
  }
  return found;
}

export function collectDesignInventory(root = PROJECT_ROOT) {
  const files = walk(join(root, "src")).filter(file => /\.(tsx|css)$/.test(file));
  const elements = {}, roles = {}, classes = {}, families = {}, hooks = {}, cssClasses = {};
  const sources = { tsx: [], css: [] }, dynamicRoles = [], cssRules = [];
  const hash = createHash("sha256"); let jsxSites = 0, dynamicClassSites = 0;
  for (const path of files) {
    const file = relative(root, path).split("\\").join("/"), source = readFileSync(path, "utf8");
    hash.update(file + "\0" + source + "\0");
    if (path.endsWith(".css")) {
      sources.css.push(file);
      for (const rule of cssPreludes(source)) {
        const site = { file, line: source.slice(0, rule.offset).split("\n").length, selector: rule.selector };
        cssRules.push(site);
        if (!rule.selector.startsWith("@")) for (const token of new Set(rule.selector.match(/\.(?:cp-[\w-]+|btn(?:-[\w-]+)?)/g) ?? [])) add(cssClasses, token.slice(1), site);
      }
      continue;
    }
    sources.tsx.push(file);
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const visit = node => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ["useMenuKeys", "useDismiss", "useModalFocus"].includes(node.expression.text)) {
        add(hooks, node.expression.text, { file, line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1 });
      }
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        jsxSites++;
        const tag = node.tagName.getText(tree), attributes = Object.fromEntries(node.attributes.properties
          .filter(ts.isJsxAttribute).map(attribute => [attribute.name.getText(tree), attribute]));
        const role = textValue(attributes.role), type = textValue(attributes.type);
        const site = { file, line: tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1, tag };
        add(elements, tag, site);
        if (role) for (const name of role.split(/\s+/)) add(roles, name, site);
        else if (attributes.role) dynamicRoles.push(site);
        if (attributes.className && textValue(attributes.className) === null) dynamicClassSites++;
        for (const name of classLiterals(attributes.className)) add(classes, name, site);
        const matched = new Set();
        for (const [family, names] of Object.entries(FAMILY_ROLES)) if (role?.split(/\s+/).some(name => names.includes(name))) matched.add(family);
        if (["input", "textarea", "select"].includes(tag)) matched.add("fields");
        if (tag === "select") matched.add("selects");
        if (tag === "input" && ["checkbox", "radio", "range"].includes(type)) matched.add("choices");
        if (["table", "ul", "ol", "li"].includes(tag)) matched.add("lists");
        if (tag === "nav") matched.add("navigation");
        if (tag === "details" || tag === "CollapsibleSection") matched.add("disclosures");
        if (tag === "Tooltip") matched.add("tooltips");
        if (tag === "button") matched.add("buttons");
        if (["main", "aside", "section"].includes(tag)) matched.add("panels");
        if (tag.startsWith("Icon")) matched.add("icons");
        for (const family of matched) add(families, family, site);
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
  }
  return {
    schemaVersion: 1,
    scope: "Production src/**/*.tsx and src/**/*.css; recursive; tests, fixtures and symlinks excluded",
    interpretation: "Source sites, not rendered instances or compliance. Dynamic roles are listed separately. Class counts include string literals in conditional JSX.",
    sourceHash: hash.digest("hex"), sources,
    summary: { tsxFiles: sources.tsx.length, cssFiles: sources.css.length, jsxSites, cssRuleSites: cssRules.length, dynamicRoleSites: dynamicRoles.length, dynamicClassSites },
    families: sorted(families), roles: sorted(roles), elements: sorted(elements), jsxClasses: sorted(classes),
    cssClasses: sorted(cssClasses), sharedHookCalls: sorted(hooks), dynamicRoles,
  };
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const args = process.argv.slice(2);
  if (args.some(argument => !["--json", "--help"].includes(argument))) {
    process.stderr.write("Usage: node scripts/design-catalog-audit.mjs [--json]\n"); process.exitCode = 1;
  } else if (args.includes("--help")) process.stdout.write("Read-only recursive production UI source inventory. No files are written. Use --json for source locations and counts.\n");
  else {
    const report = collectDesignInventory();
    if (args.includes("--json")) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    else {
      process.stdout.write("Sauce Bunny production design inventory\n" + report.scope + "\n" + report.interpretation + "\n\n");
      process.stdout.write(report.summary.tsxFiles + " TSX files; " + report.summary.cssFiles + " CSS files; " + report.summary.jsxSites + " JSX source sites\n");
      for (const [name, family] of Object.entries(report.families)) process.stdout.write(name.padEnd(16) + String(family.count).padStart(5) + " sites in " + family.files.length + " files\n");
      process.stdout.write("\nRoles: " + Object.entries(report.roles).map(([role, value]) => role + "=" + value.count).join(", ") + "\n");
      process.stdout.write("Dynamic role sites (manual review): " + report.dynamicRoles.length + "\nSource SHA-256: " + report.sourceHash + "\nUse --json for every source location.\n");
    }
  }
}
