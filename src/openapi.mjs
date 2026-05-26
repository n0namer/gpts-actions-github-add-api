export function openApiDocument() {
  return {
    openapi: "3.1.0",
    info: {
      title: "GitHub ADD API",
      version: "0.1.0",
      description: "Safe marker-based patch preview/apply service for GPTS.",
    },
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
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/PatchRequest" } } } },
          responses: { "200": { description: "Preview passed" }, "409": { description: "Expected SHA mismatch" }, "422": { description: "Patch cannot be applied safely" } },
        },
      },
      "/patch/apply": {
        post: {
          operationId: "githubPatchApply",
          summary: "Apply a previously previewed marker-based patch and commit it",
          requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/PatchApplyRequest" } } } },
          responses: { "200": { description: "Apply passed" }, "409": { description: "Expected SHA mismatch" }, "422": { description: "Patch cannot be applied safely" } },
        },
      },
    },
    components: {
      schemas: {
        PatchRequest: {
          type: "object",
          required: ["repository_full_name", "branch", "path", "expected_sha", "operation"],
          properties: {
            repository_full_name: { type: "string", examples: ["n0namer/GitHub-add"] },
            branch: { type: "string", examples: ["main"] },
            path: { type: "string", examples: ["test-fixtures/marker-file.md"] },
            expected_sha: { type: "string" },
            operation: { oneOf: [{ $ref: "#/components/schemas/ReplaceBetweenMarkersOperation" }, { $ref: "#/components/schemas/InsertAfterMarkerOperation" }] },
            options: { type: "object", properties: { max_changed_lines: { type: "integer" } } },
          },
        },
        PatchApplyRequest: {
          allOf: [
            { $ref: "#/components/schemas/PatchRequest" },
            { type: "object", required: ["commit_message"], properties: { commit_message: { type: "string" }, preview_patch_id: { type: "string" } } },
          ],
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
