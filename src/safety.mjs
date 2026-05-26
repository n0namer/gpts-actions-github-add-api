import { GitHubAddError } from "./errors.mjs";

export function validateAccess(payload, config) {
  if (!config.allowedRepos.includes(payload.repository_full_name)) {
    throw new GitHubAddError(403, { status: "NOT_ALLOWED", reason: "repository_not_allowed" });
  }
  if (!config.allowedBranches.includes(payload.branch)) {
    throw new GitHubAddError(403, { status: "NOT_ALLOWED", reason: "branch_not_allowed" });
  }
  if (!config.allowedPathPrefixes.some((prefix) => payload.path.startsWith(prefix))) {
    throw new GitHubAddError(403, { status: "NOT_ALLOWED", reason: "path_prefix_not_allowed" });
  }
  if (payload.path.includes("..") || payload.path.startsWith("/") || payload.path.includes("\\")) {
    throw new GitHubAddError(403, { status: "NOT_ALLOWED", reason: "invalid_path" });
  }
  if (config.blockProtectedPaths && config.protectedPathPrefixes.some((prefix) => payload.path.startsWith(prefix))) {
    throw new GitHubAddError(422, { status: "PATCH_NOT_APPLICABLE", reason: "protected_path", path: payload.path });
  }
}

export function scanSecrets(content) {
  const patterns = [
    ["github_token", /\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9_]{20,})\b/],
    ["openai_key", /\bsk-[A-Za-z0-9]{32,}\b/],
    ["aws_access_key", /\bAKIA[0-9A-Z]{16}\b/],
    ["private_key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
    ["assigned_secret", /\b(?:password|passwd|api_key|secret|token)\s*[:=]\s*["'][^"'\n]{16,}["']/i],
  ];
  const hit = patterns.find(([, pattern]) => pattern.test(content));
  if (hit) throw new GitHubAddError(422, { status: "PATCH_NOT_APPLICABLE", reason: "secret_scan_failed", pattern: hit[0] });
  return true;
}

export function checkLimits(file, changedLines, config, options = {}) {
  if (file.size > config.maxFileBytes) {
    throw new GitHubAddError(422, { status: "PATCH_NOT_APPLICABLE", reason: "file_too_large", max_file_bytes: config.maxFileBytes });
  }
  const maxChangedLines = Number(options.max_changed_lines || config.maxChangedLines);
  if (changedLines.total > maxChangedLines) {
    throw new GitHubAddError(422, { status: "PATCH_NOT_APPLICABLE", reason: "diff_too_large", max_changed_lines: maxChangedLines, changed_lines: changedLines.total });
  }
}
