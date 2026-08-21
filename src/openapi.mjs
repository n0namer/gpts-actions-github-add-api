export function openApiDocument() {
  const patchRequestProperties = {
    repository_full_name: { type: "string", examples: ["n0namer/GitHub-add"] },
    branch: { type: "string", examples: ["main"] },
    path: { type: "string", examples: ["test-fixtures/marker-file.md"] },
    expected_sha: { type: "string" },
    operation: {
      oneOf: [
        { $ref: "#/components/schemas/ReplaceBetweenMarkersOperation" },
        { $ref: "#/components/schemas/InsertAfterMarkerOperation" },
        { $ref: "#/components/schemas/ReplaceExactOnceOperation" },
        { $ref: "#/components/schemas/ReplaceWithContextOperation" },
        { $ref: "#/components/schemas/ReplaceLineRangeOperation" },
        { $ref: "#/components/schemas/InsertAfterExactOnceOperation" },
      ],
    },
    options: { type: "object", properties: { max_changed_lines: { type: "integer" } } },
  };

  const jsonResponse = (schemaRef, description) => ({
    description,
    content: {
      "application/json": {
        schema: { $ref: schemaRef },
      },
    },
  });

  return {
    openapi: "3.1.0",
    info: {
      title: "GitHub Control + File Patch API",
      version: "0.5.0",
      description: "Action-friendly GitHub control plane: safe file/PR operations plus generic REST and GraphQL gateways, GitHub App/installation auth, bounded pagination, repository/ruleset/CI diagnostics, scoped ref-write probes, bounded Actions job logs, mutation confirmation, repository policy enforcement, response limits, and secret redaction.",
    },
    servers: [
      {
        url: "https://github-patch.srv1904412.hstgr.cloud",
        description: "Coolify production",
      },
    ],
    paths: {
      "/health": {
        get: {
          operationId: "addHealth",
          summary: "Health check",
          responses: {
            "200": jsonResponse("#/components/schemas/HealthResponse", "Service is healthy"),
          },
        },
      },
      "/github/rest": {
        post: {
          operationId: "githubRest",
          summary: "Call any GitHub REST API path through the server-owned credential gateway",
          description: "GitHub REST gateway. Reads are allowed. Writes require confirm_mutation. Admin/destructive writes are disabled by default and need separate server enable flags plus dedicated confirmations. Secret mutations are blocked; repo scope is enforced server-side.",
          security: [{ ActionBearerAuth: [] }],
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/GitHubRestRequest" } } } },
          responses: {
            "200": { description: "GitHub REST request succeeded with bounded/redacted response" },
            "400": { description: "Invalid method, path, query, or auth mode" },
            "401": { description: "GitHub authentication failed" },
            "403": { description: "GitHub or repository policy denied the operation" },
            "409": { description: "Mutation confirmation required" },
            "502": { description: "GitHub API unavailable, failed, or response too large" },
            "503": { description: "Requested GitHub App authentication is not configured" },
          },
          "x-openai-isConsequential": true,
        },
      },
      "/github/graphql": {
        post: {
          operationId: "githubGraphql",
          summary: "Call GitHub GraphQL with server-owned user or installation credentials",
          description: "GitHub GraphQL gateway. Queries are allowed. Mutations are disabled by default; when enabled they require write and admin confirmations. In repo-scoped mode, use installation auth; credentials remain server-side.",
          security: [{ ActionBearerAuth: [] }],
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/GitHubGraphqlRequest" } } } },
          responses: { "200": { description: "GraphQL request succeeded" }, "400": { description: "Invalid GraphQL request" }, "409": { description: "Mutation confirmation required" }, "502": { description: "GitHub GraphQL request failed" } },
          "x-openai-isConsequential": true,
        },
      },
      "/github/repository/diagnose": {
        post: {
          operationId: "diagnoseGitHubRepository",
          summary: "Diagnose repository controls, CI, rulesets, protection, checks, and status",
          security: [{ ActionBearerAuth: [] }],
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/GitHubRepositoryDiagnoseRequest" } } } },
          responses: { "200": { description: "Repository diagnostic completed; individual checks include their own ok/status evidence" }, "403": { description: "Repository not allowed" } },
        },
      },
      "/github/ref-write-probe": {
        post: {
          operationId: "githubRefWriteProbe",
          summary: "Verify repository write capability using a temporary self-cleaning branch ref",
          description: "Creates a station/probe/* ref at the default-branch HEAD, verifies readback, then deletes that exact ref. Requires confirm_mutation=true.",
          security: [{ ActionBearerAuth: [] }],
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/GitHubRefWriteProbeRequest" } } } },
          responses: { "200": { description: "Create/readback/delete probe passed" }, "409": { description: "Mutation confirmation required" }, "502": { description: "Probe or cleanup failed" } },
          "x-openai-isConsequential": true,
        },
      },
      "/github/actions/job-logs": {
        post: {
          operationId: "downloadGitHubJobLogs",
          summary: "Download bounded GitHub Actions job logs without exposing signed redirect URLs",
          security: [{ ActionBearerAuth: [] }],
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/GitHubJobLogsRequest" } } } },
          responses: { "200": { description: "Job logs downloaded within configured size bounds" }, "403": { description: "Repository or GitHub permission denied" }, "404": { description: "Job not found" }, "502": { description: "Redirect or log download failed" } },
        },
      },
      "/github/app/diagnose": {
        post: {
          operationId: "diagnoseGitHubAppRepository",
          summary: "Diagnose GitHub App installation, permissions, token mint, and repository access",
          security: [{ ActionBearerAuth: [] }],
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/GitHubAppDiagnoseRequest" } } } },
          responses: {
            "200": { description: "GitHub App and repository installation are usable" },
            "403": { description: "Repository policy or GitHub App permissions denied access" },
            "404": { description: "No installation is available for the repository" },
            "503": { description: "GitHub App credentials are not configured or private key is invalid" },
          },
        },
      },
      "/file/read": {
        post: {
          operationId: "readFile",
          summary: "Read a file from GitHub with line view",
          security: [{ ActionBearerAuth: [] }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["repository_full_name", "branch", "path"],
                  properties: {
                    repository_full_name: { type: "string", examples: ["n0namer/GitHub-add"] },
                    branch: { type: "string", examples: ["main"] },
                    path: { type: "string", examples: ["test-fixtures/marker-file.md"] },
                    options: { type: "object", properties: { fields: { type: "array", items: { type: "string" } } } },
                  },
                },
              },
            },
          },
          responses: { "200": { description: "File read successfully" } },
        },
      },
      "/file/create": {
        post: {
          operationId: "createFile",
          summary: "Create a new file in GitHub and commit it",
          security: [{ ActionBearerAuth: [] }],
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/CreateFileRequest" } } } },
          responses: { "200": { description: "File created successfully" }, "401": { description: "Unauthorized — missing or invalid Bearer token" }, "409": { description: "File already exists" }, "422": { description: "Create cannot be applied safely or JSON validation failed" } },
          "x-openai-isConsequential": true,
        },
      },
      "/patch/preview": {
        post: {
          operationId: "patchPreview",
          summary: "Preview a safe marker-based or text-based patch without committing",
          security: [{ ActionBearerAuth: [] }],
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/PatchRequest" } } } },
          responses: { "200": { description: "Preview passed" }, "401": { description: "Unauthorized — missing or invalid Bearer token" }, "503": { description: "Bearer auth required but not configured" }, "409": { description: "Expected SHA mismatch" }, "422": { description: "Patch cannot be applied safely or JSON validation failed" } },
        },
      },
      "/patch/apply": {
        post: {
          operationId: "patchApply",
          summary: "Apply a previously previewed patch and commit it",
          security: [{ ActionBearerAuth: [] }],
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/PatchApplyRequest" } } } },
          responses: { "200": { description: "Apply passed" }, "401": { description: "Unauthorized — missing or invalid Bearer token" }, "503": { description: "Bearer auth required but not configured" }, "409": { description: "Expected SHA mismatch" }, "422": { description: "Patch cannot be applied safely or JSON validation failed" } },
          "x-openai-isConsequential": true,
        },
      },
      "/pull-request/read": {
        post: {
          operationId: "readPullRequest",
          summary: "Read pull request state and head SHA",
          security: [{ ActionBearerAuth: [] }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: {
              type: "object",
              required: ["repository_full_name", "pull_number"],
              properties: { repository_full_name: { type: "string" }, pull_number: { type: "integer", minimum: 1 } },
            } } },
          },
          responses: { "200": { description: "Pull request read successfully" }, "401": { description: "Unauthorized" }, "403": { description: "Repository not allowed" }, "404": { description: "Pull request not found" } },
        },
      },
      "/pull-request/ready": {
        post: {
          operationId: "markPullRequestReady",
          summary: "Mark a draft pull request ready for review with head SHA guard",
          security: [{ ActionBearerAuth: [] }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: {
              type: "object",
              required: ["repository_full_name", "pull_number", "expected_head_sha"],
              properties: { repository_full_name: { type: "string" }, pull_number: { type: "integer", minimum: 1 }, expected_head_sha: { type: "string" } },
            } } },
          },
          responses: { "200": { description: "Pull request is ready for review and reread verified" }, "401": { description: "Unauthorized" }, "403": { description: "Repository not allowed" }, "409": { description: "Pull request head SHA changed" }, "422": { description: "Operation blocked" } },
          "x-openai-isConsequential": true,
        },
      },
      "/pull-request/merge": {
        post: {
          operationId: "mergePullRequest",
          summary: "Merge a pull request with mandatory head SHA guard and reread verification",
          security: [{ ActionBearerAuth: [] }],
          requestBody: {
            required: true,
            content: { "application/json": { schema: {
              type: "object",
              required: ["repository_full_name", "pull_number", "expected_head_sha"],
              properties: {
                repository_full_name: { type: "string" },
                pull_number: { type: "integer", minimum: 1 },
                expected_head_sha: { type: "string" },
                merge_method: { type: "string", enum: ["merge", "squash", "rebase"], default: "merge" },
                commit_title: { type: "string" },
                commit_message: { type: "string" },
              },
            } } },
          },
          responses: { "200": { description: "Merge passed and reread verified" }, "401": { description: "Unauthorized" }, "403": { description: "Repository not allowed" }, "409": { description: "Pull request changed or merge blocked" }, "422": { description: "Pull request cannot be merged safely" } },
          "x-openai-isConsequential": true,
        },
      },
    },
    components: {
      securitySchemes: {
        ActionBearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "opaque",
        },
      },
      schemas: {
        GitHubRestRequest: {
          type: "object",
          required: ["method", "path"],
          properties: {
            auth: { type: "string", enum: ["user", "app", "installation"], default: "user", description: "Credential mode. App and installation modes require server-side GitHub App credentials." },
            method: { type: "string", enum: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] },
            path: { type: "string", examples: ["/repos/n0namer/gpt-coding-station", "/app/installations"] },
            query: { type: "object", additionalProperties: { oneOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }, { type: "array", items: { oneOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }] } }] } },
            query_json: { type: "string", description: "Action-friendly JSON object string alias for query when the importer cannot represent a free-form object." },
            body: { type: "object", additionalProperties: true, description: "GitHub JSON request body passed to GitHub for non-GET/HEAD methods" },
            body_json: { type: "string", description: "Action-friendly JSON object string alias for body when the importer cannot represent a free-form object." },
            repository_full_name: { type: "string", description: "Optional repository scope used for policy checks and automatic installation resolution", examples: ["n0namer/gpt-coding-station"] },
            installation_id: { type: "integer", minimum: 1, description: "Optional explicit GitHub App installation ID; installation auth can resolve it from repository_full_name" },
            paginate: { type: "boolean", default: false, description: "For GET requests, follow GitHub rel=next links within configured bounds." },
            max_pages: { type: "integer", minimum: 1, maximum: 10, default: 5 },
            max_items: { type: "integer", minimum: 1, maximum: 1000, default: 500 },
            confirm_mutation: { type: "boolean", default: false, description: "Required for generic writes." },
            confirm_admin_mutation: { type: "boolean", default: false, description: "Required in addition to confirm_mutation for server-enabled admin-class mutations." },
            confirm_destructive_mutation: { type: "boolean", default: false, description: "Required in addition to confirm_mutation for server-enabled destructive-class mutations." },
          },
        },
        GitHubGraphqlRequest: {
          type: "object",
          required: ["query"],
          properties: {
            auth: { type: "string", enum: ["user", "installation"], default: "user" },
            query: { type: "string", minLength: 1, maxLength: 100000 },
            variables: { type: "object", additionalProperties: true },
            variables_json: { type: "string", description: "Action-friendly JSON object string alias for variables when the importer cannot represent a free-form object." },
            repository_full_name: { type: "string", description: "Optional repository policy scope and installation resolver." },
            installation_id: { type: "integer", minimum: 1 },
            confirm_mutation: { type: "boolean", default: false },
            confirm_admin_mutation: { type: "boolean", default: false, description: "Required for server-enabled GraphQL mutations." },
          },
        },
        GitHubRepositoryDiagnoseRequest: {
          type: "object",
          required: ["repository_full_name"],
          properties: {
            repository_full_name: { type: "string", examples: ["n0namer/gpt-coding-station"] },
            auth: { type: "string", enum: ["user", "installation"], default: "user" },
            installation_id: { type: "integer", minimum: 1 },
            branch: { type: "string", description: "Optional branch override; defaults to repository default branch." },
            ref: { type: "string", description: "Optional ref used for check-runs and combined status." },
          },
        },
        GitHubRefWriteProbeRequest: {
          type: "object",
          required: ["repository_full_name", "confirm_mutation"],
          properties: {
            repository_full_name: { type: "string", examples: ["n0namer/gpt-coding-station"] },
            auth: { type: "string", enum: ["user", "installation"], default: "installation" },
            installation_id: { type: "integer", minimum: 1 },
            confirm_mutation: { type: "boolean", const: true },
          },
        },
        GitHubJobLogsRequest: {
          type: "object",
          required: ["repository_full_name", "job_id"],
          properties: {
            repository_full_name: { type: "string", examples: ["n0namer/gpt-coding-station"] },
            job_id: { type: "integer", minimum: 1 },
            auth: { type: "string", enum: ["user", "installation"], default: "user" },
            installation_id: { type: "integer", minimum: 1 },
            max_bytes: { type: "integer", minimum: 1, maximum: 2000000, default: 2000000 },
          },
        },
        GitHubAppDiagnoseRequest: {
          type: "object",
          required: ["repository_full_name"],
          properties: {
            repository_full_name: { type: "string", examples: ["n0namer/gpt-coding-station"] },
          },
        },
        HealthResponse: {
          type: "object",
          required: ["status", "service"],
          properties: {
            status: { type: "string", examples: ["ok"] },
            service: { type: "string", examples: ["github-file-patch-api"] },
            version: { type: "string", examples: ["0.5.0"] },
          },
        },
        CreateFileRequest: {
          type: "object",
          required: ["repository_full_name", "branch", "path", "content", "commit_message"],
          properties: {
            repository_full_name: { type: "string", examples: ["n0namer/GitHub-add"] },
            branch: { type: "string", examples: ["main"] },
            path: { type: "string", examples: ["docs/new-file.md"] },
            content: { type: "string" },
            commit_message: { type: "string" },
          },
        },
        PatchRequest: {
          type: "object",
          required: ["repository_full_name", "branch", "path", "expected_sha", "operation"],
          properties: patchRequestProperties,
        },
        PatchApplyRequest: {
          type: "object",
          required: ["repository_full_name", "branch", "path", "expected_sha", "operation", "commit_message"],
          properties: {
            ...patchRequestProperties,
            commit_message: { type: "string" },
            preview_patch_id: { type: "string" },
          },
        },
        ReplaceBetweenMarkersOperation: {
          type: "object",
          required: ["type", "start_marker", "end_marker", "new_text"],
          properties: { type: { const: "replace_between_markers" }, start_marker: { type: "string" }, end_marker: { type: "string" }, new_text: { type: "string" } },
        },
        InsertAfterMarkerOperation: {
          type: "object",
          required: ["type", "marker", "text"],
          properties: { type: { const: "insert_after_marker" }, marker: { type: "string" }, text: { type: "string" } },
        },
        ReplaceExactOnceOperation: {
          type: "object",
          required: ["type", "old_text", "new_text"],
          properties: { type: { const: "replace_exact_once" }, old_text: { type: "string" }, new_text: { type: "string" } },
        },
        ReplaceWithContextOperation: {
          type: "object",
          required: ["type", "old_text", "new_text"],
          properties: { type: { const: "replace_with_context" }, before: { type: "string" }, old_text: { type: "string" }, after: { type: "string" }, new_text: { type: "string" } },
        },
        ReplaceLineRangeOperation: {
          type: "object",
          required: ["type", "start_line", "end_line", "expected_old_text", "new_text"],
          properties: { type: { const: "replace_line_range" }, start_line: { type: "integer" }, end_line: { type: "integer" }, expected_old_text: { type: "string" }, new_text: { type: "string" } },
        },
        InsertAfterExactOnceOperation: {
          type: "object",
          required: ["type", "anchor_text", "insert_text"],
          properties: { type: { const: "insert_after_exact_once" }, anchor_text: { type: "string" }, insert_text: { type: "string" } },
        },
      },
    },
  };
}
