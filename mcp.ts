// mcp.ts — Model Context Protocol over Streamable HTTP, revision 2026-07-28:
// server/discover, tools/list and tools/call, all over the same store REST
// uses. Plain JSON bodies; no SSE stream is ever needed.

import { Store, VIEWER_LOGIN, globalId } from './store.ts';

export interface McpOut {
  status: number;
  body: string | null;
}

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

// The tools list is one frozen value, so two tools/list calls serialize identically.
const TOOLS_JSON = JSON.stringify(TOOLS);

const SERVER_NAME = 'forge';
const SERVER_VERSION = '1.0.0';
const REVISION = '2026-07-28';

function rpcResult(id: unknown, result: unknown): McpOut {
  return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id, result }) };
}

function rpcError(id: unknown, code: number, message: string, status = 200): McpOut {
  return { status, body: JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) };
}

function toolResult(result: Record<string, unknown>): Record<string, unknown> {
  return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function missingArgs(tool: ToolDef, args: Record<string, unknown>): string[] {
  return tool.inputSchema.required.filter((name) => args[name] === undefined || args[name] === null || args[name] === '');
}

export function handleMcp(store: Store, rawBody: Buffer): McpOut {
  let body: unknown;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return rpcError(null, -32700, 'Parse error', 400);
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return rpcError(null, -32600, 'Invalid Request');
  }
  const req = body as Record<string, unknown>;
  const id = req.id === undefined ? null : req.id;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = (req.params ?? {}) as Record<string, unknown>;

  // A notification (no id) needs no JSON-RPC answer.
  if (id === null && method.startsWith('notifications/')) {
    return { status: 202, body: null };
  }

  if (method === 'server/discover') {
    return rpcResult(id, {
      supportedVersions: [REVISION],
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    });
  }

  if (method === 'initialize') {
    const requested = (params.protocolVersion as string | undefined) ?? REVISION;
    return rpcResult(id, {
      protocolVersion: requested,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }

  if (method === 'tools/list') {
    return { status: 200, body: `{"jsonrpc":"2.0","id":${JSON.stringify(id)},"result":{"tools":${TOOLS_JSON}}}` };
  }

  if (method === 'tools/call') {
    const name = String(params.name ?? '');
    const args = ((params.arguments ?? {}) as Record<string, unknown>) ?? {};
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) return rpcError(id, -32601, `Unknown tool: ${name}`);
    const missing = missingArgs(tool, args);
    if (missing.length > 0) {
      return rpcError(id, -32602, `Missing required argument(s): ${missing.join(', ')}`);
    }
    const out = callTool(store, name, args);
    if (out.error) return rpcResult(id, toolError(out.error));
    return rpcResult(id, toolResult(out.result!));
  }

  return rpcError(id, -32601, `Method not found: ${method}`);
}

function callTool(
  store: Store,
  name: string,
  args: Record<string, unknown>,
): { result?: Record<string, unknown>; error?: string } {
  const owner = String(args.owner ?? VIEWER_LOGIN);
  const repoName = String(args.repo ?? '');
  switch (name) {
    case 'create_repo': {
      const repoNameArg = String(args.name ?? '');
      if (repoNameArg === '') return { error: 'name is required' };
      const repo = store.createRepo(
        repoNameArg,
        typeof args.description === 'string' ? args.description : '',
        args.private === true,
      );
      if (!repo) return { error: `Repository ${repoNameArg} already exists` };
      return {
        result: {
          id: repo.id,
          name: repo.name,
          full_name: repo.fullName,
          owner: { login: repo.owner },
          private: repo.private,
          description: repo.description,
          default_branch: repo.defaultBranch,
        },
      };
    }
    case 'get_repo': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) return { error: `Repository ${owner}/${repoName} not found` };
      return {
        result: {
          id: repo.id,
          name: repo.name,
          full_name: repo.fullName,
          owner: { login: repo.owner },
          private: repo.private,
          description: repo.description,
          default_branch: repo.defaultBranch,
        },
      };
    }
    case 'create_issue': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) return { error: `Repository ${owner}/${repoName} not found` };
      const issue = store.createIssue(repo, String(args.title), typeof args.body === 'string' ? args.body : '', []);
      return {
        result: {
          id: issue.id,
          node_id: globalId('Issue', repo.id, issue.number),
          number: issue.number,
          title: issue.title,
          body: issue.body,
          state: issue.state,
        },
      };
    }
    case 'list_issues': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) return { error: `Repository ${owner}/${repoName} not found` };
      const state = typeof args.state === 'string' ? args.state : 'open';
      const list = [...repo.issues.values()]
        .filter((i) => state === 'all' || i.state === state)
        .sort((a, b) => b.createdSeq - a.createdSeq)
        .map((i) => ({
          id: i.id,
          node_id: globalId('Issue', repo.id, i.number),
          number: i.number,
          title: i.title,
          body: i.body,
          state: i.state,
        }));
      return { result: { issues: list } };
    }
    case 'create_pull_request': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) return { error: `Repository ${owner}/${repoName} not found` };
      const head = String(args.head ?? '');
      const base = String(args.base ?? '');
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha || !baseSha) return { error: 'Head or base branch does not exist' };
      for (const existing of repo.pulls.values()) {
        if (existing.state === 'open' && existing.head === head && existing.base === base) {
          return { error: 'A pull request already exists for this head and base' };
        }
      }
      const pull = store.createPull(
        repo,
        String(args.title ?? ''),
        typeof args.body === 'string' ? args.body : '',
        head,
        base,
        headSha,
        baseSha,
      );
      return {
        result: {
          id: pull.id,
          node_id: globalId('PullRequest', repo.id, pull.number),
          number: pull.number,
          title: pull.title,
          body: pull.body,
          state: pull.state,
          head: { ref: head, sha: headSha },
          base: { ref: base, sha: baseSha },
        },
      };
    }
    case 'merge_pull_request': {
      const repo = store.getRepo(owner, repoName);
      if (!repo) return { error: `Repository ${owner}/${repoName} not found` };
      const number = Number(args.pull_number);
      const pull = repo.pulls.get(number);
      if (!pull) return { error: `Pull request #${args.pull_number} not found` };
      if (pull.merged || pull.state === 'closed') return { error: 'Pull request is already closed' };
      const sha = store.squashMerge(repo, pull);
      if (!sha) return { error: 'Merge conflict' };
      return { result: { merged: true, number: pull.number, sha, state: pull.state } };
    }
    default:
      return { error: `Unknown tool: ${name}` };
  }
}
