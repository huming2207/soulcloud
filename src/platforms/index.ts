// Device platform registry. A platform knows how to read its firmware images and
// how to name its reset reasons. Add new families here (e.g. nRF, STM32).

import { esp32 } from "./esp32.ts";

export interface FirmwareImageInfo {
  platform: string;
  chip: string;
  version: string;
  projectName: string;
  buildTime: string | null;
  sdkVersion: string | null;
  /** SHA-256 of the ELF the image was built from, as recorded in the image. */
  elfSha256: string;
}

export interface Platform {
  id: string;
  matches(platform: string): boolean;
  resetReasonName(code: number): string;
  parseImage(bin: Uint8Array): FirmwareImageInfo;
}

export const platforms: Platform[] = [esp32];

export function platformFor(platform: string): Platform | undefined {
  return platforms.find((p) => p.matches(platform.toLowerCase()));
}

export function resetReasonName(platform: string, reason: string | number | undefined | null): string | null {
  if (reason == null) return null;
  if (typeof reason === "string") return reason;
  return platformFor(platform)?.resetReasonName(reason) ?? `code_${reason}`;
}

/** Firmware ELF hashes: devices may report a shortened hex prefix. */
export function elfShaMatches(full: string | null | undefined, reported: string | null | undefined): boolean {
  if (!full || !reported || reported.length < 8) return false;
  return full.toLowerCase().startsWith(reported.toLowerCase());
}
