// git smart HTTP: protocol v2 upload-pack, v0 receive-pack, v0 fallback.
// The wire format is implemented from the protocol, not from a git binary:
// pkt-lines, sideband framing, packfiles, shallow boundaries, fast-forward
// rules. Objects are stored verbatim, so clones round-trip byte-for-byte.

import {
  ZERO_OID,
  readPack,
  writePack,
  type GitObject,
  type Store,
} from './store.ts';

export const AGENT = 'forge/1.0';

/** One pkt-line: 4 hex length digits (including the 4) + payload. */
export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');

export type Pkt = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' };

/** Parse a whole request body into pkt-lines. Throws on garbage. */
export function decodePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('truncated pkt-line header');
    const head = buf.subarray(offset, offset + 4).toString('ascii');
    if (head === '0000') {
      out.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (head === '0001') {
      out.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    const len = parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || offset + len > buf.length) {
      throw new Error(`bad pkt-line length ${JSON.stringify(head)}`);
    }
    out.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
    offset += len;
  }
  return out;
}

/** The data payloads of pkt-lines, as strings, ignoring flush/delim. */
export function pktStrings(buf: Buffer): string[] {
  return decodePktLines(buf)
    .filter((pkt): pkt is { kind: 'data'; payload: Buffer } => pkt.kind === 'data')
    .map((pkt) => pkt.payload.toString('utf8'));
}

/** Wrap report/status lines in sideband band 1 (plus optional band 2 progress). */
export function sidebandReport(lines: readonly string[], progress = ''): Buffer {
  const inner = Buffer.concat([...lines.map((line) => pktLine(line)), pktFlush()]);
  const parts: Buffer[] = [];
  // Band 1 packets carry the report stream; keep each pkt-line whole.
  let offset = 0;
  while (offset < inner.length) {
    const chunk = inner.subarray(offset, Math.min(inner.length, offset + 65516));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
    offset += chunk.length;
  }
  if (progress !== '') {
    parts.push(pktLine(Buffer.concat([Buffer.from([2]), Buffer.from(progress, 'utf8')])));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

/** All refs of a repo, sorted, with HEAD first where the caller wants it. */
export function listRefs(store: Store, repo: { refs: Map<string, string>; defaultBranch: string }): RefLine[] {
  const out: RefLine[] = [];
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  out.push({
    oid: tip ?? ZERO_OID,
    name: 'HEAD',
    symrefTarget: `refs/heads/${repo.defaultBranch}`,
    unborn: tip === undefined ? true : undefined,
  });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    const entry: RefLine = { oid, name };
    const obj = store.getObject(oid);
    if (obj !== undefined && obj.type === 'tag') {
      const peeled = store.peelToCommit(oid);
      if (peeled !== null) entry.peeled = peeled;
    }
    out.push(entry);
  }
  return out;
}

const V2_CAPS: Array<[string, string]> = [
  ['fetch', 'shallow filter'],
  ['ls-refs', 'unborn'],
  ['agent', AGENT],
  ['object-format', 'sha1'],
];

/** v0 upload-pack capabilities: stateless RPC needs multi_ack_detailed. */
function v0UploadCaps(defaultBranch: string): string {
  return `symref=HEAD:refs/heads/${defaultBranch} side-band-64k multi_ack_detailed thin-pack ofs-delta shallow`;
}
const V0_RECEIVE_CAPS = `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;

/** GET info/refs for upload-pack, protocol v2 (Git-Protocol: version=2). */
export function advertisementV2(): Buffer {
  const parts: Buffer[] = [
    pktLine('# service=git-upload-pack\n'),
    pktFlush(),
    pktLine('version 2\n'),
  ];
  for (const [key, value] of V2_CAPS) parts.push(pktLine(`${key}=${value}\n`));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** GET info/refs, protocol v0: preamble, flush, ref lines (caps on the first), flush. */
export function advertisementV0(store: Store, repo: { refs: Map<string, string>; defaultBranch: string }, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? v0UploadCaps(repo.defaultBranch) : V0_RECEIVE_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const refs = listRefs(store, repo);
  if (refs.length === 1 && refs[0]?.name === 'HEAD' && refs[0]?.unborn === true) {
    // No refs at all: the capabilities pseudo-ref line git sends for an empty repo.
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    for (const ref of refs) {
      let line = `${ref.oid} ${ref.name}`;
      if (first) {
        line += `\0${caps}`;
        first = false;
      }
      parts.push(pktLine(`${line}\n`));
      if (ref.peeled !== undefined) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** v2 ls-refs answer: one line per ref (+HEAD), flush. Prefixes filter server-side. */
export function lsRefsAnswer(
  store: Store,
  repo: { refs: Map<string, string>; defaultBranch: string },
  options: { prefixes: string[]; peel: boolean; symrefs: boolean; unborn: boolean },
): Buffer {
  const parts: Buffer[] = [];
  const refs = listRefs(store, repo);
  const keep = (name: string): boolean => options.prefixes.length === 0 || options.prefixes.some((prefix) => name.startsWith(prefix));
  const isEmpty = repo.refs.size === 0;
  if (isEmpty) {
    // No refs at all: the one line is the unborn HEAD, when it matches the
    // prefixes (a clone of an empty repo asks for prefix HEAD to learn the
    // default branch name from the symref-target).
    if (keep('HEAD')) {
      parts.push(pktLine(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    }
    parts.push(pktFlush());
    return Buffer.concat(parts);
  }
  for (const ref of refs) {
    if (!keep(ref.name)) continue;
    let line: string;
    if (ref.unborn === true) {
      line = `unborn ${ref.name}`;
    } else {
      line = `${ref.oid} ${ref.name}`;
    }
    if (ref.peeled !== undefined && options.peel) line += ` peeled:${ref.peeled}`;
    if (ref.symrefTarget !== undefined && options.symrefs) line += ` symref-target:${ref.symrefTarget}`;
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// fetch object selection

export interface FetchSelection {
  /** Oids to send, in pack order (sorted for a canonical pack). */
  send: string[];
  /** Shallow boundary commits (included, parents cut off by depth). */
  shallow: string[];
  /** Previously-shallow commits that are now fully included. */
  unshallow: string[];
  /** wanted-refs lines: [oid, refname] for wants that are ref tips. */
  wantedRefs: Array<[string, string]>;
}

/**
 * Which objects a fetch delivers: the depth-limited closure of the wants,
 * minus everything reachable from the haves. The shallow-info follows the
 * boundary the depth limit drew, and the unshallow list follows the prior
 * shallow commits that are now inside the closure.
 */
export function selectFetch(
  store: Store,
  repo: { refs: Map<string, string> },
  wants: readonly string[],
  haves: readonly string[],
  priorShallow: readonly string[],
  depth: number | null,
): FetchSelection {
  const { included, boundary } = store.depthWalk(wants, depth);
  // The send set is the depth-limited commits plus their tree closure only:
  // expanding through commit parents here would undo the depth limit and
  // turn every shallow fetch into a full clone.
  const sendSet = store.objectClosure(included);
  const haveReachable = store.haveClosure(haves, priorShallow);
  for (const oid of haveReachable) sendSet.delete(oid);
  // A want that is a tag ships the tag object itself too.
  for (const want of wants) {
    const obj = store.getObject(want);
    if (obj !== undefined && obj.type === 'tag' && !haveReachable.has(want)) sendSet.add(want);
  }
  const unshallow = priorShallow.filter((oid) => included.has(oid));
  const wantedRefs: Array<[string, string]> = [];
  for (const want of wants) {
    for (const [name, oid] of repo.refs) {
      if (oid === want) wantedRefs.push([want, name]);
    }
  }
  return {
    send: [...sendSet].sort(),
    shallow: [...boundary].sort(),
    unshallow: unshallow.sort(),
    wantedRefs,
  };
}

/** The pack for a fetch, cached by repo version + request shape (clone hits it 50x). */
export function fetchPack(store: Store, repo: { version: number; id: number }, key: string, oids: readonly string[]): Buffer {
  const cacheKey = `${repo.id}:${repo.version}:${key}`;
  const cached = store.packCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const pack = writePack(store.objects, oids);
  if (store.packCache.size > 64) {
    const first = store.packCache.keys().next();
    if (!first.done) store.packCache.delete(first.value);
  }
  store.packCache.set(cacheKey, pack);
  return pack;
}

/**
 * v2 fetch answer: acknowledgments / shallow-info / wanted-refs / packfile sections.
 * The acknowledgments section is sent only when the client sent haves: the
 * protocol says a fetch with no haves gets no acknowledgments section, and
 * real git dies ("expected 'packfile', received 'acknowledgments'") if it is
 * sent anyway. The suite's client dispatches on section headers, so it reads
 * either shape.
 */
export function fetchV2Answer(selection: FetchSelection, pack: Buffer | null, includeAcks = true): Buffer {
  const parts: Buffer[] = [];
  if (includeAcks) {
    parts.push(pktLine('acknowledgments\n'));
    parts.push(pktLine('NAK\n'));
    parts.push(pktDelim());
  }
  if (selection.shallow.length > 0 || selection.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  if (selection.wantedRefs.length > 0) {
    parts.push(pktLine('wanted-refs\n'));
    for (const [oid, name] of selection.wantedRefs) parts.push(pktLine(`${oid} ${name}\n`));
    parts.push(pktDelim());
  }
  if (pack !== null) {
    parts.push(pktLine('packfile\n'));
    let offset = 0;
    while (offset < pack.length) {
      const chunk = pack.subarray(offset, Math.min(pack.length, offset + 65515));
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
      offset += chunk.length;
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** v0 fetch answer: NAK, shallow lines, then the sideband pack, flush. */
export function fetchV0Answer(selection: FetchSelection, pack: Buffer | null): Buffer {
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (pack !== null) {
    let offset = 0;
    while (offset < pack.length) {
      const chunk = pack.subarray(offset, Math.min(pack.length, offset + 65515));
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
      offset += chunk.length;
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// receive-pack (push)

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export interface PushOutcome {
  unpackOk: boolean;
  unpackDetail: string;
  refs: Array<{ ref: string; ok: boolean; reason: string }>;
}

/**
 * Parse a receive-pack request body: command pkt-lines up to the flush, then
 * the pack bytes. Returns the commands and the pack (null when absent).
 */
export function parsePushBody(body: Buffer): { commands: PushCommand[]; pack: Buffer | null } {
  const packets = decodePktLines(body.subarray(0, findPackStart(body)));
  const commands: PushCommand[] = [];
  for (const pkt of packets) {
    if (pkt.kind !== 'data') continue;
    let line = pkt.payload.toString('utf8');
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul);
    line = line.replace(/\n$/, '');
    const parts = line.split(' ');
    if (parts.length < 3) continue;
    commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
  }
  const packStart = findPackStart(body);
  const pack = packStart < body.length ? body.subarray(packStart) : null;
  return { commands, pack };
}

/** Offset of the first byte after the command section's flush pkt-line. */
function findPackStart(body: Buffer): number {
  let offset = 0;
  while (offset + 4 <= body.length) {
    const head = body.subarray(offset, offset + 4).toString('ascii');
    if (head === '0000') return offset + 4;
    const len = parseInt(head, 16);
    if (!Number.isFinite(len) || len < 4 || offset + len > body.length) return body.length;
    offset += len;
  }
  return body.length;
}

/**
 * Apply a push: store the pack's objects, then evaluate each command.
 * Fast-forward only: a non-fast-forward update is refused per-ref with the
 * exact reason the suite expects, the ref does not move, but the unpack
 * still succeeds and the objects stay stored.
 */
export function applyPush(store: Store, repo: { refs: Map<string, string>; version: number }, commands: readonly PushCommand[], packObjects: GitObject[]): PushOutcome {
  for (const obj of packObjects) store.putObject(obj.type, obj.data);
  const refs: PushOutcome['refs'] = [];
  for (const cmd of commands) {
    const current = repo.refs.get(cmd.ref);
    if (cmd.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        refs.push({ ref: cmd.ref, ok: false, reason: 'remote ref does not exist' });
      } else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) {
        refs.push({ ref: cmd.ref, ok: false, reason: 'stale info' });
      } else {
        repo.refs.delete(cmd.ref);
        repo.version += 1;
        refs.push({ ref: cmd.ref, ok: true, reason: '' });
      }
      continue;
    }
    const target = store.getObject(cmd.newOid);
    if (target === undefined) {
      refs.push({ ref: cmd.ref, ok: false, reason: 'missing object' });
      continue;
    }
    if (current === undefined) {
      if (cmd.oldOid !== ZERO_OID) {
        refs.push({ ref: cmd.ref, ok: false, reason: 'stale info' });
        continue;
      }
      repo.refs.set(cmd.ref, cmd.newOid);
      repo.version += 1;
      refs.push({ ref: cmd.ref, ok: true, reason: '' });
      continue;
    }
    if (cmd.oldOid !== current) {
      refs.push({ ref: cmd.ref, ok: false, reason: 'stale info' });
      continue;
    }
    if (cmd.ref.startsWith('refs/tags/')) {
      refs.push({ ref: cmd.ref, ok: false, reason: 'already exists' });
      continue;
    }
    if (target.type !== 'commit') {
      refs.push({ ref: cmd.ref, ok: false, reason: 'not a commit' });
      continue;
    }
    if (!store.isAncestor(current, cmd.newOid)) {
      refs.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(cmd.ref, cmd.newOid);
    repo.version += 1;
    refs.push({ ref: cmd.ref, ok: true, reason: '' });
  }
  return { unpackOk: true, unpackDetail: 'ok', refs };
}

/** The report-status stream for a push outcome, sideband-framed on band 1. */
export function pushReportAnswer(outcome: PushOutcome): Buffer {
  const lines: string[] = [outcome.unpackOk ? 'unpack ok\n' : `unpack ${outcome.unpackDetail}\n`];
  for (const ref of outcome.refs) {
    lines.push(ref.ok ? `ok ${ref.ref}\n` : `ng ${ref.ref} ${ref.reason}\n`);
  }
  return sidebandReport(lines);
}

/** Parse a v2 upload-pack request body into its command and arguments. */
export function parseV2Request(body: Buffer): { command: string; args: string[] } {
  const packets = decodePktLines(body);
  let command = '';
  const args: string[] = [];
  let pastDelim = false;
  for (const pkt of packets) {
    if (pkt.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (pkt.kind !== 'data') continue;
    const line = pkt.payload.toString('utf8').replace(/\n$/, '');
    if (!pastDelim) {
      if (line.startsWith('command=')) command = line.slice('command='.length);
      continue;
    }
    args.push(line);
  }
  return { command, args };
}

/** Parse a v0 upload-pack fetch body (want/have/shallow/deepen across two sections). */
export function parseV0Fetch(body: Buffer): { wants: string[]; haves: string[]; shallow: string[]; depth: number | null } {
  const packets = decodePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const pkt of packets) {
    if (pkt.kind !== 'data') continue;
    const line = pkt.payload.toString('utf8').replace(/\n$/, '');
    const [verb, rest] = [line.split(' ')[0], line.split(' ').slice(1).join(' ')];
    if (verb === 'want') wants.push((rest ?? '').split(' ')[0] as string);
    else if (verb === 'have') haves.push(rest ?? '');
    else if (verb === 'shallow') shallow.push(rest ?? '');
    else if (verb === 'deepen') depth = parseInt(rest ?? '0', 10);
  }
  return { wants, haves, shallow, depth };
}
