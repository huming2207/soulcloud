import { BASE62, hmacHex, randomString, safeEqual, sha256Hex } from "../crypto.ts";

/** 32 symbols: digits and uppercase letters without the look-alikes 0, 1, I and O. */
export const ID_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

const DEVICE_ID_GROUPS = [5, 5];
const PAIRING_TOKEN_GROUPS = [4, 4, 4, 4];

function group(raw: string, groups: number[]): string {
  const parts: string[] = [];
  let at = 0;
  for (const size of groups) {
    parts.push(raw.slice(at, at + size));
    at += size;
  }
  return parts.join("-");
}

function normalize(input: string, groups: number[]): string | null {
  const raw = input.toUpperCase().replace(/[\s-]/g, "");
  const total = groups.reduce((a, b) => a + b, 0);
  if (raw.length !== total) return null;
  for (const ch of raw) if (!ID_ALPHABET.includes(ch)) return null;
  return group(raw, groups);
}

/** A new device id such as `7KQ2M-XH9PA` (~50 bits). Also the MQTT username and client id. */
export function generateDeviceId(): string {
  return group(randomString(ID_ALPHABET, 10), DEVICE_ID_GROUPS);
}

/** Canonical form of a user-typed device id (case-insensitive, dashes optional), or null. */
export function normalizeDeviceId(input: string): string | null {
  return normalize(input, DEVICE_ID_GROUPS);
}

export const DEVICE_ID_PATTERN = /^[2-9A-HJ-NP-Z]{5}-[2-9A-HJ-NP-Z]{5}$/;

export function isCanonicalDeviceId(id: string): boolean {
  return DEVICE_ID_PATTERN.test(id);
}

/** Device MQTT password: 32 base62 characters (~190 bits). */
export function generateDevicePassword(): string {
  return randomString(BASE62, 32);
}

/**
 * Device passwords are high-entropy random strings, so a keyed fast hash is
 * enough and keeps the broker's per-connect auth callback cheap.
 */
export function hashDevicePassword(password: string, pepper: string): string {
  return hmacHex(pepper, password);
}

export function verifyDevicePassword(password: string, stored: string, pepper: string): boolean {
  return safeEqual(hashDevicePassword(password, pepper), stored);
}

/** Single-use pairing token such as `K7QD-M3XA-9PZT-4HNC` (~80 bits), easy to type or embed. */
export function generatePairingToken(): string {
  return group(randomString(ID_ALPHABET, 16), PAIRING_TOKEN_GROUPS);
}

export function normalizePairingToken(input: string): string | null {
  return normalize(input, PAIRING_TOKEN_GROUPS);
}

export function hashPairingToken(canonical: string): string {
  return sha256Hex(canonical);
}
