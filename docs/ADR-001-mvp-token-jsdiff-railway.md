# ADR-001 — MVP uses existing GitHub token + jsdiff + standalone Railway service

## Status

Accepted for MVP.

## Context

The user needs GPTS to safely edit small parts of GitHub text files without asking the model to reconstruct and overwrite complete files manually.

GitHub's normal file update flow writes a new complete file content in a commit. It does not expose a simple high-level command such as:

```text
replace_between_markers
insert_after_marker
preview_patch_without_commit
```

The user already has a working GitHub token and wants a fast, cheap MVP.

The user explicitly rejected overbuilding and clarified:

- do not create a GitHub App now;
- do not build a marketplace/addon product now;
- do not merge this into n8n-control;
- create a separate service named GitHub ADD / GitHub Additional Commands;
- use the ready-made JS diff/patch library already selected earlier.

## Decision

Build GitHub ADD as a separate Railway service.

```text
GPTS → GitHub ADD → GitHub API
                 ↳ kpdecker/jsdiff / npm package diff
```

MVP authentication:

```text
existing GITHUB_TOKEN in Railway env
```

MVP endpoints:

```text
GET  /health
GET  /openapi.json
POST /patch/preview
POST /patch/apply
```

MVP operations:

```text
replace_between_markers
insert_after_marker
```

Use `kpdecker/jsdiff` / npm package `diff` for text diff/patch support.

Use GitHub REST API through a service-side client, preferably `@octokit/rest`.

## Why not GitHub App in MVP

GitHub App is strategically cleaner for multi-team installation later, but it is unnecessary for the first proof.

It adds:

- GitHub App registration;
- private key management;
- installation flow;
- installation IDs;
- temporary installation token issuance;
- extra setup for users/teams.

The MVP only needs to prove:

```text
Can GPTS safely preview and apply partial file edits through a small service?
```

Existing token is enough for that.

## Future-proofing rule

Keep auth isolated behind:

```text
getGitHubClient(context)
```

MVP implementation uses `GITHUB_TOKEN`.

Future implementation may use GitHub App installation auth.

Do not spread token-specific code across patch logic.

## Consequences

### Positive

- Fastest MVP.
- Low deployment complexity.
- Does not touch n8n-control.
- Simple GPTS action surface.
- Easy to test with fixtures.
- Can migrate auth later.

### Negative

- Not yet suitable as multi-tenant public add-on.
- Access scope depends on token permissions.
- Token rotation/ownership remains operational concern.
- Audit model is weaker than GitHub App installations.

### Mitigations

- Restrict allowed repositories.
- Restrict allowed branches.
- Restrict allowed path prefixes.
- Block protected paths.
- Never print token or headers.
- Keep future auth abstraction.

## Alternatives considered

### Alternative 1 — GitHub App immediately

Rejected for MVP. Better long-term but slower and more complex now.

### Alternative 2 — GitHub Action worker with git apply

Rejected for MVP. Useful later for PR-mode and code changes, but too slow/heavy for the immediate GPTS editing UX.

### Alternative 3 — use direct GitHub connector only

Rejected as the main solution. Direct connector can update whole files but does not provide marker patch preview/apply guardrails.

### Alternative 4 — merge into n8n-control

Rejected. Different responsibility and risk. GitHub ADD should stay independent.

## Definition of success

MVP is successful when:

- service deployed on Railway;
- GPTS imports OpenAPI;
- preview returns diff without commit;
- apply creates GitHub commit;
- reread verifies content;
- negative safety tests pass;
- no secrets are exposed.
