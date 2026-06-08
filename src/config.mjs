const csv = (value, fallback = "") =>
  String(value ?? fallback).split(",").map((item) => item.trim()).filter(Boolean);

function githubTokenCandidates(env) {
  return [
    { name: "GITHUB_TOKEN", value: env.GITHUB_TOKEN || "" },
    { name: "GITHUB_PAT", value: env.GITHUB_PAT || "" },
    { name: "GH_TOKEN", value: env.GH_TOKEN || "" },
  ]
    .map((candidate) => ({ ...candidate, value: String(candidate.value || "").trim() }))
    .filter((candidate) => candidate.value.length > 0);
}

export function loadConfig(env = process.env) {
  const tokenCandidates = githubTokenCandidates(env);
  return {
    port: Number(env.PORT || 8080),
    githubToken: tokenCandidates[0]?.value || "",
    githubTokenEnvName: tokenCandidates[0]?.name || "",
    githubTokenCandidates: tokenCandidates,
    actionBearerToken: env.ACTION_BEARER_TOKEN || "",
    actionRequireBearer: String(env.ACTION_REQUIRE_BEARER ?? "true").toLowerCase() !== "false",
    // Empty allowlists mean "do not restrict in github-add"; GitHub token permissions are the source of truth.
    allowedRepos: csv(env.GITHUB_ALLOWED_REPOS,),
    allowedBranches: csv(env.GITHUB_ALLOWED_BRANCHES),
    allowedPathPrefixes: csv(env.GITHUB_ALLOWED_PATH_PREFIXES),
    protectedPathPrefixes: csv(env.PATCH_PROTECTED_PATH_PREFIXES, ".git/,.github/,node_modules/"),
    maxFileBytes: Number(env.PATCH_MAX_FILE_BYTES || 200000),
    maxChangedLines: Number(env.PATCH_MAX_CHANGED_LINES || 300),
    requirePreview: String(env.PATCH_REQUIRE_PREVIEW ?? "true").toLowerCase() !== "false",
    blockProtectedPaths: String(env.PATCH_BLOCK_PROTECTED_PATHS ?? "false").toLowerCase() !== "false",
  };
}
