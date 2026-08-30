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

console.log(`latest.json written to ${out}`);
console.log(`\nUpload all three to the ${tag} release:`);
console.log(`  ${join(bundles, installer)}`);
console.log(`  ${join(bundles, signature)}`);
console.log(`  ${out}`);
console.log(
  `\nThen copy the installer as ${asset}, and latest.json beside it, into the\n` +
    "releases directory on the server. Until they are there, this manifest\n" +
    `describes a download that 404s -- and ${new URL(".", manifestUrl).href} is\n` +
    "what every installed copy checks before it will open.",
);
