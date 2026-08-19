# API Contract — GitHub ADD

## Scope

MVP exposes only 3 public GPTS-facing operations:

```text
githubAddHealth
githubPatchPreview
githubPatchApply
```

Optional public endpoint:

```text
GET /openapi.json
```

## Base URL

To be filled after Railway deploy:

```text
https://<github-add-service>.up.railway.app
```

## Endpoint: GET /health

### Response 200

```json
{
  "status": "ok",
  "service": "github-add",
  "version": "0.1.0"
}
```

## Endpoint: POST /patch/preview

### Purpose

Dry-run a partial text edit against a GitHub file. Return diff and evidence. Do not commit.

### Request

```json
{
  "repository_full_name": "n0namer/GitHub-add",
  "branch": "main",
  "path": "test-fixtures/example.md",
  "expected_sha": "abc123",
  "operation": {
    "type": "replace_between_markers",
    "start_marker": "<!-- GPT:START block -->",
    "end_marker": "<!-- GPT:END block -->",
    "new_text": "New text"
  },
  "options": {
    "max_changed_lines": 300
  }
}
```

### Operation: replace_between_markers

```json
{
  "type": "replace_between_markers",
  "start_marker": "<!-- GPT:START block -->",
  "end_marker": "<!-- GPT:END block -->",
  "new_text": "New text"
}
```

Rules:

- start marker must occur exactly once;
- end marker must occur exactly once;
- start marker must appear before end marker;
- markers remain in the final file;
- only content between markers is replaced.

### Operation: insert_after_marker

```json
{
  "type": "insert_after_marker",
  "marker": "<!-- GPT:INSERT_AFTER setup -->",
  "text": "Inserted text"
}
```

Rules:

- marker must occur exactly once;
- new text is inserted after marker;
- marker remains in final file.

### Preview response 200

```json
{
  "status": "DRY_RUN_PASS",
  "can_apply": true,
  "repository_full_name": "n0namer/GitHub-add",
  "branch": "main",
  "path": "test-fixtures/example.md",
  "file_sha_before": "abc123",
  "operation_type": "replace_between_markers",
  "markers_found": {
    "start": 1,
    "end": 1
  },
  "changed_lines": {
    "added": 12,
    "deleted": 4
  },
  "diff_preview": "...",
  "patch_id": "sha256-request-file-operation",
  "evidence": {
    "expected_sha_matched": true,
    "repo_allowed": true,
    "branch_allowed": true,
    "path_allowed": true,
    "protected_path_blocked": false,
    "diff_within_limit": true,
    "secret_scan_pass": true
  }
}
```

## Endpoint: POST /patch/apply

### Purpose

Apply a previously previewed partial text edit and commit the updated file through GitHub API.

### Request

Same as preview, plus commit message:

```json
{
  "repository_full_name": "n0namer/GitHub-add",
  "branch": "main",
  "path": "test-fixtures/example.md",
  "expected_sha": "abc123",
  "operation": {
    "type": "replace_between_markers",
    "start_marker": "<!-- GPT:START block -->",
    "end_marker": "<!-- GPT:END block -->",
    "new_text": "New text"
  },
  "commit_message": "test: patch fixture block"
}
```

### Apply response 200

```json
{
  "status": "APPLY_PASS",
  "repository_full_name": "n0namer/GitHub-add",
  "branch": "main",
  "path": "test-fixtures/example.md",
  "file_sha_before": "abc123",
  "file_sha_after": "def456",
  "commit_sha": "commit123",
  "reread_verified": true,
  "operation_type": "replace_between_markers",
  "changed_lines": {
    "added": 12,
    "deleted": 4
  },
  "evidence": {
    "expected_sha_matched": true,
    "markers_unique": true,
    "diff_within_limit": true,
    "secret_scan_pass": true,
    "reread_verified": true
  }
}
```

## Error contract

### 400 BAD_REQUEST

Invalid schema, missing required fields, unsupported operation.

```json
{
  "status": "BAD_REQUEST",
  "message": "expected_sha is required"
}
```

### 401 AUTH_FAILED

GitHub token missing/invalid.

```json
{
  "status": "AUTH_FAILED",
  "message": "GitHub authentication failed"
}
```

### 403 NOT_ALLOWED

Protected or unsafe path is not allowed.

```json
{
  "status": "NOT_ALLOWED",
  "reason": "protected_path"
}
```

### 404 FILE_NOT_FOUND

GitHub file does not exist.

```json
{
  "status": "FILE_NOT_FOUND",
  "path": "docs/example.md"
}
```

### 409 FILE_CHANGED

Current GitHub file sha does not match request `expected_sha`.

```json
{
  "status": "FILE_CHANGED",
  "expected_sha": "abc123",
  "actual_sha": "def456"
}
```

GPTS behavior: reread file, rebuild patch, preview again, then apply.

### 422 PATCH_NOT_APPLICABLE

Patch cannot be applied safely.

Examples:

- marker missing;
- marker duplicated;
- start marker after end marker;
- diff too large;
- protected path;
- secret scan failed.

```json
{
  "status": "PATCH_NOT_APPLICABLE",
  "reason": "duplicate_start_marker",
  "marker": "<!-- GPT:START block -->"
}
```

### 423 WRITE_LOCKED

Another write is in progress for same repo/branch/path.

```json
{
  "status": "WRITE_LOCKED",
  "lock_key": "n0namer/GitHub-add:main:test-fixtures/example.md"
}
```

### 500 GITHUB_ADD_ERROR

Unexpected service error. Must not print secrets.

```json
{
  "status": "GITHUB_ADD_ERROR",
  "message": "internal error",
  "request_id": "..."
}
```

## GPTS usage rule

```text
Read file through direct GitHub connector first.
Use file sha as expected_sha.
Call githubPatchPreview.
Inspect diff.
Call githubPatchApply only when diff is correct.
Reread file after apply.
Claim DONE only with commit_sha + reread proof.
```
