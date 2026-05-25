# Implementation Plan — GitHub ADD MVP

## Goal

Build the smallest useful GitHub ADD service for GPTS:

```text
GET  /health
GET  /openapi.json
POST /patch/preview
POST /patch/apply
```

Only support text-file patching for:

```text
replace_between_markers
insert_after_marker
```

## Implementation principles

- Start with tests and fixtures.
- Build one bounded slice at a time.
- Do not create GitHub App in MVP.
- Do not mix this service into n8n-control.
- Do not build PR mode yet.
- Do not implement full repo checkout.
- Use existing GitHub token.
- Keep auth behind `getGitHubClient(context)` for future migration.

## Suggested stack

```text
Node.js 20+
TypeScript
Fastify or Express
zod
@octokit/rest
diff / jsdiff
vitest or node:test
```

## Repo structure

```text
src/
  server.ts
  routes/
    health.ts
    openapi.ts
    patchPreview.ts
    patchApply.ts
  github/
    getGitHubClient.ts
    readFile.ts
    updateFile.ts
  patch/
    applyOperation.ts
    replaceBetweenMarkers.ts
    insertAfterMarker.ts
    createDiff.ts
  safety/
    validateRepo.ts
    validateBranch.ts
    validatePath.ts
    protectedPaths.ts
    scanSecrets.ts
    checkDiffLimit.ts
    locks.ts
  schemas/
    patchSchemas.ts
  evidence/
    buildEvidence.ts

tests/
  replaceBetweenMarkers.test.ts
  insertAfterMarker.test.ts
  expectedSha.test.ts
  safety.test.ts
  api.preview.test.ts
  api.apply.test.ts

test-fixtures/
  marker-file.md
```

## Phase 0 — Bootstrap

### Tasks

- Create minimal Node/TypeScript service.
- Add `/health`.
- Add `/openapi.json` placeholder.
- Add test runner.
- Add lint/typecheck scripts.

### DoD

- `npm test` passes.
- `/health` returns 200 locally.
- `/openapi.json` returns valid JSON.

## Phase 1 — Patch engine

### Tasks

Implement pure functions first:

```text
replaceBetweenMarkers(input, startMarker, endMarker, newText)
insertAfterMarker(input, marker, text)
createDiff(oldText, newText)
```

### Required behavior

`replaceBetweenMarkers`:

- start marker exactly once;
- end marker exactly once;
- start before end;
- markers preserved;
- only inner content replaced;
- clear structured error if invalid.

`insertAfterMarker`:

- marker exactly once;
- marker preserved;
- text inserted after marker;
- clear structured error if invalid.

### DoD

- Unit tests pass.
- Missing marker test returns structured error.
- Duplicate marker test returns structured error.
- Start-after-end test returns structured error.

## Phase 2 — GitHub read/update

### Tasks

Implement:

```text
getGitHubClient(context)
readFile(repository_full_name, branch, path)
updateFile(repository_full_name, branch, path, content, sha, message)
```

### DoD

- Can read a known file from allowed repo.
- Gets decoded UTF-8 content and file sha.
- Can update test fixture file through GitHub API.
- Update returns commit sha.

## Phase 3 — Safety layer

### Tasks

Implement checks:

- allowed repository;
- allowed branch;
- allowed path prefix;
- protected path blocklist;
- expected sha match;
- max file size;
- max changed lines;
- basic secret scan;
- in-memory lock by `repo + branch + path`.

### DoD

- Disallowed repo returns 403.
- Disallowed branch returns 403.
- Protected path returns 422 or 403.
- SHA mismatch returns 409.
- Too-large diff returns 422.
- Secret-like content blocked or flagged.

## Phase 4 — `/patch/preview`

### Tasks

- Validate request with zod.
- Read GitHub file.
- Check expected sha.
- Apply operation in memory.
- Generate diff preview.
- Run safety checks.
- Return `DRY_RUN_PASS`.
- Do not commit.

### DoD

- Preview success on `test-fixtures/marker-file.md`.
- No GitHub commit created during preview.
- Response includes diff, changed lines, safety evidence.

## Phase 5 — `/patch/apply`

### Tasks

- Validate request.
- Acquire lock.
- Reread GitHub file.
- Check expected sha again.
- Apply operation in memory.
- Run safety checks again.
- Update file through GitHub API.
- Reread final file.
- Return `APPLY_PASS` with commit sha and reread proof.
- Release lock even on error.

### DoD

- Apply success on test fixture.
- Response includes commit sha.
- Reread verifies final content.
- Same apply with old sha returns 409.

## Phase 6 — OpenAPI for GPTS

### Tasks

- Expose `/openapi.json`.
- Only include 3 operations:
  - `githubAddHealth`
  - `githubPatchPreview`
  - `githubPatchApply`
- Use small schemas. Avoid operation bloat.

### DoD

- GPTS imports schema.
- Operation names are clear.
- No internal/debug endpoints exposed.

## Phase 7 — Railway deploy

### Tasks

- Create Railway project `github-add`.
- Deploy service `github-add-api`.
- Set environment variables.
- Verify public `/health`.
- Run smoke preview/apply.

### DoD

- Railway URL exists.
- `/health` returns 200.
- `/openapi.json` returns valid OpenAPI.
- Preview/apply smoke PASS.
- Evidence recorded in README or deployment report.

## MVP smoke scenario

Use file:

```text
test-fixtures/marker-file.md
```

Initial content should contain:

```text
<!-- GPT:START smoke-block -->
old smoke content
<!-- GPT:END smoke-block -->
```

Smoke steps:

1. Direct GitHub read gets file sha.
2. `/patch/preview` replaces content between markers.
3. Verify diff only touches marker block.
4. `/patch/apply` commits change.
5. Reread file.
6. Verify content changed.
7. Record commit sha.

## Rollback

For MVP, rollback is GitHub-level:

- revert commit manually or through GitHub connector;
- do not build rollback endpoint in MVP.

## Done / not done reporting

Use strict statuses:

```text
DONE = implemented + tested + evidence
PARTIAL = implemented but missing evidence/test/deploy
BLOCKED = cannot proceed, with reason
PLANNED = not yet executed
HYPOTHESIS = not verified
```

Never report DONE from code claims alone.
