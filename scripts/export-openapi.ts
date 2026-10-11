// Writes the API's OpenAPI document to stdout without starting the server:
//   bun scripts/export-openapi.ts > web/openapi.json
// Settings missing from the environment are taken from .env.example; the
// document doesn't depend on them.
import { config as loadEnv } from "dotenv";
import type { ApiDeps } from "../src/http/deps.ts";

loadEnv({ path: new URL("../.env.example", import.meta.url).pathname, quiet: true });
const { createApiApp } = await import("../src/http/app.ts");

const app = createApiApp({} as ApiDeps);
const res = await app.request("/openapi.json");
process.stdout.write(JSON.stringify(await res.json(), null, 2) + "\n");
process.exit(0);
