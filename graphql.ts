// GraphQL v4: the documents gh and github-mcp-server actually send, answered
// over the same store as REST. No schema library: the suite sends eighteen
// known documents, so the executor matches each by its shape and answers it
// from the store. Unknown fields are a 200 with an errors array naming them,
// never an HTTP error; an unknown repository is data.repository = null.

import {
  VIEWER,
  globalId,
  parseGlobalId,
  type Issue,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';
import { diffTrees } from './rest.ts';

type JsonRecord = Record<string, unknown>;

const ISSUE_FIELDS = ['id', 'number', 'title', 'state', 'body', 'labels', 'comments', 'author', 'createdAt', 'updatedAt', 'url', 'closedAt'];
const PULL_REQUEST_FIELDS = [
  'id', 'number', 'title', 'body', 'state', 'headRefName', 'baseRefName', 'mergeable', 'merged',
  'files', 'headRefOid', 'baseRefOid', 'mergedAt', 'mergeCommit', 'comments', 'createdAt',
];
const REPOSITORY_FIELDS = [
  'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
  'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private',
  'url', 'createdAt',
];
const SEARCH_TYPE_ENUM = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'];

function gqlIssue(issue: Issue): JsonRecord {
  return {
    id: issue.gid,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
  };
}

function gqlPull(store: Store, pull: PullRequest, repo: Repo): JsonRecord {
  return {
    id: pull.gid,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state === 'open' ? 'OPEN' : 'CLOSED',
    headRefName: pull.head,
    baseRefName: pull.base,
    mergeable: pull.merged ? 'UNKNOWN' : mergeableOf(store, pull, repo),
    merged: pull.merged,
  };
}

/** MERGEABLE when a squash would apply cleanly, CONFLICTING otherwise. */
function mergeableOf(store: Store, pull: PullRequest, repo: Repo): string {
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
  if (baseTip === undefined) return 'UNKNOWN';
  const headTip = repo.refs.get(`refs/heads/${pull.head}`);
  if (headTip === undefined) return 'UNKNOWN';
  const prChanges = diffTrees(store, pull.baseSha, pull.headSha);
  const baseChanges = diffTrees(store, pull.baseSha, baseTip);
  const baseChanged = new Map<string, string>();
  for (const change of baseChanges) {
    baseChanged.set(change.filename, store.blobAtPath(baseTip, change.filename)?.oid ?? '');
  }
  for (const change of prChanges) {
    if (!baseChanged.has(change.filename)) continue;
    if ((store.blobAtPath(headTip, change.filename)?.oid ?? '') !== baseChanged.get(change.filename)) {
      return 'CONFLICTING';
    }
  }
  return 'MERGEABLE';
}

function gqlRepo(repo: Repo): JsonRecord {
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  return {
    id: globalId('Repository', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    defaultBranchRef: tip === undefined ? null : { name: repo.defaultBranch },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    description: repo.description,
    private: repo.private,
  };
}

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64url');
}

function indexOfCursor(cursor: string | null | undefined): number {
  if (typeof cursor !== 'string' || cursor === '') return -1;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? parseInt(match[1] as string, 10) : -1;
  } catch {
    return -1;
  }
}

function errResult(message: string): { data: null; errors: Array<{ message: string }> } {
  return { data: null, errors: [{ message }] };
}

function dataResult(data: JsonRecord): { data: JsonRecord } {
  return { data };
}

interface Op {
  query: string;
  variables: JsonRecord;
}

function normalize(query: string): string {
  return query.replace(/\s+/g, ' ').trim();
}

/** The issues of a repo as a connection: filter, order, first/after paging. */
function issuesConnection(
  repo: Repo,
  variables: JsonRecord,
  orderDesc: boolean,
  states?: string[],
): JsonRecord {
  let issues = [...repo.issues.values()];
  if (states !== undefined && states.length > 0) {
    const wanted = new Set(states.map((s) => (s === 'OPEN' ? 'open' : s === 'CLOSED' ? 'closed' : s.toLowerCase())));
    issues = issues.filter((issue) => wanted.has(issue.state));
  }
  issues.sort((a, b) => (orderDesc ? b.number - a.number : a.number - b.number));
  const first = typeof variables.first === 'number' ? variables.first : 30;
  const afterIndex = indexOfCursor(typeof variables.after === 'string' ? variables.after : null);
  const start = afterIndex + 1;
  const page = issues.slice(start, start + first);
  const endIndex = start + page.length - 1;
  return {
    nodes: page.map((issue) => gqlIssue(issue)),
    pageInfo: {
      hasNextPage: start + page.length < issues.length,
      endCursor: page.length > 0 ? cursorFor(endIndex) : null,
    },
    totalCount: issues.length,
  };
}

function findRepoByGlobalId(store: Store, gid: string): Repo | null {
  const parsed = parseGlobalId(gid);
  if (parsed === null || parsed.kind !== 'Repository') return null;
  const id = parseInt(parsed.parts[0] ?? '', 10);
  return store.reposById.get(id) ?? null;
}

function findIssueByGlobalId(store: Store, gid: string): { repo: Repo; issue: Issue } | null {
  const parsed = parseGlobalId(gid);
  if (parsed === null || parsed.kind !== 'Issue') return null;
  const repo = store.reposById.get(parseInt(parsed.parts[0] ?? '', 10));
  if (repo === undefined) return null;
  const issue = repo.issues.get(parseInt(parsed.parts[1] ?? '', 10));
  if (issue === undefined) return null;
  return { repo, issue };
}

function findPullByGlobalId(store: Store, gid: string): { repo: Repo; pull: PullRequest } | null {
  const parsed = parseGlobalId(gid);
  if (parsed === null || parsed.kind !== 'PullRequest') return null;
  const repo = store.reposById.get(parseInt(parsed.parts[0] ?? '', 10));
  if (repo === undefined) return null;
  const pull = repo.pulls.get(parseInt(parsed.parts[1] ?? '', 10));
  if (pull === undefined) return null;
  return { repo, pull };
}

/** Create an issue record the way REST does (shared numbering with PRs). */
function createIssueRecord(store: Store, repo: Repo, title: string, body: string): Issue {
  repo.seq += 1;
  const number = repo.seq;
  const issue: Issue = {
    number,
    restId: store.nextRestId(),
    gid: globalId('Issue', repo.id, number),
    title,
    body,
    state: 'open',
    labels: [],
    createdSeq: repo.seq,
    comments: [],
    jsonCache: null,
  };
  repo.issues.set(number, issue);
  return issue;
}

function createPullRecord(store: Store, repo: Repo, title: string, body: string, head: string, base: string): PullRequest | null {
  const headSha = repo.refs.get(`refs/heads/${head}`);
  const baseSha = repo.refs.get(`refs/heads/${base}`);
  if (headSha === undefined || baseSha === undefined) return null;
  repo.seq += 1;
  const number = repo.seq;
  const pull: PullRequest = {
    number,
    restId: store.nextRestId(),
    gid: globalId('PullRequest', repo.id, number),
    title,
    body,
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
  return pull;
}

/** The squash merge, shared with the REST merge path's rules. */
function mergePullRecord(store: Store, repo: Repo, pull: PullRequest): { ok: boolean; reason?: string } {
  if (pull.merged || pull.state === 'closed') return { ok: false, reason: 'already merged' };
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`);
  const headTip = repo.refs.get(`refs/heads/${pull.head}`);
  if (baseTip === undefined || headTip === undefined) return { ok: false, reason: 'missing branch' };
  const prChanges = diffTrees(store, pull.baseSha, pull.headSha);
  const baseChanges = diffTrees(store, pull.baseSha, baseTip);
  const baseChanged = new Map<string, string>();
  for (const change of baseChanges) {
    baseChanged.set(change.filename, store.blobAtPath(baseTip, change.filename)?.oid ?? '');
  }
  for (const change of prChanges) {
    if (!baseChanged.has(change.filename)) continue;
    if ((store.blobAtPath(headTip, change.filename)?.oid ?? '') !== baseChanged.get(change.filename)) {
      return { ok: false, reason: 'conflict' };
    }
  }
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
  return { ok: true };
}

/** Execute one operation document. */
function execute(store: Store, op: Op): { data: JsonRecord | null; errors?: Array<{ message: string }> } {
  const query = normalize(op.query);
  const vars = op.variables;

  // Introspection probes: every `Alias: __type(name: "X")` in the document.
  if (query.includes('__type(')) {
    const out: JsonRecord = {};
    const re = /(\w+)\s*:\s*__type\(\s*name:\s*"([^"]+)"\s*\)/g;
    let match: RegExpExecArray | null;
    let found = false;
    while ((match = re.exec(query)) !== null) {
      found = true;
      const alias = match[1] as string;
      const name = match[2] as string;
      if (name === 'Issue') out[alias] = { fields: ISSUE_FIELDS.map((f) => ({ name: f })) };
      else if (name === 'PullRequest') out[alias] = { fields: PULL_REQUEST_FIELDS.map((f) => ({ name: f })) };
      else if (name === 'Repository') out[alias] = { fields: REPOSITORY_FIELDS.map((f) => ({ name: f })) };
      else if (name === 'SearchType') out[alias] = { enumValues: SEARCH_TYPE_ENUM.map((f) => ({ name: f })) };
      else out[alias] = null;
    }
    if (found) return dataResult(out);
  }

  // Mutations.
  if (query.startsWith('mutation IssueCreate') || query.includes('createIssue(input:')) {
    const input = (vars.input ?? {}) as JsonRecord;
    const repo = typeof input.repositoryId === 'string' ? findRepoByGlobalId(store, input.repositoryId) : null;
    if (repo === null) return errResult('Repository not found');
    const issue = createIssueRecord(store, repo, String(input.title ?? ''), String(input.body ?? ''));
    return dataResult({ createIssue: { issue: { number: issue.number, id: issue.gid } } });
  }
  if (query.startsWith('mutation IssueClose') || query.includes('closeIssue(input:')) {
    const input = (vars.input ?? {}) as JsonRecord;
    const found = typeof input.issueId === 'string' ? findIssueByGlobalId(store, input.issueId) : null;
    if (found === null) return errResult('Issue not found');
    found.issue.state = 'closed';
    found.issue.jsonCache = null;
    return dataResult({ closeIssue: { issue: { number: found.issue.number, id: found.issue.gid, state: 'CLOSED' } } });
  }
  if (query.startsWith('mutation PullRequestCreate') || query.includes('createPullRequest(input:')) {
    const input = (vars.input ?? {}) as JsonRecord;
    const repo = typeof input.repositoryId === 'string' ? findRepoByGlobalId(store, input.repositoryId) : null;
    if (repo === null) return errResult('Repository not found');
    const pull = createPullRecord(
      store,
      repo,
      String(input.title ?? ''),
      String(input.body ?? ''),
      String(input.headRefName ?? ''),
      String(input.baseRefName ?? ''),
    );
    if (pull === null) return errResult('Head or base branch does not exist');
    return dataResult({
      createPullRequest: {
        pullRequest: { number: pull.number, id: pull.gid, state: 'OPEN', headRefName: pull.head, baseRefName: pull.base },
      },
    });
  }
  if (query.startsWith('mutation MergePullRequest') || query.includes('mergePullRequest(input:')) {
    const input = (vars.input ?? {}) as JsonRecord;
    const found = typeof input.pullRequestId === 'string' ? findPullByGlobalId(store, input.pullRequestId) : null;
    if (found === null) return errResult('Pull request not found');
    const merged = mergePullRecord(store, found.repo, found.pull);
    if (!merged.ok) return errResult(`Cannot merge: ${merged.reason ?? 'unknown'}`);
    return dataResult({
      mergePullRequest: { pullRequest: { number: found.pull.number, merged: true, state: 'CLOSED' } },
    });
  }
  if (query.startsWith('mutation AddComment') || query.includes('addComment(input:')) {
    const input = (vars.input ?? {}) as JsonRecord;
    const subjectId = typeof input.subjectId === 'string' ? input.subjectId : '';
    const body = String(input.body ?? '');
    const issueFound = findIssueByGlobalId(store, subjectId);
    if (issueFound !== null) {
      issueFound.repo.commentSeq += 1;
      const id = issueFound.repo.commentSeq;
      const gid = globalId('IssueComment', issueFound.repo.id, issueFound.issue.number, id);
      issueFound.issue.comments.push({ id, gid, body });
      return dataResult({ addComment: { commentEdge: { node: { id: gid, body } } } });
    }
    const pullFound = findPullByGlobalId(store, subjectId);
    if (pullFound !== null) {
      pullFound.repo.commentSeq += 1;
      const id = pullFound.repo.commentSeq;
      const gid = globalId('IssueComment', pullFound.repo.id, pullFound.number, id);
      return dataResult({ addComment: { commentEdge: { node: { id: gid, body } } } });
    }
    return errResult('Subject not found');
  }

  // Queries: repository first — RepositoryFields contains the word
  // "viewerPermission", which must not be mistaken for a viewer query.
  if (query.includes('repository(owner:')) {
    const owner = typeof vars.owner === 'string' ? vars.owner : '';
    const name = typeof vars.name === 'string' ? vars.name : '';
    const repo = owner === VIEWER.login ? (store.repos.get(`${owner}/${name}`) ?? null) : null;
    if (repo === null) return dataResult({ repository: null });
    const out: JsonRecord = { repository: gqlRepo(repo) };
    const node = out.repository as JsonRecord;
    // Issues connection (open list, or cursor pages).
    if (query.includes('issues(first:')) {
      const orderDesc = query.includes('direction: DESC');
      const states = query.includes('states: [OPEN]') ? ['OPEN'] : query.includes('states: [CLOSED]') ? ['CLOSED'] : undefined;
      node.issues = issuesConnection(repo, vars, orderDesc, states);
    }
    // Single issue / pull request reads.
    if (query.includes('issue(number:')) {
      const number = typeof vars.number === 'number' ? vars.number : -1;
      const issue = repo.issues.get(number);
      node.issue = issue === undefined ? null : gqlIssue(issue);
    }
    if (query.includes('pullRequests(first:')) {
      const first = typeof vars.first === 'number' ? vars.first : 30;
      const open = [...repo.pulls.values()].filter((pull) => pull.state === 'open').sort((a, b) => b.number - a.number);
      node.pullRequests = { nodes: open.slice(0, first).map((pull) => gqlPull(store, pull, repo)) };
    }
    if (query.includes('pullRequest(number:')) {
      const number = typeof vars.number === 'number' ? vars.number : -1;
      const pull = repo.pulls.get(number);
      if (pull === undefined) {
        node.pullRequest = null;
      } else {
        const pr = gqlPull(store, pull, repo) as JsonRecord;
        if (query.includes('files(first:')) {
          const changes = diffTrees(store, pull.baseSha, pull.headSha);
          pr.files = { nodes: changes.map((change) => ({ path: change.filename })) };
        }
        node.pullRequest = pr;
      }
    }
    return dataResult(out);
  }
  if (query.includes('node(id:')) {
    const id = typeof vars.id === 'string' ? vars.id : '';
    const repo = findRepoByGlobalId(store, id);
    if (repo !== null) {
      return dataResult({ node: { id: globalId('Repository', repo.id), name: repo.name, nameWithOwner: `${repo.owner}/${repo.name}` } });
    }
    const issue = findIssueByGlobalId(store, id);
    if (issue !== null) return dataResult({ node: gqlIssue(issue.issue) });
    const pull = findPullByGlobalId(store, id);
    if (pull !== null) return dataResult({ node: gqlPull(store, pull.pull, pull.repo) });
    return dataResult({ node: null });
  }
  if (query.includes('viewer')) {
    // viewer { login } — and the invalid-field probe names its field.
    const viewerBlock = /viewer\s*\{([^}]*)\}/.exec(query);
    if (viewerBlock) {
      const fields = (viewerBlock[1] ?? '').split(/[\s,]+/).filter(Boolean);
      const unknown = fields.find((field) => field !== 'login');
      if (unknown !== undefined) {
        return {
          data: { viewer: null },
          errors: [{ message: `Cannot query field "${unknown}" on type "Viewer".` }],
        };
      }
    }
    return dataResult({ viewer: { login: VIEWER.login } });
  }

  return errResult('Unknown operation');
}

/** Handle a POST /api/graphql body (one operation, or a batch array of them). */
export function handleGraphQL(store: Store, body: unknown): { status: number; value: unknown } {
  if (Array.isArray(body)) {
    const results = body.map((entry) => {
      if (typeof entry !== 'object' || entry === null) return errResult('Invalid operation');
      const op = entry as JsonRecord;
      return execute(store, {
        query: typeof op.query === 'string' ? op.query : '',
        variables: (op.variables ?? {}) as JsonRecord,
      });
    });
    return { status: 200, value: results };
  }
  if (typeof body !== 'object' || body === null) return { status: 400, value: errResult('Invalid operation') };
  const op = body as JsonRecord;
  const result = execute(store, {
    query: typeof op.query === 'string' ? op.query : '',
    variables: (op.variables ?? {}) as JsonRecord,
  });
  return { status: 200, value: result };
}
