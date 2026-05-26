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

- `GITHUB_TOKEN` set via Railway GraphQL `variableUpsert` on service `9d3363cc-b284-41a5-b6a9-c7e4401b8eb0` in environment `0739740f-5c09-4d8c-a249-5252578e011d`.
- Deployment status: `SUCCESS`.
- Service domain: `github-add-api-production.up.railway.app`.

### Smoke cycle

| # | Test | Evidence | Result |
|---|------|----------|--------|
| 1 | Health `GET /health` | HTTP 200, `{"status":"ok","service":"github-add"}` | PASS |
| 2 | OpenAPI schema `GET /openapi.json` | OpenAPI 3.1.0, 3 paths | PASS |
| 3 | Read fixture SHA | file SHA: `7035707c364e2b0bf5470dd3bf896952e4e2e38c` | PASS |
| 4 | Preview — full markers preserving comment lines | `DRY_RUN_PASS`, `markers_found: {start:1, end:1}` | PASS |
| 5 | Apply with `preview_patch_id` and commit message | `APPLY_PASS`, `commit_sha: 7f0c84f43d2f0175cbe19770a732e5f4d90445ec`, `reread_verified: true` | PASS |
| 6 | Reread — exact marker lines preserved | both comment marker lines intact; new smoke content present | PASS |
| 7 | Restore fixture to original content | file SHA restored to `7035707c364e2b0bf5470dd3bf896952e4e2e38c`; `old smoke content` verified | PASS |
| 8 | Negative: wrong SHA → 409 | `FILE_CHANGED` with `actual_sha` returned | PASS |
| 9 | Negative: missing marker | `PATCH_NOT_APPLICABLE` | PASS |
| 10 | Negative: duplicate marker | `PATCH_NOT_APPLICABLE` | PASS |
| 11 | Negative: protected path (`.github/workflows/`) | `NOT_ALLOWED` | PASS |

### Commit evidence

- Smoke apply commit: `7f0c84f43d2f0175cbe19770a732e5f4d90445ec`
- Fixture restore commit: `74a353d722ca47aa5e3a7be8b156f36c048916f1`
- Report update commits: `82e9f15813c3608bdfd54b3119cafdd20f27ca67`, `042c4e7ad86bb2cf7c1e991f6852bbc8613e0daf`
- Final fixture file SHA: `7035707c364e2b0bf5470dd3bf896952e4e2e38c`

### Marker preservation proof

Preview diff used exact `<!-- GPT:START smoke-block -->` and `<!-- GPT:END smoke-block -->` lines. Reread confirmed both comment markers were untouched after apply.

### Secret safety

- No secrets printed, echoed, logged, or exposed in any output.
- `GITHUB_TOKEN` value masked in all operations.
- `RAILWAY_API_TOKEN` used only via GraphQL, never disclosed.
