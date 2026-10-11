// ESP32 family: chip ids from the app image header, reset reason names
// (esp_reset_reason_t, which on9log's BOOT packet uses as well) and parsing of
// the app description embedded in every ESP-IDF application image.

import type { FirmwareImageInfo, Platform } from "./index.ts";

// esp_chip_id_t
const CHIPS: Record<number, string> = {
  0x00: "esp32",
  0x02: "esp32s2",
  0x05: "esp32c3",
  0x09: "esp32s3",
  0x0c: "esp32c2",
  0x0d: "esp32c6",
  0x10: "esp32h2",
  0x12: "esp32p4",
  0x14: "esp32c61",
  0x17: "esp32c5",
  0x19: "esp32h21",
  0x1c: "esp32h4",
};

// esp_reset_reason_t
const RESET_REASONS = [
  "unknown",
  "power_on",
  "external",
  "software",
  "panic",
  "int_wdt",
  "task_wdt",
  "other_wdt",
  "deep_sleep",
  "brownout",
  "sdio",
  "usb",
  "jtag",
  "efuse",
  "power_glitch",
  "cpu_lockup",
];

const IMAGE_MAGIC = 0xe9;
const APP_DESC_OFFSET = 24 + 8; // image header + first segment header
const APP_DESC_MAGIC = 0xabcd5432;

function cString(buf: Uint8Array, start: number, length: number): string {
  const slice = buf.subarray(start, start + length);
  const end = slice.indexOf(0);
  return new TextDecoder().decode(end === -1 ? slice : slice.subarray(0, end));
}

export function parseEspAppImage(bin: Uint8Array): FirmwareImageInfo {
  if (bin.length < APP_DESC_OFFSET + 256) throw new Error("file is too small to be an ESP-IDF app image");
  const view = new DataView(bin.buffer, bin.byteOffset, bin.byteLength);
  if (view.getUint8(0) !== IMAGE_MAGIC) throw new Error("not an ESP-IDF app image (bad image magic)");
  const chipId = view.getUint16(12, true);
  const chip = CHIPS[chipId];
  if (!chip) throw new Error(`unknown ESP chip id 0x${chipId.toString(16)}`);

  const d = APP_DESC_OFFSET;
  if (view.getUint32(d, true) !== APP_DESC_MAGIC) throw new Error("ESP app description not found");
  const date = cString(bin, d + 96, 16);
  const time = cString(bin, d + 80, 16);
  return {
    platform: "esp32",
    chip,
    version: cString(bin, d + 16, 32),
    projectName: cString(bin, d + 48, 32),
    buildTime: [date, time].filter(Boolean).join(" ") || null,
    sdkVersion: cString(bin, d + 112, 32) || null,
    elfSha256: Buffer.from(bin.subarray(d + 144, d + 176)).toString("hex"),
  };
}

export const esp32: Platform = {
  id: "esp32",
  matches: (platform) => platform === "esp32" || platform.startsWith("esp32"),
  resetReasonName: (code) => RESET_REASONS[code] ?? `code_${code}`,
  parseImage: parseEspAppImage,
};
