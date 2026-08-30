/**
 * Collects every translatable string into a starter catalogue.
 *
 * A translator should not have to read the source to find out what needs
 * saying. This walks the client for `t("…")` and `tn("…", "…")` and prints a
 * catalogue with every English source string as a key and an empty value.
 *
 *   node scripts/extract-strings.mjs > src/i18n/de.json
 *
 * Existing translations are kept: pass the catalogue you already have and only
 * the missing keys come back blank, so this is safe to re-run as the interface
 * grows.
 *
 *   node scripts/extract-strings.mjs --merge src/i18n/de.json
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../src");

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : process.argv[i + 1];
};

/** Every .jsx/.js under src, minus tests and the i18n machinery itself. */
function sources(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sources(full));
    } else if (/\.(jsx?|mjs)$/.test(entry) && !/\.test\./.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const found = new Set();
const QUOTED = '"((?:[^"\\\\]|\\\\.)*)"';
const single = new RegExp(`\\bt\\(\\s*${QUOTED}`, "g");
const plural = new RegExp(`\\btn\\(\\s*${QUOTED}\\s*,\\s*${QUOTED}`, "g");

for (const file of sources(root)) {
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(single)) found.add(m[1]);
  for (const m of text.matchAll(plural)) {
    found.add(m[1]);
    found.add(m[2]);
  }
}

let existing = {};
const mergePath = arg("merge");
if (mergePath) {
  try {
    existing = JSON.parse(readFileSync(mergePath, "utf8"));
  } catch {
    // No catalogue there yet: everything is new, which is the normal first run.
  }
}

const catalogue = {};
for (const key of [...found].sort()) catalogue[key] = existing[key] ?? "";

const done = Object.values(catalogue).filter(Boolean).length;
process.stderr.write(`${found.size} strings, ${done} already translated\n`);
process.stdout.write(`${JSON.stringify(catalogue, null, 2)}\n`);
