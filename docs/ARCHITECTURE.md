# Architecture — GitHub ADD

## Summary

GitHub ADD is a small standalone service that gives GPTS additional safe GitHub commands for partial text-file edits.

It does not replace the direct GitHub connector. It complements it.

```text
Direct GitHub connector = read/search/issues/PR/normal GitHub operations
GitHub ADD = safe patch preview/apply for partial text edits
```

## Target architecture

```text
GPTS
  ├─ Direct GitHub connector
  │    ├─ fetch_file
  │    ├─ search
  │    ├─ issues
  │    ├─ pull requests
  │    └─ normal full-file create/update when appropriate
  │
  └─ GitHub ADD, Railway service
       ├─ /health
       ├─ /openapi.json
       ├─ /patch/preview
       └─ /patch/apply
              ↓
          GitHub REST API
              ↓
          GitHub commit + reread evidence
```

## Why this architecture

GitHub's normal file update model replaces the full file content in a commit. GitHub ADD does not change that model.

Instead, GitHub ADD adds a safer GPT-facing intent layer:

```text
GPTS intent: replace this marker block
Service action: read file, patch text, validate diff, update file, return evidence
```

This prevents GPTS from carrying a whole file in context and accidentally overwriting unrelated content.

## Non-goals

GitHub ADD MVP is not:

- a GitHub App;
- a marketplace product;
- a full repository worker;
- a pull request automation platform;
- a universal GitHub operator;
- a replacement for direct GitHub connector;
- part of n8n-control.

## Core components

### 1. HTTP API

Recommended stack:

```text
Node.js
TypeScript
Fastify or Express
zod for request validation
```

### 2. GitHub API client

Recommended:

```text
@octokit/rest
```

Responsibilities:

- read file content and current sha;
- update file using GitHub Contents API;
- return commit sha;
- reread final file for verification.

### 3. Patch/diff engine

Chosen ready-made core:

```text
kpdecker/jsdiff
npm package: diff
```

Responsibilities:

- create diff preview;
- optionally apply unified patch later;
- keep text diff logic outside GPT prompt context.

For MVP, marker operations can be implemented directly and `jsdiff` used for diff generation.

### 4. Safety layer

Responsibilities:

- protected path blocklist;
- expected sha check;
- marker uniqueness check;
- diff size limit;
- file size limit;
- basic secret scan;
- per-file write lock.

### 5. Evidence layer

Every apply response must include:

- status;
- file sha before;
- file sha after;
- commit sha;
- changed line counts;
- reread verification flag;
- safety checks summary.

## Request lifecycle

### Preview lifecycle

```text
1. Validate request schema.
2. Validate path safety and protected-path policy.
3. Read file from GitHub.
4. Check expected_sha.
5. Apply marker operation in memory.
6. Generate diff preview.
7. Run safety checks.
8. Return DRY_RUN_PASS or clear failure code.
9. Do not commit.
```

### Apply lifecycle

```text
1. Validate request schema.
2. Validate repo/branch/path against allowlists.
3. Acquire write lock for repo + branch + path.
4. Read file from GitHub again.
5. Check expected_sha again.
6. Apply same marker operation in memory.
7. Generate diff and run safety checks.
8. Update file through GitHub API.
9. Reread file.
10. Verify resulting content.
11. Release lock.
12. Return APPLY_PASS with commit_sha and evidence.
```

## Auth architecture

MVP auth:

```text
GITHUB_TOKEN from Railway env
```

Do not expose token to GPTS.

Future-proofing:

Create an internal function:

```text
getGitHubClient(context)
```

MVP implementation:

```text
use process.env.GITHUB_TOKEN
```

Future implementation:

```text
use GitHub App installation token
```

This keeps future GitHub App migration possible without rewriting patch logic.

## Routing rules for GPTS

Use direct GitHub connector for:

- reading files;
- searching code;
- inspecting commits;
- issues;
- pull requests;
- ordinary full-file writes when explicitly needed.

Use GitHub ADD for:

- replace block between markers;
- insert text after marker;
- patch preview;
- patch apply;
- small partial text edits.

Do not use GitHub ADD for:

- binary files;
- credentials;
- `.github/workflows/**` in MVP;
- large refactors;
- multi-file edits;
- protected production changes.

## ATAM-lite decision

### Drivers

- Fast MVP.
- Cheap implementation.
- Safer partial edits.
- Low coupling with n8n-control.
- Future migration to GitHub App.

### Chosen tradeoff

Use existing token now. Do not build GitHub App in MVP.

### Sensitivity points

- `expected_sha` handling.
- marker uniqueness.
- parallel writes.
- protected path blocklist.
- secret scan quality.
- OpenAPI action simplicity.

### Risks

- GPTS may try to use GitHub ADD for too-large changes.
- A weak secret scan may miss sensitive data.
- If locks are only in memory, multi-instance deployments can race.
- If allowed paths are too broad, unsafe edits are possible.

### Mitigations

- Keep MVP single instance or use external lock later.
- Enforce max file size and max changed lines.
- Restrict path prefixes.
- Block protected paths.
- Require preview before apply.
- Require reread proof.

## Final architecture decision

```text
Separate Railway service: github-add
MVP auth: existing GitHub token
Patch core: kpdecker/jsdiff
GitHub client: @octokit/rest
GPTS surface: health + preview + apply
```
