import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import test from "node:test";
import { downloadGitHubJobLogs, githubGraphqlRequest, githubRefWriteProbe, githubRestRequest } from "../src/github.mjs";
import { openApiDocument } from "../src/openapi.mjs";
import { createRequestHandler } from "../src/server.mjs";

const baseConfig = {
  actionBearerToken: "test-token",
  actionRequireBearer: false,
  allowedRepos: [],
  allowedBranches: [],
  allowedPathPrefixes: [],
  protectedPathPrefixes: [],
  blockProtectedPaths: true,
  maxFileBytes: 200000,
  maxChangedLines: 300,
  requirePreview: true,
  githubTokenCandidates: [],
  githubAppId: "",
  githubAppPrivateKey: "",
  githubApiVersion: "2026-03-10",
  githubRepositoryScopeMode: "token",
  githubRestMaxResponseBytes: 2000000,
  githubRestAdminMutationsEnabled: false,
  githubRestDestructiveMutationsEnabled: false,
  githubGraphqlMutationsEnabled: false,
  githubLogRedirectHostSuffixes: ["githubusercontent.com", "actions.githubusercontent.com", "blob.core.windows.net"],
};

async function withMockFetch(mockFetch, operation) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch;
  try {
    return await operation();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function collectRefs(value, out = []) {
  if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, out);
    return out;
  }
  if (!value || typeof value !== "object") return out;
  for (const [key, item] of Object.entries(value)) {
    if (key === "$ref" && typeof item === "string") out.push(item);
    else collectRefs(item, out);
  }
  return out;
}

function operationIds(document) {
  const ids = [];
  for (const pathItem of Object.values(document.paths || {})) {
    for (const method of ["get", "post", "put", "patch", "delete", "head"]) {
      if (pathItem?.[method]?.operationId) ids.push(pathItem[method].operationId);
    }
  }
  return ids;
}


test("OpenAPI exposes GitHub control-plane 0.5 Actions", () => {
  const doc = openApiDocument();
  assert.equal(doc.info.version, "0.5.0");
  assert.equal(doc.paths["/github/rest"].post.operationId, "githubRest");
  assert.equal(doc.paths["/github/graphql"].post.operationId, "githubGraphql");
  assert.equal(doc.paths["/github/app/diagnose"].post.operationId, "diagnoseGitHubAppRepository");
  assert.equal(doc.paths["/github/repository/diagnose"].post.operationId, "diagnoseGitHubRepository");
  assert.equal(doc.paths["/github/ref-write-probe"].post.operationId, "githubRefWriteProbe");
  assert.equal(doc.paths["/github/actions/job-logs"].post.operationId, "downloadGitHubJobLogs");
  assert.deepEqual(doc.components.schemas.GitHubRestRequest.properties.auth.enum, ["user", "app", "installation"]);
  assert.equal(doc.components.schemas.GitHubRestRequest.properties.max_pages.maximum, 10);
  assert.equal(doc.components.schemas.GitHubRestRequest.properties.max_items.maximum, 1000);
});

test("static GPT Action JSON parses and exposes the 0.5 control plane", async () => {
  const raw = await readFile(new URL("../gpts-action-openapi.json", import.meta.url), "utf8");
  const doc = JSON.parse(raw);
  assert.equal(doc.openapi, "3.1.0");
  assert.equal(doc.info.version, "0.5.0");
  assert.equal(doc.paths["/github/rest"].post.operationId, "githubRest");
  assert.equal(doc.paths["/github/graphql"].post.operationId, "githubGraphql");
  assert.equal(doc.paths["/github/repository/diagnose"].post.operationId, "diagnoseGitHubRepository");
  assert.equal(doc.paths["/github/ref-write-probe"].post.operationId, "githubRefWriteProbe");
  assert.equal(doc.paths["/github/actions/job-logs"].post.operationId, "downloadGitHubJobLogs");
  assert.equal(doc.components.schemas.GitHubRestRequest.properties.max_pages.maximum, 10);
  assert.ok(doc.components.schemas.GitHubGraphqlRequest);
  assert.ok(doc.components.schemas.GitHubRepositoryDiagnoseRequest);
  assert.ok(doc.components.schemas.GitHubRefWriteProbeRequest);
  assert.ok(doc.components.schemas.GitHubJobLogsRequest);
});

test("static Action JSON stays structurally aligned with dynamic OpenAPI", async () => {
  const raw = await readFile(new URL("../gpts-action-openapi.json", import.meta.url), "utf8");
  const staticDoc = JSON.parse(raw);
  const dynamicDoc = openApiDocument();
  const staticIds = operationIds(staticDoc);
  const dynamicIds = operationIds(dynamicDoc);
  assert.equal(new Set(staticIds).size, staticIds.length, "static operationId values must be unique");
  assert.equal(new Set(dynamicIds).size, dynamicIds.length, "dynamic operationId values must be unique");
  assert.deepEqual([...staticIds].sort(), [...dynamicIds].sort());

  for (const ref of collectRefs(staticDoc)) {
    const prefix = "#/components/schemas/";
    assert.ok(ref.startsWith(prefix), `unsupported static ref ${ref}`);
    assert.ok(staticDoc.components.schemas[ref.slice(prefix.length)], `missing static schema ${ref}`);
  }

  for (const name of ["GitHubRestRequest", "GitHubGraphqlRequest", "GitHubRepositoryDiagnoseRequest", "GitHubRefWriteProbeRequest", "GitHubJobLogsRequest", "GitHubAppDiagnoseRequest"]) {
    const a = staticDoc.components.schemas[name];
    const b = dynamicDoc.components.schemas[name];
    assert.ok(a && b, `missing control-plane schema ${name}`);
    assert.deepEqual(Object.keys(a.properties || {}).sort(), Object.keys(b.properties || {}).sort(), `${name} property drift`);
    assert.deepEqual([...(a.required || [])].sort(), [...(b.required || [])].sort(), `${name} required-field drift`);
  }

  for (const path of ["/github/rest", "/github/graphql", "/github/ref-write-probe", "/file/create", "/patch/apply", "/pull-request/ready", "/pull-request/merge"]) {
    assert.equal(staticDoc.paths[path].post["x-openai-isConsequential"], true, `${path} must be consequential in static JSON`);
    assert.equal(dynamicDoc.paths[path].post["x-openai-isConsequential"], true, `${path} must be consequential in dynamic OpenAPI`);
  }
});

test("generic mutation policy fails closed by class", async () => {
  await assert.rejects(
    githubRestRequest({ method: "POST", path: "/repos/n0namer/gpt-coding-station/issues" }, baseConfig),
    (error) => error?.payload?.status === "MUTATION_CONFIRMATION_REQUIRED" && error?.payload?.mutation_class === "write" && error?.httpStatus === 409,
  );
  await assert.rejects(
    githubRestRequest({ method: "PATCH", path: "/repos/n0namer/gpt-coding-station/rulesets/1", confirm_mutation: true }, baseConfig),
    (error) => error?.payload?.status === "ADMIN_MUTATION_DISABLED" && error?.payload?.mutation_class === "admin" && error?.httpStatus === 403,
  );
  await assert.rejects(
    githubRestRequest({ method: "DELETE", path: "/repos/n0namer/gpt-coding-station/git/refs/heads/not-a-probe", confirm_mutation: true }, baseConfig),
    (error) => error?.payload?.status === "DESTRUCTIVE_MUTATION_DISABLED" && error?.payload?.mutation_class === "destructive" && error?.httpStatus === 403,
  );
  await assert.rejects(
    githubRestRequest({ method: "PUT", path: "/orgs/example/actions/secrets/SECRET", confirm_mutation: true }, baseConfig),
    (error) => error?.payload?.status === "SECRET_BEARING_OPERATION_BLOCKED" && error?.payload?.mutation_class === "secret_bearing" && error?.httpStatus === 403,
  );
  await assert.rejects(
    githubRestRequest({ method: "PUT", path: "/repos/n0namer/gpt-coding-station/environments/prod/secrets/SECRET", confirm_mutation: true }, baseConfig),
    (error) => error?.payload?.status === "SECRET_BEARING_OPERATION_BLOCKED" && error?.payload?.mutation_class === "secret_bearing",
  );
  for (const request of [
    { method: "PATCH", path: "/repos/n0namer/gpt-coding-station", body: { archived: true } },
    { method: "POST", path: "/repos/n0namer/gpt-coding-station/releases", body: { tag_name: "v1" } },
    { method: "POST", path: "/repos/n0namer/gpt-coding-station/actions/workflows/ci.yml/dispatches", body: { ref: "main" } },
  ]) {
    await assert.rejects(
      githubRestRequest({ ...request, confirm_mutation: true }, baseConfig),
      (error) => error?.payload?.status === "ADMIN_MUTATION_DISABLED" && error?.payload?.mutation_class === "admin",
    );
  }
  for (const request of [
    { method: "POST", path: "/repos/n0namer/gpt-coding-station/transfer", body: { new_owner: "other" } },
    { method: "PATCH", path: "/repos/n0namer/gpt-coding-station/git/refs/heads/main", body: { sha: "a".repeat(40), force: true } },
  ]) {
    await assert.rejects(
      githubRestRequest({ ...request, confirm_mutation: true }, baseConfig),
      (error) => error?.payload?.status === "DESTRUCTIVE_MUTATION_DISABLED" && error?.payload?.mutation_class === "destructive",
    );
  }
});

test("GraphQL mutations are disabled by default and require two confirmations when enabled", async () => {
  await assert.rejects(
    githubGraphqlRequest({ query: "mutation { noop: __typename }" }, baseConfig),
    (error) => error?.payload?.status === "GRAPHQL_MUTATIONS_DISABLED" && error?.httpStatus === 403,
  );
  const enabled = { ...baseConfig, githubGraphqlMutationsEnabled: true };
  await assert.rejects(
    githubGraphqlRequest({ query: "mutation { noop: __typename }" }, enabled),
    (error) => error?.payload?.status === "MUTATION_CONFIRMATION_REQUIRED" && error?.httpStatus === 409,
  );
  await assert.rejects(
    githubGraphqlRequest({ query: "mutation { noop: __typename }", confirm_mutation: true }, enabled),
    (error) => error?.payload?.status === "ADMIN_MUTATION_CONFIRMATION_REQUIRED" && error?.httpStatus === 409,
  );
});

test("REST infers repository scope from /repos path and enforces allowlist", async () => {
  const config = { ...baseConfig, allowedRepos: ["n0namer/allowed"] };
  await assert.rejects(
    githubRestRequest({ method: "GET", path: "/repos/n0namer/forbidden" }, config),
    (error) => error?.payload?.status === "NOT_ALLOWED" && error?.payload?.repository_full_name === "n0namer/forbidden",
  );
  await assert.rejects(
    githubRestRequest({
      method: "GET",
      path: "/repos/n0namer/allowed",
      repository_full_name: "n0namer/other",
    }, config),
    (error) => error?.payload?.status === "REPOSITORY_SCOPE_MISMATCH",
  );
  await assert.rejects(
    githubGraphqlRequest({ query: "{ viewer { login } }" }, config),
    (error) => error?.payload?.status === "REPOSITORY_SCOPE_REQUIRED" && error?.httpStatus === 403,
  );
  await assert.rejects(
    githubGraphqlRequest({ query: "{ viewer { login } }", repository_full_name: "n0namer/allowed", auth: "user" }, config),
    (error) => error?.payload?.status === "GRAPHQL_USER_AUTH_SCOPE_UNSAFE" && error?.httpStatus === 403,
  );
});

test("repository scope defaults fail closed for generic REST and GraphQL", async () => {
  const locked = { ...baseConfig, githubRepositoryScopeMode: "allowlist", allowedRepos: [] };
  await assert.rejects(
    githubRestRequest({ method: "GET", path: "/repos/n0namer/allowed" }, locked),
    (error) => error?.payload?.status === "REPOSITORY_SCOPE_NOT_CONFIGURED" && error?.httpStatus === 403,
  );
  await assert.rejects(
    githubRestRequest({ method: "GET", path: "/user" }, locked),
    (error) => error?.payload?.status === "REPOSITORY_SCOPE_REQUIRED" && error?.httpStatus === 403,
  );
  await assert.rejects(
    githubGraphqlRequest({ query: "{ viewer { login } }" }, locked),
    (error) => error?.payload?.status === "REPOSITORY_SCOPE_NOT_CONFIGURED" && error?.httpStatus === 403,
  );

  const allowlisted = { ...locked, allowedRepos: ["n0namer/allowed"] };
  await assert.rejects(
    githubRestRequest({ method: "GET", path: "/search/code", repository_full_name: "n0namer/allowed", auth: "user", query: { q: "repo:n0namer/allowed test" } }, allowlisted),
    (error) => error?.payload?.status === "NON_REPOSITORY_ROUTE_SCOPE_UNSAFE" && error?.httpStatus === 403,
  );
});

test("REST policy rejects normalization tricks and decodes paths before scope and risk checks", async () => {
  const config = { ...baseConfig, allowedRepos: ["n0namer/allowed"] };
  for (const path of [
    "/repos/n0namer/allowed/../../user",
    "/repos/n0namer/allowed/%2e%2e/%2e%2e/user",
    "/repos/n0namer/allowed\\..\\..\\user",
    "/repos/n0namer/allowed?x=1",
    "/repos/n0namer%2Fother/allowed",
  ]) {
    await assert.rejects(
      githubRestRequest({ method: "GET", path }, config),
      (error) => error?.payload?.status === "BAD_REQUEST" && error?.httpStatus === 400,
    );
  }
  await assert.rejects(
    githubRestRequest({ method: "GET", path: "/re%70os/n0namer/forbidden" }, config),
    (error) => error?.payload?.status === "NOT_ALLOWED" && error?.payload?.repository_full_name === "n0namer/forbidden",
  );
  await assert.rejects(
    githubRestRequest({ method: "PATCH", path: "/re%70os/n0namer/allowed/r%75lesets/1", confirm_mutation: true }, config),
    (error) => error?.payload?.status === "ADMIN_MUTATION_DISABLED" && error?.payload?.mutation_class === "admin",
  );
});

test("all control-plane routes dispatch through injected backends", async () => {
  const handler = createRequestHandler({
    config: baseConfig,
    githubRest: async (payload) => ({ status: "GITHUB_REST_PASS", method: payload.method, path: payload.path }),
    githubGraphql: async (payload) => ({ status: "GITHUB_GRAPHQL_PASS", query: payload.query }),
    diagnoseGitHubApp: async (payload) => ({ status: "GITHUB_APP_DIAGNOSE_PASS", repository_full_name: payload.repository_full_name }),
    diagnoseRepository: async (payload) => ({ status: "GITHUB_REPOSITORY_DIAGNOSE_PASS", repository_full_name: payload.repository_full_name }),
    refWriteProbe: async (payload) => ({ status: "GITHUB_REF_WRITE_PROBE_PASS", repository_full_name: payload.repository_full_name }),
    downloadJobLogs: async (payload) => ({ status: "GITHUB_JOB_LOGS_PASS", job_id: payload.job_id }),
  });
  const server = createServer(handler);
  server.listen(0);
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (path, body) => {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  try {
    assert.equal((await post("/github/rest", { method: "GET", path: "/rate_limit" })).status, "GITHUB_REST_PASS");
    assert.equal((await post("/github/graphql", { query: "{ viewer { login } }" })).status, "GITHUB_GRAPHQL_PASS");
    assert.equal((await post("/github/app/diagnose", { repository_full_name: "n0namer/gpt-coding-station" })).status, "GITHUB_APP_DIAGNOSE_PASS");
    assert.equal((await post("/github/repository/diagnose", { repository_full_name: "n0namer/gpt-coding-station" })).status, "GITHUB_REPOSITORY_DIAGNOSE_PASS");
    assert.equal((await post("/github/ref-write-probe", { repository_full_name: "n0namer/gpt-coding-station", confirm_mutation: true })).status, "GITHUB_REF_WRITE_PROBE_PASS");
    assert.equal((await post("/github/actions/job-logs", { repository_full_name: "n0namer/gpt-coding-station", job_id: 1 })).status, "GITHUB_JOB_LOGS_PASS");
  } finally {
    server.close();
  }
});
