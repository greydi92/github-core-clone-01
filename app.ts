// The HTTP server: one Node process, stdlib only. It wires the four surfaces
// onto one store — REST v3 under /api/v3, GraphQL at /api/graphql, MCP at
// /mcp, and git smart HTTP at /{owner}/{repo}.git — plus a /healthz that
// needs no token. Every JSON reply carries a non-empty X-GitHub-Request-Id;
// unknown routes are JSON 404s; a malformed JSON body is a 400, never a
// crash; a malformed git POST is a 400 and the server stays up.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store, readPack } from './store.ts';
import { routeRest, type RestResult } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import {
  advertisementV0,
  advertisementV2,
  applyPush,
  fetchPack,
  fetchV0Answer,
  fetchV2Answer,
  lsRefsAnswer,
  parsePushBody,
  parseV0Fetch,
  parseV2Request,
  pushReportAnswer,
  selectFetch,
} from './gitproto.ts';

let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${Date.now().toString(36)}-${requestCounter.toString(16)}`;
}

const MAX_BODY = 16 * 1024 * 1024;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, value: unknown, requestId: string, extraHeaders: Record<string, string> = {}): void {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': requestId,
    ...extraHeaders,
  });
  res.end(body);
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string, requestId: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'x-github-request-id': requestId,
    'content-length': String(body.length),
  });
  res.end(body);
}

function sendRest(res: ServerResponse, result: RestResult, requestId: string): void {
  if (result.status === 204) {
    res.writeHead(204, { 'x-github-request-id': requestId });
    res.end();
    return;
  }
  const headers: Record<string, string> = { 'x-github-request-id': requestId };
  if (result.headers !== undefined) Object.assign(headers, result.headers);
  // RestResult.body is a pre-serialized Buffer, a value to serialize, or
  // undefined: a raw value must be serialized here, not handed to res.end
  // (which would write nothing for a non-string, non-Buffer body).
  const body =
    result.body === undefined
      ? Buffer.alloc(0)
      : Buffer.isBuffer(result.body)
        ? result.body
        : Buffer.from(JSON.stringify(result.body), 'utf8');
  res.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(body);
}

function parseJsonBody(raw: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (raw.length === 0) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(raw.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}

/** Parse the v2 fetch arguments the git client sends. */
function parseFetchArgs(args: readonly string[]): {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
} {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).split(' ')[0] as string);
    else if (arg.startsWith('have ')) haves.push(arg.slice(5));
    else if (arg.startsWith('shallow ')) shallow.push(arg.slice(8));
    else if (arg.startsWith('deepen ')) depth = parseInt(arg.slice(7), 10);
  }
  return { wants, haves, shallow, depth };
}

export function createApp(store: Store = new Store()): Server & { store: Store } {
  const server = createServer((req, res) => {
    void (async () => {
      const requestId = nextRequestId();
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const segments = url.pathname.split('/').filter((segment) => segment !== '');
        const method = req.method ?? 'GET';

        // /healthz needs no token (the harness probes it before registering).
        if (method === 'GET' && segments.length === 1 && segments[0] === 'healthz') {
          sendJson(res, 200, { ok: true }, requestId);
          return;
        }

        // Authorization: the shop token, Bearer. No token at all is a 401.
        const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
        const authorization = req.headers.authorization ?? '';
        const authorized =
          expected !== ''
            ? authorization === `Bearer ${expected}`
            : authorization.startsWith('Bearer ') && authorization.length > 7;
        if (!authorized) {
          sendJson(res, 401, { message: 'Requires authentication' }, requestId);
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/...
        if (
          segments.length >= 2 &&
          (segments[1] as string).endsWith('.git') &&
          (segments[2] === 'info' || segments[2] === 'git-upload-pack' || segments[2] === 'git-receive-pack')
        ) {
          const owner = segments[0] as string;
          const repoName = (segments[1] as string).slice(0, -4);
          const repo = store.getRepo(owner, repoName);
          if (repo === null) {
            sendJson(res, 404, { message: 'Not Found' }, requestId);
            return;
          }
          const action = segments[2] as string;
          if (method === 'GET' && action === 'info' && segments[3] === 'refs') {
            const service = url.searchParams.get('service');
            if (service === 'git-upload-pack') {
              if (req.headers['git-protocol'] === 'version=2') {
                sendBuffer(res, 200, advertisementV2(), 'application/x-git-upload-pack-advertisement', requestId);
              } else {
                sendBuffer(res, 200, advertisementV0(store, repo, 'git-upload-pack'), 'application/x-git-upload-pack-advertisement', requestId);
              }
            } else if (service === 'git-receive-pack') {
              sendBuffer(res, 200, advertisementV0(store, repo, 'git-receive-pack'), 'application/x-git-receive-pack-advertisement', requestId);
            } else {
              sendJson(res, 400, { message: 'Unknown service' }, requestId);
            }
            return;
          }
          if (method === 'POST' && action === 'git-upload-pack') {
            const body = await readBody(req);
            try {
              if (req.headers['git-protocol'] === 'version=2') {
                const parsed = parseV2Request(body);
                if (parsed.command === 'ls-refs') {
                  const args = parsed.args;
                  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
                  const answer = lsRefsAnswer(store, repo, {
                    prefixes,
                    peel: args.includes('peel'),
                    symrefs: args.includes('symrefs'),
                    unborn: args.includes('unborn'),
                  });
                  sendBuffer(res, 200, answer, 'application/x-git-upload-pack-result', requestId);
                } else if (parsed.command === 'fetch') {
                  const { wants, haves, shallow, depth } = parseFetchArgs(parsed.args);
                  const selection = selectFetch(store, repo, wants, haves, shallow, depth);
                  const pack =
                    selection.send.length > 0
                      ? fetchPack(store, repo, [...wants, ...haves, ...shallow, String(depth)].join('|'), selection.send)
                      : null;
                  sendBuffer(res, 200, fetchV2Answer(selection, pack, haves.length > 0), 'application/x-git-upload-pack-result', requestId);
                } else {
                  sendJson(res, 400, { message: 'Unknown command' }, requestId);
                }
              } else {
                const { wants, haves, shallow, depth } = parseV0Fetch(body);
                const selection = selectFetch(store, repo, wants, haves, shallow, depth);
                const pack =
                  selection.send.length > 0
                    ? fetchPack(store, repo, [...wants, ...haves, ...shallow, String(depth)].join('|'), selection.send)
                    : null;
                sendBuffer(res, 200, fetchV0Answer(selection, pack), 'application/x-git-upload-pack-result', requestId);
              }
            } catch {
              sendJson(res, 400, { message: 'Bad Request' }, requestId);
            }
            return;
          }
          if (method === 'POST' && action === 'git-receive-pack') {
            const body = await readBody(req);
            try {
              const { commands, pack } = parsePushBody(body);
              let packObjects: ReturnType<typeof readPack> = [];
              if (pack !== null) packObjects = readPack(pack, (oid) => store.getObject(oid));
              const outcome = applyPush(store, repo, commands, packObjects);
              store.invalidateRepoCache(repo);
              sendBuffer(res, 200, pushReportAnswer(outcome), 'application/x-git-receive-pack-result', requestId);
            } catch {
              sendJson(res, 400, { message: 'Bad Request' }, requestId);
            }
            return;
          }
          sendJson(res, 404, { message: 'Not Found' }, requestId);
          return;
        }

        // GraphQL.
        if (method === 'POST' && segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql') {
          const raw = await readBody(req);
          const parsed = parseJsonBody(raw);
          if (!parsed.ok) {
            sendJson(res, 400, { message: 'Invalid JSON' }, requestId);
            return;
          }
          const result = handleGraphQL(store, parsed.value);
          sendJson(res, result.status, result.value, requestId);
          return;
        }

        // MCP.
        if (segments.length === 1 && segments[0] === 'mcp') {
          if (method === 'DELETE') {
            sendJson(res, 200, {}, requestId);
            return;
          }
          if (method === 'POST') {
            const raw = await readBody(req);
            const result = handleMcp(store, raw.toString('utf8'));
            if (result.value === null) {
              res.writeHead(result.status, { 'x-github-request-id': requestId });
              res.end();
              return;
            }
            sendJson(res, result.status, result.value, requestId);
            return;
          }
          sendJson(res, 405, { message: 'Method Not Allowed' }, requestId);
          return;
        }

        // REST v3.
        if (segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3') {
          const matched = routeRest(method, segments);
          if (matched === null) {
            sendJson(res, 404, { message: 'Not Found' }, requestId);
            return;
          }
          let body: unknown;
          if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
            const raw = await readBody(req);
            const parsed = parseJsonBody(raw);
            if (!parsed.ok) {
              sendJson(res, 400, { message: 'Invalid JSON' }, requestId);
              return;
            }
            body = parsed.value;
          }
          const host = req.headers.host ?? '127.0.0.1';
          const result = matched.handler(store, matched.params, url.searchParams, body, host);
          sendRest(res, result, requestId);
          return;
        }

        sendJson(res, 404, { message: 'Not Found' }, requestId);
      } catch (error) {
        // A handler bug must never take the process down mid-suite.
        const message = error instanceof Error ? error.message : 'Internal Server Error';
        if (!res.headersSent) sendJson(res, 500, { message }, requestId);
        else if (!res.writableEnded) res.end();
      }
    })();
  });
  const app = server as Server & { store: Store };
  app.store = store;
  return app;
}
