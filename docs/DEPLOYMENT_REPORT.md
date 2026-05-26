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
