// MCP: JSON-RPC 2.0 over streamable HTTP at /mcp, revision 2026-07-28
// (server/discover) with the legacy initialize handshake as a fallback.
// The tools act on the same store as REST, so a repository or issue created
// over MCP reads back over /api/v3 as the same object.

import { VIEWER, globalId, type Issue, type PullRequest, type Repo, type Store } from './store.ts';
import { diffTrees, issueJson, pullJson } from './rest.ts';

const SERVER_NAME = 'forge-mcp';
const SERVER_VERSION = '1.0.0';
const REVISION = '2026-07-28';
const SUPPORTED_REVISIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[] };
}

/** The tool list, built once: two tools/list calls answer byte-identical JSON. */
const TOOLS: readonly ToolDef[] = Object.freeze([
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        name: { type: 'string', description: 'Repository name.' },
        description: { type: 'string', description: 'Repository description.' },
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
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
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
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Issue title.' },
        body: { type: 'string', description: 'Issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'get_issue',
    description: 'Read one issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        issue_number: { type: 'integer', description: 'Issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Pull request title.' },
        body: { type: 'string', description: 'Pull request body.' },
        head: { type: 'string', description: 'Head branch name.' },
        base: { type: 'string', description: 'Base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'list_pull_requests',
    description: 'List the pull requests of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request onto its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        pull_number: { type: 'integer', description: 'Pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
]);

type McpValue = Record<string, unknown>;

function isRecord(value: unknown): value is McpValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function argString(args: McpValue, field: string): string {
  const value = args[field];
  return typeof value === 'string' ? value : '';
}

function argNumber(args: McpValue, field: string): number | null {
  const value = args[field];
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return parseInt(value, 10);
  return null;
}

function repoObject(repo: Repo): McpValue {
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

function issueObject(issue: Issue, repo: Repo): McpValue {
  return JSON.parse(issueJson(issue, repo).toString('utf8')) as McpValue;
}

function pullObject(pull: PullRequest, repo: Repo): McpValue {
  return JSON.parse(pullJson(pull, repo).toString('utf8')) as McpValue;
}

function resolveRepo(store: Store, args: McpValue): Repo | null {
  const owner = argString(args, 'owner');
  const repoName = argString(args, 'repo') || argString(args, 'name');
  if (owner === '' || repoName === '') return null;
  return store.getRepo(owner, repoName);
}

function toolError(message: string): McpValue {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function toolOk(value: unknown): McpValue {
  const text = JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value, isError: false };
}

/** Run one tool call against the store. */
function callTool(store: Store, name: string, args: McpValue): McpValue {
  switch (name) {
    case 'create_repo': {
      const repoName = argString(args, 'name');
      if (repoName === '') return toolError('Missing required argument: name');
      const description = argString(args, 'description');
      const isPrivate = typeof args.private === 'boolean' ? args.private : false;
      const repo = store.createRepo(repoName, isPrivate, description);
      if (repo === null) return toolError('Repository already exists');
      return toolOk(repoObject(repo));
    }
    case 'get_repo': {
      const repo = resolveRepo(store, args);
      if (repo === null) return toolError('Repository not found');
      return toolOk(repoObject(repo));
    }
    case 'create_issue': {
      const repo = resolveRepo(store, args);
      if (repo === null) return toolError('Repository not found');
      const title = argString(args, 'title');
      if (title === '') return toolError('Missing required argument: title');
      repo.seq += 1;
      const number = repo.seq;
      const issue: Issue = {
        number,
        restId: store.nextRestId(),
        gid: globalId('Issue', repo.id, number),
        title,
        body: argString(args, 'body'),
        state: 'open',
        labels: [],
        createdSeq: repo.seq,
        comments: [],
        jsonCache: null,
      };
      repo.issues.set(number, issue);
      return toolOk(issueObject(issue, repo));
    }
    case 'list_issues': {
      const repo = resolveRepo(store, args);
      if (repo === null) return toolError('Repository not found');
      const state = argString(args, 'state') || 'open';
      let issues = [...repo.issues.values()];
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => b.number - a.number);
      const list = issues.map((issue) => issueObject(issue, repo));
      return toolOk({ issues: list });
    }
    case 'get_issue': {
      const repo = resolveRepo(store, args);
      if (repo === null) return toolError('Repository not found');
      const number = argNumber(args, 'issue_number') ?? argNumber(args, 'number');
      if (number === null) return toolError('Missing required argument: issue_number');
      const issue = repo.issues.get(number);
      if (issue === undefined) return toolError('Issue not found');
      return toolOk(issueObject(issue, repo));
    }
    case 'create_pull_request': {
      const repo = resolveRepo(store, args);
      if (repo === null) return toolError('Repository not found');
      const title = argString(args, 'title');
      const head = argString(args, 'head');
      const base = argString(args, 'base');
      if (title === '' || head === '' || base === '') return toolError('Missing required argument: title, head or base');
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (headSha === undefined || baseSha === undefined) return toolError('Head or base branch does not exist');
      repo.seq += 1;
      const number = repo.seq;
      const pull: PullRequest = {
        number,
        restId: store.nextRestId(),
        gid: globalId('PullRequest', repo.id, number),
        title,
        body: argString(args, 'body'),
        state: 'open',
        head,
        base,
        headSha,
        baseSha,
        merged: false,
        mergedAt: null,
        mergeSha: null,
        createdSeq: repo.seq,
        jsonCache: null,
      };
      repo.pulls.set(number, pull);
      return toolOk(pullObject(pull, repo));
    }
    case 'list_pull_requests': {
      const repo = resolveRepo(store, args);
      if (repo === null) return toolError('Repository not found');
      const state = argString(args, 'state') || 'open';
      let pulls = [...repo.pulls.values()];
      if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
      pulls.sort((a, b) => b.number - a.number);
      return toolOk({ pull_requests: pulls.map((pull) => pullObject(pull, repo)) });
    }
    case 'merge_pull_request': {
      const repo = resolveRepo(store, args);
      if (repo === null) return toolError('Repository not found');
      const number = argNumber(args, 'pull_number') ?? argNumber(args, 'number');
      if (number === null) return toolError('Missing required argument: pull_number');
      const pull = repo.pulls.get(number);
      if (pull === undefined) return toolError('Pull request not found');
      if (pull.merged || pull.state === 'closed') return toolError('Pull request is already merged');
      const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
      const headTip = repo.refs.get(`refs/heads/${pull.head}`);
      if (baseTip === undefined || headTip === undefined) return toolError('Head or base branch does not exist');
      // A squash merge with the same conflict rule as the REST merge path.
      const prChanges = diffTrees(store, pull.baseSha, pull.headSha);
      const baseChanges = diffTrees(store, pull.baseSha, baseTip);
      const baseChanged = new Map<string, string>();
      for (const change of baseChanges) baseChanged.set(change.filename, store.blobAtPath(baseTip, change.filename)?.oid ?? '');
      for (const change of prChanges) {
        if (!baseChanged.has(change.filename)) continue;
        if ((store.blobAtPath(headTip, change.filename)?.oid ?? '') !== baseChanged.get(change.filename)) {
          return toolError('Merge conflict');
        }
      }
      const baseInfo = store.getCommitInfo(baseTip);
      let tree = baseInfo?.tree ?? null;
      for (const change of prChanges) {
        if (change.status === 'removed') tree = store.applyToTree(tree, change.filename, null);
        else {
          const blob = store.blobAtPath(headTip, change.filename);
          if (blob !== null) tree = store.applyToTree(tree, change.filename, blob.oid);
        }
      }
      const mergeSha = store.makeCommit(repo, tree ?? store.putObject('tree', Buffer.alloc(0)), [baseTip], `${pull.title} (#${pull.number})`);
      repo.refs.set(`refs/heads/${pull.base}`, mergeSha);
      repo.version += 1;
      pull.state = 'closed';
      pull.merged = true;
      pull.mergedAt = '2025-01-01T00:00:00Z';
      pull.mergeSha = mergeSha;
      pull.jsonCache = null;
      store.invalidateRepoCache(repo);
      return toolOk({ number: pull.number, merged: true, sha: mergeSha, state: 'closed' });
    }
    default:
      return toolError(`Unknown tool: ${name}`);
  }
}

function rpcResult(id: unknown, result: unknown): McpValue {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): McpValue {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function discoverResult(): McpValue {
  const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
  return {
    protocolVersion: REVISION,
    supportedVersions: [...SUPPORTED_REVISIONS],
    serverInfo,
    capabilities: { tools: {} },
    _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
  };
}

/** Handle one JSON-RPC request object. Returns null for notifications (no reply). */
function handleOne(store: Store, request: unknown): McpValue | null {
  if (!isRecord(request)) return rpcError(null, -32600, 'Invalid Request');
  const id = request.id;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = isRecord(request.params) ? request.params : {};
  const isNotification = id === undefined;
  if (method === 'server/discover') {
    if (isNotification) return null;
    return rpcResult(id, discoverResult());
  }
  if (method === 'initialize') {
    if (isNotification) return null;
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const negotiated = /^\d{4}-\d{2}-\d{2}$/.test(offered) ? offered : '2025-11-25';
    return rpcResult(id, {
      protocolVersion: negotiated,
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      capabilities: { tools: {} },
    });
  }
  if (method.startsWith('notifications/')) return null;
  if (method === 'ping') {
    if (isNotification) return null;
    return rpcResult(id, {});
  }
  if (method === 'tools/list') {
    if (isNotification) return null;
    return rpcResult(id, { tools: TOOLS });
  }
  if (method === 'tools/call') {
    if (isNotification) return null;
    const name = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? params.arguments : {};
    const tool = TOOLS.find((candidate) => candidate.name === name);
    if (tool === undefined) return rpcError(id, -32601, `Unknown tool: ${name}`);
    const missing = tool.inputSchema.required.filter((field) => args[field] === undefined || args[field] === null || args[field] === '');
    if (missing.length > 0) {
      return rpcResult(id, toolError(`Missing required argument: ${missing.join(', ')}`));
    }
    return rpcResult(id, callTool(store, name, args));
  }
  if (isNotification) return null;
  return rpcError(id, -32601, `Method not found: ${method}`);
}

/**
 * Handle a POST /mcp body (raw text). Returns the HTTP status and the value
 * to serialize (null when a notification carries no reply).
 */
export function handleMcp(store: Store, bodyText: string): { status: number; value: unknown } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return {
      status: 400,
      value: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    };
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => handleOne(store, entry)).filter((entry) => entry !== null);
    return { status: 200, value: results };
  }
  const result = handleOne(store, parsed);
  if (result === null) return { status: 202, value: null };
  return { status: 200, value: result };
}
