import { models } from "../db.ts";

/**
 * The owner's firmware whose ELF hash matches what a device reports. Devices may
 * report a shortened hex prefix of the hash.
 */
export async function findFirmwareByElf(ownerId: string, elfSha256: string) {
  const sha = elfSha256.toLowerCase();
  if (sha.length === 64) return models.Firmware.where({ ownerId, elfSha256: sha }).first();
  return models.Firmware.where({ ownerId })
    .where((f) => f.elfSha256.like(`${sha}%`))
    .orderBy((f) => f.createdAt.desc())
    .first();
}
