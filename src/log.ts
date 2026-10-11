import pino from "pino";
import { config } from "./config.ts";

export const log = pino({ level: config.LOG_LEVEL, base: undefined });
