import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import {
  GitHubAddError,
  applyOperation,
  createRequestHandler,
  insertAfterMarker,
  replaceBetweenMarkers,
  replaceExactOnce,
  replaceWithContext,
  replaceLineRange,
  insertAfterExactOnce,
  createLineView,
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

/* ──── Existing marker tests ──── */

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

test("validateAccess blocks protected paths", () => {
  const config = { protectedPathPrefixes: [".github/"], blockProtectedPaths: true };
  assert.throws(
    () => validateAccess({ repository_full_name: "n0namer/GitHub-add", branch: "main", path: ".github/workflows/x.yml" }, config),
    (error) => error instanceof GitHubAddError && error.payload.reason === "protected_path",
  );
});

test("validateAccess rejects path traversal", () => {
  const config = { protectedPathPrefixes: [], blockProtectedPaths: true };
  assert.throws(
    () => validateAccess({ repository_full_name: "any/repo", branch: "any", path: "../escape.txt" }, config),
    (error) => error instanceof GitHubAddError && error.httpStatus === 403 && error.payload.reason === "invalid_path",
  );
});

test("scanSecrets blocks obvious tokens", () => {
  const fakeToken = "ghp_" + "123456789012345678901234567890123456";
  assert.throws(
    () => scanSecrets(`const token = '${fakeToken}';`),
    (error) => error instanceof GitHubAddError && error.payload.reason === "secret_scan_failed",
  );
});

test("preview and apply work with injected GitHub dependencies and preview_patch_id", async () => {
  let content = fixture;
  let sha = "sha-before";
  const handler = createRequestHandler({
    config: { actionBearerToken: "test-token", actionRequireBearer: false, allowedRepos: ["n0namer/GitHub-add"], allowedBranches: ["main"], allowedPathPrefixes: ["test-fixtures/"], protectedPathPrefixes: [".github/"], blockProtectedPaths: true, maxFileBytes: 200000, maxChangedLines: 300, requirePreview: true },
    readFile: async () => ({ content, sha, size: Buffer.byteLength(content) }),
    updateFile: async (_p, nc) => { content = nc; sha = "sha-after"; return { commit_sha: "commit-123", file_sha_after: sha }; },
  });
  const server = createServer(handler);
  server.listen(0);
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const request = { repository_full_name: "n0namer/GitHub-add", branch: "main", path: "test-fixtures/marker-file.md", expected_sha: "sha-before", operation: { type: "replace_between_markers", start_marker: "<!-- GPT:START smoke-block -->", end_marker: "<!-- GPT:END smoke-block -->", new_text: "new smoke content" } };
    const preview = await fetch(`${base}/patch/preview`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
    assert.equal(preview.status, 200);
    const p = await preview.json();
    assert.equal(p.status, "DRY_RUN_PASS");
    assert.ok(p.patch_id);
    const apply = await fetch(`${base}/patch/apply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...request, preview_patch_id: p.patch_id, commit_message: "test: patch fixture" }) });
    assert.equal(apply.status, 200);
    const a = await apply.json();
    assert.equal(a.status, "APPLY_PASS");
  } finally { server.close(); }
});

test("sha mismatch returns 409 through API", async () => {
  const handler = createRequestHandler({
    config: { actionBearerToken: "test-token", actionRequireBearer: false, allowedRepos: ["n0namer/GitHub-add"], allowedBranches: ["main"], allowedPathPrefixes: ["test-fixtures/"], protectedPathPrefixes: [], blockProtectedPaths: true, maxFileBytes: 200000, maxChangedLines: 300, requirePreview: false },
    readFile: async () => ({ content: fixture, sha: "actual-sha", size: Buffer.byteLength(fixture) }),
    updateFile: async () => ({ commit_sha: "unused", file_sha_after: "unused" }),
  });
  const server = createServer(handler);
  server.listen(0); await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const r = await fetch(`${base}/patch/preview`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repository_full_name: "n0namer/GitHub-add", branch: "main", path: "test-fixtures/marker-file.md", expected_sha: "wrong-sha", operation: { type: "replace_between_markers", start_marker: "<!-- GPT:START smoke-block -->", end_marker: "<!-- GPT:END smoke-block -->", new_text: "new" } }) });
    assert.equal(r.status, 409);
    const b = await r.json();
    assert.equal(b.status, "FILE_CHANGED");
  } finally { server.close(); }
});

/* ──── Bearer Auth Tests ──── */

async function createAuthTestServer(overrides = {}) {
  const handler = createRequestHandler({
    config: { actionBearerToken: overrides.bearerToken ?? "correct-token", actionRequireBearer: overrides.requireBearer ?? true, protectedPathPrefixes: [], blockProtectedPaths: true, maxFileBytes: 200000, maxChangedLines: 300, requirePreview: overrides.requirePreview ?? false },
    readFile: async () => ({ content: fixture, sha: "sha-before", size: Buffer.byteLength(fixture) }),
    updateFile: async () => ({ commit_sha: "commit-123", file_sha_after: "sha-after" }),
  });
  const server = createServer(handler);
  server.listen(0); await once(server, "listening");
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

test("auth: missing Authorization header returns 401", async () => {
  const { server, base } = await createAuthTestServer();
  try {
    const res = await fetch(`${base}/patch/preview`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repository_full_name: "n0namer/GitHub-add", branch: "main", path: "test-fixtures/marker-file.md", expected_sha: "sha-before", operation: { type: "replace_between_markers", start_marker: "<!-- GPT:START smoke-block -->", end_marker: "<!-- GPT:END smoke-block -->", new_text: "new" } }) });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.status, "AUTH_FAILED");
  } finally { server.close(); }
});

test("auth: wrong Bearer token returns 401", async () => {
  const { server, base } = await createAuthTestServer();
  try {
    const res = await fetch(`${base}/patch/preview`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer wrong-token" }, body: JSON.stringify({ repository_full_name: "n0namer/GitHub-add", branch: "main", path: "test-fixtures/marker-file.md", expected_sha: "sha-before", operation: { type: "replace_between_markers", start_marker: "<!-- GPT:START smoke-block -->", end_marker: "<!-- GPT:END smoke-block -->", new_text: "new" } }) });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.status, "AUTH_FAILED");
  } finally { server.close(); }
});

test("auth: correct Bearer token allows preview", async () => {
  const { server, base } = await createAuthTestServer();
  try {
    const res = await fetch(`${base}/patch/preview`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer correct-token" }, body: JSON.stringify({ repository_full_name: "n0namer/GitHub-add", branch: "main", path: "test-fixtures/marker-file.md", expected_sha: "sha-before", operation: { type: "replace_between_markers", start_marker: "<!-- GPT:START smoke-block -->", end_marker: "<!-- GPT:END smoke-block -->", new_text: "new" } }) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "DRY_RUN_PASS");
  } finally { server.close(); }
});

test("auth: Bearer required but not configured returns 503", async () => {
  const { server, base } = await createAuthTestServer({ bearerToken: "", requireBearer: true });
  try {
    const res = await fetch(`${base}/patch/preview`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer anything" }, body: JSON.stringify({ repository_full_name: "n0namer/GitHub-add", branch: "main", path: "test-fixtures/marker-file.md", expected_sha: "sha-before", operation: { type: "replace_between_markers", start_marker: "<!-- GPT:START smoke-block -->", end_marker: "<!-- GPT:END smoke-block -->", new_text: "new" } }) });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.status, "AUTH_NOT_CONFIGURED");
  } finally { server.close(); }
});

test("auth: OpenAPI advertises Bearer for patch operations only", async () => {
  const { server, base } = await createAuthTestServer();
  try {
    const res = await fetch(`${base}/openapi.json`);
    assert.equal(res.status, 200);
    const doc = await res.json();
    assert.deepEqual(doc.paths["/health"].get.security, []);
    assert.deepEqual(doc.paths["/patch/preview"].post.security, [{ ActionBearerAuth: [] }]);
    assert.deepEqual(doc.paths["/patch/apply"].post.security, [{ ActionBearerAuth: [] }]);
    assert.deepEqual(doc.paths["/file/read"].post.security, [{ ActionBearerAuth: [] }]);
    assert.deepEqual(doc.paths["/file/create"].post.security, [{ ActionBearerAuth: [] }]);
    assert.ok(doc.components.securitySchemes.ActionBearerAuth);
  } finally { server.close(); }
});

test("auth: health check does NOT require Bearer", async () => {
  const { server, base } = await createAuthTestServer();
  try {
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "ok");
    assert.equal(body.version, "0.3.0");
    assert.ok(body.capabilities.includes("file_create"));
    assert.equal("github_token_runtime" in body, false);
    assert.equal("github_auth" in body, false);
  } finally { server.close(); }
});

/* ──── New operation unit tests ──── */

test("replaceExactOnce replaces unique old_text", () => {
  const result = replaceExactOnce(fixture, "old smoke content", "new exact content");
  assert.match(result.content, /<!-- GPT:START smoke-block -->\nnew exact content\n<!-- GPT:END/);
  assert.ok(result.target_match);
  assert.equal(typeof result.target_match.line, "number");
});

test("replaceExactOnce throws 422 when old_text not found", () => {
  assert.throws(
    () => replaceExactOnce(fixture, "nonexistent text that does not exist", "x"),
    (error) => error instanceof GitHubAddError && error.payload.reason === "old_text_not_found",
  );
});

test("replaceExactOnce throws 422 when old_text not unique", () => {
  const dup = fixture + "\nold smoke content";
  assert.throws(
    () => replaceExactOnce(dup, "old smoke content", "x"),
    (error) => error instanceof GitHubAddError && error.payload.reason === "old_text_not_unique",
  );
});

test("replaceWithContext matches with before and after context", () => {
  const result = replaceWithContext(fixture, "<!-- GPT:START smoke-block -->\n", "old smoke content", "\n<!-- GPT:END smoke-block -->", "context replaced");
  assert.match(result.content, /<!-- GPT:START smoke-block -->\ncontext replaced\n<!-- GPT:END/);
  assert.ok(result.target_match);
});

test("replaceWithContext throws 422 when context not found", () => {
  assert.throws(
    () => replaceWithContext(fixture, "NONEXISTENT_BEFORE", "old smoke content", "", "x"),
    (error) => error instanceof GitHubAddError && error.payload.reason === "context_not_found",
  );
});

test("replaceWithContext throws 422 when context not unique", () => {
  const dup = fixture + "\n<!-- GPT:START smoke-block -->\nold smoke content\n<!-- GPT:END smoke-block -->";
  assert.throws(
    () => replaceWithContext(dup, "<!-- GPT:START smoke-block -->\n", "old smoke content", "\n<!-- GPT:END smoke-block -->", "x"),
    (error) => error instanceof GitHubAddError && error.payload.reason === "context_not_unique",
  );
});

test("replaceLineRange matches line range exactly", () => {
  const result = replaceLineRange(fixture, 4, 4, "old smoke content", "line range replaced");
  assert.match(result.content, /<!-- GPT:START smoke-block -->\nline range replaced\n<!-- GPT:END/);
  assert.ok(result.target_match);
  assert.equal(result.target_match.start_line, 4);
  assert.equal(result.target_match.end_line, 4);
});

test("replaceLineRange throws 422 on text mismatch", () => {
  assert.throws(
    () => replaceLineRange(fixture, 4, 4, "WRONG TEXT", "x"),
    (error) => error instanceof GitHubAddError && error.payload.reason === "line_range_text_mismatch",
  );
});

test("insertAfterExactOnce works with unique anchor", () => {
  const result = insertAfterExactOnce(fixture, "<!-- GPT:INSERT_AFTER smoke-insert -->", "inserted after anchor");
  assert.match(result.content, /<!-- GPT:INSERT_AFTER smoke-insert -->inserted after anchor/);
  assert.ok(result.target_match);
});

test("insertAfterExactOnce throws 422 when anchor not found", () => {
  assert.throws(
    () => insertAfterExactOnce(fixture, "<!-- NONE -->", "x"),
    (error) => error instanceof GitHubAddError && error.payload.reason === "anchor_text_not_found",
  );
});

test("insertAfterExactOnce throws 422 when anchor not unique", () => {
  const dup = fixture + "\n<!-- GPT:INSERT_AFTER smoke-insert -->\ndup";
  assert.throws(
    () => insertAfterExactOnce(dup, "<!-- GPT:INSERT_AFTER smoke-insert -->", "x"),
    (error) => error instanceof GitHubAddError && error.payload.reason === "anchor_text_not_unique",
  );
});

test("createLineView returns correct line objects", () => {
  const lines = createLineView("hello\nworld\n");
  assert.equal(lines.length, 3);
  assert.equal(lines[0].line, 1);
  assert.equal(lines[0].text, "hello");
  assert.equal(lines[1].line, 2);
  assert.equal(lines[1].text, "world");
  assert.equal(lines[2].line, 3);
  assert.equal(lines[2].text, "");
});

/* ──── /file/read endpoint tests ──── */

test("/file/read returns READ_PASS with lines", async () => {
  const { server, base } = await createAuthTestServer({ requirePreview: false });
  try {
    const res = await fetch(`${base}/file/read`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer correct-token" }, body: JSON.stringify({ repository_full_name: "n0namer/GitHub-add", branch: "main", path: "test-fixtures/marker-file.md" }) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "READ_PASS");
    assert.equal(body.file_sha, "sha-before");
    assert.ok(body.line_count > 0);
    assert.ok(Array.isArray(body.lines));
    assert.ok(body.lines[0].line);
    assert.ok(typeof body.lines[0].text === "string");
  } finally { server.close(); }
});

test("/file/read without Bearer returns 401", async () => {
  const { server, base } = await createAuthTestServer();
  try {
    const res = await fetch(`${base}/file/read`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repository_full_name: "n0namer/GitHub-add", branch: "main", path: "test-fixtures/marker-file.md" }) });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.status, "AUTH_FAILED");
  } finally { server.close(); }
});

test("/file/create returns CREATE_PASS and rereads content", async () => {
  let content = "";
  let sha = "";
  const createdContent = "# New file\n";
  const handler = createRequestHandler({
    config: { actionBearerToken: "correct-token", actionRequireBearer: true, protectedPathPrefixes: [], blockProtectedPaths: true, maxFileBytes: 200000, maxChangedLines: 300, requirePreview: false },
    readFile: async () => ({ content, sha, size: Buffer.byteLength(content) }),
    updateFile: async () => ({ commit_sha: "unused", file_sha_after: "unused" }),
    createFile: async (_payload, nextContent) => { content = nextContent; sha = "sha-created"; return { commit_sha: "commit-create", file_sha_after: sha }; },
  });
  const server = createServer(handler);
  server.listen(0); await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/file/create`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer correct-token" }, body: JSON.stringify({ repository_full_name: "n0namer/GitHub-add", branch: "main", path: "test-fixtures/new-file.md", content: createdContent, commit_message: "test: create file" }) });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "CREATE_PASS");
    assert.equal(body.file_sha_after, "sha-created");
    assert.equal(body.commit_sha, "commit-create");
    assert.equal(body.reread_verified, true);
  } finally { server.close(); }
});

test("/file/create without Bearer returns 401", async () => {
  const { server, base } = await createAuthTestServer();
  try {
    const res = await fetch(`${base}/file/create`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repository_full_name: "n0namer/GitHub-add", branch: "main", path: "test-fixtures/new-file.md", content: "# New file\n", commit_message: "test: create file" }) });
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.equal(body.status, "AUTH_FAILED");
  } finally { server.close(); }
});

test("/file/create rejects secret-like content before GitHub write", async () => {
  let createCalls = 0;
  const handler = createRequestHandler({
    config: { actionBearerToken: "correct-token", actionRequireBearer: true, protectedPathPrefixes: [], blockProtectedPaths: true, maxFileBytes: 200000, maxChangedLines: 300, requirePreview: false },
    readFile: async () => ({ content: "", sha: "", size: 0 }),
    createFile: async () => { createCalls++; return { commit_sha: "must-not-run", file_sha_after: "must-not-run" }; },
  });
  const server = createServer(handler);
  server.listen(0); await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const fakeToken = "ghp_" + "123456789012345678901234567890123456";
    const res = await fetch(`${base}/file/create`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer correct-token" }, body: JSON.stringify({ repository_full_name: "n0namer/GitHub-add", branch: "main", path: "test-fixtures/secret.md", content: `token=${fakeToken}`, commit_message: "test: reject secret" }) });
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.equal(body.reason, "secret_scan_failed");
    assert.equal(createCalls, 0);
  } finally { server.close(); }
});

test("/file/create rejects oversized content before GitHub write", async () => {
  let createCalls = 0;
  const handler = createRequestHandler({
    config: { actionBearerToken: "correct-token", actionRequireBearer: true, protectedPathPrefixes: [], blockProtectedPaths: true, maxFileBytes: 8, maxChangedLines: 300, requirePreview: false },
    readFile: async () => ({ content: "", sha: "", size: 0 }),
    createFile: async () => { createCalls++; return { commit_sha: "must-not-run", file_sha_after: "must-not-run" }; },
  });
  const server = createServer(handler);
  server.listen(0); await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/file/create`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer correct-token" }, body: JSON.stringify({ repository_full_name: "n0namer/GitHub-add", branch: "main", path: "test-fixtures/large.md", content: "0123456789", commit_message: "test: reject large file" }) });
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.equal(body.reason, "file_too_large");
    assert.equal(createCalls, 0);
  } finally { server.close(); }
});

test("/file/create rejects disallowed path before GitHub write", async () => {
  let createCalls = 0;
  const handler = createRequestHandler({
    config: { actionBearerToken: "correct-token", actionRequireBearer: true, protectedPathPrefixes: [".github/"], blockProtectedPaths: true, maxFileBytes: 200000, maxChangedLines: 300, requirePreview: false },
    readFile: async () => ({ content: "", sha: "", size: 0 }),
    createFile: async () => { createCalls++; return { commit_sha: "must-not-run", file_sha_after: "must-not-run" }; },
  });
  const server = createServer(handler);
  server.listen(0); await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/file/create`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer correct-token" }, body: JSON.stringify({ repository_full_name: "n0namer/GitHub-add", branch: "main", path: ".github/workflows/unsafe.yml", content: "name: unsafe\n", commit_message: "test: reject path" }) });
    assert.equal(res.status, 403);
    assert.equal(createCalls, 0);
  } finally { server.close(); }
});

test("/file/create rejects invalid JSON before GitHub write", async () => {
  let createCalls = 0;
  const handler = createRequestHandler({
    config: { actionBearerToken: "correct-token", actionRequireBearer: true, protectedPathPrefixes: [], blockProtectedPaths: true, maxFileBytes: 200000, maxChangedLines: 300, requirePreview: false },
    readFile: async () => ({ content: "", sha: "", size: 0 }),
    createFile: async () => { createCalls++; return { commit_sha: "must-not-run", file_sha_after: "must-not-run" }; },
  });
  const server = createServer(handler); server.listen(0); await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/file/create`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer correct-token" }, body: JSON.stringify({ repository_full_name: "n0namer/GitHub-add", branch: "main", path: "test-fixtures/invalid.json", content: "{", commit_message: "test: invalid json" }) });
    assert.equal(res.status, 422);
    const body = await res.json();
    assert.equal(body.reason, "invalid_json");
    assert.equal(createCalls, 0);
  } finally { server.close(); }
});

test("/file/create preserves already-exists conflict", async () => {
  const handler = createRequestHandler({
    config: { actionBearerToken: "correct-token", actionRequireBearer: true, protectedPathPrefixes: [], blockProtectedPaths: true, maxFileBytes: 200000, maxChangedLines: 300, requirePreview: false },
    readFile: async () => ({ content: "existing", sha: "existing-sha", size: 8 }),
    createFile: async () => { throw new GitHubAddError(409, { status: "FILE_ALREADY_EXISTS", reason: "file_already_exists" }); },
  });
  const server = createServer(handler);
  server.listen(0); await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await fetch(`${base}/file/create`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer correct-token" }, body: JSON.stringify({ repository_full_name: "n0namer/GitHub-add", branch: "main", path: "test-fixtures/existing.md", content: "new", commit_message: "test: existing file" }) });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.reason, "file_already_exists");
  } finally { server.close(); }
});

/* ──── Preview/apply with replace_exact_once ──── */

test("preview and apply with replace_exact_once", async () => {
  let content = fixture;
  let sha = "sha-before";
  const handler = createRequestHandler({
    config: { actionBearerToken: "test-token", actionRequireBearer: false, protectedPathPrefixes: [], blockProtectedPaths: true, maxFileBytes: 200000, maxChangedLines: 300, requirePreview: true },
    readFile: async () => ({ content, sha, size: Buffer.byteLength(content) }),
    updateFile: async (_p, nc) => { content = nc; sha = "sha-after"; return { commit_sha: "commit-exact", file_sha_after: sha }; },
  });
  const server = createServer(handler);
  server.listen(0); await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const preview = await fetch(`${base}/patch/preview`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repository_full_name: "n0namer/GitHub-add", branch: "main", path: "test-fixtures/marker-file.md", expected_sha: "sha-before", operation: { type: "replace_exact_once", old_text: "old smoke content", new_text: "exact replaced content" } }) });
    assert.equal(preview.status, 200);
    const previewBody = await preview.json();
    assert.equal(previewBody.status, "DRY_RUN_PASS");
    assert.equal(previewBody.operation_type, "replace_exact_once");
    assert.ok(previewBody.target_match, "target_match should be present");
    assert.ok(previewBody.target_match.line, "target_match.line should exist");
    assert.ok(previewBody.patch_id);
  } finally { server.close(); }
});

test("apply handles stale readFile with retry and succeeds", async () => {
  const originalContent = "<OLD>stale</OLD>";
  // replaceBetweenMarkers wraps new_text with innerText() -> \nNEW\n
  const patchedContent = "<OLD>\nNEW\n</OLD>";
  let callCount = 0;
  const handler = createRequestHandler({
    config: { actionBearerToken: "test-token", actionRequireBearer: false, protectedPathPrefixes: [], blockProtectedPaths: true, maxFileBytes: 200000, maxChangedLines: 300, requirePreview: false },
    readFile: async (payload) => {
      callCount++;
      if (callCount === 1) {
        // buildOutcome initial read: must match expected_sha and have the original content
        return { content: originalContent, sha: payload.expected_sha, size: originalContent.length };
      }
      // callCount >= 2: retry loop after updateFile
      if (callCount <= 3) {
        // stale GitHub cache after commit
        return { content: originalContent, sha: "stale-sha", size: originalContent.length };
      }
      // fresh content after retry
      return { content: patchedContent, sha: "fresh-sha", size: patchedContent.length };
    },
    updateFile: async () => ({ commit_sha: "commit-stale-retry", file_sha_after: "fresh-sha" }),
  });
  const server = createServer(handler);
  server.listen(0); await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const apply = await fetch(`${base}/patch/apply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ repository_full_name: "n0namer/GitHub-add", branch: "main", path: "test-fixtures/marker-file.md", expected_sha: "E1", operation: { type: "replace_between_markers", start_marker: "<OLD>", end_marker: "</OLD>", new_text: "NEW" }, commit_message: "test: stale retry" }) });
    assert.equal(apply.status, 200);
    const body = await apply.json();
    assert.equal(body.status, "APPLY_PASS");
    assert.equal(body.reread_verified, true);
    assert.ok(callCount >= 3, "readFile should have been called at least 3 times");
  } finally { server.close(); }
});

test("OpenAPI has flat PatchApplyRequest no allOf and new operations", async () => {
  const { server, base } = await createAuthTestServer();
  try {
    const res = await fetch(`${base}/openapi.json`);
    assert.equal(res.status, 200);
    const doc = await res.json();
    assert.equal(doc.components.schemas.PatchApplyRequest.type, "object");
    assert.equal(!!doc.components.schemas.PatchApplyRequest.allOf, false);
    assert.ok(doc.components.schemas.CreateFileRequest);
    assert.ok(doc.components.schemas.ReplaceExactOnceOperation);
    assert.ok(doc.components.schemas.ReplaceWithContextOperation);
    assert.ok(doc.components.schemas.ReplaceLineRangeOperation);
    assert.ok(doc.components.schemas.InsertAfterExactOnceOperation);
    assert.ok(doc.paths["/file/read"]);
    assert.equal(doc.paths["/file/read"].post.operationId, "githubReadFile");
    assert.ok(doc.paths["/file/create"]);
    assert.equal(doc.paths["/file/create"].post.operationId, "githubCreateFile");
  } finally { server.close(); }
});

test("runtime OpenAPI is exactly the static GPT Actions schema", async () => {
  const { server, base } = await createAuthTestServer();
  try {
    const res = await fetch(`${base}/openapi.json`);
    assert.equal(res.status, 200);
    const runtime = await res.json();
    const staticDoc = JSON.parse(await readFile(new URL("../gpts-action-openapi.json", import.meta.url), "utf8"));
    assert.deepEqual(runtime, staticDoc);
  } finally { server.close(); }
});

test("PR routes enforce expected head guards across repositories", async () => {
  let readCalls = 0, readyCalls = 0, mergeCalls = 0;
  const handler = createRequestHandler({
    config: { actionBearerToken: "x", actionRequireBearer: false, protectedPathPrefixes: [], blockProtectedPaths: true, maxFileBytes: 200000, maxChangedLines: 300, requirePreview: true },
    readPullRequest: async (p) => { readCalls++; return { pull_number: p.pull_number, state: "open", head_sha: "abc" }; },
    markPullRequestReady: async (p) => { readyCalls++; return { status: "PR_READY_PASS", head_sha: p.expected_head_sha, reread_verified: true }; },
    mergePullRequest: async (p) => { mergeCalls++; return { status: "MERGE_PASS", head_sha: p.expected_head_sha, reread_verified: true }; },
  });
  const server = createServer(handler); server.listen(0); await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    assert.equal((await post("/pull-request/read", { repository_full_name: "n0namer/GitHub-add", pull_number: 1 })).status, 200);
    assert.equal(readCalls, 1);
    assert.equal((await post("/pull-request/read", { repository_full_name: "other/repo", pull_number: 1 })).status, 200);
    assert.equal(readCalls, 2);
    assert.equal((await post("/pull-request/ready", { repository_full_name: "n0namer/GitHub-add", pull_number: 1 })).status, 400);
    assert.equal(readyCalls, 0);
    assert.equal((await post("/pull-request/ready", { repository_full_name: "n0namer/GitHub-add", pull_number: 1, expected_head_sha: "abc" })).status, 200);
    assert.equal(readyCalls, 1);
    assert.equal((await post("/pull-request/merge", { repository_full_name: "n0namer/GitHub-add", pull_number: 1 })).status, 400);
    assert.equal(mergeCalls, 0);
    assert.equal((await post("/pull-request/merge", { repository_full_name: "n0namer/GitHub-add", pull_number: 1, expected_head_sha: "abc", merge_method: "bad" })).status, 400);
    assert.equal(mergeCalls, 0);
    assert.equal((await post("/pull-request/merge", { repository_full_name: "n0namer/GitHub-add", pull_number: 1, expected_head_sha: "abc", merge_method: "squash" })).status, 200);
    assert.equal(mergeCalls, 1);
  } finally { server.close(); }
});

/* ──── applyOperation dispatch tests ──── */

test("applyOperation dispatches replace_exact_once", () => {
  const result = applyOperation(fixture, { type: "replace_exact_once", old_text: "old smoke content", new_text: "dispatched" });
  assert.match(result.content, /dispatched/);
  assert.ok(result.target_match);
});

test("applyOperation dispatches replace_with_context", () => {
  const result = applyOperation(fixture, { type: "replace_with_context", before: "<!-- GPT:START smoke-block -->\n", old_text: "old smoke content", after: "\n<!-- GPT:END smoke-block -->", new_text: "ctx dispatched" });
  assert.match(result.content, /ctx dispatched/);
  assert.ok(result.target_match);
});

test("applyOperation dispatches replace_line_range", () => {
  const result = applyOperation(fixture, { type: "replace_line_range", start_line: 4, end_line: 4, expected_old_text: "old smoke content", new_text: "lr dispatched" });
  assert.match(result.content, /lr dispatched/);
  assert.ok(result.target_match);
});

test("applyOperation dispatches insert_after_exact_once", () => {
  const result = applyOperation(fixture, { type: "insert_after_exact_once", anchor_text: "<!-- GPT:INSERT_AFTER smoke-insert -->", insert_text: "ia dispatched" });
  assert.match(result.content, /ia dispatched/);
  assert.ok(result.target_match);
});

test("applyOperation throws on unknown type", () => {
  assert.throws(
    () => applyOperation(fixture, { type: "bogus_operation" }),
    (error) => error instanceof GitHubAddError && error.httpStatus === 400,
  );
});

test("applyOperation still dispatches replace_between_markers", () => {
  const result = applyOperation(fixture, { type: "replace_between_markers", start_marker: "<!-- GPT:START smoke-block -->", end_marker: "<!-- GPT:END smoke-block -->", new_text: "still works" });
  assert.match(result.content, /still works/);
});

test("applyOperation still dispatches insert_after_marker", () => {
  const result = applyOperation(fixture, { type: "insert_after_marker", marker: "<!-- GPT:INSERT_AFTER smoke-insert -->", text: "still inserts" });
  assert.match(result.content, /still inserts/);
});
