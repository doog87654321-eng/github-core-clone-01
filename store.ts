// store.ts — the forge's whole state, in memory. One Store holds every
// repository, its git objects and refs, and its issues, pull requests, labels
// and comments. Nothing here touches the disk or the network.
//
// Determinism: server-made commits carry one fixed timestamp and the token
// owner's identity, and every created_at/updated_at comes from one
// monotonically increasing logical clock, so a replay of the same requests
// produces the same bytes.

import {
  buildCommit,
  buildTree,
  hashObject,
  isOid,
  mergeBase,
  parseCommit,
  parseTree,
  reachable,
  type GitObject,
  type ObjType,
} from './gitobj.ts';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';

/** The identity every commit the server itself writes carries. */
export const SERVER_IDENTITY = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
/** Fixed commit timestamp: 2025-01-01T00:00:00Z, so commit ids are stable. */
export const COMMIT_TIMESTAMP = 1735689600;

export function identityLine(): string {
  return `${SERVER_IDENTITY} ${COMMIT_TIMESTAMP} +0000`;
}

/** A base64 global id that never reads as a plain database id or number. */
export function globalId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from([kind, ...parts].join(':'), 'utf8').toString('base64');
}

export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (!kind || parts.length === 0) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

export interface Label {
  name: string;
  color: string;
}

export interface IssueComment {
  id: number;
  body: string;
  createdAt: string;
  createdSeq: number;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: IssueComment[];
  createdAt: string;
  updatedAt: string;
  createdSeq: number;
  /** Cached serialized issue JSON and the key it was built from. */
  jsonCache?: string;
  jsonCacheKey?: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  createdAt: string;
  updatedAt: string;
  createdSeq: number;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  fullName: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  createdSeq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  nextNumber: number;
  nextCommentId: number;
  /** Bumped on any git mutation; git response caches are cleared on bump. */
  version: number;
  /** Cached git responses (fetch packs, ls-refs, advertisements). */
  gitCache: Map<string, Buffer>;
  /** Bumped when a label is created; issue JSON caches key off it. */
  labelVersion: number;
}

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'removed';
  oldOid: string | null;
  newOid: string | null;
  additions: number;
  deletions: number;
}

export class Store {
  repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private seq = 0;

  /** The next logical timestamp, strictly increasing, one second apart. */
  nowIso(): string {
    this.seq += 1;
    return new Date((COMMIT_TIMESTAMP + this.seq) * 1000).toISOString();
  }

  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo | null {
    const key = this.key(VIEWER_LOGIN, name);
    if (this.repos.has(key)) return null;
    const now = this.nowIso();
    const repo: Repo = {
      id: this.nextRepoId++,
      owner: VIEWER_LOGIN,
      name,
      fullName: key,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      createdAt: now,
      updatedAt: now,
      createdSeq: this.seq,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      nextCommentId: 1,
      version: 0,
      gitCache: new Map(),
      labelVersion: 0,
    };
    this.repos.set(key, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  viewerRepos(): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === VIEWER_LOGIN) out.push(repo);
    out.sort((a, b) => a.createdSeq - b.createdSeq);
    return out;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(this.key(repo.owner, repo.name));
  }

  // ---------------------------------------------------------------- git objects

  putObject(repo: Repo, type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  refTip(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  defaultTip(repo: Repo): string | undefined {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  }

  /** Resolve a branch name, a full ref or a commit id to a commit id. */
  resolveCommit(repo: Repo, ref: string): string | undefined {
    if (isOid(ref)) return repo.objects.has(ref) ? ref : undefined;
    const direct = repo.refs.get(ref);
    if (direct) return direct;
    const branch = repo.refs.get(`refs/heads/${ref}`);
    if (branch) return branch;
    return undefined;
  }

  /** Mark a repository's git state changed: drop its cached git responses. */
  bumpGit(repo: Repo): void {
    repo.version += 1;
    repo.gitCache.clear();
  }

  /** Write a commit object and point `ref` at it. */
  writeCommit(
    repo: Repo,
    ref: string,
    tree: string,
    parents: string[],
    message: string,
  ): string {
    const who = identityLine();
    const data = buildCommit({ tree, parents, author: who, committer: who, message });
    const oid = this.putObject(repo, 'commit', data);
    repo.refs.set(ref, oid);
    this.bumpGit(repo);
    return oid;
  }

  /** Commits reachable from a tip, newest first (parents in order). */
  walkCommits(repo: Repo, tip: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const stack = [tip];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      out.push(oid);
      const parents = parseCommit(obj.data).parents;
      for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i]!);
    }
    return out;
  }

  // ---------------------------------------------------------------- trees

  /** The entry at `path` in the tree rooted at `rootOid`, or null. */
  treeEntry(repo: Repo, rootOid: string | null, path: string): { type: ObjType; oid: string } | null {
    if (!rootOid) return null;
    const segments = path.split('/').filter((s) => s !== '');
    let oid = rootOid;
    for (let i = 0; i < segments.length; i += 1) {
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'tree') return null;
      const entry = parseTree(obj.data).find((e) => e.name === segments[i]);
      if (!entry) return null;
      if (i === segments.length - 1) {
        const target = repo.objects.get(entry.oid);
        return target ? { type: target.type, oid: entry.oid } : null;
      }
      oid = entry.oid;
    }
    return null;
  }

  /** Immediate children of the directory at `dirPath` ('.' for the root). */
  listDir(
    repo: Repo,
    rootOid: string | null,
    dirPath: string,
  ): Array<{ type: 'file' | 'dir'; name: string; path: string; sha: string }> {
    if (!rootOid) return [];
    let oid = rootOid;
    const clean = dirPath === '' || dirPath === '.' ? '' : dirPath;
    if (clean !== '') {
      const found = this.treeEntry(repo, rootOid, clean);
      if (!found || found.type !== 'tree') return [];
      oid = found.oid;
    }
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'tree') return [];
    return parseTree(obj.data).map((e) => ({
      type: (e.mode === '40000' ? 'dir' : 'file') as 'file' | 'dir',
      name: e.name,
      path: clean === '' ? e.name : `${clean}/${e.name}`,
      sha: e.oid,
    }));
  }

  /**
   * A new root tree with `path` set to `blobOid` (or removed when null).
   * Intermediate trees are created as needed; emptied ones are dropped.
   */
  updateTreePath(repo: Repo, rootOid: string | null, path: string, blobOid: string | null): string {
    const segments = path.split('/').filter((s) => s !== '');
    const build = (oid: string | null, depth: number): string | null => {
      const entries = new Map<string, { mode: string; oid: string }>();
      if (oid) {
        const obj = repo.objects.get(oid);
        if (obj?.type === 'tree') {
          for (const e of parseTree(obj.data)) entries.set(e.name, { mode: e.mode, oid: e.oid });
        }
      }
      const name = segments[depth]!;
      if (depth === segments.length - 1) {
        if (blobOid === null) entries.delete(name);
        else entries.set(name, { mode: '100644', oid: blobOid });
      } else {
        const child = build(entries.get(name)?.oid ?? null, depth + 1);
        if (child === null) entries.delete(name);
        else entries.set(name, { mode: '40000', oid: child });
      }
      if (entries.size === 0) return null;
      const data = buildTree([...entries].map(([n, v]) => ({ mode: v.mode, name: n, oid: v.oid })));
      return this.putObject(repo, 'tree', data);
    };
    return build(rootOid, 0) ?? this.putObject(repo, 'tree', buildTree([]));
  }

  /** Flatten a tree into path -> blob oid, recursively. */
  flattenTree(repo: Repo, rootOid: string | null, prefix = ''): Map<string, string> {
    const out = new Map<string, string>();
    if (!rootOid) return out;
    const obj = repo.objects.get(rootOid);
    if (!obj || obj.type !== 'tree') return out;
    for (const e of parseTree(obj.data)) {
      const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
      if (e.mode === '40000') {
        for (const [p, o] of this.flattenTree(repo, e.oid, path)) out.set(p, o);
      } else if (e.mode !== '160000') {
        out.set(path, e.oid);
      }
    }
    return out;
  }

  /** The diff between two root trees, as file changes with line counts. */
  diffTrees(repo: Repo, baseRoot: string | null, headRoot: string | null): FileChange[] {
    const base = this.flattenTree(repo, baseRoot);
    const head = this.flattenTree(repo, headRoot);
    const changes: FileChange[] = [];
    const paths = new Set([...base.keys(), ...head.keys()]);
    for (const path of [...paths].sort()) {
      const oldOid = base.get(path) ?? null;
      const newOid = head.get(path) ?? null;
      if (oldOid === newOid) continue;
      const oldText = oldOid ? this.blobText(repo, oldOid) : '';
      const newText = newOid ? this.blobText(repo, newOid) : '';
      const { additions, deletions } = lineDiff(oldText, newText);
      changes.push({
        path,
        status: oldOid === null ? 'added' : newOid === null ? 'removed' : 'modified',
        oldOid,
        newOid,
        additions,
        deletions,
      });
    }
    return changes;
  }

  blobText(repo: Repo, oid: string): string {
    const obj = repo.objects.get(oid);
    return obj?.type === 'blob' ? obj.data.toString('utf8') : '';
  }

  /** Three-way merge of file trees. Returns the merged root tree and conflicting paths. */
  threeWayMerge(
    repo: Repo,
    mergeBaseOid: string | null,
    headOid: string,
    baseOid: string,
  ): { tree: string; conflicts: string[] } {
    const baseTree = mergeBaseOid ? this.commitTree(repo, mergeBaseOid) : null;
    const headTree = this.commitTree(repo, headOid);
    const baseTipTree = this.commitTree(repo, baseOid);
    const ancestor = this.flattenTree(repo, baseTree);
    const head = this.flattenTree(repo, headTree);
    const tip = this.flattenTree(repo, baseTipTree);
    const conflicts: string[] = [];
    const merged = new Map<string, string>();
    const paths = new Set([...ancestor.keys(), ...head.keys(), ...tip.keys()]);
    for (const path of paths) {
      const a = ancestor.get(path) ?? null;
      const h = head.get(path) ?? null;
      const t = tip.get(path) ?? null;
      if (h === t) {
        if (h !== null) merged.set(path, h);
      } else if (a === h) {
        if (t !== null) merged.set(path, t);
      } else if (a === t) {
        if (h !== null) merged.set(path, h);
      } else {
        conflicts.push(path);
      }
    }
    let root: string | null = null;
    for (const path of [...merged.keys()].sort()) {
      root = this.updateTreePath(repo, root, path, merged.get(path)!);
    }
    return { tree: root ?? this.putObject(repo, 'tree', buildTree([])), conflicts };
  }

  commitTree(repo: Repo, commitOid: string): string | null {
    const obj = repo.objects.get(commitOid);
    if (!obj || obj.type !== 'commit') return null;
    return parseCommit(obj.data).tree;
  }

  /** Whether `headOid` merges cleanly onto `baseOid`. */
  mergeable(repo: Repo, headOid: string, baseOid: string): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    const base = mergeBase(repo.objects, headOid, baseOid);
    if (base === null && headOid !== baseOid) {
      // No common ancestor: only a fast-forward onto an empty base is clean.
      const baseObj = repo.objects.get(baseOid);
      if (!baseObj) return 'UNKNOWN';
      return 'UNKNOWN';
    }
    const { conflicts } = this.threeWayMerge(repo, base, headOid, baseOid);
    return conflicts.length === 0 ? 'MERGEABLE' : 'CONFLICTING';
  }

  // ---------------------------------------------------------------- issues / pulls

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const number = repo.nextNumber++;
    const seq = this.nextSeq();
    const now = new Date((COMMIT_TIMESTAMP + seq) * 1000).toISOString();
    const issue: Issue = {
      id: repo.id * 100000 + number,
      number,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      createdAt: now,
      updatedAt: now,
      createdSeq: seq,
    };
    repo.issues.set(number, issue);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, head: string, base: string, headSha: string, baseSha: string): Pull {
    const number = repo.nextNumber++;
    const seq = this.nextSeq();
    const now = new Date((COMMIT_TIMESTAMP + seq) * 1000).toISOString();
    const pull: Pull = {
      id: repo.id * 100000 + number,
      number,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      head,
      base,
      headSha,
      baseSha,
      createdAt: now,
      updatedAt: now,
      createdSeq: seq,
    };
    repo.pulls.set(number, pull);
    return pull;
  }

  /** Squash-merge a pull request onto its base branch. Null when it conflicts. */
  squashMerge(repo: Repo, pull: Pull): string | null {
    const headTip = repo.refs.get(`refs/heads/${pull.head}`);
    const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
    if (!headTip || !baseTip) return null;
    const base = mergeBase(repo.objects, headTip, baseTip);
    const { tree, conflicts } = this.threeWayMerge(repo, base, headTip, baseTip);
    if (conflicts.length > 0) return null;
    const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.head}\n\n${pull.title}\n`;
    const sha = this.writeCommit(repo, `refs/heads/${pull.base}`, tree, [baseTip], message);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = this.nowIso();
    pull.mergeCommitSha = sha;
    pull.updatedAt = pull.mergedAt;
    return sha;
  }

  /** All objects reachable from a set of tips (used by fetch). */
  fetchObjects(
    repo: Repo,
    wants: string[],
    haves: string[],
    depth?: number,
    shallowBoundaries: string[] = [],
  ): { objects: GitObject[]; shallow: string[]; unshallow: string[] } {
    // What the client already holds. A shallow boundary counts as held
    // itself, but its ancestors do not: the client has the boundary commit
    // object only, so its parents must still be sent on a deepen.
    const fullHaves = haves.filter((h) => !shallowBoundaries.includes(h));
    const haveReach = reachable(repo.objects, fullHaves).ids;
    for (const boundary of shallowBoundaries) {
      if (haves.includes(boundary)) haveReach.add(boundary);
    }
    const { ids, shallow } = reachable(repo.objects, wants, depth);
    const send = new Set<string>();
    for (const oid of ids) if (!haveReach.has(oid)) send.add(oid);
    const objects: GitObject[] = [];
    for (const oid of [...send].sort()) {
      const obj = repo.objects.get(oid);
      if (obj) objects.push(obj);
    }
    const unshallow: string[] = [];
    if (depth !== undefined) {
      // A previous shallow boundary stops being shallow when every parent is
      // now complete: sent in this fetch, or already held as a full commit.
      const heldFull = new Set(haves.filter((h) => !shallowBoundaries.includes(h)));
      for (const boundary of shallowBoundaries) {
        const obj = repo.objects.get(boundary);
        if (obj?.type !== 'commit') continue;
        const parents = parseCommit(obj.data).parents;
        if (parents.every((p) => send.has(p) || heldFull.has(p))) unshallow.push(boundary);
      }
    }
    return { objects, shallow: [...shallow].sort(), unshallow: unshallow.sort() };
  }
}

// ---------------------------------------------------------------------------
// line diff (LCS over lines; contents here are small)
// ---------------------------------------------------------------------------

export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);
  const lcs = lcsLength(oldLines, newLines);
  return { additions: newLines.length - lcs, deletions: oldLines.length - lcs };
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function lcsLength(a: string[], b: string[]): number {
  // One-row DP; the shorter side drives the width.
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  const row = new Array<number>(short.length + 1).fill(0);
  for (let i = 0; i < long.length; i += 1) {
    let prev = 0;
    for (let j = 0; j < short.length; j += 1) {
      const temp = row[j + 1]!;
      if (long[i] === short[j]) row[j + 1] = prev + 1;
      else row[j + 1] = Math.max(row[j + 1]!, row[j]!);
      prev = temp;
    }
  }
  return row[short.length]!;
}
