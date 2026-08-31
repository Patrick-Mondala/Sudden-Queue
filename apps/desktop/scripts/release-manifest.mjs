/**
 * Builds the `latest.json` the updater fetches.
 *
 * `tauri build` signs the installers but does not write the manifest that
 * points at them, so this fills the gap and the version, the signature and the
 * download url cannot drift apart. CI runs the same script rather than a second
 * implementation of it.
 *
 *   node scripts/release-manifest.mjs --notes "What changed"
 *
 * Writes latest.json and SHA256SUMS beside the installer. Everything goes to
 * the release; the installer, the browser bundle, latest.json and SHA256SUMS
 * go to the server.
 */
import { createHash } from "node:crypto";
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
const endpoint = arg("endpoint") ?? conf.plugins?.updater?.endpoints?.[0] ?? "";

let manifestUrl;
try {
  manifestUrl = new URL(endpoint);
} catch {
  console.error(
    `The updater endpoint is not a url:\n  ${endpoint || "(none set)"}\n\n` +
      "It is where installed copies look for latest.json, and the installer url\n" +
      "is resolved against it. Set it in tauri.conf.json, or pass --endpoint.",
  );
  process.exit(1);
}

if (endpoint.includes("CHANGE-ME")) {
  console.error(
    "The updater endpoint still says CHANGE-ME. Point it at the deployment you\n" +
      "publish from before cutting a release, or installed copies will check a 404\n" +
      "and refuse to open, because not knowing counts as not current.",
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

// GitHub rewrites spaces in asset names to periods on upload. The build store
// is still a GitHub release even though the download is served from the
// deployment, so the file arrives on the server under the rewritten name --
// which makes that, not the name on disk here, the one to publish.
const asset = installer.replaceAll(" ", ".");

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": {
      signature: readFileSync(join(bundles, signature), "utf8").trim(),
      // Resolved against the manifest's own url: the installer is served from
      // beside latest.json, so there is no second host to get wrong.
      url: new URL(asset, manifestUrl).href,
    },
  },
};

const out = join(bundles, "latest.json");
writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);

/**
 * The installer's checksum, in the format `sha256sum -c` reads.
 *
 * Not for the players: the updater verifies a minisign signature over what it
 * downloads, which is a stronger statement than a hash and one an attacker
 * cannot forge. This is for the step in between -- the copy onto the server --
 * where the failure is a truncated file or a manifest that arrived before its
 * installer, and where the consequence is that every client is locked out of
 * an app that cannot fetch the version it is being told to install.
 *
 * The server reads this before it will believe latest.json, so a release that
 * has not landed properly raises no floor and shuts nobody out.
 */
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

const sumLines = [`${sha256(join(bundles, installer))}  ${asset}`];

/**
 * The browser build, when this run produced one.
 *
 * Vouched for by the same file as the installer rather than a second one: it
 * is copied across in the same step and fails the same way, and a truncated
 * bundle would leave the website broken at exactly the moment the release it
 * belongs to starts refusing every older client. Extra entries here cost the
 * server nothing -- it looks the installer up by name.
 */
const webBundle = join(desktop, "webapp.tar.gz");
if (existsSync(webBundle)) sumLines.push(`${sha256(webBundle)}  webapp.tar.gz`);

const sums = join(bundles, "SHA256SUMS");
writeFileSync(sums, `${sumLines.join("\n")}\n`);

console.log(`latest.json written to ${out}`);
console.log(`SHA256SUMS written to ${sums}`);
console.log(`\nUpload these to the ${tag} release:`);
console.log(`  ${join(bundles, installer)}`);
console.log(`  ${join(bundles, signature)}`);
console.log(`  ${out}`);
console.log(`  ${sums}`);
if (existsSync(webBundle)) console.log(`  ${webBundle}`);
console.log(
  `\nThen copy three of them -- the installer as ${asset}, latest.json and\n` +
    "SHA256SUMS -- into the releases directory on the server, installer first.\n" +
    "The server checks the installer against SHA256SUMS before it believes the\n" +
    "manifest, so a half-finished copy raises no version floor and locks nobody\n" +
    `out. ${new URL(".", manifestUrl).href} is what every installed copy checks\n` +
    "before it will open.",
);
