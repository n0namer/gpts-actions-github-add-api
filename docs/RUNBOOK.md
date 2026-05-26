# GitHub ADD Runbook

## Service

- Railway project: `github-add`
- Service: `github-add-api`
- Domain: `https://github-add-api-production.up.railway.app`
- Health: `GET /health`
- OpenAPI: `GET /openapi.json`

## Normal smoke sequence

1. Check `/health`.
2. Check `/openapi.json`.
3. Read target file SHA from GitHub.
4. Call `/patch/preview`.
5. Inspect `diff_preview`.
6. Call `/patch/apply` with `preview_patch_id`.
7. Confirm `commit_sha` and `reread_verified: true`.
8. Reread target file.
9. Restore fixture if a fixture was used.
10. Write evidence back to `docs/DEPLOYMENT_REPORT.md`.

## Error diagnosis

| HTTP / status | Meaning | Corrective action |
|---|---|---|
| 200 / `DRY_RUN_PASS` | Preview is safe to apply | Inspect diff before apply |
| 200 / `APPLY_PASS` | Patch committed and reread verified | Record `commit_sha` |
| 400 / `BAD_REQUEST` | Request JSON or required fields are invalid | Fix payload schema |
| 401 / `AUTH_FAILED` | Railway service lacks valid GitHub token | Verify `GITHUB_TOKEN` exists in Railway; do not print value |
| 403 / `NOT_ALLOWED` | Repo, branch, or path is outside allowlist | Use allowed target or update policy deliberately |
| 409 / `FILE_CHANGED` | `expected_sha` is stale | Reread file SHA, regenerate preview |
| 422 / `PATCH_NOT_APPLICABLE` | Marker missing/duplicate, protected path, secret scan, or diff limit failed | Inspect `reason`, fix target or patch |
| 423 / `WRITE_LOCKED` | Same repo/branch/path is already being written | Retry after current write completes |
| 500 / `GITHUB_ADD_ERROR` | Internal or GitHub API failure | Check Railway logs, GitHub API status, and reread target state |

## Rollback / restore

For fixture smoke, restore `test-fixtures/marker-file.md` to:

```markdown
<!-- GPT:START smoke-block -->
old smoke content
<!-- GPT:END smoke-block -->
```

For real doc write-back, rollback options are:

1. Apply a reverse marker patch through GitHub ADD.
2. Use GitHub revert for the specific commit.
3. Restore the file content through GitHub API with a clear restore commit message.

Always reread after rollback and record evidence.

## Secret safety

- Never print token values.
- Never copy tokens into docs, logs, issue text, or prompts.
- Railway variable checks should confirm presence only, not value.
- If a secret appears in output, stop and rotate it before continuing.

## Replan hooks

- Evidence gap → mark `EVIDENCE_MISSING`, collect minimal proof, retry validator.
- Failed validator → mark `PARTIAL` or `FAILED`, create corrective task.
- Blocker → mark `BLOCKED` or `BLOCKED_BY_UI`, record owner and unblock condition.
- Source/DoD change → reread source of truth and invalidate affected planned tasks to `HYPOTHESIS`.
- ACCEPT/PARTIAL/BLOCKED → write back status and next cheapest task.
