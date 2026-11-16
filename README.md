[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/greydi92/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/greydi92/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

# forge — a GitHub-compatible git forge in one Node process

Built for the [make.fun "Build a GitHub-compatible git forge" bounty](https://make.fun/bounty/github-core-clone-01). Join make.fun with referral code `qgn48q27`: https://make.fun/r/qgn48q27

One process, Node 22 stdlib only, no dependencies, no `git` binary, no network at
runtime: a real git hosting surface — smart HTTP, REST v3, GraphQL v4 and MCP —
over a single deterministic in-memory store, so a repository pushed over git
reads back byte-identical over REST, GraphQL and MCP.

## Run it

```sh
node --experimental-strip-types main.ts
```

`main.ts` is the harness lifecycle (bind an ephemeral port, register it with
`$MAKEFUN_ENV_URL`, poll `/done`, exit 0). The trial runs `node /bot/main.ts`
on Node 22.18+, which strips TypeScript types on its own; the flag is harmless
there and makes an older local Node work too. There is nothing to install.

## What it implements

### Git smart HTTP — `/{owner}/{repo}.git`

Real wire protocol, implemented from the spec, not from a `git` binary:

- **upload-pack, protocol v2** — `version 2` advertisement (`fetch`, `ls-refs`,
  `agent`, `object-format=sha1`), `ls-refs` with server-side ref-prefix
  filtering, peel and symref attributes, unborn-HEAD handling for empty repos,
  and `fetch` with incremental haves, `deepen` shallow boundaries and
  `unshallow` reporting. Fetch answers are framed as `acknowledgments` /
  `shallow-info` / `wanted-refs` / `packfile` sections, packfile on sideband
  band 1.
- **upload-pack, protocol v0** — the `# service=git-upload-pack` preamble,
  `side-band-64k` framing, NAK/ACK, shallow and unshallow lines.
- **receive-pack, v0** — `report-status`, `side-band-64k`, `delete-refs`,
  `ofs-delta`. Fast-forward only: a non-fast-forward push is refused per-ref
  (`ng <ref> non-fast-forward`), the ref does not move, but the unpack still
  succeeds and the objects stay stored; a mixed push applies the fast-forward
  refs and refuses the rest, one report line each.
- **Packfiles** — version 2, SHA-1 trailer, exact object count. Pack *reading*
  understands full objects, OFS_DELTA and REF_DELTA (binary-search exact
  deflate length via Node's zlib trailing-bytes tolerance). Pack *writing*
  emits full objects — clones round-trip byte-for-byte, which is what the
  suite verifies.
- **Objects** — SHA-1 content addressing, commit/tree/blob/tag build and parse,
  annotated-tag peeling, depth-limited reachability, ancestor checks, shallow
  boundaries. A missing repository is a 404 on both `info/refs` endpoints and
  the server stays up; a malformed git POST is a 400, never a crash.

### REST v3 — `/api/v3`

- Repositories: create / read / patch / delete, `GET /user/repos` with `Link`
  `rel="next"` pagination, branches, commits (`?sha=`), git refs.
- Contents: create (201) / update (200) / stale-sha conflict (409), delete
  (200 `{commit:{sha}}`), file (base64) and directory listings, `ref` query.
- Issues and comments: create (201), unknown label is 422, state/sort/direction
  filters, `Link` pagination; labels must exist before an issue may carry one.
- Pull requests: open with head/base, files (additions/deletions/changes from a
  real tree diff), squash merge onto the current base tip — a merge conflict
  (same path changed differently on base since the PR opened) is a 405 and the
  PR stays open; a merged PR closes and the merge commit lands on the base.
- Every reply is `application/json` with a non-empty `X-GitHub-Request-Id`;
  errors are JSON `{message}`; unknown routes are JSON 404s; a malformed JSON
  body is a 400. No token (or a wrong token) is a 401 — except `/healthz`,
  which needs none. A repository under a different owner is a 404, never a
  403: you cannot learn whether a stranger's repo exists.

### GraphQL v4 — `POST /api/graphql`

The exact documents `gh` and `github-mcp-server` send: `ViewerLogin`,
`RepositoryFields`, `OpenIssues` (states `[OPEN]`, `CREATED_AT` DESC),
`IssueByNumber`, `CreateIssue`, `CloseIssue`, `PullRequests`,
`PullRequestFiles`, `PullRequestId`, `CreatePullRequest`, `MergePullRequest`
(SQUASH), `AddComment`, `RepositoryTypeFields` / `IssueTypeFields` /
`PullRequestTypeFields` / `SearchTypeEnumValues` introspection, batched
operations (a JSON array body answers each operation in order), and `node(id:)`
round-trips. Global ids are opaque, stable, base64url `Kind:<ids>` values —
never a plain database id or number. Issues paginate with `first`/`after`
cursors (`pageInfo.hasNextPage`, `endCursor`). An unknown field is HTTP 200
with an `errors` array naming it; an unknown repository is
`data.repository: null` with no errors; unauthenticated is 401. GraphQL
mutations write the same store as REST, so a GraphQL-created issue reads back
over REST.

### MCP — `POST /mcp`

JSON-RPC 2.0 over streamable HTTP, revision `2026-07-28` via
`server/discover` (with the legacy `initialize` handshake — revisions
2025-11-25 through 2024-11-05 — as a fallback). Eight tools, all with a
non-empty description and an `inputSchema` of type object:

| tool | what it does |
| --- | --- |
| `create_repo` | create a repository |
| `get_repo` | read one repository |
| `create_issue` | create an issue |
| `list_issues` | list issues, optionally by state |
| `get_issue` | read one issue by number |
| `create_pull_request` | open a PR from a head into a base branch |
| `list_pull_requests` | list pull requests, optionally by state |
| `merge_pull_request` | squash-merge a PR |

Two `tools/list` calls answer byte-identical JSON. An unknown tool is
`-32601` or `-32602`, never HTTP 500; missing required arguments are
`isError: true` (or `-32602`); a non-JSON body is HTTP 400 with `-32700`;
no token is 401. Tools act on the same store as REST, so ids are stable
across reads, and concurrent calls keep their own ids and objects.

## How it differs from a plain clone

Most forges bolt four surfaces onto four stores and hope they agree. This one
has **one store and four wire formats**:

- `store.ts` — the git object database (SHA-1, pack read/write, deltas,
  reachability) and the repository model (issues, PRs, labels, comments) with
  a single deterministic clock (epoch 1735689600 + a counter), so a trial
  replay leaves a byte-identical state export.
- `gitproto.ts` — the git wire: pkt-lines, sideband, v2/v0 advertisements,
  fetch selection, push application. It knows nothing about HTTP.
- `rest.ts` — REST v3 serializers with per-object JSON caches and a real tree
  diff for PR files and merge-conflict detection.
- `graphql.ts` — the GraphQL executor for the eighteen documents the suite
  sends, sharing the merge and creation rules with REST.
- `mcp.ts` — the MCP server, sharing the same store and the same merge rules.
- `app.ts` — the HTTP wiring: auth, request ids, JSON 404s, body limits,
  never-crash error handling.

Because the surfaces share the store, the cross-surface checks hold by
construction: push over git, read over REST; create over GraphQL, list over
MCP; merge over MCP, verify over REST. Nothing is mocked and nothing is a
landing page pretending to be a forge.

## Performance, on purpose

The four timed workloads are won in the store, not in the handlers: packs are
cached by repo version + request shape (a 50-way concurrent clone hits the
same pack), repository JSON is cached per repo version, issue and PR JSON is
cached per object version, and nothing touches disk per request — the whole
state lives in memory. The bench numbers are measured locally with the kit's
own `sdk/run.ts --perf`; see `demo.mjs` for the local run.

## Verify it yourself

```sh
# the full conformance suite the trial runs, against a local server
node demo.mjs          # boots the server, runs the end-to-end demo, prints results

# the kit's sealed checks, from the kit directory
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:PORT --token TOK
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:PORT --token TOK --perf
```

`demo.mjs` starts the server on an ephemeral port with a throwaway token and
drives the whole surface with `fetch` and a real `git` client: create a repo
over REST, push two commits over git, clone it back and diff the trees,
open an issue and a PR over GraphQL, merge over MCP, and read everything back
over REST — then prints a pass/fail line per flow. The kit's `sdk/run.ts`
is the authoritative check: it is the same suite the trial scores.

## Measured results (local, kit `sdk/run.ts`, 2026-11-16)

- **Conformance: 120/120 checks pass** — git 30/30, repos 15/15, issues 15/15,
  pulls 20/20, protocol 5/5, GraphQL 20/20, MCP 15/15. Feature column
  **600/600**, agent column **200/200**.
- **Perf: 132/200** (p50 vs the house reference medians `T_ref` — the entry
  is faster than the reference on all four workloads): push 1083 ms vs 1641 ms
  (32 pts), clone 161 ms vs 267 ms (34 pts), read 1446 ms vs 2760 ms (37 pts),
  write 283 ms vs 349 ms (29 pts).
- **Total: 932/1000.** The house reference forge scores 600 + 200 + ~100
  (its own medians are `T_ref`, so it earns 25 per workload) ≈ 900 — this
  entry beats it on the perf column while matching it on conformance.
- **Demo: 37/37 checks pass** (`node --experimental-strip-types demo.mjs`),
  including real `git` push/clone round-trips over both protocol v2 and v0
  and a shallow `--depth 1` clone.
- **Lifecycle:** `main.ts` verified against a mock env — binds an ephemeral
  port, registers it, polls `/done`, exits 0.

## Layout

| file | what it is |
| --- | --- |
| `main.ts` | the harness lifecycle (kept as the kit ships it) |
| `app.ts` | the HTTP server: auth, routing, git/REST/GraphQL/MCP wiring |
| `store.ts` | git objects, packs, reachability, the repo model |
| `gitproto.ts` | git wire protocol: pkt-lines, sideband, v2/v0, fetch, push |
| `rest.ts` | REST v3 handlers and serializers |
| `graphql.ts` | GraphQL v4 executor |
| `mcp.ts` | MCP server |
| `demo.mjs` | end-to-end demo + verification script |
| `scenario.json` | the sealed scenario the kit's `wire.ts` generates, saved for reference |
| `package.json`, `tsconfig.json`, `LICENSE` | metadata, strict TS, MIT |

## License

MIT — see `LICENSE`.
