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
        { $ref: "#/components/schemas/ReplaceTextOperation" },
        { $ref: "#/components/schemas/ReplaceOperation" },
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
      title: "GitHub ADD API",
      version: "0.2.2",
      description: "Safe marker-based and text-based patch preview/apply service for GPTS.",
    },
    servers: [
      {
        url: "https://github-add-api-production.up.railway.app",
        description: "Railway production",
      },
    ],
    paths: {
      "/health": {
        get: {
          operationId: "githubAddHealth",
          summary: "Health check",
          responses: {
            "200": jsonResponse("#/components/schemas/HealthResponse", "Service is healthy"),
          },
        },
      },
      "/file/read": {
        post: {
          operationId: "githubReadFile",
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
      "/patch/preview": {
        post: {
          operationId: "githubPatchPreview",
          summary: "Preview a safe marker-based or text-based patch without committing",
          security: [{ ActionBearerAuth: [] }],
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/PatchRequest" } } } },
          responses: { "200": { description: "Preview passed" }, "401": { description: "Unauthorized — missing or invalid Bearer token" }, "503": { description: "Bearer auth required but not configured" }, "409": { description: "Expected SHA mismatch" }, "422": { description: "Patch cannot be applied safely" } },
        },
      },
      "/patch/apply": {
        post: {
          operationId: "githubPatchApply",
          summary: "Apply a previously previewed patch and commit it",
          security: [{ ActionBearerAuth: [] }],
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/PatchApplyRequest" } } } },
          responses: { "200": { description: "Apply passed" }, "401": { description: "Unauthorized — missing or invalid Bearer token" }, "503": { description: "Bearer auth required but not configured" }, "409": { description: "Expected SHA mismatch" }, "422": { description: "Patch cannot be applied safely" } },
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
            service: { type: "string", examples: ["github-add"] },
            version: { type: "string", examples: ["0.1.0"] },
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
        ReplaceTextOperation: {
          type: "object",
          required: ["type", "old_text", "new_text"],
          properties: { type: { const: "replace_text" }, old_text: { type: "string" }, new_text: { type: "string" } },
        },
        ReplaceOperation: {
          type: "object",
          required: ["type", "old_text", "new_text"],
          properties: { type: { const: "replace" }, old_text: { type: "string" }, new_text: { type: "string" } },
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
