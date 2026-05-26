import { Buffer } from "node:buffer";
import { GitHubAddError } from "./errors.mjs";

function parseRepository(fullName) {
  const [owner, repo, extra] = String(fullName || "").split("/");
  if (!owner || !repo || extra) throw new GitHubAddError(400, { status: "BAD_REQUEST", message: "repository_full_name must be owner/repo" });
  return { owner, repo };
}

async function getOctokit(config) {
  if (!config.githubToken) throw new GitHubAddError(401, { status: "AUTH_FAILED", message: "GitHub token is not configured" });
  const { Octokit } = await import("@octokit/rest");
  return new Octokit({ auth: config.githubToken });
}

export async function readFileFromGitHub(payload, config) {
  const { owner, repo } = parseRepository(payload.repository_full_name);
  try {
    const response = await (await getOctokit(config)).repos.getContent({ owner, repo, path: payload.path, ref: payload.branch });
    const data = response.data;
    if (Array.isArray(data) || data.type !== "file" || typeof data.content !== "string") throw new Error("not-file");
    return {
      content: Buffer.from(data.content, data.encoding === "base64" ? "base64" : "utf8").toString("utf8"),
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

export async function updateFileOnGitHub(payload, newContent, sha, message, config) {
  const { owner, repo } = parseRepository(payload.repository_full_name);
  const response = await (await getOctokit(config)).repos.createOrUpdateFileContents({
    owner,
    repo,
    path: payload.path,
    branch: payload.branch,
    message,
    sha,
    content: Buffer.from(newContent, "utf8").toString("base64"),
  });
  return {
    commit_sha: response.data.commit?.sha,
    file_sha_after: response.data.content?.sha,
  };
}
