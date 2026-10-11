import { describe, expect, test } from "bun:test";
import {
  ID_ALPHABET,
  generateDeviceId,
  generateDevicePassword,
  generatePairingToken,
  hashDevicePassword,
  isCanonicalDeviceId,
  normalizeDeviceId,
  normalizePairingToken,
  verifyDevicePassword,
} from "../../src/devices/ids.ts";
import { hashPassword, verifyPassword } from "../../src/crypto.ts";

describe("device ids", () => {
  test("alphabet has 32 unambiguous symbols", () => {
    expect(ID_ALPHABET.length).toBe(32);
    expect(new Set(ID_ALPHABET).size).toBe(32);
    for (const bad of "01IO") expect(ID_ALPHABET).not.toContain(bad);
  });

  test("generated ids are canonical and distinct", () => {
    const ids = new Set(Array.from({ length: 2000 }, generateDeviceId));
    expect(ids.size).toBe(2000);
    for (const id of ids) expect(isCanonicalDeviceId(id)).toBe(true);
  });

  test("normalisation accepts lower case and missing dash", () => {
    expect(normalizeDeviceId("7kq2mxh9pa")).toBe("7KQ2M-XH9PA");
    expect(normalizeDeviceId(" 7KQ2M-XH9PA ")).toBe("7KQ2M-XH9PA");
    expect(normalizeDeviceId("7KQ2M-XH9P0")).toBeNull(); // 0 is not in the alphabet
    expect(normalizeDeviceId("7KQ2M-XH9P")).toBeNull();
  });

  test("pairing tokens", () => {
    const t = generatePairingToken();
    expect(t).toMatch(/^[2-9A-HJ-NP-Z]{4}(-[2-9A-HJ-NP-Z]{4}){3}$/);
    expect(normalizePairingToken(t.toLowerCase().replaceAll("-", ""))).toBe(t);
  });

  test("device password hash", () => {
    const pw = generateDevicePassword();
    expect(pw).toMatch(/^[0-9A-Za-z]{32}$/);
    const h = hashDevicePassword(pw, "pepper-pepper-pepper-pepper-pepper");
    expect(verifyDevicePassword(pw, h, "pepper-pepper-pepper-pepper-pepper")).toBe(true);
    expect(verifyDevicePassword(pw + "x", h, "pepper-pepper-pepper-pepper-pepper")).toBe(false);
    expect(verifyDevicePassword(pw, h, "another-pepper-another-pepper-xx")).toBe(false);
  });

  test("human password hash", async () => {
    const h = await hashPassword("correct horse");
    expect(await verifyPassword("correct horse", h)).toBe(true);
    expect(await verifyPassword("wrong horse", h)).toBe(false);
  });
});
