import { Buffer } from "node:buffer";
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

function normalizeRestMethod(value) {
  const method = String(value || "GET").toUpperCase();
  if (!["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    throw new GitHubAddError(400, { status: "BAD_REQUEST", message: "unsupported GitHub REST method" });
  }
  return method;
}

function normalizeGitHubPath(value) {
  const path = String(value || "");
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("://") || path.includes("\\")) {
    throw new GitHubAddError(400, { status: "BAD_REQUEST", message: "path must be an absolute canonical GitHub API path" });
  }
  if (path.includes("#")) throw new GitHubAddError(400, { status: "BAD_REQUEST", message: "path must not contain a fragment" });
  return path;
}

function requiresAdminConfirmation(path) {
  return /(?:\/collaborators(?:\/|$)|\/branches\/[^/]+\/protection(?:\/|$)|\/actions\/permissions(?:\/|$)|\/hooks(?:\/|$)|\/rulesets(?:\/|$)|\/environments(?:\/|$))/i.test(path);
}

function requiresDestructiveConfirmation(method, path) {
  return method === "DELETE" || /(?:\/transfer$|\/archive$)/i.test(path);
}

function assertGenericMutationAllowed(payload, method, path) {
  if (["GET", "HEAD"].includes(method)) return;
  if (payload.confirm_mutation !== true) {
    throw new GitHubAddError(403, { status: "CONFIRMATION_REQUIRED", reason: "confirm_mutation_required" });
  }
  if (requiresAdminConfirmation(path) && payload.confirm_admin_mutation !== true) {
    throw new GitHubAddError(403, { status: "CONFIRMATION_REQUIRED", reason: "confirm_admin_mutation_required" });
  }
  if (requiresDestructiveConfirmation(method, path) && payload.confirm_destructive_mutation !== true) {
    throw new GitHubAddError(403, { status: "CONFIRMATION_REQUIRED", reason: "confirm_destructive_mutation_required" });
  }
}

function safeResponseHeaders(headers = {}) {
  const names = ["x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset", "x-github-api-version-selected", "x-accepted-github-permissions", "location", "link", "etag"];
  return Object.fromEntries(names.filter((name) => headers[name] !== undefined).map((name) => [name, headers[name]]));
}

export async function requestGitHubRest(payload, config) {
  const method = normalizeRestMethod(payload?.method);
  const path = normalizeGitHubPath(payload?.path);
  assertGenericMutationAllowed(payload || {}, method, path);
  const query = payload?.query && typeof payload.query === "object" ? payload.query : {};
  const body = payload?.body;

  return withGitHubAuth(config, async (octokit) => {
    const response = await octokit.request({
      method,
      url: path,
      ...query,
      ...(body !== undefined ? { data: body } : {}),
    });
    return {
      status: "GITHUB_REST_PASS",
      github_status: response.status,
      method,
      path,
      headers: safeResponseHeaders(response.headers),
      data: response.data,
    };
  });
}

function graphqlOperationType(query) {
  const cleaned = String(query || "").replace(/^\s*(?:#[^\n]*\n\s*)*/, "");
  return /^mutation\b/i.test(cleaned) ? "mutation" : "query";
}

export async function requestGitHubGraphql(payload, config) {
  const query = String(payload?.query || "");
  if (!query.trim()) throw new GitHubAddError(400, { status: "BAD_REQUEST", message: "query is required" });
  if (query.length > 100000) throw new GitHubAddError(400, { status: "BAD_REQUEST", message: "GraphQL query is too large" });
  const operationType = graphqlOperationType(query);
  if (operationType === "mutation" && payload.confirm_mutation !== true) {
    throw new GitHubAddError(403, { status: "CONFIRMATION_REQUIRED", reason: "confirm_mutation_required" });
  }
  if (operationType === "mutation" && payload.confirm_admin_mutation !== true) {
    throw new GitHubAddError(403, { status: "CONFIRMATION_REQUIRED", reason: "confirm_admin_mutation_required" });
  }
  const variables = payload?.variables && typeof payload.variables === "object" ? payload.variables : {};
  return withGitHubAuth(config, async (octokit) => ({
    status: "GITHUB_GRAPHQL_PASS",
    operation_type: operationType,
    data: await octokit.graphql(query, variables),
  }));
}

export async function getGitHubRateLimit(payload, config) {
  return withGitHubAuth(config, async (octokit) => {
    const response = await octokit.rateLimit.get();
    return { status: "GITHUB_RATE_LIMIT_PASS", resources: response.data.resources, rate: response.data.rate };
  });
}

export async function getGitHubCapabilities(payload, config) {
  return withGitHubAuth(config, async (octokit, candidate) => {
    const user = await octokit.users.getAuthenticated();
    const rate = await octokit.rateLimit.get();
    const result = {
      status: "GITHUB_CAPABILITIES_PASS",
      login: user.data.login,
      token_env_name: candidate.name,
      graphql: true,
      generic_rest: true,
      rate: rate.data.rate,
    };
    if (payload?.repository_full_name) {
      const { owner, repo } = parseRepository(payload.repository_full_name);
      const repository = await octokit.repos.get({ owner, repo });
      result.repository_full_name = `${owner}/${repo}`;
      result.repository_permissions = repository.data.permissions || undefined;
      result.default_branch = repository.data.default_branch;
      result.private = repository.data.private;
    }
    return result;
  });
}

export async function requestGitHubRestPaginated(payload, config) {
  const method = normalizeRestMethod(payload?.method || "GET");
  if (method !== "GET") throw new GitHubAddError(400, { status: "BAD_REQUEST", message: "paginated REST supports GET only" });
  const path = normalizeGitHubPath(payload?.path);
  const query = payload?.query && typeof payload.query === "object" ? payload.query : {};
  const maxPages = Math.max(1, Math.min(Number(payload?.max_pages || 5), 10));
  const maxItems = Math.max(1, Math.min(Number(payload?.max_items || 500), 1000));
  return withGitHubAuth(config, async (octokit) => {
    const items = [];
    let page = Number(query.page || 1);
    let pagesFetched = 0;
    while (pagesFetched < maxPages && items.length < maxItems) {
      const perPage = Math.min(Number(query.per_page || 100), 100);
      const response = await octokit.request({ method: "GET", url: path, ...query, page, per_page: perPage });
      const data = response.data;
      const batch = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
      items.push(...batch.slice(0, maxItems - items.length));
      pagesFetched += 1;
      if (batch.length === 0 || batch.length < perPage) break;
      page += 1;
    }
    return { status: "GITHUB_REST_PAGINATED_PASS", path, pages_fetched: pagesFetched, item_count: items.length, items };
  });
}

export async function batchGitHubRead(payload, config) {
  const requests = Array.isArray(payload?.requests) ? payload.requests : [];
  if (requests.length === 0 || requests.length > 20) throw new GitHubAddError(400, { status: "BAD_REQUEST", message: "requests must contain 1 to 20 items" });
  return withGitHubAuth(config, async (octokit) => {
    const results = [];
    for (const request of requests) {
      const path = normalizeGitHubPath(request?.path);
      try {
        const response = await octokit.request({ method: "GET", url: path, ...(request?.query || {}) });
        results.push({ ok: true, path, github_status: response.status, data: response.data });
      } catch (error) {
        results.push({ ok: false, path, github_status: error?.status, message: error?.response?.data?.message || error?.message });
      }
    }
    return { status: "GITHUB_BATCH_READ_PASS", result_count: results.length, results };
  });
}

export async function diagnoseGitHubAuth(payload, config) {
  try {
    const capabilities = await getGitHubCapabilities(payload, config);
    return { ...capabilities, status: "GITHUB_AUTH_DIAGNOSE_PASS" };
  } catch (error) {
    return {
      status: "GITHUB_AUTH_DIAGNOSE_FAIL",
      github_status: error?.status,
      message: error?.response?.data?.message || error?.message,
      accepted_permissions: error?.response?.headers?.["x-accepted-github-permissions"],
    };
  }
}

export async function getPullRequestDossier(payload, config) {
  const { owner, repo } = parseRepository(payload.repository_full_name);
  const pullNumber = normalizePullNumber(payload.pull_number);
  return withGitHubAuth(config, async (octokit) => {
    const [pr, files, reviews] = await Promise.all([
      octokit.pulls.get({ owner, repo, pull_number: pullNumber }),
      octokit.pulls.listFiles({ owner, repo, pull_number: pullNumber, per_page: 100 }),
      octokit.pulls.listReviews({ owner, repo, pull_number: pullNumber, per_page: 100 }),
    ]);
    const headSha = pr.data.head?.sha;
    const [checkResponse, statusResponse] = headSha ? await Promise.all([
      octokit.checks.listForRef({ owner, repo, ref: headSha, per_page: 100 }),
      octokit.repos.getCombinedStatusForRef({ owner, repo, ref: headSha }),
    ]) : [null, null];
    return {
      status: "GITHUB_PR_DOSSIER_PASS",
      pull_request: pullRequestSnapshot(pr.data),
      changed_files: files.data,
      reviews: reviews.data,
      checks: checkResponse?.data,
      combined_status: statusResponse?.data,
    };
  });
}

export async function getGitHubChecks(payload, config) {
  const { owner, repo } = parseRepository(payload.repository_full_name);
  const ref = String(payload.ref || "");
  if (!ref) throw new GitHubAddError(400, { status: "BAD_REQUEST", message: "ref is required" });
  return withGitHubAuth(config, async (octokit) => {
    const [checks, status] = await Promise.all([
      octokit.checks.listForRef({ owner, repo, ref, per_page: 100 }),
      octokit.repos.getCombinedStatusForRef({ owner, repo, ref }),
    ]);
    return { status: "GITHUB_CHECKS_PASS", ref, checks: checks.data, combined_status: status.data };
  });
}
