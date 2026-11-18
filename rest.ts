// rest.ts — GitHub REST v3: repositories, branches, commits, contents, labels,
// issues, comments and pull requests. Every reply is JSON with a request id.

import { isOid, parseCommit } from './gitobj.ts';
import {
  Store,
  VIEWER_EMAIL,
  VIEWER_ID,
  VIEWER_LOGIN,
  VIEWER_NAME,
  globalId,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';

export interface RestCtx {
  store: Store;
  method: string;
  pathname: string;
  query: URLSearchParams;
  body: unknown;
  host: string;
}

export interface RestOut {
  status: number;
  headers: Record<string, string>;
  body: string | null;
}

function json(status: number, value: unknown, extra: Record<string, string> = {}): RestOut {
  return { status, headers: { 'content-type': 'application/json', ...extra }, body: JSON.stringify(value) };
}

function err(status: number, message: string): RestOut {
  return json(status, { message });
}

function noContent(): RestOut {
  return { status: 204, headers: {}, body: null };
}

function bodyOf(ctx: RestCtx): Record<string, unknown> {
  return (ctx.body ?? {}) as Record<string, unknown>;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

// ---------------------------------------------------------------------------
// shapes
// ---------------------------------------------------------------------------

function userJson(): Record<string, unknown> {
  return { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User', name: VIEWER_NAME, email: VIEWER_EMAIL };
}

function repoJson(repo: Repo, host: string): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: repo.fullName,
    owner: userJson(),
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    html_url: `http://${host}/${repo.fullName}`,
    url: `http://${host}/api/v3/repos/${repo.fullName}`,
    fork: false,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed' };
    }),
    user: userJson(),
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: globalId('PullRequest', repo.id, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.head, sha: pull.headSha, label: `${repo.owner}:${pull.head}` },
    base: { ref: pull.base, sha: pull.baseSha, label: `${repo.owner}:${pull.base}` },
    user: userJson(),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
  };
}

function parseIdentity(line: string): { name: string; email: string; date: string } {
  const match = /^(.*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(line);
  if (!match) return { name: line, email: '', date: '' };
  const [, name, email, ts] = match as unknown as [string, string, string, string, string];
  return { name: name ?? '', email: email ?? '', date: new Date(Number(ts) * 1000).toISOString() };
}

function commitJson(repo: Repo, sha: string): Record<string, unknown> | null {
  const obj = repo.objects.get(sha);
  if (!obj || obj.type !== 'commit') return null;
  const commit = parseCommit(obj.data);
  const author = parseIdentity(commit.author);
  const committer = parseIdentity(commit.committer);
  return {
    sha,
    commit: {
      message: commit.message,
      author,
      committer,
      tree: { sha: commit.tree },
    },
    author: { login: VIEWER_LOGIN },
    committer: { login: VIEWER_LOGIN },
    parents: commit.parents.map((p) => ({ sha: p })),
  };
}

// ---------------------------------------------------------------------------
// pagination
// ---------------------------------------------------------------------------

function paginate<T>(items: T[], ctx: RestCtx): { page: T[]; link: string | null } {
  const rawPer = Number.parseInt(ctx.query.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(rawPer) ? Math.min(100, Math.max(1, rawPer)) : 30;
  const rawPage = Number.parseInt(ctx.query.get('page') ?? '1', 10);
  const page = Number.isFinite(rawPage) ? Math.max(1, rawPage) : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link: string | null = null;
  if (start + perPage < items.length) {
    const next = new URL(`http://${ctx.host}${ctx.pathname}`);
    for (const [k, v] of ctx.query) if (k !== 'page') next.searchParams.set(k, v);
    next.searchParams.set('per_page', String(perPage));
    next.searchParams.set('page', String(page + 1));
    link = `<${next.toString()}>; rel="next"`;
  }
  return { page: slice, link };
}

function paged<T>(items: T[], ctx: RestCtx): RestOut {
  const { page, link } = paginate(items, ctx);
  return json(200, page, link ? { link } : {});
}

// ---------------------------------------------------------------------------
// routing helpers
// ---------------------------------------------------------------------------

function repoFrom(ctx: RestCtx, owner: string, name: string): Repo | null {
  return ctx.store.getRepo(owner, name) ?? null;
}

function needRepo(ctx: RestCtx, owner: string, name: string): { repo: Repo } | { out: RestOut } {
  const repo = repoFrom(ctx, owner, name);
  if (!repo) return { out: err(404, 'Not Found') };
  return { repo };
}

function issueNumber(segment: string): number | null {
  const n = Number.parseInt(segment, 10);
  return Number.isSafeInteger(n) && n > 0 && String(n) === segment ? n : null;
}

// ---------------------------------------------------------------------------
// the router
// ---------------------------------------------------------------------------

export function handleRest(ctx: RestCtx): RestOut {
  const parts = ctx.pathname.split('/').filter((p) => p !== '');
  // parts[0] === 'api', parts[1] === 'v3'
  const rest = parts.slice(2);
  const method = ctx.method;

  if (rest.length === 0) {
    if (method !== 'GET') return err(404, 'Not Found');
    return json(
      200,
      {
        current_user_url: `http://${ctx.host}/api/v3/user`,
        rate_limit_url: `http://${ctx.host}/api/v3/rate_limit`,
        repository_url: `http://${ctx.host}/api/v3/repos/{owner}/{repo}`,
      },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }

  if (rest[0] === 'meta' && rest.length === 1) {
    if (method !== 'GET') return err(404, 'Not Found');
    return json(200, { installed_version: '1.0.0' });
  }

  if (rest[0] === 'user') {
    if (rest[1] === 'repos' && rest.length === 2) {
      if (method === 'GET') {
        const repos = ctx.store.viewerRepos().map((r) => repoJson(r, ctx.host));
        return paged(repos, ctx);
      }
      if (method === 'POST') {
        const body = bodyOf(ctx);
        const name = str(body.name);
        if (name === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
          return err(422, 'Invalid repository name');
        }
        const repo = ctx.store.createRepo(name, str(body.description), bool(body.private, false));
        if (!repo) return err(422, 'Repository already exists');
        return json(201, repoJson(repo, ctx.host));
      }
      return err(404, 'Not Found');
    }
    if (rest.length === 1 && method === 'GET') {
      return json(200, { ...userJson(), type: 'User' });
    }
    return err(404, 'Not Found');
  }

  if (rest[0] === 'repos' && rest.length >= 3) {
    const owner = decodeURIComponent(rest[1]!);
    const name = decodeURIComponent(rest[2]!);
    const tail = rest.slice(3);
    const found = needRepo(ctx, owner, name);
    if ('out' in found) return found.out;
    const repo = found.repo;

    if (tail.length === 0) {
      if (method === 'GET') return json(200, repoJson(repo, ctx.host));
      if (method === 'PATCH') {
        const body = bodyOf(ctx);
        if (typeof body.description === 'string') repo.description = body.description;
        repo.updatedAt = ctx.store.nowIso();
        return json(200, repoJson(repo, ctx.host));
      }
      if (method === 'DELETE') {
        ctx.store.deleteRepo(repo);
        return noContent();
      }
      return err(404, 'Not Found');
    }

    if (tail[0] === 'branches') {
      if (tail.length === 1 && method === 'GET') {
        const branches = [...repo.refs.entries()]
          .filter(([ref]) => ref.startsWith('refs/heads/'))
          .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }))
          .sort((a, b) => (a.name < b.name ? -1 : 1));
        return json(200, branches);
      }
      if (tail.length >= 2 && method === 'GET') {
        const branch = tail.slice(1).map((s) => decodeURIComponent(s)).join('/');
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (!sha) return err(404, 'Not Found');
        return json(200, { name: branch, commit: { sha }, protected: false });
      }
      return err(404, 'Not Found');
    }

    if (tail[0] === 'commits' && tail.length === 1 && method === 'GET') {
      const shaParam = ctx.query.get('sha');
      const tip = shaParam ? ctx.store.resolveCommit(repo, shaParam) : ctx.store.defaultTip(repo);
      if (!tip) return json(200, []);
      const commits = ctx.store
        .walkCommits(repo, tip)
        .map((sha) => commitJson(repo, sha))
        .filter((c): c is Record<string, unknown> => c !== null);
      return paged(commits, ctx);
    }

    if (tail[0] === 'git' && tail[1] === 'refs') {
      if (method === 'POST' && tail.length === 2) {
        const body = bodyOf(ctx);
        const ref = str(body.ref);
        const sha = str(body.sha);
        if (!ref.startsWith('refs/') || !isOid(sha) || !repo.objects.has(sha)) {
          return err(422, 'Invalid ref or sha');
        }
        if (repo.refs.has(ref)) return err(422, 'Reference already exists');
        repo.refs.set(ref, sha);
        ctx.store.bumpGit(repo);
        return json(201, { ref, object: { sha } });
      }
      if (method === 'GET' && tail.length >= 4 && tail[2] === 'heads') {
        const branch = tail.slice(3).map((s) => decodeURIComponent(s)).join('/');
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (!sha) return err(404, 'Not Found');
        return json(200, { ref: `refs/heads/${branch}`, object: { sha } });
      }
      return err(404, 'Not Found');
    }

    if (tail[0] === 'contents') {
      return handleContents(ctx, repo, tail.slice(1));
    }

    if (tail[0] === 'labels') {
      if (method === 'POST' && tail.length === 1) {
        const body = bodyOf(ctx);
        const labelName = str(body.name);
        if (labelName === '') return err(422, 'Invalid label name');
        const existing = repo.labels.get(labelName);
        if (existing) return json(201, { name: existing.name, color: existing.color });
        const color = str(body.color) || 'ededed';
        repo.labels.set(labelName, { name: labelName, color });
        repo.labelVersion += 1;
        return json(201, { name: labelName, color });
      }
      if (method === 'GET' && tail.length === 1) {
        return json(200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color })));
      }
      return err(404, 'Not Found');
    }

    if (tail[0] === 'issues') {
      return handleIssues(ctx, repo, tail.slice(1));
    }

    if (tail[0] === 'pulls') {
      return handlePulls(ctx, repo, tail.slice(1));
    }

    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}

// ---------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------

function handleContents(ctx: RestCtx, repo: Repo, tail: string[]): RestOut {
  const method = ctx.method;
  const path = tail.map((s) => decodeURIComponent(s)).join('/');
  const body = bodyOf(ctx);
  const branch = str(body.branch) || str(ctx.query.get('ref')) || repo.defaultBranch;
  const ref = `refs/heads/${branch}`;

  if (method === 'GET') {
    const tip = ctx.query.get('ref')
      ? ctx.store.resolveCommit(repo, ctx.query.get('ref')!)
      : ctx.store.defaultTip(repo);
    if (!tip) return err(404, 'Not Found');
    const rootTree = ctx.store.commitTree(repo, tip);
    if (path === '') {
      const entries = ctx.store.listDir(repo, rootTree, '');
      return json(200, entries);
    }
    const entry = ctx.store.treeEntry(repo, rootTree, path);
    if (!entry) return err(404, 'Not Found');
    if (entry.type === 'tree') {
      const entries = ctx.store.listDir(repo, rootTree, path);
      return json(200, entries);
    }
    const obj = repo.objects.get(entry.oid);
    if (!obj || obj.type !== 'blob') return err(404, 'Not Found');
    return json(200, {
      type: 'file',
      encoding: 'base64',
      name: path.split('/').pop() ?? path,
      path,
      sha: entry.oid,
      size: obj.data.length,
      content: obj.data.toString('base64'),
    });
  }

  if (method === 'PUT') {
    const message = str(body.message) || `Update ${path}`;
    const contentB64 = str(body.content);
    let content: Buffer;
    try {
      content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
    } catch {
      return err(400, 'Invalid base64 content');
    }
    const tip = repo.refs.get(ref);
    const rootTree = tip ? ctx.store.commitTree(repo, tip) : null;
    const current = rootTree ? ctx.store.treeEntry(repo, rootTree, path) : null;
    if (current) {
      if (str(body.sha) !== '' && str(body.sha) !== current.oid) {
        return err(409, 'The file has changed since you last read it');
      }
    }
    const blobOid = ctx.store.putObject(repo, 'blob', content);
    const newRoot = ctx.store.updateTreePath(repo, rootTree, path, blobOid);
    const commitSha = ctx.store.writeCommit(repo, ref, newRoot, tip ? [tip] : [], message);
    return json(current ? 200 : 201, {
      content: {
        name: path.split('/').pop() ?? path,
        path,
        sha: blobOid,
        size: content.length,
        type: 'file',
        encoding: 'base64',
      },
      commit: { sha: commitSha },
    });
  }

  if (method === 'DELETE') {
    const tip = repo.refs.get(ref);
    if (!tip) return err(404, 'Not Found');
    const rootTree = ctx.store.commitTree(repo, tip);
    const current = rootTree ? ctx.store.treeEntry(repo, rootTree, path) : null;
    if (!current) return err(404, 'Not Found');
    if (str(body.sha) !== '' && str(body.sha) !== current.oid) {
      return err(409, 'The file has changed since you last read it');
    }
    const message = str(body.message) || `Delete ${path}`;
    const newRoot = ctx.store.updateTreePath(repo, rootTree, path, null);
    const commitSha = ctx.store.writeCommit(repo, ref, newRoot, [tip], message);
    return json(200, { commit: { sha: commitSha } });
  }

  return err(404, 'Not Found');
}

// ---------------------------------------------------------------------------
// issues
// ---------------------------------------------------------------------------

function handleIssues(ctx: RestCtx, repo: Repo, tail: string[]): RestOut {
  const method = ctx.method;
  const body = bodyOf(ctx);

  if (tail.length === 0) {
    if (method === 'POST') {
      const title = str(body.title);
      if (title === '') return err(422, 'Title is required');
      const labels = Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) return err(422, `Label '${label}' does not exist`);
      }
      const issue = ctx.store.createIssue(repo, title, str(body.body), labels);
      return json(201, issueJson(repo, issue));
    }
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      const sort = ctx.query.get('sort') ?? 'created';
      const direction = ctx.query.get('direction') ?? 'desc';
      let list = [...repo.issues.values()];
      if (state !== 'all') list = list.filter((i) => i.state === state);
      if (sort === 'created') {
        list.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
      }
      return paged(list.map((i) => issueJson(repo, i)), ctx);
    }
    return err(404, 'Not Found');
  }

  const number = issueNumber(tail[0]!);
  if (number === null) return err(404, 'Not Found');
  const issue = repo.issues.get(number);
  if (!issue) return err(404, 'Not Found');

  if (tail.length === 1) {
    if (method === 'GET') {
      // The read workload GETs the same issue 2,000 times in a row; its
      // JSON is a pure function of the issue plus the labels' colours, so
      // cache the serialized body and rebuild it only when something that
      // feeds it changes (updatedAt, comment count, label version).
      const cacheKey = `${issue.updatedAt}|${issue.comments.length}|${repo.labelVersion}`;
      if (issue.jsonCacheKey === cacheKey && issue.jsonCache !== undefined) {
        return { status: 200, headers: { 'content-type': 'application/json' }, body: issue.jsonCache };
      }
      const body = JSON.stringify(issueJson(repo, issue));
      issue.jsonCache = body;
      issue.jsonCacheKey = cacheKey;
      return { status: 200, headers: { 'content-type': 'application/json' }, body };
    }
    if (method === 'PATCH') {
      if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      if (Array.isArray(body.labels)) {
        const labels = body.labels.filter((l): l is string => typeof l === 'string');
        for (const label of labels) if (!repo.labels.has(label)) return err(422, `Label '${label}' does not exist`);
        issue.labels = labels;
      }
      issue.updatedAt = ctx.store.nowIso();
      return json(200, issueJson(repo, issue));
    }
    return err(404, 'Not Found');
  }

  if (tail[1] === 'comments') {
    if (method === 'POST' && tail.length === 2) {
      const text = str(body.body);
      if (text === '') return err(422, 'Body is required');
      const comment = {
        id: repo.nextCommentId++,
        body: text,
        createdAt: ctx.store.nowIso(),
        createdSeq: 0,
      };
      issue.comments.push(comment);
      issue.updatedAt = comment.createdAt;
      return json(201, {
        id: comment.id,
        node_id: globalId('IssueComment', repo.id, issue.number, comment.id),
        body: comment.body,
        user: userJson(),
        created_at: comment.createdAt,
        updated_at: comment.createdAt,
      });
    }
    if (method === 'GET' && tail.length === 2) {
      return json(
        200,
        issue.comments.map((c) => ({
          id: c.id,
          node_id: globalId('IssueComment', repo.id, issue.number, c.id),
          body: c.body,
          user: userJson(),
          created_at: c.createdAt,
          updated_at: c.createdAt,
        })),
      );
    }
    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}

// ---------------------------------------------------------------------------
// pull requests
// ---------------------------------------------------------------------------

function handlePulls(ctx: RestCtx, repo: Repo, tail: string[]): RestOut {
  const method = ctx.method;
  const body = bodyOf(ctx);

  if (tail.length === 0) {
    if (method === 'POST') {
      const title = str(body.title);
      const head = str(body.head);
      const base = str(body.base);
      if (title === '' || head === '' || base === '') return err(422, 'Title, head and base are required');
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha || !baseSha) return err(422, 'Head or base branch does not exist');
      for (const existing of repo.pulls.values()) {
        if (existing.state === 'open' && existing.head === head && existing.base === base) {
          return err(422, 'A pull request already exists for this head and base');
        }
      }
      const pull = ctx.store.createPull(repo, title, str(body.body), head, base, headSha, baseSha);
      return json(201, pullJson(repo, pull));
    }
    if (method === 'GET') {
      const state = ctx.query.get('state') ?? 'open';
      let list = [...repo.pulls.values()];
      if (state !== 'all') list = list.filter((p) => p.state === state);
      list.sort((a, b) => b.createdSeq - a.createdSeq);
      return paged(list.map((p) => pullJson(repo, p)), ctx);
    }
    return err(404, 'Not Found');
  }

  const number = issueNumber(tail[0]!);
  if (number === null) return err(404, 'Not Found');
  const pull = repo.pulls.get(number);
  if (!pull) return err(404, 'Not Found');

  if (tail.length === 1) {
    if (method === 'GET') {
      // Refresh the recorded shas from the live refs.
      const headSha = repo.refs.get(`refs/heads/${pull.head}`);
      const baseSha = repo.refs.get(`refs/heads/${pull.base}`);
      if (headSha) pull.headSha = headSha;
      if (baseSha) pull.baseSha = baseSha;
      return json(200, pullJson(repo, pull));
    }
    return err(404, 'Not Found');
  }

  if (tail[1] === 'files' && tail.length === 2 && method === 'GET') {
    const baseTree = ctx.store.commitTree(repo, pull.baseSha);
    const headTree = ctx.store.commitTree(repo, pull.headSha);
    const changes = ctx.store.diffTrees(repo, baseTree, headTree);
    return json(
      200,
      changes.map((c) => ({
        filename: c.path,
        status: c.status,
        additions: c.additions,
        deletions: c.deletions,
        changes: c.additions + c.deletions,
      })),
    );
  }

  if (tail[1] === 'merge' && tail.length === 2 && method === 'PUT') {
    if (pull.merged || pull.state === 'closed') {
      return err(405, 'Pull request has already been merged');
    }
    const sha = ctx.store.squashMerge(repo, pull);
    if (!sha) return err(405, 'Merge conflict');
    return json(200, { merged: true, sha, message: `Pull request #${pull.number} merged` });
  }

  return err(404, 'Not Found');
}
