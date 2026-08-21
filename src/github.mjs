import { Buffer } from "node:buffer";
import { createSign, randomUUID } from "node:crypto";
import { GitHubAddError } from "./errors.mjs";
import { validateContentForPath } from "./validation.mjs";

function parseRepository(fullName) {
  const [owner, repo, extra] = String(fullName || "").split("/");
  if (!owner || !repo || extra) throw new GitHubAddError(400, { status: "BAD_REQUEST", message: "repository_full_name must be owner/repo" });
  return { owner, repo };
}

function tokenCandidates(config) {
  if (Array.isArray(config.githubTokenCandidates) && config.githubTokenCandidates.length > 0) {
    return config.githubTokenCandidates;
  }
  if (config.githubToken) {
    return [{ name: config.githubTokenEnvName || "GITHUB_TOKEN", value: config.githubToken }];
  }
  return [];
}

function isGitHubAuthError(error) {
  return error?.status === 401 || error?.status === 403;
}

async function getOctokitForToken(token) {
  const { Octokit } = await import("@octokit/rest");
  return new Octokit({ auth: token });
}

async function withGitHubAuth(config, operation) {
  const candidates = tokenCandidates(config);
  if (candidates.length === 0) {
    throw new GitHubAddError(401, { status: "AUTH_FAILED", message: "GitHub token is not configured" });
  }

  let authError = null;
  const triedTokenEnvNames = [];

  for (const candidate of candidates) {
    triedTokenEnvNames.push(candidate.name);
    try {
      const octokit = await getOctokitForToken(candidate.value);
      return await operation(octokit, candidate);
    } catch (error) {
      if (!isGitHubAuthError(error)) throw error;
      authError = error;
    }
  }

  throw new GitHubAddError(401, {
    status: "AUTH_FAILED",
    message: "GitHub authentication failed",
    tried_token_env_names: triedTokenEnvNames,
    github_status: authError?.status,
  });
}

export async function readFileFromGitHub(payload, config) {
  const { owner, repo } = parseRepository(payload.repository_full_name);
  try {
    const response = await withGitHubAuth(config, (octokit) =>
      octokit.repos.getContent({ owner, repo, path: payload.path, ref: payload.branch })
    );
    const data = response.data;
    if (Array.isArray(data) || data.type !== "file" || typeof data.content !== "string") throw new Error("not-file");
    const content = Buffer.from(data.content, data.encoding === "base64" ? "base64" : "utf8").toString("utf8");
    if (payload.validate_content === true) validateContentForPath(payload.path, content);
    return {
      content,
      sha: data.sha,
      size: data.size,
    };
  } catch (error) {
    if (error instanceof GitHubAddError) throw error;
    if (error.status === 404 || error.message === "not-file") throw new GitHubAddError(404, { status: "FILE_NOT_FOUND", path: payload.path });
    if (error.status === 401 || error.status === 403) throw new GitHubAddError(401, { status: "AUTH_FAILED", message: "GitHub authentication failed" });
    throw error;
  }
}

async function verifyCommittedContent(payload, expectedContent, config) {
  let reread = null;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    reread = await readFileFromGitHub({ ...payload, validate_content: true }, config);
    if (reread.content === expectedContent) return reread;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new GitHubAddError(500, { status: "GITHUB_ADD_ERROR", message: "GitHub readback verification failed" });
}

export async function updateFileOnGitHub(payload, newContent, sha, message, config) {
  validateContentForPath(payload.path, newContent);
  const { owner, repo } = parseRepository(payload.repository_full_name);
  const response = await withGitHubAuth(config, (octokit) =>
    octokit.repos.createOrUpdateFileContents({
      owner,
      repo,
      path: payload.path,
      branch: payload.branch,
      message,
      sha,
      content: Buffer.from(newContent, "utf8").toString("base64"),
    })
  );
  const reread = await verifyCommittedContent(payload, newContent, config);
  return {
    commit_sha: response.data.commit?.sha,
    file_sha_after: reread.sha || response.data.content?.sha,
    reread_validated: true,
  };
}

export async function createFileOnGitHub(payload, content, message, config) {
  validateContentForPath(payload.path, content);
  const { owner, repo } = parseRepository(payload.repository_full_name);
  try {
    const response = await withGitHubAuth(config, (octokit) =>
      octokit.repos.createOrUpdateFileContents({
        owner,
        repo,
        path: payload.path,
        branch: payload.branch,
        message,
        content: Buffer.from(content, "utf8").toString("base64"),
      })
    );
    const reread = await verifyCommittedContent(payload, content, config);
    return {
      commit_sha: response.data.commit?.sha,
      file_sha_after: reread.sha || response.data.content?.sha,
      reread_validated: true,
    };
  } catch (error) {
    if (error?.status === 422) {
      throw new GitHubAddError(409, { status: "FILE_ALREADY_EXISTS", path: payload.path });
    }
    throw error;
  }
}

function normalizePullNumber(value) {
  const pullNumber = Number(value);
  if (!Number.isInteger(pullNumber) || pullNumber <= 0) {
    throw new GitHubAddError(400, { status: "BAD_REQUEST", message: "pull_number must be a positive integer" });
  }
  return pullNumber;
}

function pullRequestSnapshot(data) {
  return {
    pull_number: data.number,
    state: data.state,
    draft: Boolean(data.draft),
    merged: Boolean(data.merged),
    mergeable: data.mergeable,
    mergeable_state: data.mergeable_state,
    head_ref: data.head?.ref,
    head_sha: data.head?.sha,
    base_ref: data.base?.ref,
  };
}

function translatePullRequestError(error, pullNumber) {
  if (error instanceof GitHubAddError) throw error;
  const githubStatus = error?.status;
  const message = error?.response?.data?.message || error?.message || "GitHub pull request operation failed";
  if (githubStatus === 404) {
    throw new GitHubAddError(404, { status: "PULL_REQUEST_NOT_FOUND", pull_number: pullNumber, message });
  }
  if (githubStatus === 401 || githubStatus === 403) {
    throw new GitHubAddError(401, { status: "AUTH_FAILED", message: "GitHub authentication failed", github_status: githubStatus });
  }
  if (githubStatus === 405 || githubStatus === 409 || githubStatus === 422) {
    throw new GitHubAddError(githubStatus, { status: "PULL_REQUEST_OPERATION_BLOCKED", pull_number: pullNumber, github_status: githubStatus, message });
  }
  throw error;
}

export async function readPullRequestFromGitHub(payload, config) {
  const { owner, repo } = parseRepository(payload.repository_full_name);
  const pullNumber = normalizePullNumber(payload.pull_number);
  try {
    const response = await withGitHubAuth(config, (octokit) =>
      octokit.pulls.get({ owner, repo, pull_number: pullNumber })
    );
    return pullRequestSnapshot(response.data);
  } catch (error) {
    translatePullRequestError(error, pullNumber);
  }
}

export async function markPullRequestReadyForReviewOnGitHub(payload, config) {
  const { owner, repo } = parseRepository(payload.repository_full_name);
  const pullNumber = normalizePullNumber(payload.pull_number);
  try {
    return await withGitHubAuth(config, async (octokit) => {
      const beforeResponse = await octokit.pulls.get({ owner, repo, pull_number: pullNumber });
      const before = pullRequestSnapshot(beforeResponse.data);
      if (payload.expected_head_sha && before.head_sha !== payload.expected_head_sha) {
        throw new GitHubAddError(409, { status: "PULL_REQUEST_CHANGED", expected_head_sha: payload.expected_head_sha, actual_head_sha: before.head_sha });
      }
      if (!before.draft) {
        return { status: "PR_READY_PASS", changed: false, ...before, reread_verified: true };
      }

      await octokit.graphql(
        `mutation($pullRequestId: ID!) {
          markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) {
            pullRequest { id number isDraft state }
          }
        }`,
        { pullRequestId: beforeResponse.data.node_id },
      );

      const afterResponse = await octokit.pulls.get({ owner, repo, pull_number: pullNumber });
      const after = pullRequestSnapshot(afterResponse.data);
      if (after.draft) {
        throw new GitHubAddError(500, { status: "GITHUB_ADD_ERROR", message: "ready-for-review reread verification failed" });
      }
      return { status: "PR_READY_PASS", changed: true, ...after, reread_verified: true };
    });
  } catch (error) {
    translatePullRequestError(error, pullNumber);
  }
}

export async function mergePullRequestOnGitHub(payload, config) {
  const { owner, repo } = parseRepository(payload.repository_full_name);
  const pullNumber = normalizePullNumber(payload.pull_number);
  try {
    return await withGitHubAuth(config, async (octokit) => {
      const beforeResponse = await octokit.pulls.get({ owner, repo, pull_number: pullNumber });
      const before = pullRequestSnapshot(beforeResponse.data);
      if (before.head_sha !== payload.expected_head_sha) {
        throw new GitHubAddError(409, { status: "PULL_REQUEST_CHANGED", expected_head_sha: payload.expected_head_sha, actual_head_sha: before.head_sha });
      }
      if (before.draft) {
        throw new GitHubAddError(422, { status: "PULL_REQUEST_OPERATION_BLOCKED", reason: "pull_request_is_draft", pull_number: pullNumber });
      }
      if (before.merged) {
        return { status: "MERGE_PASS", changed: false, ...before, reread_verified: true };
      }
      if (before.state !== "open") {
        throw new GitHubAddError(422, { status: "PULL_REQUEST_OPERATION_BLOCKED", reason: "pull_request_not_open", pull_number: pullNumber });
      }

      const mergeResponse = await octokit.pulls.merge({
        owner,
        repo,
        pull_number: pullNumber,
        sha: payload.expected_head_sha,
        merge_method: payload.merge_method || "merge",
        ...(payload.commit_title ? { commit_title: payload.commit_title } : {}),
        ...(payload.commit_message ? { commit_message: payload.commit_message } : {}),
      });
      if (!mergeResponse.data.merged) {
        throw new GitHubAddError(409, { status: "PULL_REQUEST_OPERATION_BLOCKED", pull_number: pullNumber, message: mergeResponse.data.message || "GitHub did not merge pull request" });
      }

      const afterResponse = await octokit.pulls.get({ owner, repo, pull_number: pullNumber });
      const after = pullRequestSnapshot(afterResponse.data);
      if (!after.merged) {
        throw new GitHubAddError(500, { status: "GITHUB_ADD_ERROR", message: "merge reread verification failed" });
      }
      return {
        status: "MERGE_PASS",
        changed: true,
        ...after,
        merge_commit_sha: mergeResponse.data.sha,
        reread_verified: true,
      };
    });
  } catch (error) {
    translatePullRequestError(error, pullNumber);
  }
}

export async function checkGitHubAuth(payload, config) {
  const repositoryFullName = payload?.repository_full_name;
  return withGitHubAuth(config, async (octokit, candidate) => {
    const user = await octokit.users.getAuthenticated();

    const result = {
      status: "GITHUB_AUTH_OK",
      token_env_name: candidate.name,
      login: user.data.login,
    };

    if (repositoryFullName) {
      const { owner, repo } = parseRepository(repositoryFullName);
      const repository = await octokit.repos.get({ owner, repo });
      result.repository_full_name = `${owner}/${repo}`;
      result.repository_private = repository.data.private;
      result.repository_permissions = repository.data.permissions || undefined;
    }

    return result;
  });
}

const GITHUB_API_BASE = "https://api.github.com";
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const SECRET_RESPONSE_KEYS = /^(?:token|access_token|refresh_token|secret|client_secret|password|private_key|authorization)$/i;

const SECRET_BEARING_MUTATION_PATH = /\/(?:actions|dependabot|codespaces)\/secrets(?:\/|$)/i;
const ADMIN_REPOSITORY_MUTATION_PATH = /^\/repos\/[^/]+\/[^/]+\/(?:collaborators|actions\/permissions|environments|rulesets|branches\/.+\/protection|hooks|interaction-limits|automated-security-fixes|private-vulnerability-reporting|security-and-analysis)(?:\/|$)/i;
const PROBE_REF_DELETE_PATH = /^\/repos\/[^/]+\/[^/]+\/git\/refs\/heads\/station\/probe\/[A-Za-z0-9._/-]+$/i;

function decodeGitHubPathForPolicy(pathname) {
  try { return decodeURIComponent(pathname); } catch { throw new GitHubAddError(400, { status: "BAD_REQUEST", message: "path contains invalid percent-encoding" }); }
}

function classifyRestMutation(method, pathname) {
  const policyPath = decodeGitHubPathForPolicy(pathname);
  if (!MUTATING_METHODS.has(method)) return "read";
  if (SECRET_BEARING_MUTATION_PATH.test(policyPath)) return "secret_bearing";
  if (method === "DELETE" && PROBE_REF_DELETE_PATH.test(policyPath)) return "write";
  if (method === "DELETE") return "destructive";
  if (!policyPath.toLowerCase().startsWith("/repos/")) return "admin";
  if (ADMIN_REPOSITORY_MUTATION_PATH.test(policyPath)) return "admin";
  return "write";
}

function enforceRestMutationPolicy(payload, method, pathname, config) {
  const mutationClass = classifyRestMutation(method, pathname);
  if (mutationClass === "read") return mutationClass;
  if (payload.confirm_mutation !== true) {
    throw new GitHubAddError(409, { status: "MUTATION_CONFIRMATION_REQUIRED", mutation_class: mutationClass, message: "confirm_mutation=true is required for GitHub REST mutations" });
  }
  if (mutationClass === "secret_bearing") {
    throw new GitHubAddError(403, { status: "SECRET_BEARING_OPERATION_BLOCKED", mutation_class: mutationClass });
  }
  if (mutationClass === "admin") {
    if (!config.githubRestAdminMutationsEnabled) throw new GitHubAddError(403, { status: "ADMIN_MUTATION_DISABLED", mutation_class: mutationClass });
    if (payload.confirm_admin_mutation !== true) throw new GitHubAddError(409, { status: "ADMIN_MUTATION_CONFIRMATION_REQUIRED", mutation_class: mutationClass });
  }
  if (mutationClass === "destructive") {
    if (!config.githubRestDestructiveMutationsEnabled) throw new GitHubAddError(403, { status: "DESTRUCTIVE_MUTATION_DISABLED", mutation_class: mutationClass });
    if (payload.confirm_destructive_mutation !== true) throw new GitHubAddError(409, { status: "DESTRUCTIVE_MUTATION_CONFIRMATION_REQUIRED", mutation_class: mutationClass });
  }
  return mutationClass;
}

function normalizeGitHubRestMethod(value) {
  const method = String(value || "GET").trim().toUpperCase();
  if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    throw new GitHubAddError(400, { status: "BAD_REQUEST", message: "method must be GET, HEAD, POST, PUT, PATCH, or DELETE" });
  }
  return method;
}

function normalizeGitHubRestPath(value) {
  const pathname = String(value || "").trim();
  if (!pathname.startsWith("/") || pathname.startsWith("//") || pathname.includes("\0") || pathname.includes("\\") || pathname.includes("?") || pathname.includes("#") || /[\r\n]/.test(pathname) || pathname.length > 2048) {
    throw new GitHubAddError(400, { status: "BAD_REQUEST", message: "path must be an absolute canonical GitHub API path without query, fragment, or backslash" });
  }
  if (/^\/https?:/i.test(pathname)) throw new GitHubAddError(400, { status: "BAD_REQUEST", message: "external URLs are not allowed" });
  const segments = pathname.split("/").slice(1);
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    let decoded;
    try { decoded = decodeURIComponent(segment); } catch { throw new GitHubAddError(400, { status: "BAD_REQUEST", message: "path contains invalid percent-encoding" }); }
    if (decoded === "." || decoded === ".." || decoded.includes("\\") || /[\0\r\n]/.test(decoded)) {
      throw new GitHubAddError(400, { status: "BAD_REQUEST", message: "path contains a non-canonical segment" });
    }
    if (segments[0] && decodeURIComponent(segments[0]).toLowerCase() === "repos" && (index === 1 || index === 2) && decoded.includes("/")) {
      throw new GitHubAddError(400, { status: "BAD_REQUEST", message: "repository owner and name cannot contain encoded slashes" });
    }
  }
  const canonicalPath = new URL(pathname, GITHUB_API_BASE).pathname;
  if (canonicalPath !== pathname) throw new GitHubAddError(400, { status: "BAD_REQUEST", message: "path normalization is not allowed" });
  return pathname;
}

function normalizeGitHubQuery(query) {
  if (query == null) return {};
  if (!query || typeof query !== "object" || Array.isArray(query)) throw new GitHubAddError(400, { status: "BAD_REQUEST", message: "query must be an object" });
  const out = {};
  for (const [key, value] of Object.entries(query)) {
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(key)) throw new GitHubAddError(400, { status: "BAD_REQUEST", message: "query contains an invalid key" });
    if (value == null || ["string", "number", "boolean"].includes(typeof value)) out[key] = value;
    else if (Array.isArray(value) && value.every((item) => ["string", "number", "boolean"].includes(typeof item))) out[key] = value;
    else throw new GitHubAddError(400, { status: "BAD_REQUEST", message: `query.${key} has an unsupported value` });
  }
  return out;
}

function redactGitHubResponse(value) {
  if (Array.isArray(value)) return value.map(redactGitHubResponse);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = SECRET_RESPONSE_KEYS.test(key) ? "[REDACTED]" : redactGitHubResponse(item);
  }
  return out;
}

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function appJwt(config) {
  const appId = String(config.githubAppId || "").trim();
  const privateKey = String(config.githubAppPrivateKey || "").replaceAll("\\n", "\n").trim();
  if (!/^[1-9][0-9]*$/.test(appId) || !privateKey) {
    throw new GitHubAddError(503, { status: "GITHUB_APP_NOT_CONFIGURED", message: "GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY are required" });
  }
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: appId }));
  const signingInput = `${header}.${payload}`;
  let signature;
  try {
    const signer = createSign("RSA-SHA256");
    signer.update(signingInput);
    signer.end();
    signature = signer.sign(privateKey).toString("base64url");
  } catch {
    throw new GitHubAddError(503, { status: "GITHUB_APP_KEY_INVALID", message: "GitHub App private key could not sign a JWT" });
  }
  return `${signingInput}.${signature}`;
}

async function boundedResponseBody(response, maxBytes) {
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch {}
      throw new GitHubAddError(502, { status: "GITHUB_RESPONSE_TOO_LARGE", max_response_bytes: maxBytes });
    }
    chunks.push(Buffer.from(value));
  }
  if (total === 0) return null;
  const text = Buffer.concat(chunks).toString("utf8");
  try { return JSON.parse(text); } catch { return text; }
}

async function githubRestRaw({ method, path: pathname, query = {}, body, token, config }) {
  const url = new URL(normalizeGitHubRestPath(pathname), GITHUB_API_BASE);
  for (const [key, value] of Object.entries(normalizeGitHubQuery(query))) {
    if (Array.isArray(value)) for (const item of value) url.searchParams.append(key, String(item));
    else if (value != null) url.searchParams.set(key, String(value));
  }
  const headers = {
    accept: "application/vnd.github+json",
    authorization: `Bearer ${token}`,
    "user-agent": "github-file-patch-api",
    "x-github-api-version": config.githubApiVersion || "2026-03-10",
  };
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: body == null ? headers : { ...headers, "content-type": "application/json" },
      body: body == null || method === "GET" || method === "HEAD" ? undefined : JSON.stringify(body),
      redirect: "manual",
    });
  } catch {
    throw new GitHubAddError(502, { status: "GITHUB_API_UNAVAILABLE", message: "GitHub API request failed at transport layer" });
  }
  const data = await boundedResponseBody(response, Number(config.githubRestMaxResponseBytes || 2000000));
  return {
    ok: response.ok,
    status: response.status,
    data,
    request_id: response.headers.get("x-github-request-id") || undefined,
    rate_limit_remaining: response.headers.get("x-ratelimit-remaining") || undefined,
    link: response.headers.get("link") || undefined,
  };
}

function githubRestFailure(result) {
  const message = typeof result.data === "object" && result.data && typeof result.data.message === "string"
    ? result.data.message.slice(0, 1200)
    : `GitHub API returned status ${result.status}`;
  throw new GitHubAddError(result.status >= 400 && result.status < 600 ? result.status : 502, {
    status: "GITHUB_REST_FAILED",
    github_status: result.status,
    message,
    request_id: result.request_id,
  });
}

function nextPageRequest(linkHeader) {
  const link = String(linkHeader || "");
  if (!link) return null;
  const part = link.split(",").map((item) => item.trim()).find((item) => /;\s*rel="next"(?:\s*;|$)/i.test(item));
  if (!part) return null;
  const match = part.match(/^<([^>]+)>/);
  if (!match) return null;
  let url;
  try { url = new URL(match[1]); } catch { throw new GitHubAddError(502, { status: "GITHUB_PAGINATION_LINK_INVALID" }); }
  if (url.origin !== GITHUB_API_BASE) throw new GitHubAddError(502, { status: "GITHUB_PAGINATION_LINK_INVALID", reason: "unexpected_origin" });
  const query = {};
  for (const [key, value] of url.searchParams.entries()) {
    if (query[key] === undefined) query[key] = value;
    else if (Array.isArray(query[key])) query[key].push(value);
    else query[key] = [query[key], value];
  }
  return { path: url.pathname, query };
}

function mergePaginatedData(base, page, maxItems) {
  if (Array.isArray(base) && Array.isArray(page)) return base.concat(page).slice(0, maxItems);
  if (!base || !page || typeof base !== "object" || typeof page !== "object" || Array.isArray(base) || Array.isArray(page)) return base;
  const out = { ...base };
  let merged = false;
  for (const key of Object.keys(base)) {
    if (Array.isArray(base[key]) && Array.isArray(page[key])) {
      out[key] = base[key].concat(page[key]).slice(0, maxItems);
      merged = true;
    }
  }
  return merged ? out : base;
}

function paginatedItemCount(value) {
  if (Array.isArray(value)) return value.length;
  if (!value || typeof value !== "object") return 0;
  const arrays = Object.values(value).filter(Array.isArray);
  return arrays.length ? Math.max(...arrays.map((items) => items.length)) : 0;
}

function serializedJsonBytes(value) {
  return Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
}

async function resolveInstallationToken(payload, config) {
  const jwt = appJwt(config);
  let installationId = Number(payload.installation_id || 0);
  let repository = null;
  if (payload.repository_full_name) {
    repository = parseRepository(payload.repository_full_name);
  }
  if (!Number.isInteger(installationId) || installationId <= 0) {
    if (!repository) throw new GitHubAddError(400, { status: "BAD_REQUEST", message: "installation auth requires installation_id or repository_full_name" });
    const lookup = await githubRestRaw({ method: "GET", path: `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/installation`, token: jwt, config });
    if (!lookup.ok) githubRestFailure(lookup);
    installationId = Number(lookup.data?.id);
  }
  if (!Number.isInteger(installationId) || installationId <= 0) throw new GitHubAddError(502, { status: "GITHUB_INSTALLATION_INVALID" });
  const mintBody = repository ? { repositories: [repository.repo] } : {};
  const minted = await githubRestRaw({ method: "POST", path: `/app/installations/${installationId}/access_tokens`, body: mintBody, token: jwt, config });
  if (!minted.ok) githubRestFailure(minted);
  const token = minted.data?.token;
  if (typeof token !== "string" || token.length < 20) throw new GitHubAddError(502, { status: "GITHUB_INSTALLATION_TOKEN_INVALID" });
  return {
    token,
    installation_id: installationId,
    expires_at: minted.data?.expires_at,
    permissions: minted.data?.permissions || {},
    repositories: Array.isArray(minted.data?.repositories) ? minted.data.repositories.map((item) => item.full_name).filter(Boolean) : undefined,
  };
}

function repositoryFromRestPath(pathname) {
  const policyPath = decodeGitHubPathForPolicy(String(pathname || ""));
  const match = policyPath.match(/^\/repos\/([^/?#]+)\/([^/?#]+)(?:\/|$)/i);
  if (!match) return null;
  return `${match[1]}/${match[2]}`;
}

function enforceRestRepositoryScope(payload, pathname, config) {
  const pathRepository = repositoryFromRestPath(pathname);
  const declaredRepository = payload.repository_full_name ? String(payload.repository_full_name).trim() : null;
  if (pathRepository && declaredRepository && pathRepository.toLowerCase() !== declaredRepository.toLowerCase()) {
    throw new GitHubAddError(409, { status: "REPOSITORY_SCOPE_MISMATCH", path_repository: pathRepository, declared_repository: declaredRepository });
  }
  const repository = declaredRepository || pathRepository;
  if (repository) parseRepository(repository);
  if (repository && config.allowedRepos.length > 0 && !config.allowedRepos.some((item) => item.toLowerCase() === repository.toLowerCase())) {
    throw new GitHubAddError(403, { status: "NOT_ALLOWED", reason: "repository_not_allowed", repository_full_name: repository });
  }
  return repository;
}

export async function githubRestRequest(payload, config) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new GitHubAddError(400, { status: "BAD_REQUEST", message: "JSON object required" });
  const method = normalizeGitHubRestMethod(payload.method);
  const pathname = normalizeGitHubRestPath(payload.path);
  const authMode = String(payload.auth || "user").trim().toLowerCase();
  if (!new Set(["user", "app", "installation"]).has(authMode)) throw new GitHubAddError(400, { status: "BAD_REQUEST", message: "auth must be user, app, or installation" });
  const mutationClass = enforceRestMutationPolicy(payload, method, pathname, config);
  const paginate = payload.paginate === true;
  if (paginate && method !== "GET") throw new GitHubAddError(400, { status: "BAD_REQUEST", message: "paginate=true is supported only for GET requests" });
  const maxPagesRaw = Number(payload.max_pages ?? 5);
  const maxItemsRaw = Number(payload.max_items ?? 500);
  if (!Number.isInteger(maxPagesRaw) || maxPagesRaw < 1 || maxPagesRaw > 10) throw new GitHubAddError(400, { status: "BAD_REQUEST", message: "max_pages must be an integer from 1 to 10" });
  if (!Number.isInteger(maxItemsRaw) || maxItemsRaw < 1 || maxItemsRaw > 1000) throw new GitHubAddError(400, { status: "BAD_REQUEST", message: "max_items must be an integer from 1 to 1000" });
  const repositoryScope = enforceRestRepositoryScope(payload, pathname, config);

  let result;
  let authToken;
  let authEvidence = {};
  if (authMode === "user") {
    const candidates = tokenCandidates(config);
    if (candidates.length === 0) throw new GitHubAddError(401, { status: "AUTH_FAILED", message: "GitHub user token is not configured" });
    let last = null;
    for (const candidate of candidates) {
      last = await githubRestRaw({ method, path: pathname, query: payload.query, body: payload.body, token: candidate.value, config });
      if (last.status !== 401 && last.status !== 403) {
        result = last;
        authToken = candidate.value;
        authEvidence = { token_env_name: candidate.name };
        break;
      }
    }
    result ||= last;
  } else if (authMode === "app") {
    authToken = appJwt(config);
    result = await githubRestRaw({ method, path: pathname, query: payload.query, body: payload.body, token: authToken, config });
    authEvidence = { app_id: String(config.githubAppId || "") };
  } else {
    const credential = await resolveInstallationToken({ ...payload, repository_full_name: repositoryScope || payload.repository_full_name }, config);
    authToken = credential.token;
    result = await githubRestRaw({ method, path: pathname, query: payload.query, body: payload.body, token: authToken, config });
    authEvidence = { installation_id: credential.installation_id, token_expires_at: credential.expires_at, permissions: credential.permissions };
  }
  if (!result?.ok) githubRestFailure(result || { status: 502, data: null });

  let pages = 1;
  let mergedData = result.data;
  if (paginate && authToken && paginatedItemCount(mergedData) > 0) {
    let next = nextPageRequest(result.link);
    while (next && pages < maxPagesRaw && paginatedItemCount(mergedData) < maxItemsRaw) {
      const page = await githubRestRaw({ method: "GET", path: next.path, query: next.query, token: authToken, config });
      if (!page.ok) githubRestFailure(page);
      mergedData = mergePaginatedData(mergedData, page.data, maxItemsRaw);
      if (serializedJsonBytes(mergedData) > Number(config.githubRestMaxResponseBytes || 2000000)) {
        throw new GitHubAddError(502, { status: "GITHUB_RESPONSE_TOO_LARGE", max_response_bytes: Number(config.githubRestMaxResponseBytes || 2000000), reason: "cumulative_pagination" });
      }
      pages += 1;
      result = page;
      next = nextPageRequest(page.link);
    }
  }

  return {
    status: "GITHUB_REST_PASS",
    method,
    path: pathname,
    auth: authMode,
    mutation_class: mutationClass,
    github_status: result.status,
    data: redactGitHubResponse(mergedData),
    request_id: result.request_id,
    rate_limit_remaining: result.rate_limit_remaining,
    pagination: paginate ? { enabled: true, pages, items: paginatedItemCount(mergedData), max_pages: maxPagesRaw, max_items: maxItemsRaw } : { enabled: false },
    evidence: authEvidence,
  };
}

async function githubGraphqlRaw({ query, variables, token, config }) {
  let response;
  try {
    response = await fetch(`${GITHUB_API_BASE}/graphql`, {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        "user-agent": "github-file-patch-api",
        "x-github-api-version": config.githubApiVersion || "2026-03-10",
      },
      body: JSON.stringify({ query, variables: variables || {} }),
      redirect: "manual",
    });
  } catch {
    throw new GitHubAddError(502, { status: "GITHUB_API_UNAVAILABLE", message: "GitHub GraphQL request failed at transport layer" });
  }
  const data = await boundedResponseBody(response, Number(config.githubRestMaxResponseBytes || 2000000));
  return {
    ok: response.ok,
    status: response.status,
    data,
    request_id: response.headers.get("x-github-request-id") || undefined,
    rate_limit_remaining: response.headers.get("x-ratelimit-remaining") || undefined,
  };
}

export async function githubGraphqlRequest(payload, config) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new GitHubAddError(400, { status: "BAD_REQUEST", message: "JSON object required" });
  const query = String(payload.query || "");
  if (!query.trim() || query.includes("\0") || Buffer.byteLength(query) > 100000) {
    throw new GitHubAddError(400, { status: "BAD_REQUEST", message: "query must be non-empty GraphQL text under 100KB" });
  }
  if (payload.variables != null && (!payload.variables || typeof payload.variables !== "object" || Array.isArray(payload.variables))) {
    throw new GitHubAddError(400, { status: "BAD_REQUEST", message: "variables must be an object" });
  }
  const authMode = String(payload.auth || "user").trim().toLowerCase();
  if (!new Set(["user", "installation"]).has(authMode)) {
    throw new GitHubAddError(400, { status: "BAD_REQUEST", message: "GraphQL auth must be user or installation" });
  }
  const isMutation = /(^|[\s{])mutation(?:\s|\()/i.test(query);
  if (isMutation && !config.githubGraphqlMutationsEnabled) {
    throw new GitHubAddError(403, { status: "GRAPHQL_MUTATIONS_DISABLED", mutation_class: "admin" });
  }
  if (isMutation && payload.confirm_mutation !== true) {
    throw new GitHubAddError(409, { status: "MUTATION_CONFIRMATION_REQUIRED", mutation_class: "admin", message: "confirm_mutation=true is required for GraphQL mutations" });
  }
  if (isMutation && payload.confirm_admin_mutation !== true) {
    throw new GitHubAddError(409, { status: "ADMIN_MUTATION_CONFIRMATION_REQUIRED", mutation_class: "admin", message: "confirm_admin_mutation=true is required for GraphQL mutations" });
  }
  const repositoryScope = payload.repository_full_name ? String(payload.repository_full_name).trim() : null;
  if (config.allowedRepos.length > 0 && !repositoryScope) {
    throw new GitHubAddError(403, { status: "REPOSITORY_SCOPE_REQUIRED", message: "repository_full_name is required for GraphQL when a repository allowlist is configured" });
  }
  if (repositoryScope) {
    parseRepository(repositoryScope);
    if (config.allowedRepos.length > 0 && !config.allowedRepos.some((item) => item.toLowerCase() === repositoryScope.toLowerCase())) {
      throw new GitHubAddError(403, { status: "NOT_ALLOWED", reason: "repository_not_allowed", repository_full_name: repositoryScope });
    }
  }
  if (config.allowedRepos.length > 0 && authMode === "user") {
    throw new GitHubAddError(403, { status: "GRAPHQL_USER_AUTH_SCOPE_UNSAFE", message: "Use installation auth for GraphQL when a repository allowlist is configured" });
  }

  let result;
  let evidence = {};
  if (authMode === "user") {
    const candidates = tokenCandidates(config);
    if (candidates.length === 0) throw new GitHubAddError(401, { status: "AUTH_FAILED", message: "GitHub user token is not configured" });
    for (const candidate of candidates) {
      const attempt = await githubGraphqlRaw({ query, variables: payload.variables, token: candidate.value, config });
      result = attempt;
      if (attempt.status !== 401 && attempt.status !== 403) {
        evidence = { token_env_name: candidate.name };
        break;
      }
    }
  } else {
    const credential = await resolveInstallationToken(payload, config);
    result = await githubGraphqlRaw({ query, variables: payload.variables, token: credential.token, config });
    evidence = { installation_id: credential.installation_id, token_expires_at: credential.expires_at, permissions: credential.permissions };
  }
  if (!result?.ok) githubRestFailure(result || { status: 502, data: null });
  return {
    status: "GITHUB_GRAPHQL_PASS",
    auth: authMode,
    mutation: isMutation,
    data: redactGitHubResponse(result.data),
    request_id: result.request_id,
    rate_limit_remaining: result.rate_limit_remaining,
    evidence,
  };
}

export async function diagnoseGitHubAppRepository(payload, config) {
  const repositoryFullName = String(payload?.repository_full_name || "").trim();
  const { owner, repo } = parseRepository(repositoryFullName);
  if (config.allowedRepos.length > 0 && !config.allowedRepos.some((item) => item.toLowerCase() === repositoryFullName.toLowerCase())) {
    throw new GitHubAddError(403, { status: "NOT_ALLOWED", reason: "repository_not_allowed" });
  }
  const jwt = appJwt(config);
  const app = await githubRestRaw({ method: "GET", path: "/app", token: jwt, config });
  if (!app.ok) githubRestFailure(app);
  const installation = await githubRestRaw({ method: "GET", path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`, token: jwt, config });
  if (!installation.ok) githubRestFailure(installation);
  const credential = await resolveInstallationToken({ repository_full_name: repositoryFullName, installation_id: installation.data?.id }, config);
  const repoCheck = await githubRestRaw({ method: "GET", path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, token: credential.token, config });
  if (!repoCheck.ok) githubRestFailure(repoCheck);
  return {
    status: "GITHUB_APP_DIAGNOSE_PASS",
    repository_full_name: repositoryFullName,
    app: { id: app.data?.id, slug: app.data?.slug, name: app.data?.name },
    installation: {
      id: installation.data?.id,
      account: installation.data?.account?.login,
      account_type: installation.data?.account?.type,
      repository_selection: installation.data?.repository_selection,
      permissions: installation.data?.permissions || {},
      suspended_at: installation.data?.suspended_at || null,
    },
    token_mint: { ok: true, expires_at: credential.expires_at, permissions: credential.permissions, repositories: credential.repositories },
    repository_access: { ok: true, private: Boolean(repoCheck.data?.private), permissions: repoCheck.data?.permissions || undefined },
  };
}


async function diagnosticRest(payload, config) {
  try {
    const result = await githubRestRequest(payload, config);
    return { ok: true, github_status: result.github_status, data: result.data };
  } catch (error) {
    return {
      ok: false,
      status: error?.payload?.status || "GITHUB_REST_FAILED",
      github_status: error?.payload?.github_status || error?.httpStatus || error?.status,
      message: error?.payload?.message || error?.message || "GitHub request failed",
    };
  }
}

export async function diagnoseGitHubRepositoryControlPlane(payload, config) {
  const repositoryFullName = String(payload?.repository_full_name || "").trim();
  const { owner, repo } = parseRepository(repositoryFullName);
  if (config.allowedRepos.length > 0 && !config.allowedRepos.some((item) => item.toLowerCase() === repositoryFullName.toLowerCase())) {
    throw new GitHubAddError(403, { status: "NOT_ALLOWED", reason: "repository_not_allowed" });
  }
  const auth = String(payload?.auth || "user").trim().toLowerCase();
  if (!new Set(["user", "installation"]).has(auth)) throw new GitHubAddError(400, { status: "BAD_REQUEST", message: "diagnostic auth must be user or installation" });
  const base = { auth, repository_full_name: repositoryFullName, installation_id: payload?.installation_id };
  const metadata = await diagnosticRest({ ...base, method: "GET", path: `/repos/${owner}/${repo}` }, config);
  const defaultBranch = String(payload?.branch || metadata.data?.default_branch || "").trim();
  if (!defaultBranch) throw new GitHubAddError(502, { status: "GITHUB_REPOSITORY_METADATA_INVALID", message: "default branch could not be resolved" });
  const ref = String(payload?.ref || defaultBranch).trim();
  const [rulesets, protection, actionsPermissions, workflows, checkRuns, combinedStatus] = await Promise.all([
    diagnosticRest({ ...base, method: "GET", path: `/repos/${owner}/${repo}/rulesets` }, config),
    diagnosticRest({ ...base, method: "GET", path: `/repos/${owner}/${repo}/branches/${encodeURIComponent(defaultBranch)}/protection` }, config),
    diagnosticRest({ ...base, method: "GET", path: `/repos/${owner}/${repo}/actions/permissions` }, config),
    diagnosticRest({ ...base, method: "GET", path: `/repos/${owner}/${repo}/actions/workflows`, query: { per_page: 10 } }, config),
    diagnosticRest({ ...base, method: "GET", path: `/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}/check-runs`, query: { per_page: 100 } }, config),
    diagnosticRest({ ...base, method: "GET", path: `/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}/status` }, config),
  ]);
  return {
    status: "GITHUB_REPOSITORY_DIAGNOSE_PASS",
    repository_full_name: repositoryFullName,
    auth,
    default_branch: defaultBranch,
    ref,
    metadata,
    rulesets,
    branch_protection: protection,
    actions_permissions: actionsPermissions,
    workflows,
    check_runs: checkRuns,
    combined_status: combinedStatus,
  };
}

export async function githubRefWriteProbe(payload, config) {
  const repositoryFullName = String(payload?.repository_full_name || "").trim();
  const { owner, repo } = parseRepository(repositoryFullName);
  const auth = String(payload?.auth || "installation").trim().toLowerCase();
  if (!new Set(["user", "installation"]).has(auth)) throw new GitHubAddError(400, { status: "BAD_REQUEST", message: "probe auth must be user or installation" });
  if (payload?.confirm_mutation !== true) throw new GitHubAddError(409, { status: "MUTATION_CONFIRMATION_REQUIRED", message: "confirm_mutation=true is required for the write probe" });
  const common = { auth, repository_full_name: repositoryFullName, installation_id: payload?.installation_id };
  const repoInfo = await githubRestRequest({ ...common, method: "GET", path: `/repos/${owner}/${repo}` }, config);
  const defaultBranch = String(repoInfo.data?.default_branch || "").trim();
  if (!defaultBranch) throw new GitHubAddError(502, { status: "GITHUB_REPOSITORY_METADATA_INVALID" });
  const head = await githubRestRequest({ ...common, method: "GET", path: `/repos/${owner}/${repo}/commits/${encodeURIComponent(defaultBranch)}` }, config);
  const baseSha = String(head.data?.sha || "").trim();
  if (!/^[0-9a-f]{40}$/i.test(baseSha)) throw new GitHubAddError(502, { status: "GITHUB_REPOSITORY_HEAD_INVALID" });
  const branch = `station/probe/${randomUUID().replaceAll("-", "").slice(0, 20)}`;
  let created = false;
  let cleanup = false;
  try {
    await githubRestRequest({
      ...common,
      method: "POST",
      path: `/repos/${owner}/${repo}/git/refs`,
      body: { ref: `refs/heads/${branch}`, sha: baseSha },
      confirm_mutation: true,
    }, config);
    created = true;
    const reread = await githubRestRequest({ ...common, method: "GET", path: `/repos/${owner}/${repo}/git/ref/heads/${branch}` }, config);
    if (String(reread.data?.object?.sha || "").toLowerCase() !== baseSha.toLowerCase()) {
      throw new GitHubAddError(502, { status: "GITHUB_REF_READBACK_MISMATCH" });
    }
  } finally {
    if (created) {
      try {
        const refPath = `/repos/${owner}/${repo}/git/refs/heads/${branch}`;
        await githubRestRequest({ ...common, method: "DELETE", path: refPath, confirm_mutation: true }, config);
        for (let attempt = 0; attempt < 5; attempt += 1) {
          try {
            await githubRestRequest({ ...common, method: "GET", path: refPath }, config);
            await new Promise((resolve) => setTimeout(resolve, 100));
          } catch (error) {
            if (error?.payload?.github_status === 404 || error?.httpStatus === 404 || error?.status === 404) {
              cleanup = true;
              break;
            }
            throw error;
          }
        }
      } catch {
        cleanup = false;
      }
    }
  }
  if (!cleanup) throw new GitHubAddError(502, { status: "GITHUB_PROBE_CLEANUP_FAILED", branch });
  return {
    status: "GITHUB_REF_WRITE_PROBE_PASS",
    repository_full_name: repositoryFullName,
    auth,
    default_branch: defaultBranch,
    base_sha: baseSha,
    temporary_branch: branch,
    created: true,
    readback_verified: true,
    cleanup_verified: true,
  };
}

async function resolveOperationalToken(payload, config) {
  const auth = String(payload?.auth || "user").trim().toLowerCase();
  if (auth === "installation") {
    const credential = await resolveInstallationToken(payload, config);
    return { auth, token: credential.token, evidence: { installation_id: credential.installation_id, token_expires_at: credential.expires_at, permissions: credential.permissions } };
  }
  if (auth !== "user") throw new GitHubAddError(400, { status: "BAD_REQUEST", message: "auth must be user or installation" });
  const candidates = tokenCandidates(config);
  if (candidates.length === 0) throw new GitHubAddError(401, { status: "AUTH_FAILED", message: "GitHub user token is not configured" });
  return { auth, token: candidates[0].value, evidence: { token_env_name: candidates[0].name } };
}

function isAllowedLogRedirectHost(hostname, config) {
  const host = String(hostname || "").toLowerCase().replace(/\.$/, "");
  const suffixes = Array.isArray(config.githubLogRedirectHostSuffixes) ? config.githubLogRedirectHostSuffixes : [];
  return suffixes.some((value) => {
    const suffix = String(value || "").toLowerCase().replace(/^\./, "").replace(/\.$/, "");
    return suffix && (host === suffix || host.endsWith(`.${suffix}`));
  });
}

export async function downloadGitHubJobLogs(payload, config) {
  const repositoryFullName = String(payload?.repository_full_name || "").trim();
  const { owner, repo } = parseRepository(repositoryFullName);
  if (config.allowedRepos.length > 0 && !config.allowedRepos.some((item) => item.toLowerCase() === repositoryFullName.toLowerCase())) {
    throw new GitHubAddError(403, { status: "NOT_ALLOWED", reason: "repository_not_allowed" });
  }
  const jobId = Number(payload?.job_id);
  if (!Number.isInteger(jobId) || jobId <= 0) throw new GitHubAddError(400, { status: "BAD_REQUEST", message: "job_id must be a positive integer" });
  const configuredMaxBytes = Number(config.githubRestMaxResponseBytes || 2000000);
  const requestedMaxBytes = Number(payload?.max_bytes ?? configuredMaxBytes);
  if (!Number.isInteger(requestedMaxBytes) || requestedMaxBytes < 1 || requestedMaxBytes > configuredMaxBytes) {
    throw new GitHubAddError(400, { status: "BAD_REQUEST", message: `max_bytes must be an integer from 1 to ${configuredMaxBytes}` });
  }
  const maxBytes = requestedMaxBytes;
  const credential = await resolveOperationalToken({ ...payload, repository_full_name: repositoryFullName }, config);
  const apiUrl = `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/jobs/${jobId}/logs`;
  let first;
  try {
    first = await fetch(apiUrl, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${credential.token}`,
        "user-agent": "github-file-patch-api",
        "x-github-api-version": config.githubApiVersion || "2026-03-10",
      },
      redirect: "manual",
    });
  } catch {
    throw new GitHubAddError(502, { status: "GITHUB_API_UNAVAILABLE", message: "GitHub job logs request failed at transport layer" });
  }
  if (first.status !== 302) {
    const data = await boundedResponseBody(first, maxBytes);
    if (!first.ok) githubRestFailure({ status: first.status, data, request_id: first.headers.get("x-github-request-id") || undefined });
    return { status: "GITHUB_JOB_LOGS_PASS", repository_full_name: repositoryFullName, job_id: jobId, log: typeof data === "string" ? data : JSON.stringify(data), redirect_followed: false, evidence: credential.evidence };
  }
  const location = first.headers.get("location");
  let target;
  try { target = new URL(String(location || "")); } catch { throw new GitHubAddError(502, { status: "GITHUB_LOG_REDIRECT_INVALID" }); }
  if (target.protocol !== "https:") throw new GitHubAddError(502, { status: "GITHUB_LOG_REDIRECT_INVALID", reason: "non_https_redirect" });
  if (!isAllowedLogRedirectHost(target.hostname, config)) {
    throw new GitHubAddError(502, { status: "GITHUB_LOG_REDIRECT_INVALID", reason: "unexpected_redirect_host" });
  }
  let redirected;
  try {
    redirected = await fetch(target, { redirect: "error", headers: { "user-agent": "github-file-patch-api" } });
  } catch {
    throw new GitHubAddError(502, { status: "GITHUB_LOG_DOWNLOAD_FAILED" });
  }
  const data = await boundedResponseBody(redirected, maxBytes);
  if (!redirected.ok) throw new GitHubAddError(redirected.status, { status: "GITHUB_LOG_DOWNLOAD_FAILED", github_status: redirected.status });
  return {
    status: "GITHUB_JOB_LOGS_PASS",
    repository_full_name: repositoryFullName,
    job_id: jobId,
    log: typeof data === "string" ? data : JSON.stringify(data),
    redirect_followed: true,
    bytes: Buffer.byteLength(typeof data === "string" ? data : JSON.stringify(data || "")),
    evidence: credential.evidence,
  };
}

