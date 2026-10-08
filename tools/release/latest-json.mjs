// Writes the latest.json the in-app updater reads, from the signed installers
// a release build produced.
//
//   node tools/release/latest-json.mjs <artifacts-dir> <tag> <repo> <out.json>
//
// The updater fetches
//   https://github.com/<repo>/releases/latest/download/latest.json
// so this file is uploaded with the release, and the release must be
// published (not left as a draft) before any installed copy will see it.
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const [dir, tag, repo, out] = process.argv.slice(2);
if (!dir || !tag || !repo || !out) {
  console.error("usage: latest-json.mjs <artifacts-dir> <tag> <repo> <out.json>");
  process.exit(2);
}
const version = tag.replace(/^v/, "");

function files(root) {
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name);
    return statSync(path).isDirectory() ? files(path) : [path];
  });
}

// GitHub stores an uploaded file's spaces as dots, so the download URL has to
// name it that way too.
const assetUrl = (file) =>
  `https://github.com/${repo}/releases/download/${tag}/${basename(file).replaceAll(" ", ".")}`;

// Which installer serves which platform. NSIS is what Rig Workbench installs
// with on Windows, so it is the one an installed copy updates from.
const wanted = {
  "windows-x86_64": (f) => f.endsWith("-setup.exe"),
  "linux-x86_64": (f) => f.endsWith(".AppImage"),
};

// Only the .sig files are read; the installer each names need not be here,
// so a later run can rebuild this from a published release's signatures.
const sigs = files(dir).filter((f) => f.endsWith(".sig"));
const platforms = {};
for (const [platform, matches] of Object.entries(wanted)) {
  const sig = sigs.find((f) => matches(f.slice(0, -4)) && basename(f).includes(version));
  if (!sig) {
    console.warn(`no signed installer for ${platform}; it will not be offered this update`);
    continue;
  }
  platforms[platform] = { signature: readFileSync(sig, "utf8").trim(), url: assetUrl(sig.slice(0, -4)) };
}

// The OpenRig daemon this release goes with, if publish-local.sh attached one.
let daemon;
const daemonSig = sigs.find((f) => /^openrig-cli-.+\.tgz\.sig$/.test(basename(f)));
if (daemonSig) {
  const tarball = daemonSig.slice(0, -4);
  const { version: daemonVersion, commit } = JSON.parse(readFileSync(tarball.replace(/\.tgz$/, ".json"), "utf8"));
  daemon = { version: daemonVersion, commit, url: assetUrl(tarball), signature: readFileSync(daemonSig, "utf8").trim() };
}

if (Object.keys(platforms).length === 0) {
  console.error("no signed installers found; was TAURI_SIGNING_PRIVATE_KEY set for the build?");
  process.exit(1);
}

// The release notes are this version's section of the changelog.
let notes = `Rig Workbench ${version}`;
try {
  const log = readFileSync("CHANGELOG.md", "utf8");
  const start = log.search(new RegExp(`^## \\[${version.replaceAll(".", "\\.")}\\]`, "m"));
  if (start >= 0) {
    const rest = log.slice(start).split("\n").slice(1).join("\n");
    const end = rest.search(/^## \[/m);
    notes = (end >= 0 ? rest.slice(0, end) : rest).trim();
  }
} catch {
  // No changelog: the plain heading will do.
}

writeFileSync(
  out,
  JSON.stringify({ version, notes, pub_date: new Date().toISOString(), platforms, daemon }, null, 2),
);
console.log(
  `latest.json for ${version}: ${Object.keys(platforms).join(", ")}${daemon ? `; daemon ${daemon.version}` : ""}`,
);
