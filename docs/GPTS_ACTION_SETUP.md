# GPTS Action Setup — GitHub ADD

Status: `READY_FOR_REIMPORT / CURRENT_CHAT_SCHEMA_STALE` until the updated Action schema is imported and verified in a fresh GPT session.

## Source of truth

- Service domain: `https://github-patch.srv1904412.hstgr.cloud`
- Live OpenAPI schema: `https://github-patch.srv1904412.hstgr.cloud/openapi.json`
- Static GPT import schema: `gpts-action-openapi.json`
- Backend evidence: `docs/DEPLOYMENT_REPORT.md`
- Task ledger: `docs/TASKS.yaml`

## Import steps in GPT Builder

1. Open the target GPT in GPT Builder.
2. Go to **Actions**.
3. Import schema from:

```text
https://github-patch.srv1904412.hstgr.cloud/openapi.json
```

4. Save the action.
5. Run the health operation first.

## Authentication

All `POST /patch/preview` and `POST /patch/apply` requests require an `Authorization: Bearer <token>` header.

### GPT Builder setup

1. In the GPT Builder **Actions** section, after importing the OpenAPI schema, click on the **Authentication** dropdown.
2. Select **API Key** → **Bearer**.
3. The token is the `ACTION_BEARER_TOKEN` — **not** a GitHub PAT. This token is stored only in the Coolify application environment.
4. OpenAI will pass the token as `Authorization: Bearer {{key}}` on every protected endpoint request.

The `GET /health` and `GET /openapi.json` endpoints are public (no auth required).

### Token management

- The token is stored in the Coolify application environment as `ACTION_BEARER_TOKEN`.
- When `ACTION_REQUIRE_BEARER=true` (default), protected Action endpoints reject unauthenticated requests.
- If `ACTION_REQUIRE_BEARER=true` but `ACTION_BEARER_TOKEN` is empty, the server responds `503 AUTH_NOT_CONFIGURED`.
- Generate a strong random token locally and store it directly in Coolify; never commit or copy the value into documentation.

GitHub authentication is handled separately by the service through server-side GitHub credential environment variables. Those credentials remain secrets and are never returned by the API.

## Expected operations

| operationId | Endpoint | Purpose |
|---|---|---|
| `addHealth` | `GET /health` | Check runtime identity, policy and capabilities |
| `githubRest` | `POST /github/rest` | Universal bounded GitHub REST gateway |
| `githubGraphql` | `POST /github/graphql` | GitHub GraphQL queries and gated mutations |
| `searchGitHubRepositories` | `POST /github/search/repositories` | Search repositories in the configured credential scope |
| `searchGitHubCode` | `POST /github/search/code` | Search code in an accessible repository |
| `createGitHubRepository` | `POST /github/repositories/create` | Create and reread-verify a user or organization repository |
| `diagnoseGitHubRepository` | `POST /github/repository/diagnose` | Repository/ruleset/Actions/check diagnostics |
| `githubRefWriteProbe` | `POST /github/ref-write-probe` | Self-cleaning repository write probe |
| `downloadGitHubJobLogs` | `POST /github/actions/job-logs` | Bounded Actions job-log retrieval |
| `readFile` / `createFile` | `/file/read`, `/file/create` | Specialized file operations |
| `patchPreview` / `patchApply` | `/patch/preview`, `/patch/apply` | SHA-guarded stale-safe patch workflow |
| `readPullRequest` / `markPullRequestReady` / `mergePullRequest` | `/pull-request/*` | Guarded pull-request operations |

## Safe fixture smoke

Use only `test-fixtures/marker-file.md` for the first GPTS action smoke.

Required flow:

1. Read current fixture SHA via GitHub connector.
2. Call `/patch/preview` with exact full marker strings:

```text
<!-- GPT:START smoke-block -->
<!-- GPT:END smoke-block -->
```

3. Inspect `diff_preview`.
4. Accept only if both marker lines are preserved exactly.
5. Call `/patch/apply` with `preview_patch_id`.
6. Verify response contains `commit_sha` and `reread_verified: true`.
7. Reread fixture content.
8. Restore fixture to original content.
9. Record apply commit, restore commit, and reread proof in `docs/DEPLOYMENT_REPORT.md`.

## Non-fixture write-back target

After the GPTS action smoke passes, the first useful write-back should update only the marker block below through GitHub ADD.

<!-- GPT:START gpts-action-status -->
GPTS Action import is not yet verified from GPT Builder UI.
<!-- GPT:END gpts-action-status -->

## Acceptance rules

Do not mark GPTS delivery `DONE` until:

- GPT Builder import succeeds.
- GPTS health action returns HTTP 200.
- GPTS action preview/apply/restore smoke passes.
- A non-fixture doc write-back through GitHub ADD passes.
- Evidence is written back to `docs/DEPLOYMENT_REPORT.md` and `docs/TASKS.yaml`.

## Replan

- Evidence gap: mark task `EVIDENCE_MISSING`, collect the smallest missing proof, then retry.
- Failed validator: record exact response/status, create corrective task, do not continue dependent tasks.
- Blocker: mark `BLOCKED_BY_UI` or `BLOCKED`, record owner and unblock condition.
- Goal/source/DoD change: reread handoff, deployment report, and tasks before changing implementation.
