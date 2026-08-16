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
      title: "GitHub File Patch API",
      version: "0.3.0",
      description: "Safe GitHub file read/create and precise text patch preview/apply service with SHA guards, diff preview, and JSON validation for .json files.",
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
        HealthResponse: {
          type: "object",
          required: ["status", "service"],
          properties: {
            status: { type: "string", examples: ["ok"] },
            service: { type: "string", examples: ["github-file-patch-api"] },
            version: { type: "string", examples: ["0.3.0"] },
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
