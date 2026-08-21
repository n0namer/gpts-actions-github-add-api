import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import test from "node:test";
import { githubGraphqlRequest, githubRestRequest } from "../src/github.mjs";
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
  githubRestMaxResponseBytes: 2000000,
};

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

test("REST and GraphQL mutations fail closed without explicit confirmation", async () => {
  await assert.rejects(
    githubRestRequest({ method: "POST", path: "/repos/n0namer/gpt-coding-station/issues" }, baseConfig),
    (error) => error?.payload?.status === "MUTATION_CONFIRMATION_REQUIRED" && error?.httpStatus === 409,
  );
  await assert.rejects(
    githubGraphqlRequest({ query: "mutation { noop: __typename }" }, baseConfig),
    (error) => error?.payload?.status === "MUTATION_CONFIRMATION_REQUIRED" && error?.httpStatus === 409,
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
