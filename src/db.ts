import postgres from "@prisma/orm-postgres/runtime";
import type { Contract } from "./prisma/contract.d.ts";
import contractJson from "./prisma/contract.json" with { type: "json" };
import { config } from "./config.ts";

export const db = postgres<Contract>({ contractJson, url: config.DATABASE_URL });
export type Db = typeof db;
export const models = db.orm.public;
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** PostgreSQL error code of a failed query, if any (also looks at `cause`). */
export function sqlState(err: unknown): string | undefined {
  const source = err instanceof Error && err.cause ? err.cause : err;
  if (typeof source === "object" && source && "sqlState" in source) return String(source.sqlState);
  if (typeof err === "object" && err && "sqlState" in err) return String(err.sqlState);
  return undefined;
}
