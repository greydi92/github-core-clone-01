// REST v3: repositories, branches, commits, contents, labels, issues,
// comments and pull requests, over the one in-memory store.
//
// Every reply is JSON with a non-empty X-GitHub-Request-Id (the app layer
// adds it); errors are JSON {message}. Ownership is absolute: a repository
// under any login but the token's is 404, never 403.

import {
  VIEWER,
  globalId,
  hashObject,
  type Issue,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';

export interface RestResult {
  status: number;
  /** A pre-serialized JSON Buffer, or a value to serialize, or undefined (204). */
  body?: Buffer | unknown;
  headers?: Record<string, string>;
}

export function json(status: number, value: unknown, headers?: Record<string, string>): RestResult {
  return { status, body: value, headers };
}

export function jsonBuf(status: number, buf: Buffer, headers?: Record<string, string>): RestResult {
  return { status, body: buf, headers };
}

export function err(status: number, message: string): RestResult {
  return { status, body: { message } };
}

const notFound = (what = 'Not Found'): RestResult => err(404, what);

// ---------------------------------------------------------------------------
// serializers (cached per object; invalidated on mutation)

function repoJson(repo: Repo): Buffer {
  if (repo.jsonCache !== null) return repo.jsonCache;
  const body = {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
  };
  repo.jsonCache = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
  return repo.jsonCache;
}

export function issueJson(issue: Issue, repo: Repo): Buffer {
  if (issue.jsonCache !== null) return issue.jsonCache;
  const body = {
    id: issue.restId,
    node_id: issue.gid,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed' };
    }),
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
  };
  issue.jsonCache = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
  return issue.jsonCache;
}

export function pullJson(pull: PullRequest, repo: Repo): Buffer {
  if (pull.jsonCache !== null) return pull.jsonCache;
  const body = {
    id: pull.restId,
    node_id: pull.gid,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.head, sha: pull.headSha, label: `${repo.owner}:${pull.head}` },
    base: { ref: pull.base, sha: pull.baseSha, label: `${repo.owner}:${pull.base}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeSha,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
  };
  pull.jsonCache = Buffer.from(`${JSON.stringify(body)}\n`, 'utf8');
  return pull.jsonCache;
}

function countLines(content: string): number {
  if (content === '') return 0;
  const parts = content.split('\n');
  return content.endsWith('\n') ? parts.length - 1 : parts.length;
}

export interface FileChange {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

/** The file diff between two commit trees, with line counts. */
export function diffTrees(store: Store, baseCommit: string, headCommit: string): FileChange[] {
  const baseInfo = store.getCommitInfo(baseCommit);
  const headInfo = store.getCommitInfo(headCommit);
  const baseFlat = baseInfo === null ? new Map() : store.flattenTree(baseInfo.tree);
  const headFlat = headInfo === null ? new Map() : store.flattenTree(headInfo.tree);
  const changes: FileChange[] = [];
  const paths = new Set([...baseFlat.keys(), ...headFlat.keys()]);
  for (const path of [...paths].sort()) {
    const from = baseFlat.get(path);
    const to = headFlat.get(path);
    if (from !== undefined && to !== undefined && from.oid === to.oid) continue;
    if (from === undefined && to !== undefined) {
      const data = store.getObject(to.oid)?.data.toString('utf8') ?? '';
      const additions = countLines(data);
      changes.push({ filename: path, status: 'added', additions, deletions: 0, changes: additions });
    } else if (from !== undefined && to === undefined) {
      const data = store.getObject(from.oid)?.data.toString('utf8') ?? '';
      const deletions = countLines(data);
      changes.push({ filename: path, status: 'removed', additions: 0, deletions, changes: deletions });
    } else if (from !== undefined && to !== undefined) {
      const oldData = store.getObject(from.oid)?.data.toString('utf8') ?? '';
      const newData = store.getObject(to.oid)?.data.toString('utf8') ?? '';
      const additions = countLines(newData);
      const deletions = countLines(oldData);
      changes.push({ filename: path, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return changes;
}

// ---------------------------------------------------------------------------
// contents commits

interface ContentCommitResult {
  status: number;
  contentSha: string;
  commitSha: string;
  created: boolean;
}

/**
 * Write one file through the contents API: blob, tree, commit, ref move.
 * `expectedSha` is the blob sha the caller believes is current; a mismatch
 * is 409. A create without a sha over an existing file is 422.
 */
function commitFile(
  store: Store,
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer,
  message: string,
  expectedSha?: string,
): { ok: true; result: ContentCommitResult } | { ok: false; result: RestResult } {
  const tip = repo.refs.get(`refs/heads/${branch}`) ?? repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  const current = tip === null ? null : store.blobAtPath(tip, path);
  if (expectedSha !== undefined) {
    if (current === null || current.oid.toLowerCase() !== expectedSha.toLowerCase()) {
      return { ok: false, result: err(409, 'sha does not match the current file') };
    }
  } else if (current !== null) {
    return { ok: false, result: err(422, 'file already exists') };
  }
  const blobOid = store.putObject('blob', content);
  const baseTree = tip === null ? null : (store.getCommitInfo(tip)?.tree ?? null);
  const newTree = store.applyToTree(baseTree, path, blobOid);
  const parents = tip === null ? [] : [tip];
  const commitSha = store.makeCommit(repo, newTree, parents, message);
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  repo.version += 1;
  store.invalidateRepoCache(repo);
  return {
    ok: true,
    result: { status: current === null ? 201 : 200, contentSha: blobOid, commitSha, created: current === null },
  };
}

function deleteFile(
  store: Store,
  repo: Repo,
  branch: string,
  path: string,
  message: string,
  expectedSha?: string,
): { ok: true; commitSha: string } | { ok: false; result: RestResult } {
  const tip = repo.refs.get(`refs/heads/${branch}`) ?? repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  if (tip === null) return { ok: false, result: notFound() };
  const current = store.blobAtPath(tip, path);
  if (current === null) return { ok: false, result: notFound() };
  if (expectedSha !== undefined && current.oid.toLowerCase() !== expectedSha.toLowerCase()) {
    return { ok: false, result: err(409, 'sha does not match the current file') };
  }
  const baseTree = store.getCommitInfo(tip)?.tree ?? null;
  const newTree = store.applyToTree(baseTree, path, null);
  const commitSha = store.makeCommit(repo, newTree, [tip], message);
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  repo.version += 1;
  store.invalidateRepoCache(repo);
  return { ok: true, commitSha };
}

// ---------------------------------------------------------------------------
// the router: method + path segments -> a result

export type RestHandler = (
  store: Store,
  params: Record<string, string>,
  query: URLSearchParams,
  body: unknown,
  host: string,
) => RestResult;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function bodyString(body: unknown, field: string): string {
  if (!isRecord(body)) return '';
  const value = body[field];
  return typeof value === 'string' ? value : '';
}

function bodyBool(body: unknown, field: string, fallback: boolean): boolean {
  if (!isRecord(body)) return fallback;
  const value = body[field];
  return typeof value === 'boolean' ? value : fallback;
}

/** Resolve a repo from the URL owner/name, or the 404 for a foreign/missing one. */
function resolveRepo(store: Store, params: Record<string, string>): Repo | null {
  const owner = params.owner ?? '';
  const name = params.repo ?? '';
  return store.getRepo(owner, name);
}

function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(query.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}

function paginate<T>(items: readonly T[], page: number, perPage: number): T[] {
  return items.slice((page - 1) * perPage, page * perPage);
}

// ---------------------------------------------------------------------------
// route handlers

function apiRoot(): RestResult {
  return json(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
}

function meta(): RestResult {
  return json(200, { installed_version: '1.0.0' });
}

function getUser(): RestResult {
  return json(200, { login: VIEWER.login, id: VIEWER.id, name: VIEWER.name, email: VIEWER.email, type: 'User' });
}

function listUserRepos(store: Store, query: URLSearchParams, host: string): RestResult {
  const { page, perPage } = pageParams(query);
  const repos = store.listViewerRepos();
  const items = paginate(repos, page, perPage).map((repo) => JSON.parse(repoJson(repo).toString('utf8')));
  const headers: Record<string, string> = {};
  const totalPages = Math.max(1, Math.ceil(repos.length / perPage));
  if (page < totalPages) {
    const next = `http://${host}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}`;
    const last = `http://${host}/api/v3/user/repos?per_page=${perPage}&page=${totalPages}`;
    headers.link = `<${next}>; rel="next", <${last}>; rel="last"`;
  }
  return json(200, items, headers);
}

function createUserRepo(store: Store, body: unknown): RestResult {
  const name = bodyString(body, 'name');
  if (name === '') return err(422, 'name is required');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) return err(422, 'invalid repository name');
  const repo = store.createRepo(name, bodyBool(body, 'private', false), bodyString(body, 'description'));
  if (repo === null) return err(422, 'Repository already exists');
  return jsonBuf(201, repoJson(repo));
}

function getRepo(store: Store, params: Record<string, string>): RestResult {
  const repo = resolveRepo(store, params);
  if (repo === null) return notFound();
  return jsonBuf(200, repoJson(repo));
}

function patchRepo(store: Store, params: Record<string, string>, body: unknown): RestResult {
  const repo = resolveRepo(store, params);
  if (repo === null) return notFound();
  if (isRecord(body) && typeof body.description === 'string') {
    repo.description = body.description;
    store.invalidateRepoCache(repo);
  }
  return jsonBuf(200, repoJson(repo));
}

function deleteRepo(store: Store, params: Record<string, string>): RestResult {
  const deleted = store.deleteRepo(params.owner ?? '', params.repo ?? '');
  if (!deleted) return notFound();
  return { status: 204 };
}

function listBranches(store: Store, params: Record<string, string>): RestResult {
  const repo = resolveRepo(store, params);
  if (repo === null) return notFound();
  const branches = [...repo.refs.keys()]
    .filter((name) => name.startsWith('refs/heads/'))
    .sort()
    .map((name) => ({ name: name.slice('refs/heads/'.length), commit: { sha: repo.refs.get(name) as string } }));
  return json(200, branches);
}

function getBranch(store: Store, params: Record<string, string>): RestResult {
  const repo = resolveRepo(store, params);
  if (repo === null) return notFound();
  const name = params.branch ?? '';
  const sha = repo.refs.get(`refs/heads/${name}`);
  if (sha === undefined) return notFound();
  return json(200, { name, commit: { sha }, protected: false });
}

function listCommits(store: Store, params: Record<string, string>, query: URLSearchParams): RestResult {
  const repo = resolveRepo(store, params);
  if (repo === null) return notFound();
  const refName = query.get('sha') ?? repo.defaultBranch;
  let tip = repo.refs.get(`refs/heads/${refName}`);
  if (tip === undefined && /^[0-9a-f]{40}$/i.test(refName)) tip = refName;
  if (tip === undefined) {
    if (repo.refs.size === 0) return json(200, []);
    return notFound('No such ref');
  }
  const seen = new Set<string>();
  const out: Array<{ sha: string; commit: { message: string } }> = [];
  const stack: string[] = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const info = store.getCommitInfo(oid);
    if (info === null) continue;
    // The stored commit object ends its message with a newline (git's own
    // convention); the API presents the message without it.
    out.push({ sha: oid, commit: { message: info.message.replace(/\n$/, '') } });
    for (let i = info.parents.length - 1; i >= 0; i -= 1) stack.push(info.parents[i] as string);
  }
  return json(200, out);
}

function createRef(store: Store, params: Record<string, string>, body: unknown): RestResult {
  const repo = resolveRepo(store, params);
  if (repo === null) return notFound();
  const ref = bodyString(body, 'ref');
  const sha = bodyString(body, 'sha');
  if (!ref.startsWith('refs/')) return err(422, 'invalid ref');
  if (!/^[0-9a-f]{40}$/i.test(sha)) return err(422, 'invalid sha');
  if (repo.refs.has(ref)) return err(422, 'Reference already exists');
  const obj = store.getObject(sha);
  if (obj === undefined || obj.type !== 'commit') return err(422, 'sha is not a commit');
  repo.refs.set(ref, sha);
  repo.version += 1;
  store.invalidateRepoCache(repo);
  return json(201, { ref, object: { sha } });
}

function getRef(store: Store, params: Record<string, string>): RestResult {
  const repo = resolveRepo(store, params);
  if (repo === null) return notFound();
  const name = params.branch ?? '';
  const sha = repo.refs.get(`refs/heads/${name}`);
  if (sha === undefined) return notFound();
  return json(200, { ref: `refs/heads/${name}`, object: { sha } });
}

/** Resolve a contents ref (?ref=branch or oid) to a commit oid, or null. */
function resolveContentsRef(store: Store, repo: Repo, query: URLSearchParams): string | null {
  const ref = query.get('ref');
  if (ref === null) return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  const byBranch = repo.refs.get(`refs/heads/${ref}`);
  if (byBranch !== undefined) return byBranch;
  if (/^[0-9a-f]{40}$/i.test(ref) && store.getObject(ref)?.type === 'commit') return ref;
  return null;
}

function getContents(store: Store, params: Record<string, string>, query: URLSearchParams): RestResult {
  const repo = resolveRepo(store, params);
  if (repo === null) return notFound();
  const path = params.path ?? '';
  const tip = resolveContentsRef(store, repo, query);
  if (tip === null) return notFound();
  const blob = store.blobAtPath(tip, path);
  if (blob !== null) {
    return json(200, {
      type: 'file',
      encoding: 'base64',
      size: blob.data.length,
      name: path.split('/').pop() ?? path,
      path,
      content: blob.data.toString('base64'),
      sha: blob.oid,
    });
  }
  const dir = store.listDir(tip, path);
  if (dir !== null) return json(200, dir);
  return notFound();
}

function putContents(store: Store, params: Record<string, string>, query: URLSearchParams, body: unknown): RestResult {
  const repo = resolveRepo(store, params);
  if (repo === null) return notFound();
  const path = params.path ?? '';
  const message = bodyString(body, 'message');
  const contentB64 = bodyString(body, 'content');
  if (contentB64 === '') return err(422, 'content is required');
  let content: Buffer;
  try {
    content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
  } catch {
    return err(422, 'content is not valid base64');
  }
  // The branch comes from the body (`branch`, as the suite and GitHub send
  // it), or from a ?branch= / ?ref= query when the caller puts it in the URL.
  const branch =
    (isRecord(body) && typeof body.branch === 'string' ? body.branch : '') ||
    query.get('branch') ||
    query.get('ref') ||
    repo.defaultBranch;
  const sha = isRecord(body) && typeof body.sha === 'string' ? body.sha : undefined;
  const done = commitFile(store, repo, branch, path, content, message, sha);
  if (!done.ok) return done.result;
  return json(done.result.status, {
    content: { name: path.split('/').pop() ?? path, path, sha: done.result.contentSha, size: content.length, type: 'file', encoding: 'base64' },
    commit: { sha: done.result.commitSha, message },
  });
}

function deleteContents(store: Store, params: Record<string, string>, body: unknown): RestResult {
  const repo = resolveRepo(store, params);
  if (repo === null) return notFound();
  const path = params.path ?? '';
  const message = bodyString(body, 'message');
  const sha = isRecord(body) && typeof body.sha === 'string' ? body.sha : undefined;
  const done = deleteFile(store, repo, repo.defaultBranch, path, message, sha);
  if (!done.ok) return done.result;
  return json(200, { commit: { sha: done.commitSha } });
}

function createLabel(store: Store, params: Record<string, string>, body: unknown): RestResult {
  const repo = resolveRepo(store, params);
  if (repo === null) return notFound();
  const name = bodyString(body, 'name');
  if (name === '') return err(422, 'name is required');
  if (repo.labels.has(name)) return err(422, 'Label already exists');
  const color = bodyString(body, 'color') || 'ededed';
  repo.labels.set(name, { name, color });
  return json(201, { name, color, description: '' });
}

function createIssue(store: Store, params: Record<string, string>, body: unknown): RestResult {
  const repo = resolveRepo(store, params);
  if (repo === null) return notFound();
  const title = bodyString(body, 'title');
  if (title === '') return err(422, 'title is required');
  const labels: string[] = isRecord(body) && Array.isArray(body.labels) ? body.labels.filter((l): l is string => typeof l === 'string') : [];
  for (const label of labels) {
    if (!repo.labels.has(label)) return err(422, `Label '${label}' does not exist`);
  }
  repo.seq += 1;
  const number = repo.seq;
  const restId = store.nextRestId();
  const issue: Issue = {
    number,
    restId,
    gid: globalId('Issue', repo.id, number),
    title,
    body: bodyString(body, 'body'),
    state: 'open',
    labels: [...labels],
    createdSeq: repo.seq,
    comments: [],
    jsonCache: null,
  };
  repo.issues.set(number, issue);
  return jsonBuf(201, issueJson(issue, repo));
}

function listIssues(store: Store, params: Record<string, string>, query: URLSearchParams): RestResult {
  const repo = resolveRepo(store, params);
  if (repo === null) return notFound();
  const state = query.get('state') ?? 'open';
  const sort = query.get('sort') ?? 'created';
  const direction = query.get('direction') ?? 'desc';
  let issues = [...repo.issues.values()];
  if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
  if (sort === 'created') {
    issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  }
  const { page, perPage } = pageParams(query);
  const items = paginate(issues, page, perPage).map((issue) => JSON.parse(issueJson(issue, repo).toString('utf8')));
  return json(200, items);
}

function getIssue(store: Store, params: Record<string, string>): RestResult {
  const repo = resolveRepo(store, params);
  if (repo === null) return notFound();
  const issue = repo.issues.get(parseInt(params.number ?? '', 10));
  if (issue === undefined) return notFound();
  return jsonBuf(200, issueJson(issue, repo));
}

function patchIssue(store: Store, params: Record<string, string>, body: unknown): RestResult {
  const repo = resolveRepo(store, params);
  if (repo === null) return notFound();
  const issue = repo.issues.get(parseInt(params.number ?? '', 10));
  if (issue === undefined) return notFound();
  if (isRecord(body) && (body.state === 'open' || body.state === 'closed')) {
    issue.state = body.state;
    issue.jsonCache = null;
  }
  if (isRecord(body) && typeof body.title === 'string') {
    issue.title = body.title;
    issue.jsonCache = null;
  }
  if (isRecord(body) && typeof body.body === 'string') {
    issue.body = body.body;
    issue.jsonCache = null;
  }
  return jsonBuf(200, issueJson(issue, repo));
}

function createComment(store: Store, params: Record<string, string>, body: unknown): RestResult {
  const repo = resolveRepo(store, params);
  if (repo === null) return notFound();
  const issue = repo.issues.get(parseInt(params.number ?? '', 10));
  if (issue === undefined) return notFound();
  const text = bodyString(body, 'body');
  repo.commentSeq += 1;
  const id = repo.commentSeq;
  issue.comments.push({ id, gid: globalId('IssueComment', repo.id, issue.number, id), body: text });
  return json(201, { id, body: text, user: { login: VIEWER.login, id: VIEWER.id, type: 'User' } });
}

function listComments(store: Store, params: Record<string, string>): RestResult {
  const repo = resolveRepo(store, params);
  if (repo === null) return notFound();
  const issue = repo.issues.get(parseInt(params.number ?? '', 10));
  if (issue === undefined) return notFound();
  return json(
    200,
    issue.comments.map((comment) => ({ id: comment.id, body: comment.body, user: { login: VIEWER.login, id: VIEWER.id, type: 'User' } })),
  );
}

function createPull(store: Store, params: Record<string, string>, body: unknown): RestResult {
  const repo = resolveRepo(store, params);
  if (repo === null) return notFound();
  const title = bodyString(body, 'title');
  const head = bodyString(body, 'head');
  const base = bodyString(body, 'base');
  if (title === '' || head === '' || base === '') return err(422, 'title, head and base are required');
  const headSha = repo.refs.get(`refs/heads/${head}`);
  const baseSha = repo.refs.get(`refs/heads/${base}`);
  if (headSha === undefined || baseSha === undefined) return err(422, 'head or base branch does not exist');
  for (const existing of repo.pulls.values()) {
    if (existing.state === 'open' && existing.head === head && existing.base === base) {
      return err(422, 'A pull request already exists for this head and base');
    }
  }
  repo.seq += 1;
  const number = repo.seq;
  const restId = store.nextRestId();
  const pull: PullRequest = {
    number,
    restId,
    gid: globalId('PullRequest', repo.id, number),
    title,
    body: bodyString(body, 'body'),
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
  return jsonBuf(201, pullJson(pull, repo));
}

function listPulls(store: Store, params: Record<string, string>, query: URLSearchParams): RestResult {
  const repo = resolveRepo(store, params);
  if (repo === null) return notFound();
  const state = query.get('state') ?? 'open';
  let pulls = [...repo.pulls.values()];
  if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
  pulls.sort((a, b) => b.number - a.number);
  const { page, perPage } = pageParams(query);
  const items = paginate(pulls, page, perPage).map((pull) => JSON.parse(pullJson(pull, repo).toString('utf8')));
  return json(200, items);
}

function getPull(store: Store, params: Record<string, string>): RestResult {
  const repo = resolveRepo(store, params);
  if (repo === null) return notFound();
  const pull = repo.pulls.get(parseInt(params.number ?? '', 10));
  if (pull === undefined) return notFound();
  return jsonBuf(200, pullJson(pull, repo));
}

function listPullFiles(store: Store, params: Record<string, string>): RestResult {
  const repo = resolveRepo(store, params);
  if (repo === null) return notFound();
  const pull = repo.pulls.get(parseInt(params.number ?? '', 10));
  if (pull === undefined) return notFound();
  return json(200, diffTrees(store, pull.baseSha, pull.headSha));
}

function mergePull(store: Store, params: Record<string, string>): RestResult {
  const repo = resolveRepo(store, params);
  if (repo === null) return notFound();
  const pull = repo.pulls.get(parseInt(params.number ?? '', 10));
  if (pull === undefined) return notFound();
  if (pull.merged || pull.state === 'closed') return err(405, 'Pull request is already merged');
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
  if (baseTip === undefined) return notFound('Base branch does not exist');
  const headTip = repo.refs.get(`refs/heads/${pull.head}`);
  if (headTip === undefined) return err(422, 'Head branch does not exist');
  // Conflict: a path the PR changes that the base also changed since the PR
  // opened, to different bytes.
  const prChanges = diffTrees(store, pull.baseSha, pull.headSha);
  const baseChanges = diffTrees(store, pull.baseSha, baseTip);
  const baseChanged = new Map<string, string>();
  for (const change of baseChanges) {
    const blob = store.blobAtPath(baseTip, change.filename);
    baseChanged.set(change.filename, blob?.oid ?? '');
  }
  for (const change of prChanges) {
    if (!baseChanged.has(change.filename)) continue;
    const headBlob = store.blobAtPath(headTip, change.filename);
    if ((headBlob?.oid ?? '') !== baseChanged.get(change.filename)) {
      return err(405, 'Merge conflict');
    }
  }
  // Squash: the PR's file changes applied onto the current base tip.
  const baseInfo = store.getCommitInfo(baseTip);
  let tree = baseInfo?.tree ?? null;
  for (const change of prChanges) {
    if (change.status === 'removed') {
      tree = store.applyToTree(tree, change.filename, null);
    } else {
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
  return json(200, { sha: mergeSha, merged: true, message: 'Pull request successfully merged' });
}

// ---------------------------------------------------------------------------
// dispatch table: [method, pattern segments, handler]
// A segment starting with ':' captures one path segment; ':path' captures the rest.

type Pattern = readonly string[];

const ROUTES: Array<{ method: string; pattern: Pattern; handler: RestHandler }> = [
  { method: 'GET', pattern: ['api', 'v3'], handler: () => apiRoot() },
  { method: 'GET', pattern: ['api', 'v3', 'meta'], handler: () => meta() },
  { method: 'GET', pattern: ['api', 'v3', 'user'], handler: () => getUser() },
  { method: 'GET', pattern: ['api', 'v3', 'user', 'repos'], handler: (s, _p, q, _b, h) => listUserRepos(s, q, h) },
  { method: 'POST', pattern: ['api', 'v3', 'user', 'repos'], handler: (s, _p, _q, b) => createUserRepo(s, b) },
  { method: 'GET', pattern: ['api', 'v3', 'repos', ':owner', ':repo'], handler: (s, p) => getRepo(s, p) },
  { method: 'PATCH', pattern: ['api', 'v3', 'repos', ':owner', ':repo'], handler: (s, p, _q, b) => patchRepo(s, p, b) },
  { method: 'DELETE', pattern: ['api', 'v3', 'repos', ':owner', ':repo'], handler: (s, p) => deleteRepo(s, p) },
  { method: 'GET', pattern: ['api', 'v3', 'repos', ':owner', ':repo', 'branches'], handler: (s, p) => listBranches(s, p) },
  { method: 'GET', pattern: ['api', 'v3', 'repos', ':owner', ':repo', 'branches', ':branch'], handler: (s, p) => getBranch(s, p) },
  { method: 'GET', pattern: ['api', 'v3', 'repos', ':owner', ':repo', 'commits'], handler: (s, p, q) => listCommits(s, p, q) },
  { method: 'POST', pattern: ['api', 'v3', 'repos', ':owner', ':repo', 'git', 'refs'], handler: (s, p, _q, b) => createRef(s, p, b) },
  { method: 'GET', pattern: ['api', 'v3', 'repos', ':owner', ':repo', 'git', 'refs', 'heads', ':branch'], handler: (s, p) => getRef(s, p) },
  { method: 'GET', pattern: ['api', 'v3', 'repos', ':owner', ':repo', 'contents', ':path'], handler: (s, p, q) => getContents(s, p, q) },
  { method: 'PUT', pattern: ['api', 'v3', 'repos', ':owner', ':repo', 'contents', ':path'], handler: (s, p, q, b) => putContents(s, p, q, b) },
  { method: 'DELETE', pattern: ['api', 'v3', 'repos', ':owner', ':repo', 'contents', ':path'], handler: (s, p, _q, b) => deleteContents(s, p, b) },
  { method: 'POST', pattern: ['api', 'v3', 'repos', ':owner', ':repo', 'labels'], handler: (s, p, _q, b) => createLabel(s, p, b) },
  { method: 'GET', pattern: ['api', 'v3', 'repos', ':owner', ':repo', 'issues'], handler: (s, p, q) => listIssues(s, p, q) },
  { method: 'POST', pattern: ['api', 'v3', 'repos', ':owner', ':repo', 'issues'], handler: (s, p, _q, b) => createIssue(s, p, b) },
  { method: 'GET', pattern: ['api', 'v3', 'repos', ':owner', ':repo', 'issues', ':number'], handler: (s, p) => getIssue(s, p) },
  { method: 'PATCH', pattern: ['api', 'v3', 'repos', ':owner', ':repo', 'issues', ':number'], handler: (s, p, _q, b) => patchIssue(s, p, b) },
  { method: 'GET', pattern: ['api', 'v3', 'repos', ':owner', ':repo', 'issues', ':number', 'comments'], handler: (s, p) => listComments(s, p) },
  { method: 'POST', pattern: ['api', 'v3', 'repos', ':owner', ':repo', 'issues', ':number', 'comments'], handler: (s, p, _q, b) => createComment(s, p, b) },
  { method: 'GET', pattern: ['api', 'v3', 'repos', ':owner', ':repo', 'pulls'], handler: (s, p, q) => listPulls(s, p, q) },
  { method: 'POST', pattern: ['api', 'v3', 'repos', ':owner', ':repo', 'pulls'], handler: (s, p, _q, b) => createPull(s, p, b) },
  { method: 'GET', pattern: ['api', 'v3', 'repos', ':owner', ':repo', 'pulls', ':number'], handler: (s, p) => getPull(s, p) },
  { method: 'GET', pattern: ['api', 'v3', 'repos', ':owner', ':repo', 'pulls', ':number', 'files'], handler: (s, p) => listPullFiles(s, p) },
  { method: 'PUT', pattern: ['api', 'v3', 'repos', ':owner', ':repo', 'pulls', ':number', 'merge'], handler: (s, p) => mergePull(s, p) },
];

/** Match a method + path against the table. Returns the handler or null. */
export function routeRest(method: string, segments: string[]): { handler: RestHandler; params: Record<string, string> } | null {
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const params: Record<string, string> = {};
    let matched = true;
    for (let i = 0; i < route.pattern.length; i += 1) {
      const want = route.pattern[i] as string;
      if (want === ':path') {
        params.path = segments.slice(i).map(decodeURIComponent).join('/');
        break;
      }
      const got = segments[i];
      if (got === undefined) {
        matched = false;
        break;
      }
      if (want.startsWith(':')) {
        params[want.slice(1)] = decodeURIComponent(got);
      } else if (want !== got) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;
    // A non-:path pattern must consume every segment; a :path pattern ends the match.
    const last = route.pattern[route.pattern.length - 1] as string;
    if (last !== ':path' && segments.length !== route.pattern.length) continue;
    return { handler: route.handler, params };
  }
  return null;
}
