// on9log binary packet framing. Every packet starts with an 18-byte
// little-endian header; `payload_len` gives the exact payload size, so several
// packets can be concatenated in one MQTT message without extra framing.
//
//   u8 magic (0x9a) | u8 type<<4 | level | u16 seq | u32 time_ms
//   u32 tag_id | u32 fmt_id | u16 payload_len

export const ON9LOG_MAGIC = 0x9a;
export const HEADER_SIZE = 18;
export const PAYLOAD_LEN_STREAMING = 0xffff;

export const PacketType = {
  Log: 0,
  Dropped: 1,
  TimeSync: 2,
  Boot: 3,
  Buffer: 4,
} as const;

export interface On9logPacket {
  type: number;
  level: number;
  seq: number;
  timeMs: number;
  tagId: number;
  fmtId: number;
  payload: Buffer;
  /** Header and payload exactly as received. */
  raw: Buffer;
}

export interface SplitResult {
  packets: On9logPacket[];
  /** Why splitting stopped early, if it did. Bytes after that point are dropped. */
  error?: string;
}

export function readHeader(buf: Buffer, at = 0) {
  return {
    magic: buf.readUInt8(at),
    type: buf.readUInt8(at + 1) >> 4,
    level: buf.readUInt8(at + 1) & 0x0f,
    seq: buf.readUInt16LE(at + 2),
    timeMs: buf.readUInt32LE(at + 4),
    tagId: buf.readUInt32LE(at + 8),
    fmtId: buf.readUInt32LE(at + 12),
    payloadLen: buf.readUInt16LE(at + 16),
  };
}

/** Splits a buffer of back-to-back on9log packets. */
export function splitPackets(buf: Buffer): SplitResult {
  const packets: On9logPacket[] = [];
  let at = 0;
  while (at < buf.length) {
    if (buf.length - at < HEADER_SIZE) return { packets, error: `truncated header at byte ${at}` };
    const h = readHeader(buf, at);
    if (h.magic !== ON9LOG_MAGIC) return { packets, error: `bad magic 0x${h.magic.toString(16)} at byte ${at}` };
    if (h.payloadLen === PAYLOAD_LEN_STREAMING) return { packets, error: `streaming payload length at byte ${at}` };
    const end = at + HEADER_SIZE + h.payloadLen;
    if (end > buf.length) return { packets, error: `truncated payload at byte ${at}` };
    packets.push({
      type: h.type,
      level: h.level,
      seq: h.seq,
      timeMs: h.timeMs,
      tagId: h.tagId,
      fmtId: h.fmtId,
      payload: buf.subarray(at + HEADER_SIZE, end),
      raw: buf.subarray(at, end),
    });
    at = end;
  }
  return { packets };
}

export function parseBoot(p: On9logPacket): { bootId: number; resetReason: number } | null {
  if (p.payload.length < 5) return null;
  return { bootId: p.payload.readUInt32LE(0), resetReason: p.payload.readUInt8(4) };
}

export function parseTimeSync(p: On9logPacket): { bootId: number } | null {
  return p.payload.length < 4 ? null : { bootId: p.payload.readUInt32LE(0) };
}

export function parseDropped(p: On9logPacket): { count: number } | null {
  return p.payload.length < 4 ? null : { count: p.payload.readUInt32LE(0) };
}
