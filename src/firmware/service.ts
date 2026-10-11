import { config } from "../config.ts";
import { hmacHex, safeEqual, sha256Hex } from "../crypto.ts";
import { models, sqlState } from "../db.ts";
import { ApiError, badRequest, conflict } from "../http/errors.ts";
import { platforms, type FirmwareImageInfo } from "../platforms/index.ts";
import type { BlobStore } from "./storage.ts";

const binKey = (sha: string) => `firmware/${sha}.bin`;
const elfKey = (sha: string) => `elf/${sha}.elf`;

export function parseFirmwareImage(bin: Uint8Array): FirmwareImageInfo {
  const problems: string[] = [];
  for (const platform of platforms) {
    try {
      return platform.parseImage(bin);
    } catch (err) {
      problems.push(`${platform.id}: ${(err as Error).message}`);
    }
  }
  throw badRequest("unrecognised firmware image", problems);
}

export async function uploadFirmware(
  blobs: BlobStore,
  ownerId: string,
  bin: Uint8Array,
  elf: Uint8Array | null,
  notes: string | null,
) {
  const info = parseFirmwareImage(bin);
  const binSha256 = sha256Hex(bin);
  if (elf) checkElf(info.elfSha256, elf);

  const existing = await models.Firmware.select("id").where({ ownerId, binSha256 }).first();
  if (existing) throw new ApiError(409, "firmware_exists", `this image was already uploaded as ${existing.id}`, { id: existing.id });

  await blobs.put(binKey(binSha256), bin);
  if (elf) await blobs.put(elfKey(info.elfSha256), elf);
  try {
    return await models.Firmware.create({
      ownerId,
      platform: info.platform,
      chip: info.chip,
      projectName: info.projectName,
      version: info.version,
      idfVersion: info.sdkVersion,
      buildTime: info.buildTime,
      elfSha256: info.elfSha256,
      binSha256,
      size: bin.length,
      binKey: binKey(binSha256),
      elfKey: elf ? elfKey(info.elfSha256) : null,
      notes,
    });
  } catch (err) {
    if (sqlState(err) === "23505") throw conflict("this image was already uploaded");
    throw err;
  }
}

function checkElf(expectedSha: string, elf: Uint8Array) {
  const actual = sha256Hex(elf);
  if (actual !== expectedSha) {
    throw badRequest("the ELF does not belong to this image", { imageElfSha256: expectedSha, uploadedElfSha256: actual });
  }
}

export async function attachElf(blobs: BlobStore, firmware: { id: string; elfSha256: string }, elf: Uint8Array) {
  checkElf(firmware.elfSha256, elf);
  await blobs.put(elfKey(firmware.elfSha256), elf);
  return models.Firmware.where({ id: firmware.id }).update({ elfKey: elfKey(firmware.elfSha256) });
}

/** Deletes a firmware row and any blobs no other row still uses. */
export async function deleteFirmware(blobs: BlobStore, firmware: { id: string; binSha256: string; elfSha256: string; elfKey: string | null }) {
  const job = await models.OtaJob.select("id").where({ firmwareId: firmware.id }).first();
  if (job) throw conflict("firmware is used by an OTA job");
  await models.Firmware.where({ id: firmware.id }).delete();
  if (!(await models.Firmware.select("id").where({ binSha256: firmware.binSha256 }).first())) {
    await blobs.delete(binKey(firmware.binSha256));
  }
  if (firmware.elfKey && !(await models.Firmware.select("id").where({ elfSha256: firmware.elfSha256 }).first())) {
    await blobs.delete(firmware.elfKey);
  }
}

// --- Signed device downloads ---------------------------------------------------

function signature(firmwareId: string, deviceId: string, exp: number): string {
  return hmacHex(config.DOWNLOAD_SIGNING_SECRET, `${firmwareId}:${deviceId}:${exp}`);
}

export function signedDownloadUrl(firmwareId: string, deviceId: string, ttlSec: number): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const qs = new URLSearchParams({ d: deviceId, exp: String(exp), sig: signature(firmwareId, deviceId, exp) });
  return `${config.PUBLIC_BASE_URL}/v1/device/firmware/${firmwareId}?${qs}`;
}

export function verifyDownload(firmwareId: string, deviceId: string, exp: number, sig: string): boolean {
  if (!Number.isFinite(exp) || exp < Date.now() / 1000) return false;
  return safeEqual(signature(firmwareId, deviceId, exp), sig);
}
