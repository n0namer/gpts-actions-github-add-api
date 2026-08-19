# Railway Deployment — GitHub ADD

## Target

Deploy a standalone Railway project/service for GitHub ADD.

```text
Railway project: github-add
Service: github-add-api
Runtime: Node.js / TypeScript HTTP API
```

## Important constraint

This service is separate from:

- `n8n-control`;
- `n8n-control-mcp`;
- OpenClaw runtime;
- direct GitHub connector.

Do not merge GitHub ADD into any existing service for MVP.

## Required public endpoints

```text
GET  /health
GET  /openapi.json
POST /patch/preview
POST /patch/apply
```

## Environment variables

Set in Railway service variables:

```text
PORT=8080
NODE_ENV=production
GITHUB_TOKEN=<existing GitHub token>
PATCH_MAX_FILE_BYTES=200000
PATCH_MAX_CHANGED_LINES=300
PATCH_REQUIRE_PREVIEW=true
PATCH_BLOCK_PROTECTED_PATHS=true
```

## Do not print secrets

Logs must never print:

- GitHub token;
- Authorization header;
- full env dump;
- request headers containing secrets.

## Suggested start command

```text
npm start
```

Expected behavior:

- bind to `0.0.0.0`;
- use `process.env.PORT`;
- return 200 on `/health`.

## Deployment steps

1. Create Railway project `github-add`.
2. Create service `github-add-api` from `n0namer/GitHub-add`.
3. Set environment variables.
4. Deploy.
5. Open public domain.
6. Verify `/health`.
7. Verify `/openapi.json`.
8. Run preview smoke.
9. Run apply smoke on `test-fixtures/marker-file.md`.
10. Record evidence in deployment report or commit/issue.

## Smoke test sequence

### 1. Health

```text
GET https://<domain>/health
```

Expected:

```json
{"status":"ok","service":"github-add"}
```

### 2. OpenAPI

```text
GET https://<domain>/openapi.json
```

Expected:

- valid JSON;
- 3 GPTS operations only:
  - `githubAddHealth`;
  - `githubPatchPreview`;
  - `githubPatchApply`.

### 3. Prepare fixture

Use:

```text
test-fixtures/marker-file.md
```

Read file from GitHub and obtain `sha`.

### 4. Preview

Call `/patch/preview` with `replace_between_markers` on smoke block.

Expected:

```text
DRY_RUN_PASS
can_apply=true
diff_preview present
no commit created
```

### 5. Apply

Call `/patch/apply` with same operation and expected sha.

Expected:

```text
APPLY_PASS
commit_sha present
reread_verified=true
```

### 6. Negative tests

- old sha returns `409 FILE_CHANGED`;
- missing marker returns `422 PATCH_NOT_APPLICABLE`;
- duplicate marker returns `422 PATCH_NOT_APPLICABLE`;
- protected path returns block response;
- secret-like text is blocked or flagged.

## Railway evidence required

A valid deployment report must include:

```text
service_name
public_domain
health_status
openapi_status
preview_status
apply_status
commit_sha
reread_verified
negative_test_results
secret_safety_confirmed
```

## Failure handling

If deploy fails:

- do not change architecture;
- inspect build logs;
- fix package/start/env issue;
- redeploy same service;
- do not move code into n8n-control as workaround.

If GitHub API fails:

- check token permissions;
- check allowed repo/path/branch;
- do not print token;
- do not disable safety gates to pass smoke.
