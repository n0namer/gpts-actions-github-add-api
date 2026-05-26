import { createHash } from "node:crypto";
import { GitHubAddError } from "./errors.mjs";

export const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function countOccurrences(input, marker) {
  let count = 0;
  let index = 0;
  while (true) {
    const found = input.indexOf(marker, index);
    if (found === -1) return count;
    count += 1;
    index = found + marker.length;
  }
}

const innerText = (text) => `${text.startsWith("\n") ? "" : "\n"}${text}${text.endsWith("\n") ? "" : "\n"}`;

export function replaceBetweenMarkers(input, startMarker, endMarker, newText) {
  const startCount = countOccurrences(input, startMarker);
  const endCount = countOccurrences(input, endMarker);
  if (startCount === 0) throw new GitHubAddError(422, { status: "PATCH_NOT_APPLICABLE", reason: "missing_start_marker", marker: startMarker });
  if (startCount > 1) throw new GitHubAddError(422, { status: "PATCH_NOT_APPLICABLE", reason: "duplicate_start_marker", marker: startMarker });
  if (endCount === 0) throw new GitHubAddError(422, { status: "PATCH_NOT_APPLICABLE", reason: "missing_end_marker", marker: endMarker });
  if (endCount > 1) throw new GitHubAddError(422, { status: "PATCH_NOT_APPLICABLE", reason: "duplicate_end_marker", marker: endMarker });

  const start = input.indexOf(startMarker);
  const end = input.indexOf(endMarker);
  if (start > end) throw new GitHubAddError(422, { status: "PATCH_NOT_APPLICABLE", reason: "start_marker_after_end_marker" });

  return {
    content: input.slice(0, start + startMarker.length) + innerText(newText) + input.slice(end),
    markers_found: { start: startCount, end: endCount },
  };
}

export function insertAfterMarker(input, marker, text) {
  const markerCount = countOccurrences(input, marker);
  if (markerCount === 0) throw new GitHubAddError(422, { status: "PATCH_NOT_APPLICABLE", reason: "missing_marker", marker });
  if (markerCount > 1) throw new GitHubAddError(422, { status: "PATCH_NOT_APPLICABLE", reason: "duplicate_marker", marker });

  const index = input.indexOf(marker) + marker.length;
  let tail = input.slice(index);
  if (tail.startsWith("\n")) tail = tail.slice(1);

  return {
    content: input.slice(0, index) + innerText(text) + tail,
    markers_found: { marker: markerCount },
  };
}

export function applyOperation(input, operation) {
  if (operation.type === "replace_between_markers") {
    return replaceBetweenMarkers(input, operation.start_marker, operation.end_marker, operation.new_text);
  }
  if (operation.type === "insert_after_marker") {
    return insertAfterMarker(input, operation.marker, operation.text);
  }
  throw new GitHubAddError(400, { status: "BAD_REQUEST", message: "unsupported operation.type" });
}

function fallbackDiff(path, oldText, newText) {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const lines = [`--- ${path}`, `+++ ${path}`, "@@ preview @@"];
  for (let i = 0; i < Math.max(oldLines.length, newLines.length); i += 1) {
    if (oldLines[i] === newLines[i]) {
      if (oldLines[i] !== undefined) lines.push(` ${oldLines[i]}`);
    } else {
      if (oldLines[i] !== undefined) lines.push(`-${oldLines[i]}`);
      if (newLines[i] !== undefined) lines.push(`+${newLines[i]}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export async function createDiffPreview(path, oldText, newText) {
  try {
    const diffModule = await import("diff");
    if (diffModule.createTwoFilesPatch) return diffModule.createTwoFilesPatch(path, path, oldText, newText, "before", "after");
  } catch {
    // Unit tests may run before npm install; production uses npm package "diff".
  }
  return fallbackDiff(path, oldText, newText);
}

export function countChangedLines(diffPreview) {
  let added = 0;
  let deleted = 0;
  for (const line of diffPreview.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added += 1;
    if (line.startsWith("-")) deleted += 1;
  }
  return { added, deleted, total: added + deleted };
}
