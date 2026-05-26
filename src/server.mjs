import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { GitHubAddError, normalizeError } from "./errors.mjs";
import { loadConfig } from "./config.mjs";
import { applyOperation, countChangedLines, createDiffPreview, replaceBetweenMarkers, insertAfterMarker, sha256 } from "./patch.mjs";
import { checkLimits, scanSecrets, validateAccess } from "./safety.mjs";
import { readFileFromGitHub, updateFileOnGitHub } from "./github.mjs";
import { openApiDocument } from "./openapi.mjs";

export { GitHubAddError } from "./errors.mjs";
export { loadConfig } from "./config.mjs";
export { applyOperation, replaceBetweenMarkers, insertAfterMarker } from "./patch.mjs";
export { scanSecrets, validateAccess } from "./safety.mjs";
export { readFileFromGitHub, updateFileOnGitHub } from "./github.mjs";
export { openApiDocument } from "./openapi.mjs";

const previews = new Map();
const locks = new Set();

function constantTimeEqual(a, b) {
  if (a.length !== b.length) {
    // Still do a comparison to prevent length-based timing leak
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

function validateOperation(operation) {
  if (!operation || typeof operation !== "object") throw new GitHubAddError(400, { status: "BAD_REQUEST", message: "operation is required" });
  if (operation.type === "replace_between_markers") {
    requireString(operation.start_marker, "operation.start_marker");
    requireString(operation.end_marker, "operation.end_marker");
    if (typeof operation.new_text !== "string") throw new GitHubAddError(400, { status: "BAD_REQUEST", message: "operation.new_text is required" });
    return operation;
  }
  if (operation.type === "insert_after_marker") {
    requireString(operation.marker, "operation.marker");
    if (typeof operation.text !== "string") throw new GitHubAddError(400, { status: "BAD_REQUEST", message: "operation.text is required" });
    return operation;
  }
  throw new GitHubAddError(400, { status: "BAD_REQUEST", message: "unsupported operation.type" });
}

function validatePayload(payload) {
  return {
    repository_full_name: requireString(payload.repository_full_name, "repository_full_name"),
    branch: requireString(payload.branch, "branch"),
    path: requireString(payload.path, "path"),
    expected_sha: requireString(payload.expected_sha, "expected_sha"),
    operation: validateOperation(payload.operation),
    options: payload.options || {},
  };
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

  return {
    file,
    newContent: patched.content,
    markers_found: patched.markers_found,
    diff_preview,
    changedLines,
    patch_id: sha256(JSON.stringify({ payload, new_content_sha256: sha256(patched.content) })),
  };
}

function previewSignature(payload) {
  return JSON.stringify({
    repository_full_name: payload.repository_full_name,
    branch: payload.branch,
    path: payload.path,
    expected_sha: payload.expected_sha,
    operation: payload.operation,
  });
}

function savePreview(patchId, payload) {
  previews.set(patchId, { signature: previewSignature(payload), expiresAt: Date.now() + 600000 });
}

function requirePreview(patchId, payload, required) {
  if (!required) return;
  if (!patchId) throw new GitHubAddError(400, { status: "BAD_REQUEST", message: "preview_patch_id is required when PATCH_REQUIRE_PREVIEW=true" });
  const preview = previews.get(patchId);
  if (!preview || preview.expiresAt < Date.now() || preview.signature !== previewSignature(payload)) {
    throw new GitHubAddError(422, { status: "PATCH_NOT_APPLICABLE", reason: "preview_required_or_expired" });
  }
}

async function handlePreview(payload, config, deps) {
  const outcome = await buildOutcome(payload, config, deps);
  savePreview(outcome.patch_id, payload);
  return {
    status: "DRY_RUN_PASS",
    can_apply: true,
    repository_full_name: payload.repository_full_name,
    branch: payload.branch,
    path: payload.path,
    file_sha_before: outcome.file.sha,
    operation_type: payload.operation.type,
    markers_found: outcome.markers_found,
    changed_lines: { added: outcome.changedLines.added, deleted: outcome.changedLines.deleted },
    diff_preview: outcome.diff_preview,
    patch_id: outcome.patch_id,
    evidence: {
      expected_sha_matched: true,
      repo_allowed: true,
      branch_allowed: true,
      path_allowed: true,
      protected_path_blocked: false,
      diff_within_limit: true,
      secret_scan_pass: true,
    },
  };
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
    const reread = await deps.readFile({ ...payload, expected_sha: update.file_sha_after || payload.expected_sha }, config);
    if (reread.content !== outcome.newContent) throw new GitHubAddError(500, { status: "GITHUB_ADD_ERROR", message: "reread verification failed" });
    if (previewPatchId) previews.delete(previewPatchId);

    return {
      status: "APPLY_PASS",
      repository_full_name: payload.repository_full_name,
      branch: payload.branch,
      path: payload.path,
      file_sha_before: outcome.file.sha,
      file_sha_after: reread.sha || update.file_sha_after,
      commit_sha: update.commit_sha,
      reread_verified: true,
      operation_type: payload.operation.type,
      changed_lines: { added: outcome.changedLines.added, deleted: outcome.changedLines.deleted },
      evidence: { expected_sha_matched: true, markers_unique: true, diff_within_limit: true, secret_scan_pass: true, reread_verified: true },
    };
  } finally {
    locks.delete(key);
  }
}

export function createRequestHandler(options = {}) {
  const config = options.config || loadConfig(options.env || process.env);
  const deps = {
    readFile: options.readFile || readFileFromGitHub,
    updateFile: options.updateFile || updateFileOnGitHub,
  };

  return async function requestHandler(req, res) {
    try {
      const url = new URL(req.url || "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/health") return send(res, 200, { status: "ok", service: "github-add", version: "0.1.0" });
      if (req.method === "GET" && url.pathname === "/openapi.json") return send(res, 200, openApiDocument());
      if (req.method === "POST" && url.pathname === "/patch/preview") {
        requireBearer(req, config);
        return send(res, 200, await handlePreview(validatePayload(await readBody(req)), config, deps));
      }
      if (req.method === "POST" && url.pathname === "/patch/apply") {
        requireBearer(req, config);
        return send(res, 200, await handleApply(await readBody(req), config, deps));
      }

      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      return res.end("not found");
    } catch (error) {
      const normalized = normalizeError(error);
      return send(res, normalized.httpStatus, normalized.payload);
    }
  };
}

export function startServer(options = {}) {
  const config = options.config || loadConfig(options.env || process.env);
  const server = createServer(createRequestHandler({ ...options, config }));
  server.listen(config.port, () => {
    console.log(JSON.stringify({ level: "info", service: "github-add", event: "listen", port: config.port }));
  });
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) startServer();
