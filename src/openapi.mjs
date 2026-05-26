export function openApiDocument() {
  const patchRequestProperties = {
    repository_full_name: { type: "string", examples: ["n0namer/GitHub-add"] },
    branch: { type: "string", examples: ["main"] },
    path: { type: "string", examples: ["test-fixtures/marker-file.md"] },
    expected_sha: { type: "string" },
    operation: { oneOf: [{ $ref: "#/components/schemas/ReplaceBetweenMarkersOperation" }, { $ref: "#/components/schemas/InsertAfterMarkerOperation" }] },
    options: { type: "object", properties: { max_changed_lines: { type: "integer" } } },
  };

  return {
    openapi: "3.1.0",
    info: {
      title: "GitHub ADD API",
      version: "0.1.0",
      description: "Safe marker-based patch preview/apply service for GPTS.",
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
          responses: { "200": { description: "Service is healthy" } },
        },
      },
      "/patch/preview": {
        post: {
          operationId: "githubPatchPreview",
          summary: "Preview a safe marker-based patch without committing",
          security: [{ ActionBearerAuth: [] }],
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/PatchRequest" } } } },
          responses: { "200": { description: "Preview passed" }, "401": { description: "Unauthorized — missing or invalid Bearer token" }, "503": { description: "Bearer auth required but not configured" }, "409": { description: "Expected SHA mismatch" }, "422": { description: "Patch cannot be applied safely" } },
        },
      },
      "/patch/apply": {
        post: {
          operationId: "githubPatchApply",
          summary: "Apply a previously previewed marker-based patch and commit it",
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
      },
    },
  };
}
