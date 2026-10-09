import { invoke } from "@tauri-apps/api/core";
import { isMap, isScalar, isSeq, parseDocument, type Document, type YAMLMap, type YAMLSeq } from "yaml";

/**
 * Keeps the rig spec (`rig.yaml` in the rig folder) in step with changes made
 * through the daemon, so a rig edited here still comes up the same with
 * `rig up`. Edits go through the `yaml` document model, which keeps the
 * file's comments, quoting and layout; only the touched entries change.
 */

/** A seat as the spec declares it (snake_case, like the file). */
export interface SpecMember {
  id: string;
  agent_ref: string;
  runtime: string;
  model?: string;
  profile: string;
  cwd: string;
}

export type SpecChange =
  | { op: "addEdge"; from: string; to: string; kind: string }
  | { op: "removeEdge"; from: string; to: string; kind: string }
  /** Adds the member, or updates it in place (keeping its label and comments) if it exists. */
  | { op: "upsertMember"; pod: string; member: SpecMember }
  /** Removes the member and every edge that mentions it, as the daemon does. */
  | { op: "removeMember"; logicalId: string };

const MEMBER_KEYS: (keyof SpecMember)[] = ["agent_ref", "runtime", "model", "profile", "cwd"];

function splitId(logicalId: string): [string, string] {
  const dot = logicalId.indexOf(".");
  return [logicalId.slice(0, dot), logicalId.slice(dot + 1)];
}

function str(node: unknown, key: string): string | undefined {
  if (!isMap(node)) return undefined;
  const value = node.get(key);
  return typeof value === "string" ? value : undefined;
}

function pods(doc: Document): YAMLMap[] {
  const seq = doc.get("pods");
  return isSeq(seq) ? seq.items.filter(isMap) : [];
}

function findPod(doc: Document, pod: string): YAMLMap | undefined {
  return pods(doc).find((p) => str(p, "id") === pod);
}

/** A block-style sequence under `key`, created if missing; an empty flow `[]` becomes block style. */
function blockSeq(doc: Document, owner: YAMLMap | Document, key: string): YAMLSeq {
  const existing = owner.get(key, true);
  const seq = isSeq(existing) ? existing : (doc.createNode([]) as YAMLSeq);
  if (seq !== existing) owner.set(key, seq);
  if (seq.items.length === 0) seq.flow = false;
  return seq;
}

/** Remove matching items; returns how many went. */
function removeWhere(seq: unknown, match: (item: unknown) => boolean): number {
  if (!isSeq(seq)) return 0;
  const before = seq.items.length;
  seq.items = seq.items.filter((item) => !match(item));
  return before - seq.items.length;
}

/** Folder-relative paths (like `.`) and absolute ones naming the same place are equal. */
function samePath(folder: string, a: string, b: string): boolean {
  const resolve = (p: string) => {
    const full = p.startsWith("/") ? p : `${folder}/${p}`;
    const parts: string[] = [];
    for (const part of full.split("/")) {
      if (part === "" || part === ".") continue;
      if (part === "..") parts.pop();
      else parts.push(part);
    }
    return "/" + parts.join("/");
  };
  return resolve(a) === resolve(b);
}

/** Sets a scalar, keeping the old quoting; a new key copies the quoting a sibling uses for it. */
function setScalar(doc: Document, map: YAMLMap, key: string, value: string, sibling?: YAMLMap) {
  const existing = map.get(key, true);
  if (isScalar(existing)) {
    existing.value = value;
    return;
  }
  const node = doc.createNode(value);
  const style = sibling?.get(key, true);
  if (isScalar(style) && isScalar(node)) node.type = style.type;
  map.set(key, node);
}

/**
 * Apply one change to the spec text. `folder` is the rig folder, used to
 * recognise a working directory written relative to it. Unchanged when the
 * spec already says what the change asks for.
 */
export function applySpecChange(text: string, change: SpecChange, folder: string): { text: string; changed: boolean } {
  const crlf = text.includes("\r\n");
  const doc = parseDocument(crlf ? text.replace(/\r\n/g, "\n") : text);
  if (doc.errors.length > 0) throw new Error(`rig.yaml does not parse: ${doc.errors[0].message}`);
  let changed = false;

  const isEdge = (from: string, to: string, kind: string) => (item: unknown) =>
    str(item, "kind") === kind && str(item, "from") === from && str(item, "to") === to;
  /** Pod-local edges name members within the pod; they only cover two seats of one pod. */
  const podLocal = (from: string, to: string): [YAMLMap, string, string] | null => {
    const [fromPod, fromMember] = splitId(from);
    const [toPod, toMember] = splitId(to);
    const pod = fromPod === toPod ? findPod(doc, fromPod) : undefined;
    return pod ? [pod, fromMember, toMember] : null;
  };

  switch (change.op) {
    case "addEdge": {
      const { from, to, kind } = change;
      const top = doc.get("edges");
      const local = podLocal(from, to);
      const declared =
        (isSeq(top) && top.items.some(isEdge(from, to, kind))) ||
        (local && isSeq(local[0].get("edges")) && (local[0].get("edges") as YAMLSeq).items.some(isEdge(local[1], local[2], kind)));
      if (!declared) {
        // OpenRig rejects a top-level edge between two seats of one pod; those
        // belong in the pod's own list, by member id.
        if (local) blockSeq(doc, local[0], "edges").add(doc.createNode({ kind, from: local[1], to: local[2] }));
        else blockSeq(doc, doc, "edges").add(doc.createNode({ kind, from, to }));
        changed = true;
      }
      break;
    }
    case "removeEdge": {
      const { from, to, kind } = change;
      changed = removeWhere(doc.get("edges"), isEdge(from, to, kind)) > 0;
      const local = podLocal(from, to);
      if (local) changed = removeWhere(local[0].get("edges"), isEdge(local[1], local[2], kind)) > 0 || changed;
      break;
    }
    case "upsertMember": {
      const pod = findPod(doc, change.pod);
      if (!pod) throw new Error(`rig.yaml has no pod "${change.pod}"`);
      const members = blockSeq(doc, pod, "members");
      const maps = members.items.filter(isMap);
      let entry = maps.find((m) => str(m, "id") === change.member.id);
      const others = maps.filter((m) => m !== entry);
      const sibling = others[others.length - 1];
      if (!entry) {
        entry = doc.createNode({ id: change.member.id }) as YAMLMap;
        members.add(entry);
        changed = true;
      }
      for (const key of MEMBER_KEYS) {
        let value = change.member[key];
        if (!value) continue;
        const current = str(entry, key);
        if (key === "cwd") {
          if (current !== undefined && samePath(folder, current, value)) continue;
          if (samePath(folder, ".", value)) value = ".";
        }
        if (current === value) continue;
        setScalar(doc, entry, key, value, sibling);
        changed = true;
      }
      break;
    }
    case "removeMember": {
      const [podId, memberId] = splitId(change.logicalId);
      const pod = findPod(doc, podId);
      if (pod) {
        changed = removeWhere(pod.get("members"), (m) => str(m, "id") === memberId) > 0;
        const mentionsMember = (e: unknown) => str(e, "from") === memberId || str(e, "to") === memberId;
        changed = removeWhere(pod.get("edges"), mentionsMember) > 0 || changed;
      }
      const mentions = (e: unknown) => str(e, "from") === change.logicalId || str(e, "to") === change.logicalId;
      changed = removeWhere(doc.get("edges"), mentions) > 0 || changed;
      break;
    }
  }

  if (!changed) return { text, changed };
  const out = doc.toString();
  return { text: crlf ? out.replace(/\n/g, "\r\n") : out, changed };
}

// ---- Applying to the file ------------------------------------------------------

type Listener = (message: string) => void;
const listeners = new Set<Listener>();

/** Hear about spec updates that failed. The daemon change they followed still stands. */
export function onSpecProblem(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Bring `<folder>/rig.yaml` in line with a change the daemon has already made.
 * Never throws: a failure is reported to `onSpecProblem` listeners, because the
 * daemon change it followed has happened either way.
 */
export async function updateRigSpec(folder: string, change: SpecChange): Promise<void> {
  try {
    if (!folder.trim()) throw new Error("no rig folder is set");
    const before = await invoke<string>("rig_spec_read", { folder });
    const { text, changed } = applySpecChange(before, change, folder);
    if (changed) await invoke("rig_spec_write", { folder, text, expected: before });
  } catch (e) {
    const message = `Changed in the daemon, but rig.yaml was not updated: ${e instanceof Error ? e.message : e}`;
    for (const l of listeners) l(message);
  }
}
