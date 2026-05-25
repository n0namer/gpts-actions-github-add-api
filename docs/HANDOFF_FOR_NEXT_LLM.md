# Handoff for Next LLM — GitHub ADD

## Project identity

Project name: **GitHub ADD**

Meaning: **GitHub Additional Commands**

Repository: `n0namer/GitHub-add`

Target runtime: separate Railway project/service named `github-add`.

## User intent

The user does not want a large custom GitHub platform. The user wants a small standalone service that adds missing high-value GitHub commands for GPTS.

The first and only MVP capability is safe patch editing for text files.

## Important correction from prior discussion

Do not overbuild this into:

- GitHub App;
- marketplace/addon product;
- universal GitHub operator;
- n8n-control extension;
- full repository checkout worker;
- PR-mode system.

For MVP, use the existing GitHub token and a separate Railway service.

## Chosen ready-made library

Use:

```text
kpdecker/jsdiff
npm package: diff
```

Purpose:

- create/preview text diffs;
- support patch-oriented text transformations where useful;
- keep patch/diff logic out of GPTS prompt context.

GitHub API access should be done through the service using GitHub REST, preferably `@octokit/rest`.

## Core idea

GitHub does not offer a high-level native operation like `replace_between_markers`.

So GitHub ADD exposes this higher-level operation to GPTS:

```text
replace block between markers
insert text after marker
preview patch
apply patch
```

Internally the service does normal GitHub file update flow:

```text
read file → patch text in memory → validate diff → update full file via GitHub API → reread evidence
```

## MVP API

Endpoints:

```text
GET  /health
GET  /openapi.json
POST /patch/preview
POST /patch/apply
```

Supported operations:

```text
replace_between_markers
insert_after_marker
```

## Required safety rules

- `expected_sha` is required.
- Preview before apply.
- Apply rereads file before commit.
- Markers must be found exactly once.
- Diff must stay under configured limits.
- Protected paths blocked by default.
- Basic secret scan required.
- No parallel write to the same `repo + branch + path`.
- No secrets printed in logs.

## Railway MVP

Create a separate Railway project:

```text
Railway project: github-add
Service: github-add-api
```

Required environment variables:

```text
PORT=8080
NODE_ENV=production
GITHUB_TOKEN=<existing token>
GITHUB_ALLOWED_REPOS=n0namer/n8n-control,n0namer/gpts-n8n-action-schema,n0namer/GitHub-add
GITHUB_ALLOWED_BRANCHES=main
GITHUB_ALLOWED_PATH_PREFIXES=docs/,prompts/,schemas/,workspace/,test-fixtures/
PATCH_MAX_FILE_BYTES=200000
PATCH_MAX_CHANGED_LINES=300
PATCH_REQUIRE_PREVIEW=true
PATCH_BLOCK_PROTECTED_PATHS=true
```

## Definition of Done

Do not claim DONE until:

- `/health` returns 200.
- `/openapi.json` returns valid OpenAPI.
- `/patch/preview` works on a marker fixture.
- `/patch/apply` commits to a test file.
- response includes `commit_sha`.
- reread verifies file content changed.
- sha mismatch returns 409.
- missing marker returns 422.
- duplicate marker returns 422.
- protected path blocked.
- no secrets printed.

## First execution request

```text
REQUEST_ID: GITHUB_ADD_MVP_001
Mode: implementation package first, then build.
Goal: create standalone github-add Railway service with jsdiff + GitHub API patch preview/apply.
Do not use manual hotfix loop.
Evidence required: code diff, tests, Railway health URL, preview/apply smoke, commit SHA, reread proof.
```
