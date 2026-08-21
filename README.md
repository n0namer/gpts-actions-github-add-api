# GitHub Control + File Patch API

This service is the GitHub control plane used by GPT Actions. It keeps the original stale-safe file patching workflow and adds broad GitHub API coverage without exposing GitHub credentials to the model.

## North Star

```text
GPT Actions
   ↓
GitHub Control + File Patch API
   ├─ safe file / patch / PR operations
   ├─ GitHub REST gateway
   ├─ GitHub GraphQL gateway
   ├─ GitHub App / installation authentication
   ├─ repository / ruleset / CI diagnostics
   └─ bounded operational probes and Actions logs
   ↓
GitHub
```

The target is to make this service sufficient for normal repository development and GitHub operations so a separate direct `api.github.com` Action is not required.

## Version 0.5 control plane

High-value endpoints:

```text
GET  /health
GET  /openapi.json
POST /github/rest
POST /github/graphql
POST /github/app/diagnose
POST /github/repository/diagnose
POST /github/ref-write-probe
POST /github/actions/job-logs
POST /file/read
POST /file/create
POST /patch/preview
POST /patch/apply
POST /pull-request/read
POST /pull-request/ready
POST /pull-request/merge
```

`/github/rest` is the universal fallback for official GitHub REST paths. It supports server-owned user-token, GitHub App JWT, and short-lived installation-token authentication. Repository scope is inferred from `/repos/{owner}/{repo}` paths and checked against the local allowlist.

`/github/graphql` is the GraphQL fallback. Mutations require explicit confirmation. When a repository allowlist is configured, GraphQL calls require an explicit `repository_full_name` policy scope.

## GitHub App model

GitHub App credentials remain server-side:

```text
GITHUB_APP_ID
GITHUB_APP_PRIVATE_KEY
```

The service can discover the installation for a repository and mint short-lived repository-scoped installation tokens. Tokens and private keys are never returned in API responses.

`POST /github/app/diagnose` verifies:

```text
App JWT
→ repository installation discovery
→ approved installation permissions
→ short-lived token mint
→ repository access readback
```

## Repository and CI diagnostics

`POST /github/repository/diagnose` collects bounded evidence for:

- repository metadata and default branch;
- repository rulesets;
- branch protection;
- GitHub Actions permissions and workflows;
- check runs;
- combined commit status.

Individual diagnostic subchecks report their own result so one unavailable capability does not hide the rest of the evidence.

`POST /github/actions/job-logs` follows GitHub's temporary job-log redirect server-side, does not expose the signed URL, does not forward GitHub authorization to the redirect target, and enforces a response-size bound.

## Safety model

- Mutating generic REST requests (`POST`, `PUT`, `PATCH`, `DELETE`) require `confirm_mutation=true`.
- GraphQL mutations require `confirm_mutation=true`.
- REST repository paths are automatically mapped to repository policy scope.
- REST pagination is bounded to at most 10 pages / 1000 items.
- Responses are size-bounded and common secret fields are redacted.
- External URLs are not accepted by the REST gateway.
- File patching remains SHA-guarded, previewable, diff-bounded, secret-scanned and reread-verified.
- The ref write probe creates only a `station/probe/*` branch ref, verifies it, and deletes that exact ref before reporting PASS.
- GitHub credentials are held only by the service; health output reports credential presence, not token content or token fingerprints.

Existing specialized operations should be preferred when they fit because they provide stronger domain-specific guards. The generic REST/GraphQL gateways are fallbacks for operations not covered by specialized endpoints.

## Action schema

The JSON schema intended for GPT Action import is:

```text
gpts-action-openapi.json
```

YAML is not the publication format for this service. The build test suite parses this JSON and verifies the 0.5 control-plane operation IDs and required schemas.

## Validation / DONE gate

`npm run check` is the pre-deployment gate. It performs syntax checks for the server, GitHub backend and OpenAPI module, then runs all tests.

A release is not considered accepted until evidence shows:

- `npm run check` PASS;
- deployed image commit equals the intended source commit;
- `/health` reports the intended version/capabilities;
- the static Action JSON parses and exposes the required operation IDs;
- repository-policy and mutation-confirmation tests PASS;
- live GitHub operations used for acceptance have observable readback;
- temporary probe state is cleaned up.

## Current deployment

The Coolify application is `github-file-patch-api` at `https://github-patch.srv1904412.hstgr.cloud`.

GitHub App authentication is optional at runtime. Until `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` are configured, user-token operations can work but App/installation diagnostics correctly report App auth as unavailable.
