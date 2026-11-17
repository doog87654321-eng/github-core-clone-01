// server.ts — one Node http server for every surface: /healthz, git smart HTTP,
// REST v3, GraphQL v4 and MCP. Auth is enforced on the API surfaces (a missing
// or wrong bearer token is 401); /healthz and the git endpoints take the
// requests the suite sends them as they come.

import http from 'node:http';
import { Store } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './gitserver.ts';

const MAX_BODY = 64 * 1024 * 1024;

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createServer(store: Store): http.Server {
  let requestSeq = 0;
  const server = http.createServer(async (req, res) => {
    const requestId = `req-${(requestSeq += 1)}`;
    const send = (status: number, contentType: string, payload: string | Buffer | null, extra: Record<string, string> = {}): void => {
      res.writeHead(status, { 'content-type': contentType, 'x-github-request-id': requestId, ...extra });
      res.end(payload);
    };
    const sendJson = (status: number, value: unknown, extra: Record<string, string> = {}): void => {
      send(status, 'application/json', JSON.stringify(value), extra);
    };
    try {
      const rawUrl = req.url ?? '/';
      const url = new URL(rawUrl, `http://${req.headers.host ?? '127.0.0.1'}`);
      const pathname = url.pathname;
      const method = (req.method ?? 'GET').toUpperCase();

      if (pathname === '/healthz') {
        sendJson(200, { ok: true });
        return;
      }

      const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);

      // Git smart HTTP: /{owner}/{repo}.git/{info/refs,git-upload-pack,git-receive-pack}
      const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(pathname);
      if (gitMatch) {
        const owner = decodeURIComponent(gitMatch[1]!);
        const repoName = decodeURIComponent(gitMatch[2]!);
        const service = gitMatch[3]!;
        if (service === 'info/refs') {
          if (method !== 'GET') {
            sendJson(405, { message: 'Method Not Allowed' });
            return;
          }
          const which = url.searchParams.get('service');
          if (which !== 'git-upload-pack' && which !== 'git-receive-pack') {
            sendJson(400, { message: 'Unknown service' });
            return;
          }
          const out = handleInfoRefs(store, owner, repoName, which, true);
          send(out.status, out.contentType, out.body);
          return;
        }
        if (method !== 'POST') {
          sendJson(405, { message: 'Method Not Allowed' });
          return;
        }
        const out =
          service === 'git-upload-pack'
            ? handleUploadPack(store, owner, repoName, body)
            : handleReceivePack(store, owner, repoName, body);
        send(out.status, out.contentType, out.body);
        return;
      }

      // Every API surface below needs the trial's bearer token.
      const expected = process.env.MAKEFUN_SHOP_TOKEN;
      const auth = req.headers.authorization ?? '';
      const authed = expected
        ? auth === `Bearer ${expected}`
        : auth.startsWith('Bearer ') && auth.length > 'Bearer '.length;
      if (!authed) {
        sendJson(401, { message: 'Requires authentication' });
        return;
      }

      if (pathname === '/api/graphql') {
        if (method !== 'POST') {
          sendJson(404, { message: 'Not Found' });
          return;
        }
        let parsed: unknown;
        try {
          parsed = body.length === 0 ? {} : JSON.parse(body.toString('utf8'));
        } catch {
          sendJson(400, { message: 'Invalid JSON' });
          return;
        }
        const out = handleGraphQL(store, parsed);
        sendJson(out.status, JSON.parse(out.body));
        return;
      }

      if (pathname === '/mcp') {
        if (method !== 'POST') {
          sendJson(404, { message: 'Not Found' });
          return;
        }
        const out = handleMcp(store, body);
        if (out.body === null) {
          res.writeHead(out.status, { 'x-github-request-id': requestId });
          res.end();
        } else {
          send(out.status, 'application/json', out.body);
        }
        return;
      }

      if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
        let parsed: unknown;
        if (body.length > 0) {
          try {
            parsed = JSON.parse(body.toString('utf8'));
          } catch {
            sendJson(400, { message: 'Invalid JSON' });
            return;
          }
        }
        const out = handleRest({
          store,
          method,
          pathname,
          query: url.searchParams,
          body: parsed,
          host: req.headers.host ?? '127.0.0.1',
        });
        if (out.body === null) {
          res.writeHead(out.status, { 'x-github-request-id': requestId, ...out.headers });
          res.end();
        } else {
          send(out.status, out.headers['content-type'] ?? 'application/json', out.body, out.headers);
        }
        return;
      }

      sendJson(404, { message: 'Not Found' });
    } catch (err) {
      if (!res.headersSent) {
        sendJson(500, { message: err instanceof Error ? err.message : 'Internal error' });
      } else {
        res.end();
      }
    }
  });
  server.on('clientError', (_err, socket) => {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });
  return server;
}
