import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { GitHubAddError, normalizeError } from "./errors.mjs";
import { loadConfig } from "./config.mjs";
import {
  applyOperation, countChangedLines, createDiffPreview, replaceBetweenMarkers, insertAfterMarker, sha256,
  replaceExactOnce, replaceWithContext, replaceLineRange, insertAfterExactOnce, createLineView,
} from "./patch.mjs";
import { checkLimits, scanSecrets, validateAccess, validateRepositoryAccess } from "./safety.mjs";
import { validateContentForPath } from "./validation.mjs";
import {
  readFileFromGitHub, updateFileOnGitHub, createFileOnGitHub, checkGitHubAuth,
  readPullRequestFromGitHub, markPullRequestReadyForReviewOnGitHub, mergePullRequestOnGitHub,
} from "./github.mjs";
import { openApiDocument } from "./openapi.mjs";

export { GitHubAddError } from "./errors.mjs";
export { loadConfig } from "./config.mjs";
export { applyOperation, replaceBetweenMarkers, insertAfterMarker, replaceExactOnce, replaceWithContext, replaceLineRange, insertAfterExactOnce, createLineView } from "./patch.mjs";
export { scanSecrets, validateAccess } from "./safety.mjs";
export {
  readFileFromGitHub, updateFileOnGitHub, createFileOnGitHub, checkGitHubAuth,
  readPullRequestFromGitHub, markPullRequestReadyForReviewOnGitHub, mergePullRequestOnGitHub,
} from "./github.mjs";
export { openApiDocument } from "./openapi.mjs";

const previews = new Map();
const locks = new Set();

function tokenRuntimeDiagnostics(config) {
  const candidates = Array.isArray(config.githubTokenCandidates) ? config.githubTokenCandidates : [];
  return {
    token_env_names_configured: candidates.map((candidate) => candidate.name),
    selected_token_env_name: config.githubTokenEnvName || "",
    selected_token_present: Boolean(config.githubToken),
    selected_token_length: String(config.githubToken || "").length,
    selected_token_prefix: String(config.githubToken || "").startsWith("github_pat_")
      ? "github_pat"
      : String(config.githubToken || "").startsWith("ghp_")
        ? "ghp"
        : String(config.githubToken || "").length > 0
          ? "other"
          : "none",
  };
}

async function healthPayload(config) {
  const payload = {
    status: "ok",
    service: "github-file-patch-api",
    version: "0.3.0",
    source_commit: process.env.SOURCE_COMMIT || "",
    capabilities: ["file_read", "file_create", "patch_preview", "patch_apply", "pull_request_read", "pull_request_ready", "pull_request_merge"],
    github_token_runtime: tokenRuntimeDiagnostics(config),
  };

  try {
    const auth = await checkGitHubAuth({ repository_full_name: "n0namer/content-generator" }, config);
    payload.github_auth = {
      status: auth.status,
      token_env_name: auth.token_env_name,
      repository_full_name: auth.repository_full_name,
      repository_private: auth.repository_private,
      repository_permissions: auth.repository_permissions,
    };
  } catch (error) {
    payload.github_auth = {
      status: "GITHUB_AUTH_FAILED",
      message: error?.payload?.message || error?.message || "GitHub auth check failed",
      tried_token_env_names: error?.payload?.tried_token_env_names,
      github_status: error?.payload?.github_status || error?.status,
    };
  }

  return payload;
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) {
    const buf = Buffer.alloc(Math.max(a.length, b.length) || 1);
    timingSafeEqual(buf.slice(0, 1), buf.slice(0, 1));
    return false;
  }
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function requireBearer(req, config) {
  const token = config.actionBearerToken;
  if (config.actionRequireBearer && !token) {
    throw new GitHubAddError(503, { status: "AUTH_NOT_CONFIGURED", message: "Bearer token not configured on server" });
  }
  if (!config.actionRequireBearer) return;
  const header = req.headers["authorization"] || req.headers["Authorization"] || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    throw new GitHubAddError(401, { status: "AUTH_FAILED", message: "Missing or malformed Authorization header" });
  }
  if (!constantTimeEqual(match[1], token)) {
    throw new GitHubAddError(401, { status: "AUTH_FAILED", message: "Invalid Bearer token" });
  }
}
function send(res, statusCode, payload) {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(payload));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1_000_000) throw new GitHubAddError(400, { status: "BAD_REQUEST", message: "request body too large" });
    chunks.push(chunk);
  }
  try {
    const raw = Buffer.concat(chunks).toString("utf8");
    if (!raw.trim()) throw new Error("empty body");
    return JSON.parse(raw);
  } catch {
    throw new GitHubAddError(400, { status: "BAD_REQUEST", message: "request body must be valid JSON" });
  }
}

function requireString(value, field) {
  if (typeof value !== "string" || value.length === 0) throw new GitHubAddError(400, { status: "BAD_REQUEST", message: `${field} is required` });
  return value;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string") return value;
  }
  return undefined;
}

function normalizeOperation(operation) {
  if (!operation || typeof operation !== "object") return operation;
  if (operation.type === "replace_text" || operation.type === "replace") {
    const oldText = firstString(operation.old_text, operation.oldText, operation.search_text, operation.searchText, operation.search, operation.target_text, operation.targetText, operation.text);
    const newText = firstString(operation.new_text, operation.newText, operation.replace_with, operation.replaceWith, operation.replacement, operation.new, operation.value);
    return { ...operation, type: "replace_exact_once", old_text: oldText, new_text: newText };
  }
  return operation;
}

function validateOperation(operation) {
  if (!operation || typeof operation !== "object") throw new GitHubAddError(400, { status: "BAD_REQUEST", message: "operation is required" });
  operation = normalizeOperation(operation);
  if (operation.type === "replace_between_markers") {
    requireString(operation.start_marker, "operation.start_marker"); requireString(operation.end_marker, "operation.end_marker");
    if (typeof operation.new_text !== "string") throw new GitHubAddError(400, { status: "BAD_REQUEST", message: "operation.new_text is required" }); return operation;
  }
  if (operation.type === "insert_after_marker") {
    requireString(operation.marker, "operation.marker"); if (typeof operation.text !== "string") throw new GitHubAddError(400, { status: "BAD_REQUEST", message: "operation.text is required" }); return operation;
  }
  if (operation.type === "replace_exact_once") {
    requireString(operation.old_text, "operation.old_text"); if (typeof operation.new_text !== "string") throw new GitHubAddError(400, { status: "BAD_REQUEST", message: "operation.new_text is required" }); return operation;
  }
  if (operation.type === "replace_with_context") {
    requireString(operation.old_text, "operation.old_text"); if (typeof operation.new_text !== "string") throw new GitHubAddError(400, { status: "BAD_REQUEST", message: "operation.new_text is required" });
    if (!operation.before && !operation.after) throw new GitHubAddError(400, { status: "BAD_REQUEST", message: "at least one of operation.before or operation.after is required" }); return operation;
  }
  if (operation.type === "replace_line_range") {
    if (typeof operation.start_line !== "number" || typeof operation.end_line !== "number") throw new GitHubAddError(400, { status: "BAD_REQUEST", message: "operation line range is required" });
    requireString(operation.expected_old_text, "operation.expected_old_text"); if (typeof operation.new_text !== "string") throw new GitHubAddError(400, { status: "BAD_REQUEST", message: "operation.new_text is required" }); return operation;
  }
  if (operation.type === "insert_after_exact_once") {
    requireString(operation.anchor_text, "operation.anchor_text"); if (typeof operation.insert_text !== "string") throw new GitHubAddError(400, { status: "BAD_REQUEST", message: "operation.insert_text is required" }); return operation;
  }
  throw new GitHubAddError(400, { status: "BAD_REQUEST", message: "unsupported operation.type" });
}

function validatePayload(payload) {
  return { repository_full_name: requireString(payload.repository_full_name, "repository_full_name"), branch: requireString(payload.branch, "branch"), path: requireString(payload.path, "path"), expected_sha: requireString(payload.expected_sha || payload.file_sha || payload.sha, "expected_sha"), operation: validateOperation(payload.operation), options: payload.options || {} };
}

function validateCreatePayload(payload) {
  if (!payload || typeof payload !== "object") throw new GitHubAddError(400, { status: "BAD_REQUEST", message: "payload is required" });
  if (typeof payload.content !== "string") throw new GitHubAddError(400, { status: "BAD_REQUEST", message: "content is required" });
  return { repository_full_name: requireString(payload.repository_full_name, "repository_full_name"), branch: requireString(payload.branch, "branch"), path: requireString(payload.path, "path"), content: payload.content, commit_message: requireString(payload.commit_message, "commit_message") };
}

function validateRepositoryAccess(repositoryFullName, config) {
  if (config.allowedRepos.length > 0 && !config.allowedRepos.includes(repositoryFullName)) throw new GitHubAddError(403, { status: "NOT_ALLOWED", reason: "repository_not_allowed" });
}

function validatePullRequestPayload(payload, options = {}) {
  if (!payload || typeof payload !== "object") throw new GitHubAddError(400, { status: "BAD_REQUEST", message: "payload is required" });
  const pullNumber = Number(payload.pull_number);
  if (!Number.isInteger(pullNumber) || pullNumber <= 0) throw new GitHubAddError(400, { status: "BAD_REQUEST", message: "pull_number must be a positive integer" });
  const result = { repository_full_name: requireString(payload.repository_full_name, "repository_full_name"), pull_number: pullNumber };
  if (options.requireExpectedHead) result.expected_head_sha = requireString(payload.expected_head_sha, "expected_head_sha");
  else if (typeof payload.expected_head_sha === "string" && payload.expected_head_sha) result.expected_head_sha = payload.expected_head_sha;
  if (payload.merge_method !== undefined) { if (!["merge", "squash", "rebase"].includes(payload.merge_method)) throw new GitHubAddError(400, { status: "BAD_REQUEST", message: "merge_method must be merge, squash, or rebase" }); result.merge_method = payload.merge_method; }
  if (typeof payload.commit_title === "string" && payload.commit_title) result.commit_title = payload.commit_title;
  if (typeof payload.commit_message === "string" && payload.commit_message) result.commit_message = payload.commit_message;
  return result;
}
async function buildOutcome(payload, config, deps) {
  validateAccess(payload, config);
  const file = await deps.readFile(payload, config);
  if (file.sha !== payload.expected_sha) throw new GitHubAddError(409, { status: "FILE_CHANGED", expected_sha: payload.expected_sha, actual_sha: file.sha });
  const patched = applyOperation(file.content, payload.operation);
  const diff_preview = await createDiffPreview(payload.path, file.content, patched.content);
  const changedLines = countChangedLines(diff_preview);
  checkLimits(file, changedLines, config, payload.options);
  scanSecrets(patched.content);
  return { file, newContent: patched.content, markers_found: patched.markers_found, target_match: patched.target_match, diff_preview, changedLines, patch_id: sha256(JSON.stringify({ payload, new_content_sha256: sha256(patched.content) })) };
}

function previewSignature(payload) {
  return JSON.stringify({ repository_full_name: payload.repository_full_name, branch: payload.branch, path: payload.path, expected_sha: payload.expected_sha, operation: payload.operation });
}

function savePreview(patchId, payload) { previews.set(patchId, { signature: previewSignature(payload), expiresAt: Date.now() + 600000 }); }

function requirePreview(patchId, payload, required) {
  if (!required) return;
  if (!patchId) throw new GitHubAddError(400, { status: "BAD_REQUEST", message: "preview_patch_id is required when PATCH_REQUIRE_PREVIEW=true" });
  const preview = previews.get(patchId);
  if (!preview || preview.expiresAt < Date.now() || preview.signature !== previewSignature(payload)) throw new GitHubAddError(422, { status: "PATCH_NOT_APPLICABLE", reason: "preview_required_or_expired" });
}

async function handlePreview(payload, config, deps) {
  const outcome = await buildOutcome(payload, config, deps);
  savePreview(outcome.patch_id, payload);
  const result = { status: "DRY_RUN_PASS", can_apply: true, repository_full_name: payload.repository_full_name, branch: payload.branch, path: payload.path, file_sha_before: outcome.file.sha, operation_type: payload.operation.type, markers_found: outcome.markers_found, changed_lines: { added: outcome.changedLines.added, deleted: outcome.changedLines.deleted }, diff_preview: outcome.diff_preview, patch_id: outcome.patch_id, evidence: { expected_sha_matched: true, repo_allowed: true, branch_allowed: true, path_allowed: true, protected_path_blocked: false, diff_within_limit: true, secret_scan_pass: true } };
  if (outcome.target_match) result.target_match = outcome.target_match;
  return result;
}

async function handleApply(rawPayload, config, deps) {
  const payload = validatePayload(rawPayload);
  const commitMessage = requireString(rawPayload.commit_message, "commit_message");
  const previewPatchId = rawPayload.preview_patch_id || rawPayload.patch_id;
  requirePreview(previewPatchId, payload, config.requirePreview);
  const key = `${payload.repository_full_name}:${payload.branch}:${payload.path}`;
  if (locks.has(key)) throw new GitHubAddError(423, { status: "WRITE_LOCKED", lock_key: key });
  locks.add(key);
  try {
    const outcome = await buildOutcome(payload, config, deps);
    const update = await deps.updateFile(payload, outcome.newContent, outcome.file.sha, commitMessage, config);
    const rereadPayload = { ...payload, expected_sha: update.file_sha_after || payload.expected_sha };
    let reread = null;
    for (let attempt = 0; attempt < 5; attempt++) { reread = await deps.readFile(rereadPayload, config); if (reread.content === outcome.newContent) break; await new Promise((r) => setTimeout(r, 250)); }
    if (!reread || reread.content !== outcome.newContent) throw new GitHubAddError(500, { status: "GITHUB_ADD_ERROR", message: "reread verification failed" });
    if (previewPatchId) previews.delete(previewPatchId);
    const result = { status: "APPLY_PASS", repository_full_name: payload.repository_full_name, branch: payload.branch, path: payload.path, file_sha_before: outcome.file.sha, file_sha_after: reread.sha || update.file_sha_after, commit_sha: update.commit_sha, reread_verified: true, operation_type: payload.operation.type, changed_lines: { added: outcome.changedLines.added, deleted: outcome.changedLines.deleted }, evidence: { expected_sha_matched: true, markers_unique: true, diff_within_limit: true, secret_scan_pass: true, reread_verified: true } };
    if (outcome.target_match) result.target_match = outcome.target_match;
    return result;
  } finally { locks.delete(key); }
}

async function handleCreate(rawPayload, config, deps) {
  const payload = validateCreatePayload(rawPayload);
  validateAccess(payload, config);
  const size = Buffer.byteLength(payload.content, "utf8");
  if (size > config.maxFileBytes) throw new GitHubAddError(422, { status: "PATCH_NOT_APPLICABLE", reason: "file_too_large", max_file_bytes: config.maxFileBytes });
  scanSecrets(payload.content);
  const key = `${payload.repository_full_name}:${payload.branch}:${payload.path}`;
  if (locks.has(key)) throw new GitHubAddError(423, { status: "WRITE_LOCKED", lock_key: key });
  locks.add(key);
  try {
    const create = await deps.createFile(payload, payload.content, payload.commit_message, config);
    const reread = await deps.readFile(payload, config);
    if (reread.content !== payload.content) throw new GitHubAddError(500, { status: "GITHUB_ADD_ERROR", message: "reread verification failed" });
    return { status: "CREATE_PASS", repository_full_name: payload.repository_full_name, branch: payload.branch, path: payload.path, file_sha_after: reread.sha || create.file_sha_after, commit_sha: create.commit_sha, size, reread_verified: true, evidence: { repo_allowed: true, branch_allowed: true, path_allowed: true, protected_path_blocked: false, secret_scan_pass: true, reread_verified: true } };
  } finally { locks.delete(key); }
}
export function createRequestHandler(options = {}) {
  const config = options.config || loadConfig(options.env || process.env);
  const deps = {
    readFile: options.readFile || readFileFromGitHub,
    updateFile: options.updateFile || updateFileOnGitHub,
    createFile: options.createFile || createFileOnGitHub,
    readPullRequest: options.readPullRequest || readPullRequestFromGitHub,
    markPullRequestReady: options.markPullRequestReady || markPullRequestReadyForReviewOnGitHub,
    mergePullRequest: options.mergePullRequest || mergePullRequestOnGitHub,
  };
  return async function requestHandler(req, res) {
    try {
      const url = new URL(req.url || "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/health") return send(res, 200, await healthPayload(config));
      if (req.method === "GET" && url.pathname === "/openapi.json") return send(res, 200, openApiDocument());
      if (req.method === "POST" && url.pathname === "/patch/preview") { requireBearer(req, config); return send(res, 200, await handlePreview(validatePayload(await readBody(req)), config, deps)); }
      if (req.method === "POST" && url.pathname === "/patch/apply") { requireBearer(req, config); return send(res, 200, await handleApply(await readBody(req), config, deps)); }
      if (req.method === "POST" && url.pathname === "/file/read") {
        requireBearer(req, config);
        const body = await readBody(req);
        const repo = requireString(body.repository_full_name, "repository_full_name"); const branch = requireString(body.branch, "branch"); const path = requireString(body.path, "path");
        const readPayload = { repository_full_name: repo, branch, path }; validateAccess(readPayload, config); const file = await deps.readFile(readPayload, config); const lines = createLineView(file.content);
        const result = { status: "READ_PASS", repository_full_name: repo, branch, path, file_sha: file.sha, sha: file.sha, size: file.size, line_count: lines.length, content: file.content, lines };
        if (body.options?.fields) { const fields = new Set(body.options.fields); for (const k of Object.keys(result)) if (!fields.has(k)) delete result[k]; }
        return send(res, 200, result);
      }
      if (req.method === "POST" && url.pathname === "/file/create") { requireBearer(req, config); return send(res, 200, await handleCreate(await readBody(req), config, deps)); }
      if (req.method === "POST" && url.pathname === "/pull-request/read") { requireBearer(req, config); const payload = validatePullRequestPayload(await readBody(req)); validateRepositoryAccess(payload.repository_full_name, config); return send(res, 200, await deps.readPullRequest(payload, config)); }
      if (req.method === "POST" && url.pathname === "/pull-request/ready") { requireBearer(req, config); const payload = validatePullRequestPayload(await readBody(req), { requireExpectedHead: true }); validateRepositoryAccess(payload.repository_full_name, config); return send(res, 200, await deps.markPullRequestReady(payload, config)); }
      if (req.method === "POST" && url.pathname === "/pull-request/merge") { requireBearer(req, config); const payload = validatePullRequestPayload(await readBody(req), { requireExpectedHead: true }); validateRepositoryAccess(payload.repository_full_name, config); return send(res, 200, await deps.mergePullRequest(payload, config)); }
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); return res.end("not found");
    } catch (error) { const normalized = normalizeError(error); return send(res, normalized.httpStatus, normalized.payload); }
  };
}

export function startServer(options = {}) {
  const config = options.config || loadConfig(options.env || process.env);
  const server = createServer(createRequestHandler({ ...options, config }));
  server.listen(config.port, () => console.log(JSON.stringify({ level: "info", service: "github-file-patch-api", event: "listen", port: config.port })));
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) startServer();
