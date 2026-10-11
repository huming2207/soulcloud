import postgres from "@prisma/orm-postgres/runtime";
import type { Contract } from "./prisma/contract.d.ts";
import contractJson from "./prisma/contract.json" with { type: "json" };
import { config } from "./config.ts";

export const db = postgres<Contract>({ contractJson, url: config.DATABASE_URL });
export type Db = typeof db;
export const models = db.orm.public;
