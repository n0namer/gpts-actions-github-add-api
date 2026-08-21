import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
}).trim();

if (!/^[0-9a-f]{40}$/.test(sourceCommit)) {
  throw new Error("Unable to derive a valid source commit from git rev-parse HEAD");
}

writeFileSync(".source-commit.env", `SOURCE_COMMIT=${sourceCommit}\n`, {
  encoding: "utf8",
  mode: 0o600,
});

console.log(`source commit stamped: ${sourceCommit}`);
