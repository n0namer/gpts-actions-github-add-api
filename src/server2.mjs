// Backward-compatibility shim. Canonical runtime is src/server.mjs.
export * from "./server.mjs";
import { startServer } from "./server.mjs";

if (import.meta.url === `file://${process.argv[1]}`) startServer();
