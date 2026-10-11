import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/** Uniformly random string over `alphabet` (rejection sampling, no modulo bias). */
export function randomString(alphabet: string, length: number): string {
  const n = alphabet.length;
  if (n < 2 || n > 256) throw new RangeError("alphabet must have 2..256 symbols");
  const limit = 256 - (256 % n);
  let out = "";
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      if (byte >= limit) continue;
      out += alphabet[byte % n];
      if (out.length === length) break;
    }
  }
  return out;
}

export const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function hmacHex(key: string, data: string): string {
  return createHmac("sha256", key).update(data).digest("hex");
}

/** Constant-time comparison of two equal-format strings (e.g. hex digests). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** Opaque random token for sessions and similar bearer secrets. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

// Human passwords: scrypt (available on both Bun and Node), self-describing format
// `scrypt$N$r$p$salt$hash` so parameters can be raised later.
const SCRYPT = { N: 16384, r: 8, p: 1, keyLen: 32 };

function scryptAsync(password: string, salt: Buffer, N: number, r: number, p: number, keyLen: number) {
  return new Promise<Buffer>((resolve, reject) =>
    scrypt(password, salt, keyLen, { N, r, p, maxmem: 64 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, SCRYPT.N, SCRYPT.r, SCRYPT.p, SCRYPT.keyLen);
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64"), key.toString("base64")].join("$");
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [algo, N, r, p, salt, hash] = stored.split("$");
  if (algo !== "scrypt" || !N || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64");
  const key = await scryptAsync(password, Buffer.from(salt, "base64"), +N, +r, +p, expected.length);
  return timingSafeEqual(key, expected);
}
