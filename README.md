# GitHub ADD

**GitHub ADD** = **GitHub Additional Commands**.

This repository contains the architecture and implementation plan for a small standalone service that gives GPTS extra safe GitHub commands that the normal GitHub connector/API does not provide directly.

## North Star

Give GPTS a safe, deterministic, evidence-based way to edit small parts of GitHub text files without manually rebuilding and overwriting the whole file in the model context.

```text
GPTS → GitHub ADD → GitHub API
                 ↳ kpdecker/jsdiff for text patch/diff
```

## What problem this solves

GitHub can update files, but the file update API replaces file content in a commit. It does not provide a native high-level operation like:

```text
replace this exact block between markers
insert this text after this marker
preview this patch before commit
```

GPTS can currently read files and update complete files through the GitHub connector, but that is risky for partial edits:

- the model may accidentally overwrite unrelated content;
- line numbers drift;
- concurrent edits can be lost;
- there is no built-in dry-run patch preview;
- there is no simple marker-based operation.

GitHub ADD is a small safety adapter:

```text
read file → apply patch in memory → preview diff → apply through GitHub API → reread proof
```

## MVP decision

Use the simplest architecture.

- Separate Railway project/service.
- Use existing GitHub token in MVP.
- Use `kpdecker/jsdiff` / npm package `diff` as ready-made text diff/patch core.
- Use GitHub REST API client, preferably `@octokit/rest`.
- Do **not** build GitHub App in MVP.
- Do **not** merge this into `n8n-control`.
- Do **not** build a universal GitHub operator.

## MVP endpoints

```text
GET  /health
GET  /openapi.json
POST /patch/preview
POST /patch/apply
```

## MVP operations

```text
replace_between_markers
insert_after_marker
```

## Not MVP

```text
GitHub App
Marketplace
billing/dashboard
PR mode
full repo checkout
multi-file batch patch
.github/workflows editing
secrets/env/credentials editing
universal GitHub operator
```

## Source of truth in this repository

Read in this order:

1. `docs/HANDOFF_FOR_NEXT_LLM.md`
2. `docs/ARCHITECTURE.md`
3. `docs/API_CONTRACT.md`
4. `docs/IMPLEMENTATION_PLAN.md`
5. `docs/RAILWAY_DEPLOYMENT.md`
6. `docs/TASKS.yaml`

## Implementation principle

Do not write speculative code first. Start with an implementation package, then build the smallest working service.

Required proof before DONE:

- `/health` returns 200.
- `/openapi.json` is available.
- `/patch/preview` returns `DRY_RUN_PASS` on marker fixture.
- `/patch/apply` returns `APPLY_PASS` on test file.
- GitHub commit SHA is returned.
- Reread verifies final content.
- `expected_sha` mismatch returns 409.
- missing or duplicate marker returns 422.
- protected paths are blocked.
- no secrets printed in logs.
