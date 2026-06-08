# Command Registry — GitHub ADD

Status: `ACTIVE`

## Purpose

`src/commands/index.mjs` is the single source of truth for GPT-visible GitHub ADD commands.

A command entry defines:

- `operationId` — GPT Action command name.
- `method` and `path` — HTTP route.
- `summary` — OpenAPI summary.
- `auth` — `none` or `bearer`.
- `requestSchemaRef` — OpenAPI request schema reference for `POST` commands.
- `responses` — OpenAPI responses.

## Generation flow

```text
src/commands/index.mjs
  ├─ commands[]        → src/server2.mjs route dispatch
  ├─ commands[]        → src/openapi.mjs paths
  ├─ schemas           → src/openapi.mjs components.schemas
  └─ securitySchemes   → src/openapi.mjs components.securitySchemes
```

The public GPT Builder import URL remains:

```text
https://github-add-api-production.up.railway.app/openapi.json
```

## Adding a command

1. Add or update a command in `src/commands/index.mjs`.
2. Add a request schema to `schemas` if the command accepts a body.
3. Add a handler mapping in `src/server2.mjs` under `handlerByOperationId`.
4. Add a smoke test in `tests/server.test.mjs`.
5. Run `npm run check`.
6. Deploy and re-import `/openapi.json` in GPT Builder.

## Guardrails

- `validateCommands(commands)` runs during OpenAPI generation and production handler creation.
- Duplicate `operationId` values are blocked.
- Duplicate `method path` routes are blocked.
- Every `POST` command must have `requestSchemaRef`.
- Every protected command must declare `auth: "bearer"`.

## Current commands

| operationId | Method | Path | Auth |
|---|---:|---|---|
| `githubAddHealth` | GET | `/health` | none |
| `githubReadFile` | POST | `/file/read` | bearer |
| `githubCreateFile` | POST | `/file/create` | bearer |
| `githubPatchPreview` | POST | `/patch/preview` | bearer |
| `githubPatchApply` | POST | `/patch/apply` | bearer |
