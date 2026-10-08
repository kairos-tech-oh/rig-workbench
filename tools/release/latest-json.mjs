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

const all = files(dir);
const platforms = {};
for (const [platform, matches] of Object.entries(wanted)) {
  const installer = all.find((f) => matches(f) && f.includes(version));
  const sig = installer && all.find((f) => f === `${installer}.sig`);
  if (!installer || !sig) {
    console.warn(`no signed installer for ${platform}; it will not be offered this update`);
    continue;
  }
  platforms[platform] = { signature: readFileSync(sig, "utf8").trim(), url: assetUrl(installer) };
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
  JSON.stringify({ version, notes, pub_date: new Date().toISOString(), platforms }, null, 2),
);
console.log(`latest.json for ${version}: ${Object.keys(platforms).join(", ")}`);
