import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { GitHubAddError, normalizeError } from "./errors.mjs";
import { loadConfig } from "./config.mjs";
import {
  applyOperation, countChangedLines, createDiffPreview, replaceBetweenMarkers, insertAfterMarker, sha256,
  replaceExactOnce, replaceWithContext, replaceLineRange, insertAfterExactOnce, createLineView,
} from "./patch.mjs";
import { checkLimits, scanSecrets, validateAccess } from "./safety.mjs";
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
    capabilities: ["file_read", "patch_preview", "patch_apply", "pull_request_read", "pull_request_ready", "pull_request_merge"],
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
  if (!config.actionRequireBearer return;
  const header = req.headers["authorization"] || req.headers["Authorization"] || "";
  const match = header.match(/^Bearer\s+(.+)$oi);
  if (!match) {
    throw new GitHubAddError(401, { status: "AUTH_FAILED", message: "Missing or malformed Authorization header" });
  }
  if (!constantTimeEqual(match[1], token)) {
    throw new GitHubAddError(401, { status: "AUTH_FAILED", message: "Invalid Bearer token" });
  }
}
