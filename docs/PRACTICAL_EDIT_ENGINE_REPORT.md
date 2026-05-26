# Practical Edit Engine Verification — 2026-05-26

Status: DONE for backend practical text-edit layer.

## Goal

Move GitHub ADD beyond marker-only patches. The model can now send the text it wants to replace and the service validates where and whether it can be safely applied.

## Implemented operations

- `POST /file/read`
- `replace_exact_once`
- `replace_with_context`
- `replace_line_range`
- `insert_after_exact_once`
- existing marker operations remain backward-compatible:
  - `replace_between_markers`
  - `insert_after_marker`

## Runtime evidence

Railway service:

- Project: `github-add`
- Service: `github-add-api`
- Domain: `github-add-api-production.up.railway.app`

Deployment:

- Commit: `11e5782b890b18ebc5bdab95bc3c22fb0e8e2dff`
- Deployment: `84992a27-d0ad-48e7-b94d-9f2ef9fbbff3`
- Status: `SUCCESS`

Corrective reread retry:

- Commit: `33b074b8a5cfe7884449dcfa64d5bc59704b6c5a`
- Deployment: `e1c5e683-6c83-4359-90bd-10ff3bb07a40`
- Status: `SUCCESS`
- Reason: live apply committed successfully but immediate reread could receive stale GitHub content; retry loop fixes this.

## Test evidence

Commit `33b074b8a5cfe7884449dcfa64d5bc59704b6c5a` records:

- `node --check src/server.mjs`: PASS
- `npm test`: 37/37 PASS
- Added test: stale `readFile` returns old content for 2 calls, then fresh content; apply succeeds after retry.

## Live smoke evidence

Target:

- Repo: `n0namer/GitHub-add`
- Branch: `main`
- File: `test-fixtures/marker-file.md`
- Initial SHA: `7035707c364e2b0bf5470dd3bf896952e4e2e38c`

### replace_exact_once preview

Operation:

- `old_text`: `old smoke content`
- `new_text`: `exact once retry verify 2026-05-26T16:28:00Z`

Result:

- Status: `DRY_RUN_PASS`
- Patch ID: `c0da540c63ec0cc8f7a1723e9d2c550671076028a35275ddff476e6429fafb2b`
- `target_match.line`: `10`
- Changed lines: `+1 / -1`

### replace_exact_once apply

Result:

- Status: `APPLY_PASS`
- Commit: `91f5734ac882f72f97e8780c136cd0a87036f97a`
- File SHA after apply: `a047fe26f88886daacaeb2b9e64f95bc3719fd97`
- `reread_verified`: `true`

### restore fixture

Restore operation:

- `old_text`: `exact once retry verify 2026-05-26T16:28:00Z`
- `new_text`: `old smoke content`

Result:

- Status: `APPLY_PASS`
- Commit: `53c955f32e438cef34b694fa0189472441427ed9`
- Final SHA: `7035707c364e2b0bf5470dd3bf896952e4e2e38c`
- `reread_verified`: `true`

## Negative test evidence

Operation:

- `replace_exact_once`
- `old_text`: `GitHub ADD`

Result:

- Status: `PATCH_NOT_APPLICABLE`
- Reason: `old_text_not_unique`
- Occurrences: `2`
- Candidate lines returned:
  - line 1: `# GitHub ADD Smoke Fixture`
  - line 5: `Do not use production files for the first apply test.`

This proves the service does not guess when the text is ambiguous.

## Verdict

Backend practical edit engine: ACCEPT / DONE.

Still not marked DONE:

- GPT Builder UI re-import of updated OpenAPI.
- GPTS UI call to `githubReadFile`.
- First useful non-fixture document write-back via GPTS UI.
