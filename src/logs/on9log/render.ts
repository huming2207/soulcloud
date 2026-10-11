// Renders one stored on9log packet into tag + message text.

import { decodeArgs, summarizeArgs } from "./args.ts";
import { looksLikeCpp, renderCpp } from "./cppfmt.ts";
import type { ElfStrings } from "./elf.ts";
import { PacketType, readHeader, HEADER_SIZE } from "./packet.ts";
import { hasPrintfConversion, renderPrintf } from "./printf.ts";
import type { Arg } from "./args.ts";

export interface RenderedPacket {
  tag: string;
  message: string;
  /** False when the ELF was missing or didn't know the format string. */
  decoded: boolean;
  buffer?: { totalLen: number; offset: number; bytes: Uint8Array };
}

const hex8 = (n: number) => `0x${n.toString(16).padStart(8, "0")}`;

/** tag_id / fmt_id value meaning "the string is carried in the payload". */
export const ID_INLINE = 0xffffffff;

const lossy = new TextDecoder();

/**
 * Strings the device couldn't send by address (built at runtime, held in RAM)
 * precede the payload: the tag first, then the format, each `u32 len + bytes`.
 */
function splitInline(tagId: number, fmtId: number, payload: Buffer): { tag: string | null; fmt: string | null; rest: Buffer } {
  let at = 0;
  const take = (what: string) => {
    if (at + 4 > payload.length) throw new Error(`inline ${what} length truncated`);
    const len = payload.readUInt32LE(at);
    at += 4;
    if (at + len > payload.length) throw new Error(`inline ${what} truncated`);
    const text = lossy.decode(payload.subarray(at, at + len));
    at += len;
    return text;
  };
  const tag = tagId === ID_INLINE ? take("tag") : null;
  const fmt = fmtId === ID_INLINE ? take("format") : null;
  return { tag, fmt, rest: payload.subarray(at) };
}

/**
 * `{}`-style strings go to the C++ renderer only if they contain no printf
 * conversion, so `"payload={} status=%d"` stays printf like the compiler sees it.
 */
export function renderFormat(fmt: string, args: Arg[]): string {
  return looksLikeCpp(fmt) && !hasPrintfConversion(fmt) ? renderCpp(fmt, args) : renderPrintf(fmt, args);
}

export function renderPacket(raw: Uint8Array, elf: ElfStrings | null): RenderedPacket {
  const buf = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  const h = readHeader(buf);
  let inline;
  try {
    inline = splitInline(h.tagId, h.fmtId, buf.subarray(HEADER_SIZE, HEADER_SIZE + h.payloadLen));
  } catch (err) {
    return { tag: `@${hex8(h.tagId)}`, message: `<malformed packet: ${(err as Error).message}>`, decoded: false };
  }
  const payload = inline.rest;
  const tagText = inline.tag ?? elf?.readTag(h.tagId) ?? null;
  const tag = tagText ?? `@${hex8(h.tagId)}`;

  if (h.type === PacketType.Buffer) {
    if (payload.length < 12) return { tag, message: "<malformed buffer packet>", decoded: false };
    const totalLen = payload.readUInt32LE(0);
    const offset = payload.readUInt32LE(4);
    const len = payload.readUInt32LE(8);
    const bytes = payload.subarray(12, 12 + len);
    const header = `<buffer dump, ${bytes.length} bytes, offset ${offset} of ${totalLen}>`;
    return {
      tag,
      message: bytes.length ? `${header}\n${hexdump(bytes, offset)}` : header,
      decoded: tagText !== null,
      buffer: { totalLen, offset, bytes },
    };
  }

  if (h.type !== PacketType.Log) return { tag, message: `<packet type ${h.type}>`, decoded: false };

  let args: Arg[];
  try {
    args = decodeArgs(payload);
  } catch (err) {
    return { tag, message: `<malformed log packet: ${(err as Error).message}>`, decoded: false };
  }
  const fmt = inline.fmt ?? elf?.readFormat(h.fmtId) ?? null;
  if (fmt === null) return { tag, message: `<fmt @${hex8(h.fmtId)}> ${summarizeArgs(args)}`, decoded: false };
  return { tag, message: renderFormat(fmt, args), decoded: tagText !== null };
}

export function hexdump(bytes: Uint8Array, base = 0): string {
  const lines: string[] = [];
  for (let at = 0; at < bytes.length; at += 16) {
    const row = bytes.subarray(at, at + 16);
    const hex = [...row].map((b) => b.toString(16).padStart(2, "0")).join(" ");
    const ascii = [...row].map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ".")).join("");
    lines.push(`${(base + at).toString(16).padStart(8, "0")}  ${hex.padEnd(47)}   ${ascii}`);
  }
  return lines.join("\n");
}
