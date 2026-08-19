import { createHash } from "node:crypto";
import { GitHubAddError } from "./errors.mjs";
import { validateContentForPath } from "./validation.mjs";

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

export function replaceExactOnce(input, oldText, newText) {
  const count = countOccurrences(input, oldText);
  if (count === 0) {
    throw new GitHubAddError(422, { status: "PATCH_NOT_APPLICABLE", reason: "old_text_not_found", old_text: oldText });
  }
  if (count > 1) {
    const lines = input.split("\n");
    const ranges = [];
    let searchFrom = 0;
    for (let lineNum = 1; lineNum <= lines.length; lineNum++) {
      const lineEnd = searchFrom + lines[lineNum - 1].length + 1;
      const idx = input.indexOf(oldText, searchFrom);
      if (idx !== -1 && idx < lineEnd) {
        ranges.push({ line: lineNum, text: lines[lineNum - 1] });
        searchFrom = idx + oldText.length;
      } else {
        searchFrom = lineEnd;
      }
    }
    throw new GitHubAddError(422, {
      status: "PATCH_NOT_APPLICABLE",
      reason: "old_text_not_unique",
      occurrences: count,
      candidate_lines: ranges.slice(0, 5),
    });
  }
  const index = input.indexOf(oldText);
  const content = input.slice(0, index) + newText + input.slice(index + oldText.length);
  const lineNum = input.slice(0, index).split("\n").length;
  return { content, target_match: { line: lineNum, old_text_length: oldText.length } };
}

export function replaceWithContext(input, before, oldText, after, newText) {
  const candidates = [];
  let searchFrom = 0;
  while (true) {
    const idx = input.indexOf(oldText, searchFrom);
    if (idx === -1) break;
    const beforeSlice = input.slice(Math.max(0, idx - before.length), idx);
    const afterIdx = idx + oldText.length;
    const afterSlice = input.slice(afterIdx, afterIdx + after.length);
    const beforeOk = before.length === 0 || beforeSlice === before;
    const afterOk = after.length === 0 || afterSlice === after;
    if (beforeOk && afterOk) {
      candidates.push({ index: idx, line: input.slice(0, idx).split("\n").length });
    }
    searchFrom = idx + oldText.length;
  }

  if (candidates.length === 0) {
    throw new GitHubAddError(422, { status: "PATCH_NOT_APPLICABLE", reason: "context_not_found", before, old_text: oldText, after });
  }
  if (candidates.length > 1) {
    throw new GitHubAddError(422, {
      status: "PATCH_NOT_APPLICABLE",
      reason: "context_not_unique",
      occurrences: candidates.length,
      candidate_lines: candidates.map(c => ({ line: c.line })),
    });
  }

  const index = candidates[0].index;
  const content = input.slice(0, index) + newText + input.slice(index + oldText.length);
  return { content, target_match: { line: candidates[0].line, old_text_length: oldText.length } };
}

export function replaceLineRange(input, startLine, endLine, expectedOldText, newText) {
  const lines = input.split("\n");
  if (startLine < 1 || endLine > lines.length || endLine < startLine) {
    throw new GitHubAddError(400, { status: "BAD_REQUEST", message: "invalid line range" });
  }
  const actualLines = lines.slice(startLine - 1, endLine);
  const actualText = actualLines.join("\n");
  if (actualText !== expectedOldText) {
    throw new GitHubAddError(422, {
      status: "PATCH_NOT_APPLICABLE",
      reason: "line_range_text_mismatch",
      start_line: startLine,
      end_line: endLine,
    });
  }
  const before = lines.slice(0, startLine - 1);
  const after = lines.slice(endLine);
  const content = [...before, newText, ...after].join("\n");
  return { content, target_match: { start_line: startLine, end_line: endLine, line_count: actualLines.length } };
}

export function insertAfterExactOnce(input, anchorText, insertText) {
  const count = countOccurrences(input, anchorText);
  if (count === 0) {
    throw new GitHubAddError(422, { status: "PATCH_NOT_APPLICABLE", reason: "anchor_text_not_found", anchor_text: anchorText });
  }
  if (count > 1) {
    throw new GitHubAddError(422, { status: "PATCH_NOT_APPLICABLE", reason: "anchor_text_not_unique", occurrences: count });
  }
  const idx = input.indexOf(anchorText) + anchorText.length;
  const lineNum = input.slice(0, idx).split("\n").length;
  const trimmed = input.slice(idx);
  const suffix = trimmed.startsWith("\n") ? "" : "\n";
  const content = input.slice(0, idx) + suffix + insertText + "\n" + (trimmed.startsWith("\n") ? trimmed.slice(1) : trimmed);
  return { content, target_match: { line: lineNum, anchor_text_length: anchorText.length } };
}

export function createLineView(content) {
  const lines = content.split("\n");
  return lines.map((text, idx) => ({ line: idx + 1, text }));
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
  validateContentForPath(path, newText);
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

export function applyOperation(input, operation) {
  if (operation.type === "replace_between_markers") {
    return replaceBetweenMarkers(input, operation.start_marker, operation.end_marker, operation.new_text);
  }
  if (operation.type === "insert_after_marker") {
    return insertAfterMarker(input, operation.marker, operation.text);
  }
  if (operation.type === "replace_exact_once") {
    return replaceExactOnce(input, operation.old_text, operation.new_text);
  }
  if (operation.type === "replace_with_context") {
    return replaceWithContext(input, operation.before || "", operation.old_text, operation.after || "", operation.new_text);
  }
  if (operation.type === "replace_line_range") {
    return replaceLineRange(input, operation.start_line, operation.end_line, operation.expected_old_text, operation.new_text);
  }
  if (operation.type === "insert_after_exact_once") {
    return insertAfterExactOnce(input, operation.anchor_text, operation.insert_text);
  }
  throw new GitHubAddError(400, { status: "BAD_REQUEST", message: "unsupported operation.type" });
}
