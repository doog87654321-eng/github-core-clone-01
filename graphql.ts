// graphql.ts — GitHub GraphQL v4 for the documents gh and github-mcp-server
// send: a small lexer/parser for the query language plus resolvers over the
// same store REST uses. No GraphQL library; the schema surface is the one the
// suite's checks exercise.

import { Store, VIEWER_LOGIN, decodeGlobalId, globalId, type Issue, type Pull, type Repo } from './store.ts';

// ---------------------------------------------------------------------------
// lexer
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string };

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (c: string): boolean => /[_A-Za-z]/.test(c);
  const isNameChar = (c: string): boolean => /[_0-9A-Za-z]/.test(c);
  while (i < input.length) {
    const c = input[i]!;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@'.includes(c)) {
      tokens.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1]!;
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else if (esc === 'u' && j + 5 < input.length) {
            out += String.fromCharCode(Number.parseInt(input.slice(j + 2, j + 6), 16));
            j += 4;
          } else out += esc;
          j += 2;
        } else {
          out += input[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j]!)) j += 1;
      let isFloat = false;
      if (input[j] === '.' && /[0-9]/.test(input[j + 1] ?? '')) {
        isFloat = true;
        j += 1;
        while (j < input.length && /[0-9]/.test(input[j]!)) j += 1;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        isFloat = true;
        j += 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        while (j < input.length && /[0-9]/.test(input[j]!)) j += 1;
      }
      const text = input.slice(i, j);
      tokens.push(isFloat ? { kind: 'float', value: Number(text) } : { kind: 'int', value: Number(text) });
      i = j;
      continue;
    }
    if (isNameStart(c)) {
      let j = i;
      while (j < input.length && isNameChar(input[j]!)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(c)} in GraphQL document`);
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// parser
// ---------------------------------------------------------------------------

export type GqlValue =
  | { kind: 'var'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: GqlValue[] }
  | { kind: 'object'; fields: Array<{ name: string; value: GqlValue }> };

export interface GqlField {
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: GqlValue }>;
  selections: GqlSelection[] | null;
}

export type GqlSelection =
  | { kind: 'field'; field: GqlField }
  | { kind: 'fragment'; type: string | null; selections: GqlSelection[] };

export interface GqlOperation {
  type: 'query' | 'mutation';
  name: string | null;
  selections: GqlSelection[];
}

class Parser {
  private readonly tokens: Token[];
  private pos = 0;
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  next(): Token {
    const tok = this.tokens[this.pos];
    if (!tok) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return tok;
  }

  expectPunct(value: string): void {
    const tok = this.next();
    if (tok.kind !== 'punct' || tok.value !== value) {
      throw new Error(`expected ${value} in GraphQL document`);
    }
  }

  expectName(): string {
    const tok = this.next();
    if (tok.kind !== 'name') throw new Error('expected a name in GraphQL document');
    return tok.value;
  }

  parseDocument(): GqlOperation[] {
    const operations: GqlOperation[] = [];
    while (this.pos < this.tokens.length) {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  parseOperation(): GqlOperation {
    let type: 'query' | 'mutation' = 'query';
    const tok = this.peek();
    if (tok?.kind === 'name' && (tok.value === 'query' || tok.value === 'mutation')) {
      type = this.next().value as 'query' | 'mutation';
    }
    let name: string | null = null;
    const maybeName = this.peek();
    if (maybeName?.kind === 'name') name = this.next().value;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      this.skipVariableDefinitions();
    }
    return { type, name, selections: this.parseSelectionSet() };
  }

  skipVariableDefinitions(): void {
    this.expectPunct('(');
    let depth = 1;
    while (depth > 0) {
      const tok = this.next();
      if (tok.kind === 'punct' && tok.value === '(') depth += 1;
      else if (tok.kind === 'punct' && tok.value === ')') depth -= 1;
    }
  }

  parseSelectionSet(): GqlSelection[] {
    this.expectPunct('{');
    const selections: GqlSelection[] = [];
    while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }

  parseSelection(): GqlSelection {
    const tok = this.peek();
    if (tok?.kind === 'punct' && tok.value === '...') {
      this.next();
      let type: string | null = null;
      const next = this.peek();
      if (next?.kind === 'name' && next.value === 'on') {
        this.next();
        type = this.expectName();
      }
      return { kind: 'fragment', type, selections: this.parseSelectionSet() };
    }
    return { kind: 'field', field: this.parseField() };
  }

  parseField(): GqlField {
    let name = this.expectName();
    let alias: string | null = null;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === ':') {
      this.next();
      alias = name;
      name = this.expectName();
    }
    const args: Array<{ name: string; value: GqlValue }> = [];
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    let selections: GqlSelection[] | null = null;
    if (this.peek()?.kind === 'punct' && this.peek()?.value === '{') {
      selections = this.parseSelectionSet();
    }
    return { alias, name, args, selections };
  }

  parseValue(): GqlValue {
    const tok = this.next();
    if (tok.kind === 'punct' && tok.value === '$') return { kind: 'var', name: this.expectName() };
    if (tok.kind === 'punct' && tok.value === '[') {
      const values: GqlValue[] = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (tok.kind === 'punct' && tok.value === '{') {
      const fields: Array<{ name: string; value: GqlValue }> = [];
      while (!(this.peek()?.kind === 'punct' && this.peek()?.value === '}')) {
        const fieldName = this.expectName();
        this.expectPunct(':');
        fields.push({ name: fieldName, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (tok.kind === 'int') return { kind: 'int', value: tok.value };
    if (tok.kind === 'float') return { kind: 'float', value: tok.value };
    if (tok.kind === 'string') return { kind: 'string', value: tok.value };
    if (tok.kind === 'name') {
      if (tok.value === 'true') return { kind: 'bool', value: true };
      if (tok.value === 'false') return { kind: 'bool', value: false };
      if (tok.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: tok.value };
    }
    throw new Error('unexpected value in GraphQL document');
  }
}

function valueOf(node: GqlValue, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'var':
      return variables[node.name] ?? null;
    case 'int':
    case 'float':
    case 'string':
    case 'bool':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => valueOf(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = valueOf(f.value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------
// values the resolvers hand around (each carries its GraphQL type)
// ---------------------------------------------------------------------------

type Parent =
  | { t: 'Query' }
  | { t: 'Mutation' }
  | { t: 'Repository'; repo: Repo }
  | { t: 'Issue'; repo: Repo; issue: Issue }
  | { t: 'PullRequest'; repo: Repo; pull: Pull }
  | { t: 'User' }
  | { t: 'Ref'; name: string }
  | { t: 'IssueConnection'; nodes: Parent[]; hasNextPage: boolean; endCursor: string | null }
  | { t: 'PullRequestConnection'; nodes: Parent[] }
  | { t: 'ChangedFile'; path: string }
  | { t: 'Comment'; repo: Repo; issue: Issue; id: number; body: string }
  | { t: 'TypeInfo'; name: string; fields: string[]; enumValues: string[] }
  | { t: 'CreateIssuePayload'; issue: Parent }
  | { t: 'CloseIssuePayload'; issue: Parent }
  | { t: 'CreatePullRequestPayload'; pull: Parent }
  | { t: 'MergePullRequestPayload'; pull: Parent }
  | { t: 'AddCommentPayload'; comment: Parent };

class GqlError extends Error {}

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'repository', 'url', 'closedAt'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRef', 'baseRef', 'files', 'commits', 'author', 'createdAt', 'updatedAt', 'mergedAt', 'mergeCommit'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'createdAt', 'updatedAt', 'url'],
  User: ['id', 'login', 'name', 'email'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
};

const TYPE_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

// ---------------------------------------------------------------------------
// executor
// ---------------------------------------------------------------------------

function argMap(field: GqlField, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = valueOf(arg.value, variables);
  return out;
}

function issueParent(repo: Repo, issue: Issue): Parent {
  return { t: 'Issue', repo, issue };
}

function pullParent(repo: Repo, pull: Pull): Parent {
  return { t: 'PullRequest', repo, pull };
}

function repoByGlobalId(store: Store, id: string): Repo | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'Repository') return null;
  const dbid = Number(decoded.parts[0]);
  if (!Number.isSafeInteger(dbid)) return null;
  for (const repo of store.repos.values()) if (repo.id === dbid) return repo;
  return null;
}

function issueByGlobalId(store: Store, id: string): { repo: Repo; issue: Issue } | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'Issue') return null;
  const dbid = Number(decoded.parts[0]);
  const number = Number(decoded.parts[1]);
  for (const repo of store.repos.values()) {
    if (repo.id !== dbid) continue;
    const issue = repo.issues.get(number);
    return issue ? { repo, issue } : null;
  }
  return null;
}

function pullByGlobalId(store: Store, id: string): { repo: Repo; pull: Pull } | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'PullRequest') return null;
  const dbid = Number(decoded.parts[0]);
  const number = Number(decoded.parts[1]);
  for (const repo of store.repos.values()) {
    if (repo.id !== dbid) continue;
    const pull = repo.pulls.get(number);
    return pull ? { repo, pull } : null;
  }
  return null;
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function cursorNumber(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

function issueConnection(
  store: Store,
  repo: Repo,
  args: Record<string, unknown>,
): Parent {
  let list = [...repo.issues.values()];
  const states = args.states;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toLowerCase()));
    list = list.filter((i) => wanted.has(i.state));
  }
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const field = String(orderBy.field ?? 'CREATED_AT');
  const direction = String(orderBy.direction ?? 'DESC');
  const desc = direction !== 'ASC';
  list.sort((a, b) => {
    let cmp = 0;
    if (field === 'COMMENTS') cmp = a.comments.length - b.comments.length;
    else if (field === 'UPDATED_AT') cmp = a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0;
    else cmp = a.createdSeq - b.createdSeq;
    if (cmp === 0) cmp = a.number - b.number;
    return desc ? -cmp : cmp;
  });
  const after = typeof args.after === 'string' ? cursorNumber(args.after) : null;
  if (after !== null) {
    list = list.filter((i) => (desc ? i.number < after : i.number > after));
  }
  const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : list.length;
  const page = list.slice(0, first);
  const hasNextPage = list.length > first;
  return {
    t: 'IssueConnection',
    nodes: page.map((i) => issueParent(repo, i)),
    hasNextPage,
    endCursor: page.length > 0 ? cursorFor(page[page.length - 1]!.number) : null,
  };
}

function resolveField(store: Store, parent: Parent, field: GqlField, variables: Record<string, unknown>): unknown {
  const args = argMap(field, variables);
  switch (parent.t) {
    case 'Query': {
      if (field.name === 'viewer') return { t: 'User' } as Parent;
      if (field.name === 'repository') {
        const repo = store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return repo ? ({ t: 'Repository', repo } as Parent) : null;
      }
      if (field.name === 'node') {
        const id = String(args.id ?? '');
        const decoded = decodeGlobalId(id);
        if (!decoded) return null;
        if (decoded.kind === 'Repository') {
          const repo = repoByGlobalId(store, id);
          return repo ? ({ t: 'Repository', repo } as Parent) : null;
        }
        if (decoded.kind === 'Issue') {
          const found = issueByGlobalId(store, id);
          return found ? issueParent(found.repo, found.issue) : null;
        }
        if (decoded.kind === 'PullRequest') {
          const found = pullByGlobalId(store, id);
          return found ? pullParent(found.repo, found.pull) : null;
        }
        return null;
      }
      if (field.name === '__type') {
        const name = String(args.name ?? '');
        const fields = TYPE_FIELDS[name];
        const enums = TYPE_ENUMS[name];
        if (!fields && !enums) return null;
        return { t: 'TypeInfo', name, fields: fields ?? [], enumValues: enums ?? [] } as Parent;
      }
      throw new GqlError(`Cannot query field "${field.name}" on type "Query".`);
    }
    case 'Mutation': {
      if (field.name === 'createIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = repoByGlobalId(store, String(input.repositoryId ?? ''));
        if (!repo) throw new GqlError('createIssue: unknown repository');
        const title = String(input.title ?? '');
        if (title === '') throw new GqlError('createIssue: title is required');
        const issue = store.createIssue(repo, title, String(input.body ?? ''), []);
        return { t: 'CreateIssuePayload', issue: issueParent(repo, issue) } as Parent;
      }
      if (field.name === 'closeIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = issueByGlobalId(store, String(input.issueId ?? ''));
        if (!found) throw new GqlError('closeIssue: unknown issue');
        found.issue.state = 'closed';
        found.issue.updatedAt = store.nowIso();
        return { t: 'CloseIssuePayload', issue: issueParent(found.repo, found.issue) } as Parent;
      }
      if (field.name === 'createPullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const repo = repoByGlobalId(store, String(input.repositoryId ?? ''));
        if (!repo) throw new GqlError('createPullRequest: unknown repository');
        const head = String(input.headRefName ?? '');
        const base = String(input.baseRefName ?? '');
        const headSha = repo.refs.get(`refs/heads/${head}`);
        const baseSha = repo.refs.get(`refs/heads/${base}`);
        if (!headSha || !baseSha) throw new GqlError('createPullRequest: head or base branch does not exist');
        for (const existing of repo.pulls.values()) {
          if (existing.state === 'open' && existing.head === head && existing.base === base) {
            throw new GqlError('createPullRequest: a pull request already exists for this head and base');
          }
        }
        const pull = store.createPull(repo, String(input.title ?? ''), '', head, base, headSha, baseSha);
        return { t: 'CreatePullRequestPayload', pull: pullParent(repo, pull) } as Parent;
      }
      if (field.name === 'mergePullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = pullByGlobalId(store, String(input.pullRequestId ?? ''));
        if (!found) throw new GqlError('mergePullRequest: unknown pull request');
        if (found.pull.merged || found.pull.state === 'closed') {
          throw new GqlError('mergePullRequest: pull request is already closed');
        }
        const sha = store.squashMerge(found.repo, found.pull);
        if (!sha) throw new GqlError('mergePullRequest: merge conflict');
        return { t: 'MergePullRequestPayload', pull: pullParent(found.repo, found.pull) } as Parent;
      }
      if (field.name === 'addComment') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const found = issueByGlobalId(store, String(input.subjectId ?? ''));
        if (!found) throw new GqlError('addComment: unknown subject');
        const body = String(input.body ?? '');
        if (body === '') throw new GqlError('addComment: body is required');
        const comment = {
          id: found.repo.nextCommentId++,
          body,
          createdAt: store.nowIso(),
          createdSeq: 0,
        };
        found.issue.comments.push(comment);
        found.issue.updatedAt = comment.createdAt;
        return {
          t: 'AddCommentPayload',
          comment: { t: 'Comment', repo: found.repo, issue: found.issue, id: comment.id, body } as Parent,
        } as Parent;
      }
      throw new GqlError(`Cannot query field "${field.name}" on type "Mutation".`);
    }
    case 'Repository': {
      const repo = parent.repo;
      switch (field.name) {
        case 'id':
          return globalId('Repository', repo.id);
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return repo.fullName;
        case 'owner':
          return { t: 'User' } as Parent;
        case 'defaultBranchRef': {
          const tip = store.defaultTip(repo);
          return tip ? ({ t: 'Ref', name: repo.defaultBranch } as Parent) : null;
        }
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'description':
          return repo.description;
        case 'private':
          return repo.private;
        case 'createdAt':
          return repo.createdAt;
        case 'updatedAt':
          return repo.updatedAt;
        case 'url':
          return `/${repo.fullName}`;
        case 'issue': {
          const issue = repo.issues.get(Number(args.number));
          return issue ? issueParent(repo, issue) : null;
        }
        case 'issues':
          return issueConnection(store, repo, args);
        case 'pullRequests': {
          let list = [...repo.pulls.values()];
          const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : list.length;
          list = list.slice(0, first);
          return { t: 'PullRequestConnection', nodes: list.map((p) => pullParent(repo, p)) } as Parent;
        }
        case 'pullRequest': {
          const pull = repo.pulls.get(Number(args.number));
          return pull ? pullParent(repo, pull) : null;
        }
        default:
          throw new GqlError(`Cannot query field "${field.name}" on type "Repository".`);
      }
    }
    case 'Issue': {
      const { repo, issue } = parent;
      switch (field.name) {
        case 'id':
          return globalId('Issue', repo.id, issue.number);
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'state':
          return issue.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'body':
          return issue.body;
        case 'createdAt':
          return issue.createdAt;
        case 'updatedAt':
          return issue.updatedAt;
        case 'closedAt':
          return issue.state === 'closed' ? issue.updatedAt : null;
        case 'url':
          return `/${repo.fullName}/issues/${issue.number}`;
        default:
          throw new GqlError(`Cannot query field "${field.name}" on type "Issue".`);
      }
    }
    case 'PullRequest': {
      const { repo, pull } = parent;
      switch (field.name) {
        case 'id':
          return globalId('PullRequest', repo.id, pull.number);
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'merged':
          return pull.merged;
        case 'headRefName':
          return pull.head;
        case 'baseRefName':
          return pull.base;
        case 'mergeable': {
          const headTip = repo.refs.get(`refs/heads/${pull.head}`);
          const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
          if (!headTip || !baseTip) return 'UNKNOWN';
          return store.mergeable(repo, headTip, baseTip);
        }
        case 'createdAt':
          return pull.createdAt;
        case 'updatedAt':
          return pull.updatedAt;
        case 'mergedAt':
          return pull.mergedAt;
        case 'files': {
          const baseTree = store.commitTree(repo, pull.baseSha);
          const headTree = store.commitTree(repo, pull.headSha);
          const changes = store.diffTrees(repo, baseTree, headTree);
          const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : changes.length;
          return {
            t: 'PullRequestConnection',
            nodes: changes.slice(0, first).map((c) => ({ t: 'ChangedFile', path: c.path }) as Parent),
          } as Parent;
        }
        default:
          throw new GqlError(`Cannot query field "${field.name}" on type "PullRequest".`);
      }
    }
    case 'User': {
      if (field.name === 'login') return VIEWER_LOGIN;
      if (field.name === 'id') return globalId('User', VIEWER_LOGIN);
      if (field.name === 'name') return 'ada iversen';
      if (field.name === 'email') return 'adaiversen@example.invalid';
      throw new GqlError(`Cannot query field "${field.name}" on type "User".`);
    }
    case 'Ref': {
      if (field.name === 'name') return parent.name;
      throw new GqlError(`Cannot query field "${field.name}" on type "Ref".`);
    }
    case 'IssueConnection': {
      if (field.name === 'nodes') return parent.nodes;
      if (field.name === 'pageInfo') {
        return { hasNextPage: parent.hasNextPage, endCursor: parent.endCursor };
      }
      throw new GqlError(`Cannot query field "${field.name}" on type "IssueConnection".`);
    }
    case 'PullRequestConnection': {
      if (field.name === 'nodes') return parent.nodes;
      if (field.name === 'pageInfo') return { hasNextPage: false, endCursor: null };
      throw new GqlError(`Cannot query field "${field.name}" on type "PullRequestConnection".`);
    }
    case 'ChangedFile': {
      if (field.name === 'path') return parent.path;
      throw new GqlError(`Cannot query field "${field.name}" on type "PullRequestChangedFile".`);
    }
    case 'Comment': {
      if (field.name === 'id') return globalId('IssueComment', parent.repo.id, parent.issue.number, parent.id);
      if (field.name === 'body') return parent.body;
      throw new GqlError(`Cannot query field "${field.name}" on type "IssueComment".`);
    }
    case 'TypeInfo': {
      if (field.name === 'name') return parent.name;
      if (field.name === 'fields') return parent.fields.map((name) => ({ name }));
      if (field.name === 'enumValues') return parent.enumValues.map((name) => ({ name }));
      throw new GqlError(`Cannot query field "${field.name}" on type "__Type".`);
    }
    case 'CreateIssuePayload': {
      if (field.name === 'issue') return parent.issue;
      throw new GqlError(`Cannot query field "${field.name}" on type "CreateIssuePayload".`);
    }
    case 'CloseIssuePayload': {
      if (field.name === 'issue') return parent.issue;
      throw new GqlError(`Cannot query field "${field.name}" on type "CloseIssuePayload".`);
    }
    case 'CreatePullRequestPayload': {
      if (field.name === 'pullRequest') return parent.pull;
      throw new GqlError(`Cannot query field "${field.name}" on type "CreatePullRequestPayload".`);
    }
    case 'MergePullRequestPayload': {
      if (field.name === 'pullRequest') return parent.pull;
      throw new GqlError(`Cannot query field "${field.name}" on type "MergePullRequestPayload".`);
    }
    case 'AddCommentPayload': {
      if (field.name === 'commentEdge') return { node: parent.comment };
      throw new GqlError(`Cannot query field "${field.name}" on type "AddCommentPayload".`);
    }
  }
}

/** pageInfo and commentEdge are plain records, not typed parents. */
function isParent(value: unknown): value is Parent {
  return typeof value === 'object' && value !== null && 't' in (value as Record<string, unknown>);
}

function executeSelections(
  store: Store,
  parent: Parent | Record<string, unknown>,
  selections: GqlSelection[],
  variables: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.type !== null) {
        const typeName = isParent(parent) ? parent.t : null;
        // Inline fragments apply when the type matches (Ref maps to BranchRef only here).
        const matches =
          selection.type === typeName ||
          (selection.type === 'Repository' && typeName === 'Repository') ||
          (selection.type === 'Node' && typeName !== null);
        if (!matches) continue;
      }
      Object.assign(out, executeSelections(store, parent, selection.selections, variables));
      continue;
    }
    const field = selection.field;
    const key = field.alias ?? field.name;
    let value: unknown;
    if (isParent(parent)) {
      value = resolveField(store, parent, field, variables);
    } else {
      value = (parent as Record<string, unknown>)[field.name];
      if (value === undefined) throw new GqlError(`Cannot query field "${field.name}".`);
    }
    out[key] = executeValue(store, value, field.selections, variables);
  }
  return out;
}

function executeValue(
  store: Store,
  value: unknown,
  selections: GqlSelection[] | null,
  variables: Record<string, unknown>,
): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((v) => executeValue(store, v, selections, variables));
  if (isParent(value)) {
    if (selections === null) return value;
    return executeSelections(store, value, selections, variables);
  }
  if (typeof value === 'object') {
    if (selections === null) return value;
    return executeSelections(store, value as Record<string, unknown>, selections, variables);
  }
  return value;
}

export interface GraphQLOut {
  status: number;
  body: string;
}

/** Run one operation document. Never throws for a GraphQL error: those go in `errors`. */
export function executeOperation(
  store: Store,
  query: string,
  variables: Record<string, unknown>,
  operationName?: string,
): { data: unknown; errors: Array<{ message: string }> } {
  try {
    const operations = new Parser(lex(query)).parseDocument();
    let operation: GqlOperation | undefined;
    if (operationName) operation = operations.find((op) => op.name === operationName);
    else if (operations.length === 1) operation = operations[0];
    else operation = operations.find((op) => op.type === 'query') ?? operations[0];
    if (!operation) return { data: null, errors: [{ message: 'No operation found in document' }] };
    const root: Parent = operation.type === 'mutation' ? { t: 'Mutation' } : { t: 'Query' };
    const data = executeSelections(store, root, operation.selections, variables);
    return { data, errors: [] };
  } catch (err) {
    if (err instanceof GqlError) return { data: null, errors: [{ message: err.message }] };
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
}

export function handleGraphQL(store: Store, body: unknown): GraphQLOut {
  if (Array.isArray(body)) {
    const results = body.map((entry) => {
      const op = (entry ?? {}) as Record<string, unknown>;
      if (typeof op.query !== 'string') return { data: null, errors: [{ message: 'Missing query' }] };
      return executeOperation(
        store,
        op.query,
        (op.variables ?? {}) as Record<string, unknown>,
        typeof op.operationName === 'string' ? op.operationName : undefined,
      );
    });
    return { status: 200, body: JSON.stringify(results) };
  }
  const op = (body ?? {}) as Record<string, unknown>;
  if (typeof op.query !== 'string') {
    return { status: 400, body: JSON.stringify({ message: 'Missing query' }) };
  }
  const result = executeOperation(
    store,
    op.query,
    (op.variables ?? {}) as Record<string, unknown>,
    typeof op.operationName === 'string' ? op.operationName : undefined,
  );
  const envelope: Record<string, unknown> = { data: result.data };
  if (result.errors.length > 0) envelope.errors = result.errors;
  return { status: 200, body: JSON.stringify(envelope) };
}
