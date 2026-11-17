// gitobj.ts — the git object model, packfiles and pkt-lines, written from the
// git format itself. Only node:crypto and node:zlib are used. No git binary.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export const ZERO_OID = '0'.repeat(40);

const HEX40 = /^[0-9a-f]{40}$/;

export function isOid(value: string): boolean {
  return HEX40.test(value);
}

/** SHA-1 of `<type> <size>\0` + bytes: exactly how git names an object. */
export function hashObject(type: ObjType, data: Buffer): string {
  const hash = createHash('sha1');
  hash.update(`${type} ${data.length}\0`, 'utf8');
  hash.update(data);
  return hash.digest('hex');
}

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

// ---------------------------------------------------------------------------
// commits, trees, tags
// ---------------------------------------------------------------------------

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const head = blank < 0 ? data.toString('utf8') : data.subarray(0, blank).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5);
    else if (line.startsWith('parent ')) parents.push(line.slice(7));
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    const nul = data.indexOf(0x00, sp + 1);
    if (sp < 0 || nul < 0 || nul + 21 > data.length) throw new Error('malformed tree object');
    entries.push({
      mode: data.subarray(off, sp).toString('ascii'),
      name: data.subarray(sp + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    off = nul + 21;
  }
  return entries;
}

/** git's tree sort: byte order, a directory compared as if its name ended in '/'. */
function treeCompare(a: TreeEntry, b: TreeEntry): number {
  const an = a.mode === '40000' ? `${a.name}/` : a.name;
  const bn = b.mode === '40000' ? `${b.name}/` : b.name;
  return Buffer.compare(Buffer.from(an, 'utf8'), Buffer.from(bn, 'utf8'));
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort(treeCompare);
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface TagView {
  object: string;
  type: ObjType;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const head = blank < 0 ? data.toString('utf8') : data.subarray(0, blank).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let object = '';
  let type: ObjType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7);
    else if (line.startsWith('type ')) type = line.slice(5) as ObjType;
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

export function buildCommit(opts: {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines = [`tree ${opts.tree}`];
  for (const p of opts.parents) lines.push(`parent ${p}`);
  lines.push(`author ${opts.author}`, `committer ${opts.committer}`, '');
  return Buffer.from(`${lines.join('\n')}\n${opts.message}`, 'utf8');
}

// ---------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------

export const PKT_MAX = 65520;

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length + 4 > PKT_MAX) throw new Error('pkt-line too long');
  const head = Buffer.alloc(4);
  head.write((data.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, data]);
}

export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');

export function pktLines(items: Array<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(pktFlush());
    else if (item === 'delim') parts.push(pktDelim());
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

export interface DecodedPacket {
  kind: 'data' | 'flush' | 'delim' | 'end';
  payload: Buffer;
}

/** Decode a whole buffer of pkt-lines. Throws on malformed framing. */
export function decodePktLines(buf: Buffer): DecodedPacket[] {
  const out: DecodedPacket[] = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('truncated pkt-line');
    const head = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error('bad pkt-line length');
    const len = parseInt(head, 16);
    if (len === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      off += 4;
    } else if (len === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      off += 4;
    } else if (len === 2) {
      out.push({ kind: 'end', payload: Buffer.alloc(0) });
      off += 4;
    } else if (len < 4 || len > PKT_MAX || off + len > buf.length) {
      throw new Error('bad pkt-line length');
    } else {
      out.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
      off += len;
    }
  }
  return out;
}

/** Split a buffer at the first flush packet: [packets before it, bytes after it]. */
export function splitAtFlush(buf: Buffer): { packets: DecodedPacket[]; rest: Buffer } {
  let off = 0;
  const packets: DecodedPacket[] = [];
  while (off < buf.length) {
    if (off + 4 > buf.length) throw new Error('truncated pkt-line');
    const head = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error('bad pkt-line length');
    const len = parseInt(head, 16);
    if (len === 0) return { packets, rest: buf.subarray(off + 4) };
    if (len === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      off += 4;
    } else if (len === 2) {
      packets.push({ kind: 'end', payload: Buffer.alloc(0) });
      off += 4;
    } else if (len < 4 || len > PKT_MAX || off + len > buf.length) {
      throw new Error('bad pkt-line length');
    } else {
      packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
      off += len;
    }
  }
  throw new Error('no flush packet');
}

// ---------------------------------------------------------------------------
// packfiles (plain objects only; this forge never writes deltas)
// ---------------------------------------------------------------------------

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function packObjectHeader(type: ObjType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let rest = size;
  let first = (code << 4) | (rest & 0x0f);
  rest = Math.floor(rest / 16);
  while (rest > 0) {
    bytes.push(first | 0x80);
    first = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a pack version 2 from plain objects, trailer SHA-1 included. */
export function writePack(objects: GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 4, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(objects.length, 8);
  parts.push(head);
  for (const obj of objects) {
    parts.push(packObjectHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

export interface PackRead {
  version: number;
  count: number;
  objects: Map<string, GitObject>;
}

function readVarint(buf: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buf[start]!;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let off = start + 1;
  while (byte & 0x80) {
    if (off >= buf.length) throw new Error('pack size varint truncated');
    byte = buf[off++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: off, first };
}

/** Read a packfile. Verifies the trailer checksum and every object's id and size. */
export function readPack(pack: Buffer): PackRead {
  if (pack.length < 32) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack has no PACK header');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerAt = pack.length - 20;
  const trailer = pack.subarray(trailerAt).toString('hex');
  if (sha1Hex(pack.subarray(0, trailerAt)) !== trailer) throw new Error('pack trailer checksum mismatch');
  const objects = new Map<string, GitObject>();
  let off = 12;
  for (let i = 0; i < count; i += 1) {
    const header = readVarint(pack, off);
    off = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    if (typeCode === 6 || typeCode === 7) throw new Error('delta packs are not accepted');
    const type = CODE_TYPE[typeCode];
    if (!type) throw new Error(`unknown pack object type ${typeCode}`);
    const inflated = inflateSync(pack.subarray(off), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    if (inflated.buffer.length !== header.size) throw new Error('pack object size mismatch');
    off += inflated.engine.bytesWritten;
    const oid = hashObject(type, inflated.buffer);
    objects.set(oid, { type, data: inflated.buffer });
  }
  if (off !== trailerAt) throw new Error('pack has trailing bytes');
  return { version, count, objects };
}

// ---------------------------------------------------------------------------
// reachability
// ---------------------------------------------------------------------------

export type ObjectStore = Map<string, GitObject>;

/**
 * Every object reachable from `roots`. With a depth limit, commits are only
 * followed `depth` generations down from a root (roots are depth 1); their
 * trees and blobs are always included whole. Returns the object ids and, for
 * the depth-limited case, the shallow boundary commits (included commits whose
 * parents were not all included).
 */
export function reachable(
  store: ObjectStore,
  roots: Iterable<string>,
  depth?: number,
): { ids: Set<string>; shallow: Set<string> } {
  const ids = new Set<string>();
  const shallow = new Set<string>();
  // Breadth-first by depth: a node is always first reached at its smallest
  // depth, so a depth-limited walk never starves a parent it should include.
  const seenDepth = new Map<string, number>();
  const queue: Array<{ oid: string; d: number }> = [];
  for (const root of roots) {
    if (isOid(root) && store.has(root) && !seenDepth.has(root)) {
      seenDepth.set(root, 1);
      queue.push({ oid: root, d: 1 });
    }
  }
  let head = 0;
  while (head < queue.length) {
    const { oid, d } = queue[head++]!;
    if (ids.has(oid)) continue;
    const obj = store.get(oid);
    if (!obj) continue;
    ids.add(oid);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      const follow = depth === undefined || d < depth;
      if (!follow && commit.parents.length > 0) shallow.add(oid);
      queue.push({ oid: commit.tree, d });
      if (follow) {
        for (const p of commit.parents) {
          if (!seenDepth.has(p)) {
            seenDepth.set(p, d + 1);
            queue.push({ oid: p, d: d + 1 });
          }
        }
      }
    } else if (obj.type === 'tag') {
      const tag = parseTag(obj.data);
      if (!seenDepth.has(tag.object)) {
        seenDepth.set(tag.object, d);
        queue.push({ oid: tag.object, d });
      }
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) {
        if (e.mode === '160000') continue;
        if (!seenDepth.has(e.oid)) {
          seenDepth.set(e.oid, d);
          queue.push({ oid: e.oid, d });
        }
      }
    }
  }
  return { ids, shallow };
}

/** True when `ancestor` is reachable from `tip` (or equal to it). */
export function isAncestor(store: ObjectStore, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = store.get(oid);
    if (!obj) continue;
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      if (commit.parents.includes(ancestor)) return true;
      for (const p of commit.parents) queue.push(p);
    } else if (obj.type === 'tag') {
      queue.push(parseTag(obj.data).object);
    }
  }
  return false;
}

/** The merge-base of two commits: the first common ancestor found walking from `a`. */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  if (a === b) return a;
  const bAncestors = new Set<string>();
  const bQueue = [b];
  while (bQueue.length > 0) {
    const oid = bQueue.pop()!;
    if (bAncestors.has(oid)) continue;
    bAncestors.add(oid);
    const obj = store.get(oid);
    if (obj?.type === 'commit') for (const p of parseCommit(obj.data).parents) bQueue.push(p);
    else if (obj?.type === 'tag') bQueue.push(parseTag(obj.data).object);
  }
  const aQueue = [a];
  const aSeen = new Set<string>();
  while (aQueue.length > 0) {
    const oid = aQueue.shift()!;
    if (aSeen.has(oid)) continue;
    aSeen.add(oid);
    if (bAncestors.has(oid)) return oid;
    const obj = store.get(oid);
    if (obj?.type === 'commit') for (const p of parseCommit(obj.data).parents) aQueue.push(p);
    else if (obj?.type === 'tag') aQueue.push(parseTag(obj.data).object);
  }
  return null;
}
