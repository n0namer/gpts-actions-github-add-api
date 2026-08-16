import assert from "node:assert/strict";
import test from "node:test";
import { GitHubAddError } from "../src/errors.mjs";
import { createDiffPreview } from "../src/patch.mjs";
import { createFileOnGitHub, updateFileOnGitHub } from "../src/github.mjs";
import { validateContentForPath, validatorForPath } from "../src/validation.mjs";

test("validatorForPath selects JSON only for .json files", () => {
  assert.equal(validatorForPath("config.json"), "json");
  assert.equal(validatorForPath("CONFIG.JSON"), "json");
  assert.equal(validatorForPath("config.yaml"), null);
});

test("validateContentForPath accepts valid JSON", () => {
  const result = validateContentForPath("config.json", '{"ok":true}');
  assert.deepEqual(result, { validator: "json", applicable: true, valid: true });
});

test("validateContentForPath rejects invalid JSON with 422", () => {
  assert.throws(
    () => validateContentForPath("config.json", '{"ok":'),
    (error) =>
      error instanceof GitHubAddError &&
      error.httpStatus === 422 &&
      error.payload.status === "CONTENT_VALIDATION_FAILED" &&
      error.payload.reason === "invalid_json",
  );
});

test("validateContentForPath leaves non-JSON files unchanged", () => {
  const result = validateContentForPath("notes.md", "not json");
  assert.deepEqual(result, { validator: "none", applicable: false, valid: true });
});

test("createDiffPreview rejects an invalid JSON candidate", async () => {
  await assert.rejects(
    createDiffPreview("config.json", '{"ok":true}', '{"ok":'),
    (error) =>
      error instanceof GitHubAddError &&
      error.httpStatus === 422 &&
      error.payload.reason === "invalid_json",
  );
});

test("GitHub write helpers reject invalid JSON before authentication/write", async () => {
  const payload = {
    repository_full_name: "n0namer/gpts-actions-github-add-api",
    branch: "main",
    path: "config.json",
  };

  await assert.rejects(
    updateFileOnGitHub(payload, '{"broken":', "sha", "test", {}),
    (error) => error instanceof GitHubAddError && error.payload.reason === "invalid_json",
  );

  await assert.rejects(
    createFileOnGitHub(payload, '{"broken":', "test", {}),
    (error) => error instanceof GitHubAddError && error.payload.reason === "invalid_json",
  );
});
