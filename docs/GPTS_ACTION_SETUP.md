# GPTS Action Setup — GitHub ADD

Status: `PLANNED / BLOCKED_BY_UI` until the GPT Builder action is imported and verified from the GPT UI.

## Source of truth

- Service domain: `https://github-add-api-production.up.railway.app`
- OpenAPI schema: `https://github-add-api-production.up.railway.app/openapi.json`
- Backend evidence: `docs/DEPLOYMENT_REPORT.md`
- Task ledger: `docs/TASKS.yaml`

## Import steps in GPT Builder

1. Open the target GPT in GPT Builder.
2. Go to **Actions**.
3. Import schema from:

```text
https://github-add-api-production.up.railway.app/openapi.json
```

4. Save the action.
5. Run the health operation first.

## Authentication

All `POST /patch/preview` and `POST /patch/apply` requests require an `Authorization: Bearer <token>` header.

### GPT Builder setup

1. In the GPT Builder **Actions** section, after importing the OpenAPI schema, click on the **Authentication** dropdown.
2. Select **API Key** → **Bearer**.
3. The token is the `ACTION_BEARER_TOKEN` — **not** a GitHub PAT. This token is set as a Railway secret.
4. OpenAI will pass the token as `Authorization: Bearer {{key}}` on every protected endpoint request.

The `GET /health` and `GET /openapi.json` endpoints are public (no auth required).

### Token management

- The token is set via the Railway environment variable `ACTION_BEARER_TOKEN`.
- When `ACTION_REQUIRE_BEARER=true` (default), all patch endpoints reject unauthenticated requests.
- If `ACTION_REQUIRE_BEARER=true` but `ACTION_BEARER_TOKEN` is empty, the server responds `503 AUTH_NOT_CONFIGURED`.
- Use a strong random token (e.g., 64 hex chars = 32 bytes). Generate locally with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Then set it on Railway via `railway variables set ACTION_BEARER_TOKEN=<token>` or the Railway dashboard.

GitHub authentication is handled separately by the Railway service through `GITHUB_TOKEN`, which must remain a Railway secret.

## Expected operations

| operationId | Endpoint | Purpose |
|---|---|---|
| `githubAddHealth` | `GET /health` | Check service health |
| `githubPatchPreview` | `POST /patch/preview` | Preview marker-bounded patch without committing |
| `githubPatchApply` | `POST /patch/apply` | Apply previously previewed marker-bounded patch |

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
