// The configuration a CI build layers over src-tauri/tauri.conf.json, written
// to the path given. Kept out of the base config on purpose: a local build or
// a pull request has neither the update key nor a signing certificate, and
// asking for either would make its build fail.
//
//   node tools/release/ci-config.mjs <out.json>
//
// Update artifacts are signed when TAURI_SIGNING_PRIVATE_KEY is set.
// Windows installers are Authenticode-signed when WINDOWS_SIGNING is
// "trusted-signing" and the AZURE_SIGNING_* settings name the account, using
// trusted-signing-cli (installed by the workflow) and the AZURE_CLIENT_ID,
// AZURE_CLIENT_SECRET and AZURE_TENANT_ID it reads from the environment.
import { writeFileSync } from "node:fs";

const out = process.argv[2];
if (!out) {
  console.error("usage: ci-config.mjs <out.json>");
  process.exit(2);
}

const env = process.env;
const config = { bundle: {} };
const said = [];

if (env.TAURI_SIGNING_PRIVATE_KEY) {
  config.bundle.createUpdaterArtifacts = true;
  said.push("update artifacts: signed");
} else {
  said.push("update artifacts: off (no TAURI_SIGNING_PRIVATE_KEY)");
}

// Linux builds ignore bundle.windows, so this is the same on every runner.
if (env.WINDOWS_SIGNING === "trusted-signing") {
  const need = ["AZURE_SIGNING_ENDPOINT", "AZURE_SIGNING_ACCOUNT", "AZURE_SIGNING_PROFILE"];
  const missing = need.filter((k) => !env[k]);
  if (missing.length) {
    // Asked for and not possible is a failure, not a quiet unsigned build.
    console.error(`Windows signing is on but ${missing.join(", ")} is not set`);
    process.exit(1);
  }
  config.bundle.windows = {
    signCommand: [
      "trusted-signing-cli",
      "-e", env.AZURE_SIGNING_ENDPOINT,
      "-a", env.AZURE_SIGNING_ACCOUNT,
      "-c", env.AZURE_SIGNING_PROFILE,
      // One word: Tauri splits the command on spaces.
      "-d", "RigWorkbench",
      "%1",
    ].join(" "),
  };
  said.push("windows code signing: Azure Trusted Signing");
} else {
  said.push("windows code signing: off");
}

writeFileSync(out, JSON.stringify(config, null, 2));
console.log(said.join("\n"));
