// Checks each <file>.sig against the update public key in src-tauri/tauri.conf.json,
// the key installed copies trust, so a release signed with any other key never ships.
//
//   node tools/release/verify-sig.mjs <file>...
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: verify-sig.mjs <file>...");
  process.exit(2);
}

// Tauri stores minisign files base64-encoded; the second line holds the key or signature.
const minisignBlob = (b64) => Buffer.from(Buffer.from(b64.trim(), "base64").toString("utf8").split("\n")[1], "base64");

const pub = minisignBlob(JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")).plugins.updater.pubkey);
const keyId = pub.subarray(2, 10);
const key = createPublicKey({
  key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), pub.subarray(10, 42)]),
  format: "der",
  type: "spki",
});

let failed = false;
for (const file of files) {
  const sig = minisignBlob(readFileSync(`${file}.sig`, "utf8"));
  const prehashed = sig.subarray(0, 2).toString() === "ED";
  const message = prehashed ? createHash("blake2b512").update(readFileSync(file)).digest() : readFileSync(file);
  const ok = sig.subarray(2, 10).equals(keyId) && verify(null, message, key, sig.subarray(10, 74));
  console.log(`${ok ? "signed by the update key" : "NOT signed by the update key"}: ${file}`);
  failed ||= !ok;
}
process.exit(failed ? 1 : 0);
