export type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };

/**
 * Marks a value as JSON for a Jsonb column. Only use it on values that came from
 * JSON.parse or a schema built from JSON-compatible types.
 */
export function toJson(value: unknown): Json {
  return value as Json;
}
