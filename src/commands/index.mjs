export const VERSION = "0.2.5";

export const SERVER_URL = "https://github-add-api-production.up.railway.app";

export const securitySchemes = {
  ActionBearerAuth: {
    type: "http",
    scheme: "bearer",
    bearerFormat: "opaque",
  },
};

export const schemas = {
  HealthResponse: {
    type: "object",
    required: ["status", "service"],
    properties: {
      status: { type: "string", examples: ["ok"] },
      service: { type: "string", examples: ["github-add"] },
      version: { type: "string", examples: [VERSION] },
    },
  },
  ReadFileRequest: {
    type: "object",
    required: ["repository_full_name", "branch", "path"],
    properties: {
      repository_full_name: { type: "string", examples: ["n0namer/GitHub-add"] },
      branch: { type: "string", examples: ["main"] },
      path: { type: "string", examples: ["test-fixtures/marker-file.md"] },
      options: {
        type: "object",
        properties: {
          fields: { type: "array", items: { type: "string" } },
        },
      },
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
    properties: {
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
    },
  },
  PatchApplyRequest: {
    type: "object",
    required: ["repository_full_name", "branch", "path", "expected_sha", "operation", "commit_message"],
    properties: {
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
      commit_message: { type: "string" },
      preview_patch_id: { type: "string" },
    },
  },
  ReplaceBetweenMarkersOperation: {
    type: "object",
    required: ["type", "start_marker", "end_marker", "new_text"],
    properties: {
      type: { const: "replace_between_markers" },
      start_marker: { type: "string" },
      end_marker: { type: "string" },
      new_text: { type: "string" },
    },
  },
  InsertAfterMarkerOperation: {
    type: "object",
    required: ["type", "marker", "text"],
    properties: {
      type: { const: "insert_after_marker" },
      marker: { type: "string" },
      text: { type: "string" },
    },
  },
  ReplaceExactOnceOperation: {
    type: "object",
    required: ["type", "old_text", "new_text"],
    properties: {
      type: { const: "replace_exact_once" },
      old_text: { type: "string" },
      new_text: { type: "string" },
    },
  },
  ReplaceWithContextOperation: {
    type: "object",
    required: ["type", "old_text", "new_text"],
    properties: {
      type: { const: "replace_with_context" },
      before: { type: "string" },
      old_text: { type: "string" },
      after: { type: "string" },
      new_text: { type: "string" },
    },
  },
  ReplaceLineRangeOperation: {
    type: "object",
    required: ["type", "start_line", "end_line", "expected_old_text", "new_text"],
    properties: {
      type: { const: "replace_line_range" },
      start_line: { type: "integer" },
      end_line: { type: "integer" },
      expected_old_text: { type: "string" },
      new_text: { type: "string" },
    },
  },
  InsertAfterExactOnceOperation: {
    type: "object",
    required: ["type", "anchor_text", "insert_text"],
    properties: {
      type: { const: "insert_after_exact_once" },
      anchor_text: { type: "string" },
      insert_text: { type: "string" },
    },
  },
};

export const commands = [
  {
    operationId: "githubAddHealth",
    method: "GET",
    path: "/health",
    summary: "Health check",
    auth: "none",
    responses: {
      "200": {
        description: "Service is healthy",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/HealthResponse" },
          },
        },
      },
    },
  },
  {
    operationId: "githubReadFile",
    method: "POST",
    path: "/file/read",
    summary: "Read a file from GitHub with line view",
    auth: "bearer",
    requestSchemaRef: "#/components/schemas/ReadFileRequest",
    responses: {
      "200": { description: "File read successfully" },
      "401": { description: "Unauthorized — missing or invalid Bearer token" },
      "403": { description: "Repository, branch, or path is not allowed" },
      "404": { description: "File not found" },
    },
  },
  {
    operationId: "githubCreateFile",
    method: "POST",
    path: "/file/create",
    summary: "Create a new file in GitHub and commit it",
    auth: "bearer",
    requestSchemaRef: "#/components/schemas/CreateFileRequest",
    responses: {
      "200": { description: "File created successfully" },
      "401": { description: "Unauthorized — missing or invalid Bearer token" },
      "409": { description: "File already exists" },
      "422": { description: "Create cannot be applied safely" },
    },
  },
  {
    operationId: "githubPatchPreview",
    method: "POST",
    path: "/patch/preview",
    summary: "Preview a safe marker-based or text-based patch without committing",
    auth: "bearer",
    requestSchemaRef: "#/components/schemas/PatchRequest",
    responses: {
      "200": { description: "Preview passed" },
      "401": { description: "Unauthorized — missing or invalid Bearer token" },
      "503": { description: "Bearer auth required but not configured" },
      "409": { description: "Expected SHA mismatch" },
      "422": { description: "Patch cannot be applied safely" },
    },
  },
  {
    operationId: "githubPatchApply",
    method: "POST",
    path: "/patch/apply",
    summary: "Apply a previously previewed patch and commit it",
    auth: "bearer",
    requestSchemaRef: "#/components/schemas/PatchApplyRequest",
    responses: {
      "200": { description: "Apply passed" },
      "401": { description: "Unauthorized — missing or invalid Bearer token" },
      "503": { description: "Bearer auth required but not configured" },
      "409": { description: "Expected SHA mismatch" },
      "422": { description: "Patch cannot be applied safely" },
    },
  },
];

export function validateCommands(commandList = commands) {
  const operationIds = new Set();
  const routes = new Set();

  for (const command of commandList) {
    if (!command.operationId) throw new Error("command.operationId is required");
    if (!command.method) throw new Error(`${command.operationId}: command.method is required`);
    if (!command.path) throw new Error(`${command.operationId}: command.path is required`);
    if (!command.summary) throw new Error(`${command.operationId}: command.summary is required`);
    if (!["GET", "POST"].includes(command.method)) throw new Error(`${command.operationId}: unsupported method ${command.method}`);
    if (!["none", "bearer"].includes(command.auth)) throw new Error(`${command.operationId}: unsupported auth ${command.auth}`);

    const routeKey = `${command.method} ${command.path}`;
    if (operationIds.has(command.operationId)) throw new Error(`duplicate operationId ${command.operationId}`);
    if (routes.has(routeKey)) throw new Error(`duplicate route ${routeKey}`);

    operationIds.add(command.operationId);
    routes.add(routeKey);

    if (command.method === "POST" && !command.requestSchemaRef) {
      throw new Error(`${command.operationId}: POST commands require requestSchemaRef`);
    }
  }

  return true;
}
