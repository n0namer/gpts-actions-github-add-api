import { once } from "node:events";
import { startServer } from "../src/server.mjs";

const repo = process.env.SMOKE_REPOSITORY || "n0namer/gpts-actions-github-add-api";
const branch = process.env.SMOKE_BRANCH || "archops/json-validation-unify-server";
const path = process.env.SMOKE_PATH || "package.json";
const port = Number(process.env.PORT || 8080);
const base = `http://127.0.0.1:${port}`;
const token = process.env.ACTION_BEARER_TOKEN;

if (!token) {
  console.error(JSON.stringify({ status: "SMOKE_FAIL", reason: "missing_action_bearer_token" }));
  process.exit(1);
}

const headers = {
  "content-type": "application/json",
  authorization: `Bearer ${token}`,
};

async function post(route, body, expectedStatus = 200) {
  const response = await fetch(base + route, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json = {};
  try { json = JSON.parse(text); } catch {}
  if (response.status !== expectedStatus) {
    throw new Error(`${route} expected ${expectedStatus} got ${response.status}: ${text}`);
  }
  return json;
}

const server = startServer();
if (!server.listening) await once(server, "listening");

try {
  const read1 = await post("/file/read", { repository_full_name: repo, branch, path });
  const parsed1 = JSON.parse(read1.content);
  const originalDescription = parsed1.description;
  const oldLine = read1.content.split("\n").find((line) => line.includes('"description"'));
  if (!oldLine) throw new Error("description line not found");

  const testDescription = `${originalDescription} [runtime-smoke]`;
  const newLine = oldLine.replace(JSON.stringify(originalDescription), JSON.stringify(testDescription));
  const operation = { type: "replace_exact_once", old_text: oldLine, new_text: newLine };

  const preview1 = await post("/patch/preview", {
    repository_full_name: repo,
    branch,
    path,
    expected_sha: read1.file_sha,
    operation,
    options: { max_changed_lines: 4 },
  });
  if (preview1.status !== "DRY_RUN_PASS" || preview1.can_apply !== true || !preview1.patch_id) {
    throw new Error("unexpected preview result");
  }

  const apply1 = await post("/patch/apply", {
    repository_full_name: repo,
    branch,
    path,
    expected_sha: read1.file_sha,
    operation,
    options: { max_changed_lines: 4 },
    commit_message: "test: runtime smoke patch",
    preview_patch_id: preview1.patch_id,
  });
  if (apply1.status !== "APPLY_PASS" || !apply1.reread_verified) {
    throw new Error("patch apply not verified");
  }

  const read2 = await post("/file/read", { repository_full_name: repo, branch, path });
  if (JSON.parse(read2.content).description !== testDescription) {
    throw new Error("patch readback mismatch");
  }

  const versionLine = read2.content.split("\n").find((line) => line.includes('"version"'));
  if (!versionLine) throw new Error("version line not found");
  const badOperation = {
    type: "replace_exact_once",
    old_text: versionLine,
    new_text: `${versionLine},`,
  };
  const badResponse = await fetch(base + "/patch/preview", {
    method: "POST",
    headers,
    body: JSON.stringify({
      repository_full_name: repo,
      branch,
      path,
      expected_sha: read2.file_sha,
      operation: badOperation,
      options: { max_changed_lines: 4 },
    }),
  });
  const badText = await badResponse.text();
  let badJson = {};
  try { badJson = JSON.parse(badText); } catch {}
  if (badResponse.status !== 422 || badJson.reason !== "invalid_json") {
    throw new Error(`JSON guard failed: ${badResponse.status} ${badText}`);
  }

  const revertLine = read2.content.split("\n").find((line) => line.includes('"description"'));
  const restoreLine = revertLine.replace(JSON.stringify(testDescription), JSON.stringify(originalDescription));
  const revertOperation = { type: "replace_exact_once", old_text: revertLine, new_text: restoreLine };

  const revertPreview = await post("/patch/preview", {
    repository_full_name: repo,
    branch,
    path,
    expected_sha: read2.file_sha,
    operation: revertOperation,
    options: { max_changed_lines: 4 },
  });

  const revertApply = await post("/patch/apply", {
    repository_full_name: repo,
    branch,
    path,
    expected_sha: read2.file_sha,
    operation: revertOperation,
    options: { max_changed_lines: 4 },
    commit_message: "test: revert runtime smoke patch",
    preview_patch_id: revertPreview.patch_id,
  });
  if (revertApply.status !== "APPLY_PASS" || !revertApply.reread_verified) {
    throw new Error("revert apply not verified");
  }

  const read3 = await post("/file/read", { repository_full_name: repo, branch, path });
  if (JSON.parse(read3.content).description !== originalDescription) {
    throw new Error("revert readback mismatch");
  }

  console.log(JSON.stringify({
    status: "SMOKE_PASS",
    repository: repo,
    branch,
    path,
    patch_apply_reread: true,
    invalid_json_blocked: true,
    revert_reread: true,
  }));
} catch (error) {
  console.error(JSON.stringify({ status: "SMOKE_FAIL", message: error.message }));
  server.close(() => process.exit(1));
}
