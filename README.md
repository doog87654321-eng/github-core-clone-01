# github-core-clone-01 — a GitHub-compatible git forge

A Node 22 program (no dependencies, TypeScript stripped at runtime) that
implements a GitHub-compatible git forge in memory:

- git smart HTTP: clone / fetch / push over protocol v2 (upload-pack) and v0
  (receive-pack), with SHA-1 objects, packfiles, shallow clones, fast-forward
  and non-fast-forward push rules, and side-band report status;
- REST v3: repositories, branches, commits, contents, labels, issues,
  comments, pull requests and merges;
- GraphQL v4: viewer, repository, issue, pullRequest, node, __type, mutations
  for issues / pull requests / comments, batch operations;
- MCP over Streamable HTTP (revision 2026-07-28): server/discover,
  tools/list, tools/call for repos, issues and pull requests.

The same store backs every surface, so a repository created through REST is
visible to git, GraphQL and MCP. State is kept in memory; the trial's seed
scenario is served by the conformance suite itself, not by this program.

## Run

```sh
node --experimental-strip-types main.ts
```

Without `MAKEFUN_ENV_URL` the server runs standalone on an ephemeral port and
prints the address. With it set, the program registers its port with the env
and exits 0 once the env reports the trial is done.

## Verify locally

```sh
PORT=<port>
node --experimental-strip-types /home/hatch/workspace/makefun/github-core-clone-01-kit/sdk/run.ts \
  --url http://127.0.0.1:$PORT --token test-token --json
```

## License

MIT — see `LICENSE`.
