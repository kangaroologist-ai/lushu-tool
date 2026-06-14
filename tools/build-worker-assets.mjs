#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = join(ROOT, ".worker-assets");
const FILES = [
  "index.html",
  "sw.js",
  "manifest.webmanifest",
  "trip.data.js",
  "trips.json",
  "sample-trip.md",
  "trip-template.md",
];

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
for (const file of FILES) {
  cpSync(join(ROOT, file), join(OUT, file));
}
cpSync(join(ROOT, "icons"), join(OUT, "icons"), { recursive: true });
let extra = "icons";
if (existsSync(join(ROOT, "offline-map", "manifest.json"))) {
  cpSync(join(ROOT, "offline-map"), join(OUT, "offline-map"), { recursive: true });
  extra += " + offline-map";
}
console.log(`[build-worker-assets] OK: ${FILES.length} files + ${extra} -> ${OUT}`);
