# Deployment Report — GitHub ADD MVP

REQUEST_ID: `GITHUB_ADD_MVP_001`

## Status

`PARTIAL` until Railway deployment and live smoke tests are completed.

## Implemented in repository

- Minimal Node.js service.
- `GET /health`.
- `GET /openapi.json`.
- `POST /patch/preview`.
- `POST /patch/apply`.
- Marker operations:
  - `replace_between_markers`;
  - `insert_after_marker`.
- Safety checks:
  - `expected_sha` required;
  - repo allowlist;
  - branch allowlist;
  - path prefix allowlist;
  - protected path block;
  - max file bytes;
  - max changed lines;
  - basic secret scan;
  - in-memory write lock by `repo + branch + path`;
  - reread verification after apply.
- Preview cache:
  - `/patch/preview` returns `patch_id`;
  - `/patch/apply` accepts `preview_patch_id`;
  - when `PATCH_REQUIRE_PREVIEW=true`, apply requires a matching, non-expired preview.

## Local verification

Run:

```bash
npm install
npm test
npm run check
```

## Railway verification checklist

Do not mark `DONE` until all checks pass:

- `/health` returns HTTP 200.
- `/openapi.json` returns valid OpenAPI JSON.
- `/patch/preview` passes on `test-fixtures/marker-file.md`.
- `/patch/apply` commits to `test-fixtures/marker-file.md`.
- Apply response includes `commit_sha`.
- Reread verifies changed content.
- Old SHA returns HTTP 409.
- Missing marker returns HTTP 422.
- Duplicate marker returns HTTP 422.
- Protected path is blocked.
- Logs do not print secrets.


## Execution evidence — 2026-05-26

### GitHub

- Repository: `n0namer/GitHub-add`.
- Main commit after implementation: `80c3282dcdb32f0786efbef7330524c04b6f5ebd`.
- Read-back tree includes:
  - `package.json`;
  - `railway.json`;
  - `src/config.mjs`;
  - `src/errors.mjs`;
  - `src/github.mjs`;
  - `src/openapi.mjs`;
  - `src/patch.mjs`;
  - `src/safety.mjs`;
  - `src/server.mjs`;
  - `tests/server.test.mjs`.

### Local tests

Observed local commands:

```bash
node --check src/server.mjs
node --test
```

Result: `PASS`, 7 tests passed.

### Railway

- Project: `github-add`.
- Project ID: `6eebe485-ad39-41e6-9356-061bf7aee00a`.
- Environment: `production`.
- Environment ID: `0739740f-5c09-4d8c-a249-5252578e011d`.
- Service: `github-add-api`.
- Service ID: `9d3363cc-b284-41a5-b6a9-c7e4401b8eb0`.
- Deployment ID: `5bec6052-e5f8-4aa4-91c7-8ed82824b9f8`.
- Deployment status: `SUCCESS`.
- Service domain: `github-add-api-production.up.railway.app`.
- Target port: `8080`.

### Remaining blocker

`GITHUB_TOKEN` is not set in Railway service variables yet. Do not run `/patch/preview` or `/patch/apply` live smoke until this secret is configured.

After `GITHUB_TOKEN` is set, run the smoke checklist above and update this report with:

- `/health` HTTP status;
- `/openapi.json` validation result;
- preview `patch_id`;
- apply `commit_sha`;
- reread proof;
- negative cases: 409 SHA mismatch, 422 missing marker, 422 duplicate marker, protected path blocked.
