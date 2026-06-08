import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { GitHubAddError, normalizeError } from "./errors.mjs";
import { loadConfig } from "./config.mjs";
import { applyOperation, countChangedLines, createDiffPreview, sha256, createLineView } from "./patch.mjs";
import { checkLimits, scanSecrets, validateAccess } from "./safety.mjs";
import { readFileFromGitHub, updateFileOnGitHub, createFileOnGitHub } from "./github.mjs";
import { openApiDocument } from "./openapi.mjs";

const previews = new Map();
const locks = new Set();

const send = (res, code, payload) => {
  res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(payload));
};

const reqstr = (v, f) => {
  if (typeof v !== "string" || !v) throw new GitHubAddError(400, { status: "BAD_REQUEST", message: `${f} is required` });
  return v;
};

function equal(a, b) {
  if (a.length !== b.length) {
    const x = Buffer.alloc(Math.max(a.length, b.length) || 1);
    timingSafeEqual(x.subarray(0, 1), x.subarray(0, 1));
    return false;
  }
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function bearer(req, config) {
  if (config.actionRequireBearer && !config.actionBearerToken) throw new GitHubAddError(503, { status: "AUTH_NOT_CONFIGURED", message: "Bearer token not configured" });
  if (!config.actionRequireBearer) return;
  const m = String(req.headers.authorization || "").match(/^Bearer\s+(.+)$/i);
  if (!m) throw new GitHubAddError(401, { status: "AUTH_FAILED", message: "Missing Authorization header" });
  if (!equal(m[1], config.actionBearerToken)) throw new GitHubAddError(401, { status: "AUTH_FAILED", message: "Invalid Bearer token" });
}

async function body(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try {
    const raw = Buffer.concat(chunks).toString("utf8");
    if (!raw.trim()) throw new Error("empty");
    return JSON.parse(raw);
  } catch {
    throw new GitHubAddError(400, { status: "BAD_REQUEST", message: "request body must be valid JSON" });
  }
}

function op(operation = {}) {
  if (operation.type !== "replace" && operation.type !== "replace_text") return operation;
  return {
    ...operation,
    type: "replace_exact_once",
    old_text: operation.old_text ?? operation.oldText ?? operation.search_text ?? operation.searchText ?? operation.search ?? operation.target_text ?? operation.targetText ?? operation.text,
    new_text: operation.new_text ?? operation.newText ?? operation.replace_with ?? operation.replaceWith ?? operation.replacement ?? operation.new ?? operation.value,
  };
}

function payload(b) {
  return {
    repository_full_name: reqstr(b.repository_full_name, "repository_full_name"),
    branch: reqstr(b.branch, "branch"),
    path: reqstr(b.path, "path"),
    expected_sha: reqstr(b.expected_sha || b.file_sha || b.sha, "expected_sha"),
    operation: op(b.operation || {}),
    options: b.options || {},
  };
}

function createPayload(b) {
  if (typeof b.content !== "string") throw new GitHubAddError(400, { status: "BAD_REQUEST", message: "content is required" });
  return {
    repository_full_name: reqstr(b.repository_full_name, "repository_full_name"),
    branch: reqstr(b.branch, "branch"),
    path: reqstr(b.path, "path"),
    content: b.content,
    commit_message: reqstr(b.commit_message, "commit_message"),
  };
}

function tokenDiag(config) {
  const token = String(config.githubToken || "");
  const candidates = Array.isArray(config.githubTokenCandidates) ? config.githubTokenCandidates : [];
  return {
    token_env_names_configured: candidates.map((c) => c.name),
    selected_token_env_name: config.githubTokenEnvName || "",
    selected_token_present: Boolean(token),
    selected_token_length: token.length,
    selected_token_prefix: token.startsWith("github_pat_") ? "github_pat" : token.startsWith("ghp_") ? "ghp" : token ? "other" : "none",
  };
}

async function health(config) {
  const out = { status: "ok", service: "github-add", version: "0.2.4", github_token_runtime: tokenDiag(config) };
  try {
    const probe = await readFileFromGitHub({
      repository_full_name: "n0namer/content-generator",
      branch: "main",
      path: "projects/mini-product-ai-accelerator/05_BACKLOG.md",
    }, config);
    out.github_auth = {
      status: "GITHUB_CONTENT_READ_OK",
      token_env_name: config.githubTokenEnvName || "",
      repository_full_name: "n0namer/content-generator",
      branch: "main",
      probe_path: "projects/mini-product-ai-accelerator/05_BACKLOG.md",
      probe_file_sha: probe.sha,
      probe_size: probe.size,
    };
  } catch (e) {
    out.github_auth = {
      status: "GITHUB_CONTENT_READ_FAILED",
      message: e?.payload?.message || e?.message || "GitHub content read check failed",
      tried_token_env_names: e?.payload?.tried_token_env_names,
      github_status: e?.payload?.github_status || e?.status,
    };
  }
  return out;
}

async function outcome(p, config, deps) {
  validateAccess(p, config);
  const file = await deps.readFile(p, config);
  if (file.sha !== p.expected_sha) throw new GitHubAddError(409, { status: "FILE_CHANGED", expected_sha: p.expected_sha, actual_sha: file.sha });
  const patched = applyOperation(file.content, p.operation);
  const diff = await createDiffPreview(p.path, file.content, patched.content);
  const changed = countChangedLines(diff);
  checkLimits(file, changed, config, p.options);
  scanSecrets(patched.content);
  return { file, patched, diff, changed, id: sha256(JSON.stringify({ p, sha: sha256(patched.content) })) };
}

function sig(p) {
  return JSON.stringify({ r: p.repository_full_name, b: p.branch, p: p.path, s: p.expected_sha, o: p.operation });
}

async function preview(b, config, deps) {
  const p = payload(b);
  const o = await outcome(p, config, deps);
  previews.set(o.id, { signature: sig(p), expiresAt: Date.now() + 600000 });
  return {
    status: "DRY_RUN_PASS",
    can_apply: true,
    repository_full_name: p.repository_full_name,
    branch: p.branch,
    path: p.path,
    file_sha_before: o.file.sha,
    operation_type: p.operation.type,
    markers_found: o.patched.markers_found,
    target_match: o.patched.target_match,
    changed_lines: { added: o.changed.added, deleted: o.changed.deleted },
    diff_preview: o.diff,
    patch_id: o.id,
  };
}

async function apply(b, config, deps) {
  const p = payload(b);
  const msg = reqstr(b.commit_message, "commit_message");
  const id = b.preview_patch_id || b.patch_id;
  if (config.requirePreview) {
    const saved = previews.get(id);
    if (!id || !saved || saved.expiresAt < Date.now() || saved.signature !== sig(p)) throw new GitHubAddError(422, { status: "PATCH_NOT_APPLICABLE", reason: "preview_required_or_expired" });
  }
  const key = `${p.repository_full_name}:${p.branch}:${p.path}`;
  if (locks.has(key)) throw new GitHubAddError(423, { status: "WRITE_LOCKED", lock_key: key });
  locks.add(key);
  try {
    const o = await outcome(p, config, deps);
    const u = await deps.updateFile(p, o.patched.content, o.file.sha, msg, config);
    const reread = await deps.readFile({ ...p, expected_sha: u.file_sha_after || p.expected_sha }, config);
    if (reread.content !== o.patched.content) throw new GitHubAddError(500, { status: "GITHUB_ADD_ERROR", message: "reread verification failed" });
    if (id) previews.delete(id);
    return { status: "APPLY_PASS", repository_full_name: p.repository_full_name, branch: p.branch, path: p.path, file_sha_before: o.file.sha, file_sha_after: reread.sha || u.file_sha_after, commit_sha: u.commit_sha, reread_verified: true, operation_type: p.operation.type };
  } finally {
    locks.delete(key);
  }
}

async function read(b, config, deps) {
  const p = { repository_full_name: reqstr(b.repository_full_name, "repository_full_name"), branch: reqstr(b.branch, "branch"), path: reqstr(b.path, "path") };
  validateAccess(p, config);
  const f = await deps.readFile(p, config);
  const lines = createLineView(f.content);
  const out = { status: "READ_PASS", repository_full_name: p.repository_full_name, branch: p.branch, path: p.path, file_sha: f.sha, sha: f.sha, size: f.size, line_count: lines.length, content: f.content, lines };
  if (b.options?.fields) for (const k of Object.keys(out)) if (!new Set(b.options.fields).has(k)) delete out[k];
  return out;
}

export function createRequestHandler(options = {}) {
  const config = options.config || loadConfig(options.env || process.env);
  const deps = { readFile: options.readFile || readFileFromGitHub, updateFile: options.updateFile || updateFileOnGitHub };
  return async (req, res) => {
    try {
      const url = new URL(req.url || "/", "http://localhost");
      if (req.method === "GET" && url.pathname === "/health") return send(res, 200, await health(config));
      if (req.method === "GET" && url.pathname === "/openapi.json") return send(res, 200, openApiDocument());
      if (req.method === "POST" && url.pathname === "/file/read") { bearer(req, config); return send(res, 200, await read(await body(req), config, deps)); }
      if (req.method === "POST" && url.pathname === "/patch/preview") { bearer(req, config); return send(res, 200, await preview(await body(req), config, deps)); }
      if (req.method === "POST" && url.pathname === "/patch/apply") { bearer(req, config); return send(res, 200, await apply(await body(req), config, deps)); }
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      return res.end("not found");
    } catch (e) {
      const n = normalizeError(e);
      return send(res, n.httpStatus, n.payload);
    }
  };
}

export function startServer(options = {}) {
  const config = options.config || loadConfig(options.env || process.env);
  const server = createServer(createRequestHandler({ ...options, config }));
  server.listen(config.port, () => console.log(JSON.stringify({ level: "info", service: "github-add", event: "listen", port: config.port, version: "0.2.2" })));
  return server;
}

if (import.meta.url === `file://${process.argv[1]}`) startServer();
