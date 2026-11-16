// forge store: the in-memory git object database and the repository model.
//
// Everything lives in Maps; nothing touches the filesystem. Objects are stored
// by their SHA-1 under their exact pushed bytes, so a clone round-trips
// byte-for-byte. The repository model (refs, issues, pull requests, labels)
// is the same store the git wire, REST v3, GraphQL v4 and MCP surfaces all
// read and write, so the four surfaces can never disagree about a repository.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0'.repeat(40);

/** The one login the trial token names (wire.ts SCENARIO_SEED is constant). */
export const VIEWER = Object.freeze({
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
});
/** The stranger login: a repository under any other owner is 404, never 403. */
export const STRANGER = 'olgabauer';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  message: string;
  author: string;
  committer: string;
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

/** The git object id of `type` + `data` (the `<type> <len>\0` header is hashed). */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return sha1Hex(Buffer.concat([header, data]));
}

/** Compare two tree entry names the way git sorts a tree (directories as name + '/'). */
export function compareTreeNames(a: string, b: string, aIsDir: boolean, bIsDir: boolean): number {
  const an = aIsDir ? `${a}/` : a;
  const bn = bIsDir ? `${b}/` : b;
  return an < bn ? -1 : an > bn ? 1 : 0;
}

/** Encode tree entries (already in git sort order) into a tree object's bytes. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse a tree object's bytes into its entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const nul = data.indexOf(0x00, space);
    if (nul < 0 || nul + 21 > data.length) break;
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** Parse a commit object's bytes into its headers and message. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, message, author, committer };
}

/** Build a commit object's bytes. `message` must already end with '\n' when wanted. */
export function buildCommit(fields: {
  tree: string;
  parents: readonly string[];
  message: string;
  author: string;
  committer: string;
  timestamp: number;
}): Buffer {
  const lines: string[] = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author} ${fields.timestamp} +0000`);
  lines.push(`committer ${fields.committer} ${fields.timestamp} +0000`);
  lines.push('', fields.message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

/** Build an annotated tag object's bytes. */
export function buildTag(fields: {
  object: string;
  type: GitObjectType;
  tag: string;
  message: string;
  tagger: string;
  timestamp: number;
}): Buffer {
  const lines: string[] = [
    `object ${fields.object}`,
    `type ${fields.type}`,
    `tag ${fields.tag}`,
    `tagger ${fields.tagger} ${fields.timestamp} +0000`,
    '',
    fields.message,
  ];
  return Buffer.from(lines.join('\n'), 'utf8');
}

// ---------------------------------------------------------------------------
// packfiles

const PACK_MAGIC = 0x5041434b; // 'PACK'

/** Read one pack varint (7 bits per byte, little-endian groups, MSB continues). */
/**
 * The OFS_DELTA base offset: git's own encoding, not a plain varint — each
 * continuation step adds one before shifting (`((offset + 1) << 7) | bits`),
 * so a plain LEB128 decode reads a multi-byte offset wrong and the base is
 * "not in pack" even though it is.
 */
function readOfsDeltaOffset(buf: Buffer, offset: number): { value: number; next: number } {
  let pos = offset;
  let byte = buf[pos] ?? 0;
  pos += 1;
  let value = byte & 0x7f;
  while ((byte & 0x80) !== 0) {
    byte = buf[pos] ?? 0;
    pos += 1;
    value = ((value + 1) << 7) | (byte & 0x7f);
  }
  return { value, next: pos };
}

function readVarint(buf: Buffer, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let pos = offset;
  for (;;) {
    const byte = buf[pos] ?? 0;
    pos += 1;
    value |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  return { value, next: pos };
}

/** Apply a git delta to a base object, returning the result bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readSize = (): number => {
    const { value, next } = readVarint(delta, pos);
    pos = next;
    return value;
  };
  const baseSize = readSize();
  const resultSize = readSize();
  if (baseSize !== base.length) throw new Error(`delta base size ${baseSize} != ${base.length}`);
  const out: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const op = delta[pos];
    pos += 1;
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) {
        if ((op & (1 << i)) !== 0) {
          offset |= (delta[pos] ?? 0) << (8 * i);
          pos += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if ((op & (0x10 << i)) !== 0) {
          size |= (delta[pos] ?? 0) << (8 * i);
          pos += 1;
        }
      }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op !== 0) {
      out.push(delta.subarray(pos, pos + op));
      pos += op;
      produced += op;
    } else {
      throw new Error('delta op 0');
    }
  }
  const result = Buffer.concat(out);
  if (produced !== resultSize || result.length !== resultSize) {
    throw new Error(`delta result size ${result.length} != ${resultSize}`);
  }
  return result;
}

const PACK_TYPES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const PACK_TYPE_CODES: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/**
 * Parse a packfile into its objects. Deltas resolve against earlier entries in
 * the same pack or, through `lookup`, objects the server already holds.
 * Throws on a bad header, a bad checksum or an unresolvable delta.
 */
export function readPack(pack: Buffer, lookup?: (oid: string) => GitObject | undefined): GitObject[] {
  if (pack.length < 12) throw new Error('pack too short');
  if (pack.readUInt32BE(0) !== PACK_MAGIC) throw new Error('bad pack magic');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = sha1Hex(pack.subarray(0, pack.length - 20));
  const actual = pack.subarray(pack.length - 20).toString('hex');
  if (trailer !== actual) throw new Error('pack checksum mismatch');
  const objects: GitObject[] = [];
  const byOffset = new Map<number, GitObject>();
  const byOid = new Map<string, GitObject>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const start = offset;
    let byte = pack[offset] ?? 0;
    offset += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      byte = pack[offset] ?? 0;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let obj: GitObject;
    if (typeCode === 6) {
      // OFS_DELTA: a negative offset back to the base object in this pack.
      const { value: back, next } = readOfsDeltaOffset(pack, offset);
      offset = next;
      const baseOffset = start - back;
      const base = byOffset.get(baseOffset);
      if (base === undefined) throw new Error('ofs-delta base not in pack');
      const consumed = inflatedLength(pack, offset);
      const data = inflateSync(pack.subarray(offset, offset + consumed));
      offset += consumed;
      obj = { type: base.type, data: applyDelta(base.data, data) };
    } else if (typeCode === 7) {
      // REF_DELTA: the base object's id follows the header.
      const baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const base = byOid.get(baseOid) ?? lookup?.(baseOid);
      if (base === undefined) throw new Error(`ref-delta base ${baseOid} unknown`);
      const consumed = inflatedLength(pack, offset);
      const data = inflateSync(pack.subarray(offset, offset + consumed));
      offset += consumed;
      obj = { type: base.type, data: applyDelta(base.data, data) };
    } else {
      const type = PACK_TYPES[typeCode];
      if (type === undefined) throw new Error(`unknown pack type ${typeCode}`);
      const consumed = inflatedLength(pack, offset);
      const data = inflateSync(pack.subarray(offset, offset + consumed));
      offset += consumed;
      if (data.length !== size) throw new Error(`object size ${data.length} != ${size}`);
      obj = { type, data };
    }
    objects.push(obj);
    byOffset.set(start, obj);
    byOid.set(hashObject(obj.type, obj.data), obj);
  }
  return objects;
}

/**
 * How many bytes the zlib stream starting at `offset` occupies. Node's
 * inflateSync ignores trailing bytes after a stream and throws on a truncated
 * one, so success is monotonic in the slice end: double-probe for an upper
 * bound, then binary-search the smallest end that inflates. Exact, no
 * bit-level deflate parsing needed.
 */
function inflatedLength(pack: Buffer, offset: number): number {
  let lo = offset + 1;
  let hi = lo;
  for (;;) {
    try {
      inflateSync(pack.subarray(offset, hi));
      break;
    } catch {
      if (hi >= pack.length) throw new Error('truncated deflate stream');
      lo = hi;
      hi = Math.min(pack.length, offset + Math.max(1, (hi - offset) * 2));
    }
  }
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    try {
      inflateSync(pack.subarray(offset, mid));
      hi = mid;
    } catch {
      lo = mid;
    }
  }
  return hi - offset;
}

/** Build a packfile (version 2, full objects, no deltas) from object ids in `store`. */
export function writePack(store: Map<string, GitObject>, oids: readonly string[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(oids.length, 8);
  const parts: Buffer[] = [header];
  for (const oid of oids) {
    const obj = store.get(oid);
    if (obj === undefined) continue;
    const typeCode = PACK_TYPE_CODES[obj.type];
    const size = obj.data.length;
    // Object header: type in bits 4-6, low 4 size bits, then 7-bit size groups.
    const headerBytes: number[] = [];
    let first = (typeCode << 4) | (size & 0x0f);
    let rest = size >> 4;
    if (rest !== 0) first |= 0x80;
    headerBytes.push(first);
    while (rest !== 0) {
      let byte = rest & 0x7f;
      rest >>= 7;
      if (rest !== 0) byte |= 0x80;
      headerBytes.push(byte);
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, Buffer.from(sha1Hex(body), 'hex')]);
}

// ---------------------------------------------------------------------------
// repository model

export interface IssueComment {
  id: number;
  gid: string;
  body: string;
}

export interface Issue {
  number: number;
  restId: number;
  gid: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdSeq: number;
  comments: IssueComment[];
  jsonCache: Buffer | null;
}

export interface PullRequest {
  number: number;
  restId: number;
  gid: string;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeSha: string | null;
  createdSeq: number;
  jsonCache: Buffer | null;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  labels: Map<string, { name: string; color: string }>;
  issues: Map<number, Issue>;
  pulls: Map<number, PullRequest>;
  /** Shared issue + pull request counter (GitHub numbers one sequence). */
  seq: number;
  commentSeq: number;
  /** Bumped on every ref/object mutation: pack-cache invalidation. */
  version: number;
  createdSeq: number;
  jsonCache: Buffer | null;
}

/** Opaque Relay-style global id: base64url of `Kind:<ids>`, never the plain number. */
export function globalId(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64url');
}

/** Decode a global id back to its kind and parts, or null. */
export function parseGlobalId(gid: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(gid, 'base64url').toString('utf8');
    const split = text.indexOf(':');
    if (split < 0) return null;
    return { kind: text.slice(0, split), parts: text.slice(split + 1).split(':') };
  } catch {
    return null;
  }
}

let repoSeqCounter = 0;
let restIdCounter = 0;
let createCounter = 0;

export class Store {
  readonly objects = new Map<string, GitObject>();
  readonly repos = new Map<string, Repo>();
  readonly reposById = new Map<number, Repo>();
  /** Parsed-commit memo (commits are immutable, so this never goes stale). */
  readonly commitInfo = new Map<string, CommitInfo>();
  /** Parsed-tree memo (trees are immutable too). */
  readonly treeEntries = new Map<string, TreeEntry[]>();
  /** Built-pack cache: key -> pack bytes. Invalidated by repo.version. */
  readonly packCache = new Map<string, Buffer>();
  /** Server-created commit timestamps: fixed epoch + a counter, deterministic. */
  private commitClock = 1735689600;

  nextCommitTimestamp(): number {
    this.commitClock += 1;
    return this.commitClock;
  }

  viewerIdentity(): { name: string; email: string } {
    return { name: VIEWER.name, email: VIEWER.email };
  }

  putObject(type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  getCommitInfo(oid: string): CommitInfo | null {
    const cached = this.commitInfo.get(oid);
    if (cached !== undefined) return cached;
    const obj = this.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') return null;
    const info = parseCommit(obj.data);
    this.commitInfo.set(oid, info);
    return info;
  }

  getTreeEntries(oid: string): TreeEntry[] | null {
    const cached = this.treeEntries.get(oid);
    if (cached !== undefined) return cached;
    const obj = this.objects.get(oid);
    if (obj === undefined || obj.type !== 'tree') return null;
    const entries = parseTree(obj.data);
    this.treeEntries.set(oid, entries);
    return entries;
  }

  /** The commit a tag object points at (peeling one level), or the oid itself. */
  peelToCommit(oid: string): string | null {
    const obj = this.objects.get(oid);
    if (obj === undefined) return null;
    if (obj.type === 'commit') return oid;
    if (obj.type === 'tag') {
      const text = obj.data.toString('utf8');
      const match = /^object ([0-9a-f]{40})$/m.exec(text);
      if (match) return this.peelToCommit(match[1] ?? '');
    }
    return null;
  }

  /**
   * Every object reachable from `roots` (commits, their trees and blobs, tags
   * peeled to their target). Iterative: no recursion depth risk on long chains.
   */
  /**
   * The objects a fetch sends for a commit set: the commits themselves plus
   * their tree closure (trees and blobs). Commit parents are NOT followed —
   * that is what makes a depth-limited fetch shallow instead of a full clone.
   */
  objectClosure(commits: Iterable<string>): Set<string> {
    const seen = new Set<string>();
    const stack: string[] = [...commits];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      const obj = this.objects.get(oid);
      if (obj === undefined) continue;
      seen.add(oid);
      if (obj.type === 'commit') {
        const info = this.getCommitInfo(oid);
        if (info !== null) stack.push(info.tree);
      } else if (obj.type === 'tree') {
        const entries = this.getTreeEntries(oid);
        if (entries !== null) for (const entry of entries) stack.push(entry.oid);
      }
    }
    return seen;
  }

  /**
   * The objects a fetching client already has: the closure of its haves,
   * stopping at the prior shallow commits — their parents are NOT on the
   * client (that is the point of shallow), so they must not be treated as
   * present when a deepen extends the boundary.
   */
  haveClosure(haves: Iterable<string>, shallow: Iterable<string>): Set<string> {
    const shallowSet = new Set(shallow);
    const seen = new Set<string>();
    const stack: string[] = [...haves];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      const obj = this.objects.get(oid);
      if (obj === undefined) continue;
      seen.add(oid);
      if (obj.type === 'commit') {
        const info = this.getCommitInfo(oid);
        if (info === null) continue;
        stack.push(info.tree);
        if (!shallowSet.has(oid)) for (const parent of info.parents) stack.push(parent);
      } else if (obj.type === 'tree') {
        const entries = this.getTreeEntries(oid);
        if (entries !== null) for (const entry of entries) stack.push(entry.oid);
      } else if (obj.type === 'tag') {
        const target = this.peelToCommit(oid);
        if (target !== null && target !== oid) stack.push(target);
      }
    }
    return seen;
  }

  reachable(roots: Iterable<string>): Set<string> {
    const seen = new Set<string>();
    const stack: string[] = [...roots];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      const obj = this.objects.get(oid);
      if (obj === undefined) continue;
      seen.add(oid);
      if (obj.type === 'commit') {
        const info = this.getCommitInfo(oid);
        if (info === null) continue;
        stack.push(info.tree);
        for (const parent of info.parents) stack.push(parent);
      } else if (obj.type === 'tree') {
        const entries = this.getTreeEntries(oid);
        if (entries === null) continue;
        for (const entry of entries) stack.push(entry.oid);
      } else if (obj.type === 'tag') {
        const target = this.peelToCommit(oid);
        if (target !== null && target !== oid) stack.push(target);
      }
    }
    return seen;
  }

  /** Is `ancestor` reachable from `tip` following commit parents (first-parent walk is not enough)? */
  isAncestor(ancestor: string, tip: string): boolean {
    if (ancestor === tip) return true;
    const seen = new Set<string>();
    const stack: string[] = [tip];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const info = this.getCommitInfo(oid);
      if (info === null) continue;
      for (const parent of info.parents) {
        if (parent === ancestor) return true;
        stack.push(parent);
      }
    }
    return false;
  }

  /**
   * Depth-limited commit walk from `wants`: commits at distance 1..maxDepth.
   * Returns the included commits and the shallow boundary (included commits
   * whose parents exist but were cut off by the depth limit).
   */
  depthWalk(wants: readonly string[], maxDepth: number | null): { included: Set<string>; boundary: Set<string> } {
    const included = new Set<string>();
    const boundary = new Set<string>();
    const queue: Array<{ oid: string; depth: number }> = [];
    for (const want of wants) {
      const commit = this.peelToCommit(want);
      if (commit !== null) queue.push({ oid: commit, depth: 1 });
    }
    const seenDepth = new Map<string, number>();
    while (queue.length > 0) {
      const { oid, depth } = queue.shift() as { oid: string; depth: number };
      const prev = seenDepth.get(oid);
      if (prev !== undefined && prev <= depth) continue;
      seenDepth.set(oid, depth);
      if (maxDepth !== null && depth > maxDepth) continue;
      included.add(oid);
      const info = this.getCommitInfo(oid);
      if (info === null) continue;
      if (maxDepth !== null && depth === maxDepth) {
        // At the depth boundary this commit's parents are cut off: it is a
        // shallow boundary itself, even when it is a root with no parents.
        boundary.add(oid);
      } else {
        for (const parent of info.parents) queue.push({ oid: parent, depth: depth + 1 });
      }
    }
    return { included, boundary };
  }

  /** Flatten a tree into path -> {oid, mode} (recursive, '/'-joined paths). */
  flattenTree(treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
    const entries = this.getTreeEntries(treeOid);
    if (entries === null) return out;
    for (const entry of entries) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') {
        this.flattenTree(entry.oid, path, out);
      } else {
        out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    }
    return out;
  }

  /**
   * A new tree oid equal to `rootTreeOid` with `path` set to `blobOid`
   * (or removed when null). Creates the intermediate trees it needs.
   */
  applyToTree(rootTreeOid: string | null, path: string, blobOid: string | null): string {
    const segments = path.split('/');
    const build = (treeOid: string | null, depth: number): string => {
      const entries = treeOid === null ? [] : [...(this.getTreeEntries(treeOid) ?? [])];
      const name = segments[depth] as string;
      const last = depth === segments.length - 1;
      const existing = entries.findIndex((entry) => entry.name === name);
      if (last) {
        if (blobOid === null) {
          if (existing >= 0) entries.splice(existing, 1);
        } else if (existing >= 0) {
          entries[existing] = { mode: '100644', name, oid: blobOid };
        } else {
          entries.push({ mode: '100644', name, oid: blobOid });
        }
      } else {
        const childOid = existing >= 0 && entries[existing]?.mode === '40000' ? (entries[existing] as TreeEntry).oid : null;
        const next = build(childOid, depth + 1);
        const childEntries = this.getTreeEntries(next);
        if (childEntries !== null && childEntries.length === 0) {
          if (existing >= 0) entries.splice(existing, 1);
        } else if (existing >= 0) {
          entries[existing] = { mode: '40000', name, oid: next };
        } else {
          entries.push({ mode: '40000', name, oid: next });
        }
      }
      entries.sort((a, b) => compareTreeNames(a.name, b.name, a.mode === '40000', b.mode === '40000'));
      return this.putObject('tree', buildTree(entries));
    };
    return build(rootTreeOid, 0);
  }

  /** The blob at `path` in the tree of `commitOid`, or null. */
  blobAtPath(commitOid: string, path: string): { oid: string; data: Buffer } | null {
    const info = this.getCommitInfo(commitOid);
    if (info === null) return null;
    const flat = this.flattenTree(info.tree);
    const entry = flat.get(path);
    if (entry === undefined) return null;
    const obj = this.objects.get(entry.oid);
    if (obj === undefined || obj.type !== 'blob') return null;
    return { oid: entry.oid, data: obj.data };
  }

  /** The direct children of `dirPath` in the tree of `commitOid` (files and dirs). */
  listDir(commitOid: string, dirPath: string): Array<{ type: 'file' | 'dir'; name: string; path: string; sha: string }> | null {
    const info = this.getCommitInfo(commitOid);
    if (info === null) return null;
    const flat = this.flattenTree(info.tree);
    const prefix = dirPath === '' ? '' : `${dirPath}/`;
    const seen = new Map<string, { type: 'file' | 'dir'; name: string; path: string; sha: string }>();
    for (const [path, entry] of flat) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) {
        seen.set(rest, { type: 'file', name: rest, path, sha: entry.oid });
      } else {
        const dirName = rest.slice(0, slash);
        if (!seen.has(dirName)) {
          seen.set(dirName, { type: 'dir', name: dirName, path: `${prefix}${dirName}`, sha: entry.oid });
        }
      }
    }
    if (seen.size === 0) return null;
    return [...seen.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  /** Create a repository owned by the viewer. Returns null when the name is taken. */
  createRepo(name: string, isPrivate: boolean, description: string): Repo | null {
    const key = `${VIEWER.login}/${name}`;
    if (this.repos.has(key)) return null;
    repoSeqCounter += 1;
    const id = repoSeqCounter;
    const repo: Repo = {
      id,
      owner: VIEWER.login,
      name,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      seq: 0,
      commentSeq: 0,
      version: 0,
      createdSeq: (createCounter += 1),
      jsonCache: null,
    };
    this.repos.set(key, repo);
    this.reposById.set(id, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | null {
    if (owner !== VIEWER.login) return null;
    return this.repos.get(`${owner}/${name}`) ?? null;
  }

  deleteRepo(owner: string, name: string): boolean {
    if (owner !== VIEWER.login) return false;
    const repo = this.repos.get(`${owner}/${name}`);
    if (repo === undefined) return false;
    this.repos.delete(`${owner}/${name}`);
    this.reposById.delete(repo.id);
    return true;
  }

  listViewerRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  }

  nextRestId(): number {
    restIdCounter += 1;
    return restIdCounter;
  }

  /** Create a commit object for `repo` and store it; returns its oid. */
  makeCommit(repo: Repo, tree: string, parents: readonly string[], message: string): string {
    const author = `${VIEWER.name} <${VIEWER.email}>`;
    const data = buildCommit({
      tree,
      parents,
      message: message.endsWith('\n') ? message : `${message}\n`,
      author,
      committer: author,
      timestamp: this.nextCommitTimestamp(),
    });
    const oid = this.putObject('commit', data);
    repo.version += 1;
    return oid;
  }

  invalidateRepoCache(repo: Repo): void {
    repo.jsonCache = null;
  }
}
