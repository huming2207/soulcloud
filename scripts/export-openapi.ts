// Writes the API's OpenAPI document to stdout without starting the server:
//   bun scripts/export-openapi.ts > web/openapi.json
import { createApiApp } from "../src/http/app.ts";
import type { ApiDeps } from "../src/http/deps.ts";

const app = createApiApp({} as ApiDeps);
const res = await app.request("/openapi.json");
process.stdout.write(JSON.stringify(await res.json(), null, 2) + "\n");
process.exit(0);
