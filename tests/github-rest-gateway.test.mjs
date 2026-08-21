import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { githubRestRequest } from "../src/github.mjs";
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

test("OpenAPI exposes full GitHub REST and App diagnose Actions", () => {
  const doc = openApiDocument();
  assert.equal(doc.info.version, "0.4.0");
  assert.equal(doc.paths["/github/rest"].post.operationId, "githubRest");
  assert.equal(doc.paths["/github/app/diagnose"].post.operationId, "diagnoseGitHubAppRepository");
  assert.deepEqual(doc.components.schemas.GitHubRestRequest.properties.auth.enum, ["user", "app", "installation"]);
});

test("GitHub REST mutations fail closed without explicit confirmation", async () => {
  await assert.rejects(
    githubRestRequest({ method: "POST", path: "/repos/n0namer/gpt-coding-station/issues" }, baseConfig),
    (error) => error?.payload?.status === "MUTATION_CONFIRMATION_REQUIRED" && error?.httpStatus === 409,
  );
});

test("GitHub REST and App diagnose routes dispatch through injected backends", async () => {
  const handler = createRequestHandler({
    config: baseConfig,
    githubRest: async (payload) => ({ status: "GITHUB_REST_PASS", method: payload.method, path: payload.path }),
    diagnoseGitHubApp: async (payload) => ({ status: "GITHUB_APP_DIAGNOSE_PASS", repository_full_name: payload.repository_full_name }),
  });
  const server = createServer(handler);
  server.listen(0);
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const rest = await fetch(`${base}/github/rest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method: "GET", path: "/rate_limit" }),
    });
    assert.equal(rest.status, 200);
    assert.deepEqual(await rest.json(), { status: "GITHUB_REST_PASS", method: "GET", path: "/rate_limit" });

    const diag = await fetch(`${base}/github/app/diagnose`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repository_full_name: "n0namer/gpt-coding-station" }),
    });
    assert.equal(diag.status, 200);
    assert.deepEqual(await diag.json(), {
      status: "GITHUB_APP_DIAGNOSE_PASS",
      repository_full_name: "n0namer/gpt-coding-station",
    });
  } finally {
    server.close();
  }
});
