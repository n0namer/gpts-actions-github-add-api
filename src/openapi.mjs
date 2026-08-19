import { readFileSync } from "node:fs";

const STATIC_OPENAPI_URL = new URL("../gpts-action-openapi.json", import.meta.url);
const STATIC_OPENAPI_DOCUMENT = JSON.parse(readFileSync(STATIC_OPENAPI_URL, "utf8"));

export function openApiDocument() {
  return structuredClone(STATIC_OPENAPI_DOCUMENT);
}
