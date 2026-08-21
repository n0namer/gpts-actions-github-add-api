# Deployment Report — GitHub Control Plane

## Current server acceptance — 2026-08-21

`SERVER_ACCEPTED` for the server-owned user-token mode on Coolify. GPT Action schema import and post-import Action acceptance are a separate next stage and are not claimed here.

Server evidence:

- Service: `github-file-patch-api` at `https://github-patch.srv1904412.hstgr.cloud`.
- Branch: `archops/github-control-plane-v05`.
- Runtime acceptance code baseline: `86a2273df3c07732b405f2006c0e9c480d15b1cf`.
- Coolify build gate: `npm run check`; the accepted image was created only after this gate succeeded.
- `/health`: `version=0.5.0`, exact accepted source commit, `github_auth.status=GITHUB_AUTH_OK`.
- Live control policy: repository scope `allowlist`, two repositories, Bearer required, generic admin/destructive/GraphQL mutations disabled.
- Live safe read on an allowlisted repository: PASS.
- Live read on a non-allowlisted repository: `NOT_ALLOWED`.
- Live patch preview: `DRY_RUN_PASS` with expected-SHA, diff-limit and secret-scan evidence.
- `/github/rest`, `/github/graphql`, `/github/repository/diagnose`, `/github/ref-write-probe`, and `/github/actions/job-logs` are present in runtime OpenAPI and reject unauthenticated POST requests with HTTP 401.
- Generic REST/GraphQL policy, redirect, pagination, credential-fallback, ref-cleanup, OpenAPI parity, and secret-redaction regression tests are part of the build gate.
- GitHub App runtime is intentionally not claimed accepted: App credentials are not configured in this service (`configured=false`).

The direct GitHub connector remains a fallback until the updated Action JSON is imported and the new callable Action surface passes live acceptance.

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
- Bearer auth (added 2026-05-26):
  - `POST /patch/preview` and `POST /patch/apply` require `Authorization: Bearer <token>`;
  - Constant-time comparison via `crypto.timingSafeEqual`;
  - `503 AUTH_NOT_CONFIGURED` when `ACTION_REQUIRE_BEARER=true` but `ACTION_BEARER_TOKEN` is missing;
  - `401 AUTH_FAILED` for missing/wrong token;
  - `/health` and `/openapi.json` remain public (no auth);
  - OpenAPI document advertises `ActionBearerAuth` security scheme on patch operations only.

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

## Bearer Auth — live smoke 2026-05-26

### Code changes (commit `4e5a337`)

- `src/config.mjs`: added `actionBearerToken` and `actionRequireBearer` (default `true`).
- `src/server.mjs`: `requireBearer()` helper using `crypto.timingSafeEqual` constant-time comparison.
- `src/openapi.mjs`: `components.securitySchemes.ActionBearerAuth` (http, bearer, opaque) — security on patch operations only.
- `src/safety.mjs`: fixed `GitHubAdddError` typo → `GitHubAddError`.
- `tests/server.test.mjs`: 7 new auth tests — 13 total, all PASS.

### Railway variables

- `ACTION_BEARER_TOKEN`: set server-side; value and credential fingerprints are intentionally not recorded.
- `ACTION_REQUIRE_BEARER`: `true`.

### Smoke cycle

| # | Test | Evidence | Result |
|---|------|----------|--------|
| 1 | Health `GET /health` without Bearer | HTTP 200 `{"status":"ok"}` | PASS |
| 2 | OpenAPI `/openapi.json` | `/patch/preview` has `security: [{ActionBearerAuth:[]}]`, `/health` has no security, `ActionBearerAuth` scheme present | PASS |
| 3 | `/patch/preview` without Authorization header | HTTP 401 `{"status":"AUTH_FAILED"}` | PASS |
| 4 | `/patch/preview` with wrong Bearer token | HTTP 401 `{"status":"AUTH_FAILED"}` | PASS |
| 5 | `/patch/preview` with correct Bearer token | HTTP 200 `{"status":"DRY_RUN_PASS"}`, `patch_id` present, `markers_found: {start:1, end:1}` | PASS |

### Commit evidence

- Bearer auth code: `4e5a337` (commit pushed to main).
- Bearer auth deploy: `c0625e7f-b708-4822-bbed-4d9760c13374` (Railway deployment, SUCCESS).

### Secret safety

- Generated token is 64 random hex characters (32 bytes).
- Set via Railway GraphQL `variableUpsert` (never printed, echoed, or logged).
- Token value never stored in code, config, or memory files.
- `RAILWAY_API_TOKEN` used only via GraphQL, never disclosed.
- Only the first 8 hex characters (token prefix) recorded for verification.
