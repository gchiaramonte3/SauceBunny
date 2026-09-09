import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const licenses = ["react", "react-dom", "scheduler"].map(name =>
  `${name}\n${readFileSync(resolve(root, "node_modules", name, "LICENSE"), "utf8")}`);
writeFileSync(resolve(root, "public", "THIRD-PARTY-NOTICES.txt"), licenses.join("\n\n"));
