import { GitHubAddError } from "./errors.mjs";

export function validatorForPath(path) {
  const normalized = String(path || "").toLowerCase();
  if (normalized.endsWith(".json")) return "json";
  return null;
}

export function validateContentForPath(path, content) {
  const validator = validatorForPath(path);
  if (!validator) {
    return { validator: "none", applicable: false, valid: true };
  }

  if (validator === "json") {
    try {
      JSON.parse(content);
    } catch {
      throw new GitHubAddError(422, {
        status: "CONTENT_VALIDATION_FAILED",
        reason: "invalid_json",
        validator: "json",
        path,
        message: "JSON content is invalid",
      });
    }
    return { validator: "json", applicable: true, valid: true };
  }

  return { validator: "none", applicable: false, valid: true };
}
