# Deployment Report — GitHub ADD MVP

REQUEST_ID: `GITHUB_ADD_MVP_001`

## Status

`DONE` — full live smoke cycle completed against Railway production.

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

```bash
npm install
npm test
npm run check
```

## Railway verification — live smoke 2026-05-26

### Setup

- **GITHUB_TOKEN** set via Railway GraphQL `variableUpsert` on service `9d3363cc` in environment `0739740f`.
- **Redeploy** triggered via `deploymentRedeploy(id: "5bec6052-e5f8-4aa4-91c7-8ed82824b9f8")`.
- Deployment status: **SUCCESS**.
- Service domain: `github-add-api-production.up.railway.app`.

### Smoke cycle

| # | Test | Evidence | Result |
|---|------|----------|--------|
| 1 | Health `GET /health` | HTTP 200, `{"status":"ok","service":"github-add"}` | ✅ |
| 2 | OpenAPI schema `GET /openapi.json` | openapi: 3.1.0, 3 paths | ✅ |
| 3 | Read fixture SHA | main: `4a8edc0b...`, file SHA: `7035707c...` | ✅ |
| 4 | Preview — full markers preserving comment lines | `DRY_RUN_PASS`, markers_found: {start:1, end:1} | ✅ |
| 5 | Apply with preview_patch_id, commit_message | `APPLY_PASS`, commit_sha: `7f0c84f43d2f0175cbe19770a732e5f4d90445ec`, reread_verified: true | ✅ |
| 6 | Reread — verify exact marker lines preserved | Both comment marker lines intact, `new smoke content - full-marker smoke 2026-05-26T01:36:37Z` present | ✅ |
| 7 | Restore fixture to original content | file SHA restored to `7035707c`, `old smoke content` verified | ✅ |
| 8 | Negative: wrong SHA → 409 | `FILE_CHANGED` with actual_sha returned | ✅ |
| 9 | Negative: missing marker | `PATCH_NOT_APPLICABLE` | ✅ |
| 10 | Negative: duplicate marker | `PATCH_NOT_APPLICABLE` | ✅ |
| 11 | Negative: protected path (`.github/workflows/`) | `NOT_ALLOWED` | ✅ |

### Commit evidence

- Smoke apply commit: `7f0c84f43d2f0175cbe19770a732e5f4d90445ec`
- Restore commit: `74a353d722ca`
- Final main SHA: `74a353d722ca`
- Final fixture file SHA: `7035707c364e2b0bf5470dd3bf896952e4e2e38c`

### Marker preservation proof

Preview diff showed exact `<!-- GPT:START smoke-block -->` and `<!-- GPT:END smoke-block -->` lines preserved (3-line space: marker → content → marker). Reread confirmed both comment markers untouched.

### Secret safety

- No secrets printed, echoed, logged, or exposed in any output.
- `GITHUB_TOKEN` value masked in all operations.
- `RAILWAY_API_TOKEN` used only via GraphQL, never disclosed.