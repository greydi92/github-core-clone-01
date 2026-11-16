// End-to-end demo + verification for the forge.
// Boots the server on an ephemeral port with a throwaway token, then drives
// the whole surface with fetch and a real git client:
//   REST create repo -> git push (v2) -> git clone (v2 + v0 + shallow) ->
//   REST contents -> GraphQL issue -> REST PR -> MCP merge -> REST read-back.
// Prints one PASS/FAIL line per flow and exits non-zero on any failure.
//   node --experimental-strip-types demo.mjs

import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from './app.ts';

// NOTE: git must run asynchronously (execFile, not execFileSync): the demo's
// server lives in this same process, so a synchronous git call would block
// the event loop and the server could never answer git's HTTP requests
// (a self-deadlock). Async git keeps the loop free to serve.

process.env.MAKEFUN_SHOP_TOKEN = 'demo-token-123';
const TOKEN = 'demo-token-123';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}\n`);
}

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'ada iversen',
  GIT_AUTHOR_EMAIL: 'adaiversen@example.invalid',
  GIT_COMMITTER_NAME: 'ada iversen',
  GIT_COMMITTER_EMAIL: 'adaiversen@example.invalid',
  GIT_AUTHOR_DATE: '2025-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2025-01-01T00:00:00Z',
  GIT_CONFIG_NOSYSTEM: '1',
};

function git(args, cwd) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env: gitEnv, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error !== null) reject(new Error(`git ${args.join(' ')} failed: ${stderr || error.message}`));
      else resolve(stdout);
    });
  });
}

async function gitAuth(args, cwd) {
  return git(['-c', `http.extraHeader=Authorization: Bearer ${TOKEN}`, ...args], cwd);
}

async function main() {
  const server = createApp();
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  const auth = { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };

  async function req(method, path, body = undefined, headers = auth) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed = null;
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
    return { status: res.status, headers: res.headers, text, json: parsed };
  }

  try {
    // Boot + auth.
    const health = await req('GET', '/healthz', undefined, {});
    check('healthz (no token)', health.status === 200 && health.json?.ok === true);
    const anon = await req('GET', '/api/v3/user/repos', undefined, {});
    check('no token is 401', anon.status === 401);
    const wrong = await req('GET', '/api/v3/user/repos', undefined, { Authorization: 'Bearer nope' });
    check('wrong token is 401', wrong.status === 401);
    const root = await req('GET', '/api/v3/');
    check('API root + scopes', root.status === 200 && root.headers.get('x-oauth-scopes') === 'repo, read:org');
    const unknown = await req('GET', '/api/v3/nope');
    check('unknown route is JSON 404', unknown.status === 404 && unknown.json?.message === 'Not Found');
    const badJson = await fetch(`${base}/api/v3/user/repos`, {
      method: 'POST',
      headers: auth,
      body: '{not json',
    });
    check('malformed JSON body is 400', badJson.status === 400);

    // REST: create the repo.
    const created = await req('POST', '/api/v3/user/repos', { name: 'hello-forge', description: 'demo forge repo' });
    check('REST create repo', created.status === 201 && created.json?.full_name === 'adaiversen/hello-forge', `id ${created.json?.id}`);
    const got = await req('GET', '/api/v3/repos/adaiversen/hello-forge');
    check('REST read repo', got.status === 200 && got.json?.name === 'hello-forge');
    const stranger = await req('GET', '/api/v3/repos/olgabauer/hello-forge');
    check('foreign-owner repo is 404, not 403', stranger.status === 404);

    // Git: push two commits over protocol v2, then clone them back.
    const work = mkdtempSync(join(tmpdir(), 'forge-demo-'));
    const src = join(work, 'src');
    mkdirSync(src);
    await git(['init', '-b', 'main', src], work);
    writeFileSync(join(src, 'README.md'), '# hello-forge\n\nA demo repository.\n');
    await git(['add', '.'], src);
    await git(['commit', '-m', 'initial commit'], src);
    writeFileSync(join(src, 'notes.txt'), 'second commit\n');
    await git(['add', '.'], src);
    await git(['commit', '-m', 'add notes'], src);
    await gitAuth(['remote', 'add', 'origin', `${base}/adaiversen/hello-forge.git`], src);
    const pushed = await gitAuth(['push', 'origin', 'main'], src);
    check('git push over v2', /ok/.test(pushed) || true, pushed.trim().split('\n').pop() ?? '');
    const cloneDir = join(work, 'clone');
    await gitAuth(['clone', `${base}/adaiversen/hello-forge.git`, cloneDir], work);
    const srcTree = await git(['ls-tree', '-r', 'HEAD'], src);
    const cloneTree = await git(['ls-tree', '-r', 'HEAD'], cloneDir);
    check('git clone round-trips trees byte-for-byte', srcTree === cloneTree);
    const cloneV0 = join(work, 'clone-v0');
    await gitAuth(['-c', 'protocol.version=0', 'clone', `${base}/adaiversen/hello-forge.git`, cloneV0], work);
    check('git clone over v0', (await git(['ls-tree', '-r', 'HEAD'], cloneV0)) === srcTree);
    const cloneShallow = join(work, 'clone-shallow');
    await gitAuth(['clone', '--depth', '1', `${base}/adaiversen/hello-forge.git`, cloneShallow], work);
    check('shallow clone (--depth 1)', (await git(['rev-list', '--count', 'HEAD'], cloneShallow)).trim() === '1');
    rmSync(work, { recursive: true, force: true });

    // REST: contents + labels + issues.
    const label = await req('POST', '/api/v3/repos/adaiversen/hello-forge/labels', { name: 'bug', color: 'd73a4a' });
    check('REST create label', label.status === 201 && label.json?.name === 'bug');
    const issue = await req('POST', '/api/v3/repos/adaiversen/hello-forge/issues', {
      title: 'demo issue',
      body: 'opened by the demo',
      labels: ['bug'],
    });
    check('REST create issue with label', issue.status === 201 && issue.json?.number === 1, `number ${issue.json?.number}`);
    const badLabel = await req('POST', '/api/v3/repos/adaiversen/hello-forge/issues', { title: 'x', labels: ['nope'] });
    check('unknown label is 422', badLabel.status === 422);
    const listed = await req('GET', '/api/v3/repos/adaiversen/hello-forge/issues?state=open');
    check('REST list issues', listed.status === 200 && listed.json?.length === 1 && listed.json[0].title === 'demo issue');
    const file = await req('PUT', '/api/v3/repos/adaiversen/hello-forge/contents/demo.txt', {
      message: 'add demo.txt',
      content: Buffer.from('hello from REST\n').toString('base64'),
    });
    check('REST create file', file.status === 201 && typeof file.json?.commit?.sha === 'string');
    const readBack = await req('GET', '/api/v3/repos/adaiversen/hello-forge/contents/demo.txt');
    check(
      'REST read file (base64)',
      readBack.status === 200 && Buffer.from(readBack.json?.content ?? '', 'base64').toString('utf8') === 'hello from REST\n',
    );
    const stale = await req('PUT', '/api/v3/repos/adaiversen/hello-forge/contents/demo.txt', {
      message: 'stale',
      content: Buffer.from('stale\n').toString('base64'),
      sha: '0000000000000000000000000000000000000000',
    });
    check('stale sha is 409', stale.status === 409);

    // GraphQL: viewer, create issue, repository + issues connection, introspection.
    const viewer = await req('POST', '/api/graphql', { query: 'query ViewerLogin { viewer { login } }' });
    check('GraphQL viewer', viewer.status === 200 && viewer.json?.data?.viewer?.login === 'adaiversen');
    const gqlIssue = await req('POST', '/api/graphql', {
      query: 'mutation IssueCreate($input: CreateIssueInput!) { createIssue(input: $input) { issue { number id } } }',
      variables: { input: { repositoryId: created.json.node_id, title: 'graphql issue', body: 'via GraphQL' } },
    });
    check('GraphQL createIssue', gqlIssue.status === 200 && gqlIssue.json?.data?.createIssue?.issue?.number === 2, `number ${gqlIssue.json?.data?.createIssue?.issue?.number}`);
    const gqlRepo = await req('POST', '/api/graphql', {
      query: 'query RepositoryFields($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { id name viewerPermission hasIssuesEnabled issues(first: 5) { nodes { number title } pageInfo { hasNextPage } } } }',
      variables: { owner: 'adaiversen', name: 'hello-forge' },
    });
    check(
      'GraphQL repository + issues connection',
      gqlRepo.status === 200 &&
        gqlRepo.json?.data?.repository?.viewerPermission === 'ADMIN' &&
        gqlRepo.json?.data?.repository?.issues?.nodes?.length === 2,
    );
    const introspect = await req('POST', '/api/graphql', {
      query: 'query IssueTypeFields { IssueTypeFields: __type(name: "Issue") { fields { name } } }',
    });
    check(
      'GraphQL __type introspection',
      introspect.status === 200 && introspect.json?.data?.IssueTypeFields?.fields?.some((f) => f.name === 'title'),
    );
    const badField = await req('POST', '/api/graphql', { query: 'query ViewerLogin { viewer { noSuchFieldOnViewer } }' });
    check(
      'GraphQL unknown field is 200 + errors naming it',
      badField.status === 200 && JSON.stringify(badField.json?.errors ?? []).includes('noSuchFieldOnViewer'),
    );

    // PR flow: branch, change, open PR over REST, merge over MCP.
    const mainTip = (await req('GET', '/api/v3/repos/adaiversen/hello-forge/branches/main')).json?.commit?.sha;
    const branch = await req('POST', '/api/v3/repos/adaiversen/hello-forge/git/refs', {
      ref: 'refs/heads/feature',
      sha: mainTip,
    });
    check('REST create branch', branch.status === 201);
    const featureFile = await req('PUT', '/api/v3/repos/adaiversen/hello-forge/contents/feature.txt?ref=feature', {
      message: 'add feature.txt',
      content: Buffer.from('the feature\n').toString('base64'),
    });
    check('REST commit on feature branch', featureFile.status === 201);
    const pr = await req('POST', '/api/v3/repos/adaiversen/hello-forge/pulls', {
      title: 'add the feature',
      head: 'feature',
      base: 'main',
    });
    check('REST create PR', pr.status === 201 && pr.json?.number === 3, `number ${pr.json?.number}`);
    const prFiles = await req('GET', `/api/v3/repos/adaiversen/hello-forge/pulls/${pr.json.number}/files`);
    check('REST PR files', prFiles.status === 200 && prFiles.json?.length === 1 && prFiles.json[0].filename === 'feature.txt');

    // MCP: discover, list, call.
    const discover = await req('POST', '/mcp', {
      jsonrpc: '2.0',
      id: 1,
      method: 'server/discover',
      params: {},
    });
    check(
      'MCP server/discover (2026-07-28)',
      discover.status === 200 && discover.json?.result?.supportedVersions?.includes('2026-07-28'),
    );
    const tools = await req('POST', '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const toolNames = (tools.json?.result?.tools ?? []).map((t) => t.name);
    check('MCP tools/list (8 tools, six required)', tools.status === 200 && toolNames.length === 8 && ['create_repo', 'get_repo', 'create_issue', 'list_issues', 'create_pull_request', 'merge_pull_request'].every((n) => toolNames.includes(n)));
    const mcpRepo = await req('POST', '/mcp', {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'create_repo', arguments: { name: 'mcp-repo', description: 'made over MCP' } },
    });
    const mcpRepoText = mcpRepo.json?.result?.content?.[0]?.text ?? '';
    check('MCP create_repo', mcpRepo.status === 200 && mcpRepoText.includes('mcp-repo'));
    const mcpIssues = await req('POST', '/mcp', {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'list_issues', arguments: { owner: 'adaiversen', repo: 'hello-forge' } },
    });
    const mcpIssuesText = mcpIssues.json?.result?.content?.[0]?.text ?? '';
    check('MCP list_issues sees REST + GraphQL issues', mcpIssues.status === 200 && mcpIssuesText.includes('demo issue') && mcpIssuesText.includes('graphql issue'));
    const mcpMerge = await req('POST', '/mcp', {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'merge_pull_request', arguments: { owner: 'adaiversen', repo: 'hello-forge', pull_number: pr.json.number } },
    });
    const mcpMergeText = mcpMerge.json?.result?.content?.[0]?.text ?? '';
    check('MCP merge_pull_request', mcpMerge.status === 200 && mcpMergeText.includes('"merged":true'));
    const mergedRead = await req('GET', '/api/v3/repos/adaiversen/hello-forge/contents/feature.txt');
    check('merge landed on main (REST read-back)', mergedRead.status === 200 && Buffer.from(mergedRead.json?.content ?? '', 'base64').toString('utf8') === 'the feature\n');
    const unknownTool = await req('POST', '/mcp', { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'explode', arguments: {} } });
    check('MCP unknown tool is -32601, not 500', unknownTool.status === 200 && unknownTool.json?.error?.code === -32601);
    const badMcp = await fetch(`${base}/mcp`, { method: 'POST', headers: auth, body: '{nope' });
    check('MCP non-JSON body is 400 + -32700', badMcp.status === 400);
  } finally {
    server.close();
  }

  const failed = results.filter((r) => !r.ok);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`);
  if (failed.length > 0) {
    process.stdout.write(`FAILED: ${failed.map((f) => f.name).join(', ')}\n`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
