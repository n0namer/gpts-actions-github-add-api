import { randomUUID } from "node:crypto";
export class GitHubAddError extends Error {
  constructor(httpStatus, payload) {
    super(payload?.message || payload?.reason || payload?.status || "GitHub ADD error");
    this.httpStatus = httpStatus;
    this.payload = payload;
  }
}

export function normalizeError(error) {
  if (error instanceof GitHubAddError) return error;
  const request_id = randomUUID();
  console.error(JSON.stringify({ level: "error", service: "github-add", request_id, message: error?.message || "internal error" }));
  return new GitHubAddError(500, { status: "GITHUB_ADD_ERROR", message: "internal error", request_id });
}
