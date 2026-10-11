// The typed SLIP envelope on9log uses on byte streams (UART, stdio):
//   0xa5 | SLIP(type) | SLIP(payload) | SLIP(crc16-ccitt LE) | 0xc0
// The raw log export wraps packets this way so the host CLI can replay them.

const START = 0xa5;
const END = 0xc0;
const ESC = 0xdb;
const ESCAPES: Record<number, number> = { 0xc0: 0xdc, 0xdb: 0xdd, 0xa5: 0xde, 0x0d: 0xd0, 0x0a: 0xd1 };
const UNESCAPES: Record<number, number> = Object.fromEntries(Object.entries(ESCAPES).map(([k, v]) => [v, Number(k)]));

export const FRAME_ON9LOG = 0x01;
export const FRAME_TEXT = 0x02;

export function crc16Ccitt(data: Uint8Array, crc = 0xffff): number {
  for (const byte of data) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

export function slipFrame(type: number, payload: Uint8Array): Buffer {
  const body = Buffer.concat([Buffer.from([type]), payload]);
  const crc = crc16Ccitt(body);
  const raw = Buffer.concat([body, Buffer.from([crc & 0xff, crc >> 8])]);
  const out: number[] = [START];
  for (const b of raw) {
    const esc = ESCAPES[b];
    if (esc === undefined) out.push(b);
    else out.push(ESC, esc);
  }
  out.push(END);
  return Buffer.from(out);
}

/** Extracts CRC-valid frames from a byte stream; bytes outside frames are skipped. */
export function slipDeframe(stream: Uint8Array): { type: number; payload: Buffer }[] {
  const frames: { type: number; payload: Buffer }[] = [];
  let i = 0;
  while (i < stream.length) {
    if (stream[i++] !== START) continue;
    const bytes: number[] = [];
    let ok = false;
    while (i < stream.length) {
      const b = stream[i++]!;
      if (b === END) {
        ok = true;
        break;
      }
      if (b === START) {
        i--;
        break;
      }
      if (b === ESC) {
        const u = UNESCAPES[stream[i++]!];
        if (u === undefined) break;
        bytes.push(u);
      } else {
        bytes.push(b);
      }
    }
    if (!ok || bytes.length < 3) continue;
    const body = Uint8Array.from(bytes.slice(0, -2));
    const crc = bytes[bytes.length - 2]! | (bytes[bytes.length - 1]! << 8);
    if (crc16Ccitt(body) !== crc) continue;
    frames.push({ type: body[0]!, payload: Buffer.from(body.subarray(1)) });
  }
  return frames;
}
