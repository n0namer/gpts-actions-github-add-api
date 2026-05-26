import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  GitHubAddError,
  applyOperation,
  createRequestHandler,
  insertAfterMarker,
  replaceBetweenMarkers,
  scanSecrets,
  validateAccess,
} from "../src/server.mjs";

const fixture = `# Fixture

<!-- GPT:START smoke-block -->
old smoke content
<!-- GPT:END smoke-block -->

<!-- GPT:INSERT_AFTER smoke-insert -->

End.
`;

test("replaceBetweenMarkers preserves markers and replaces only inner content", () => {
  const result = replaceBetweenMarkers(
    fixture,
    "<!-- GPT:START smoke-block -->",
    "<!-- GPT:END smoke-block -->",
    "new smoke content",
  );

  assert.match(result.content, /<!-- GPT:START smoke-block -->\nnew smoke content\n<!-- GPT:END smoke-block -->/);
  assert.equal(result.markers_found.start, 1);
  assert.equal(result.markers_found.end, 1);
});

test("replaceBetweenMarkers returns structured duplicate marker error", () => {
  const duplicated = `${fixture}\n<!-- GPT:START smoke-block -->`;
  assert.throws(
    () => replaceBetweenMarkers(duplicated, "<!-- GPT:START smoke-block -->", "<!-- GPT:END smoke-block -->", "x"),
    (error) => error instanceof GitHubAddError && error.payload.reason === "duplicate_start_marker",
  );
});

test("insertAfterMarker preserves marker and inserts text", () => {
  const result = insertAfterMarker(fixture, "<!-- GPT:INSERT_AFTER smoke-insert -->", "inserted smoke content");
  assert.match(result.content, /<!-- GPT:INSERT_AFTER smoke-insert -->\ninserted smoke content\n\nEnd\./);
});

test("validateAccess blocks disallowed protected paths", () => {
  const config = {
    allowedRepos: ["n0namer/GitHub-add"],
    allowedBranches: ["main"],
    allowedPathPrefixes: ["docs/", "test-fixtures/"],
    protectedPathPrefixes: [".github/"],
    blockProtectedPaths: true,
  };
  assert.throws(
    () => validateAccess({ repository_full_name: "n0namer/GitHub-add", branch: "main", path: ".github/workflows/x.yml" }, config),
    (error) => error instanceof GitHubAddError && error.payload.reason === "path_prefix_not_allowed",
  );
});

test("scanSecrets blocks obvious tokens", () => {
  assert.throws(
    () => scanSecrets("const token = 'ghp_123456789012345678901234567890123456';"),
    (error) => error instanceof GitHubAddError && error.payload.reason === "secret_scan_failed",
  );
});

test("preview and apply work with injected GitHub dependencies and preview_patch_id", async () => {
  let content = fixture;
  let sha = "sha-before";

  const handler = createRequestHandler({
    config: {
      allowedRepos: ["n0namer/GitHub-add"],
      allowedBranches: ["main"],
      allowedPathPrefixes: ["test-fixtures/"],
      protectedPathPrefixes: [".github/"],
      blockProtectedPaths: true,
      maxFileBytes: 200000,
      maxChangedLines: 300,
      requirePreview: true,
    },
    readFile: async () => ({ content, sha, size: Buffer.byteLength(content) }),
    updateFile: async (_payload, newContent) => {
      content = newContent;
      sha = "sha-after";
      return { commit_sha: "commit-123", file_sha_after: sha };
    },
  });

  const server = createServer(handler);
  server.listen(0);
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const request = {
      repository_full_name: "n0namer/GitHub-add",
      branch: "main",
      path: "test-fixtures/marker-file.md",
      expected_sha: "sha-before",
      operation: {
        type: "replace_between_markers",
        start_marker: "<!-- GPT:START smoke-block -->",
        end_marker: "<!-- GPT:END smoke-block -->",
        new_text: "new smoke content",
      },
    };

    const preview = await fetch(`${base}/patch/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
    });
    assert.equal(preview.status, 200);
    const previewBody = await preview.json();
    assert.equal(previewBody.status, "DRY_RUN_PASS");
    assert.ok(previewBody.patch_id);

    const apply = await fetch(`${base}/patch/apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...request, preview_patch_id: previewBody.patch_id, commit_message: "test: patch fixture" }),
    });
    assert.equal(apply.status, 200);
    const applyBody = await apply.json();
    assert.equal(applyBody.status, "APPLY_PASS");
    assert.equal(applyBody.commit_sha, "commit-123");
    assert.equal(applyBody.reread_verified, true);
  } finally {
    server.close();
  }
});

test("sha mismatch returns 409 through API", async () => {
  const handler = createRequestHandler({
    config: {
      allowedRepos: ["n0namer/GitHub-add"],
      allowedBranches: ["main"],
      allowedPathPrefixes: ["test-fixtures/"],
      protectedPathPrefixes: [],
      blockProtectedPaths: true,
      maxFileBytes: 200000,
      maxChangedLines: 300,
      requirePreview: false,
    },
    readFile: async () => ({ content: fixture, sha: "actual-sha", size: Buffer.byteLength(fixture) }),
    updateFile: async () => ({ commit_sha: "unused", file_sha_after: "unused" }),
  });
  const server = createServer(handler);
  server.listen(0);
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const response = await fetch(`${base}/patch/preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        repository_full_name: "n0namer/GitHub-add",
        branch: "main",
        path: "test-fixtures/marker-file.md",
        expected_sha: "wrong-sha",
        operation: {
          type: "replace_between_markers",
          start_marker: "<!-- GPT:START smoke-block -->",
          end_marker: "<!-- GPT:END smoke-block -->",
          new_text: "new",
        },
      }),
    });
    assert.equal(response.status, 409);
    const body = await response.json();
    assert.equal(body.status, "FILE_CHANGED");
  } finally {
    server.close();
  }
});
