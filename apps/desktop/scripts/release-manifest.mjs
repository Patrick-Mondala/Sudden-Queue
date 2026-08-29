/**
 * Builds the `latest.json` the updater fetches.
 *
 * `tauri build` signs the installers but does not write the manifest that
 * points at them -- in a GitHub Actions release that gap is filled by
 * tauri-action. Releasing by hand, this fills it instead, so the version, the
 * signature and the download url cannot drift apart.
 *
 *   node scripts/release-manifest.mjs --notes "What changed"
 *
 * Then upload the installer, its .sig, and latest.json to the release.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, "..");
const conf = JSON.parse(readFileSync(join(desktop, "src-tauri/tauri.conf.json"), "utf8"));

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : process.argv[i + 1];
};

const version = conf.version;
const tag = arg("tag") ?? `v${version}`;
const notes = arg("notes") ?? `Sudden Queue ${version}`;

/**
 * Where the assets will live.
 *
 * Derived from the configured endpoint so there is one place to be wrong
 * rather than two.
 */
const endpoint = conf.plugins?.updater?.endpoints?.[0] ?? "";
const repo = endpoint.match(/github\.com\/([^/]+)\/([^/]+)\//);
if (!repo) {
  console.error(`Cannot read owner/repo from the updater endpoint:\n  ${endpoint || "(none set)"}`);
  process.exit(1);
}
const [, owner, name] = repo;
if (owner === "CHANGE-ME") {
  console.error(
    "The updater endpoint still says CHANGE-ME. Point it at the repository you\n" +
      "publish to before cutting a release, or installed copies will check a 404.",
  );
  process.exit(1);
}

const bundles = join(desktop, "src-tauri/target/release/bundle/nsis");
if (!existsSync(bundles)) {
  console.error(`No bundles at ${bundles}. Run \`npm run tauri build\` first.`);
  process.exit(1);
}

const files = await readdir(bundles);
const installer = files.find((f) => f.endsWith("-setup.exe"));
const signature = files.find((f) => f.endsWith("-setup.exe.sig"));

if (!installer || !signature) {
  console.error(
    "Built installer or its signature is missing. The signature needs\n" +
      "TAURI_SIGNING_PRIVATE_KEY set during the build.",
  );
  process.exit(1);
}

// GitHub rewrites spaces in asset names to periods on upload, so the url has to
// carry the rewritten name rather than the one on disk.
const asset = installer.replaceAll(" ", ".");

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": {
      signature: readFileSync(join(bundles, signature), "utf8").trim(),
      url: `https://github.com/${owner}/${name}/releases/download/${tag}/${asset}`,
    },
  },
};

const out = join(bundles, "latest.json");
writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`latest.json written to ${out}`);
console.log(`\nUpload all three to the ${tag} release:`);
console.log(`  ${join(bundles, installer)}`);
console.log(`  ${join(bundles, signature)}`);
console.log(`  ${out}`);
