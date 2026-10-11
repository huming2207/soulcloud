import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ElfStrings } from "../../src/logs/on9log/elf.ts";
import { PacketType, splitPackets } from "../../src/logs/on9log/packet.ts";
import { renderFormat, renderPacket } from "../../src/logs/on9log/render.ts";
import { FRAME_ON9LOG, slipDeframe, slipFrame } from "../../src/logs/on9log/slip.ts";
import type { Arg } from "../../src/logs/on9log/args.ts";

const fixture = (name: string) => readFileSync(new URL(`../fixtures/on9log/${name}`, import.meta.url));
const LETTERS = "NEWIDV";
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

describe("on9log golden output", () => {
  // unix_demo.slip is the on9log Unix demo's binary stdout; unix_demo.expected.txt
  // is what the reference host decoder (on9log --log-bin --elf) printed for it.
  test("matches the reference decoder line for line", () => {
    const elf = ElfStrings.parse(fixture("unix_demo.elf"));
    const lines: string[] = [];
    for (const frame of slipDeframe(fixture("unix_demo.slip"))) {
      if (frame.type !== FRAME_ON9LOG) continue;
      const { packets, error } = splitPackets(frame.payload);
      expect(error).toBeUndefined();
      for (const p of packets) {
        if (p.type !== PacketType.Log && p.type !== PacketType.Buffer) continue;
        const r = renderPacket(p.raw, elf);
        const prefix = `${LETTERS[p.level]} (${p.timeMs}) ${r.tag}`;
        lines.push(
          r.buffer
            ? `${prefix} [buf ${r.buffer.totalLen} @${r.buffer.offset} +${r.buffer.bytes.length}]: <buffer dump, ${r.buffer.bytes.length} bytes>`
            : `${prefix}: ${r.message}`,
        );
      }
    }
    const expected = fixture("unix_demo.expected.txt").toString("utf8").trimEnd().split("\n");
    expect(lines.map(squash)).toEqual(expected.map(squash));
  });
});

describe("on9log packets", () => {
  const packet = (type: number, level: number, payload: number[]) => {
    const h = Buffer.alloc(18);
    h.writeUInt8(0x9a, 0);
    h.writeUInt8((type << 4) | level, 1);
    h.writeUInt16LE(7, 2);
    h.writeUInt32LE(1234, 4);
    h.writeUInt16LE(payload.length, 16);
    return Buffer.concat([h, Buffer.from(payload)]);
  };

  test("splits back-to-back packets and reports trailing garbage", () => {
    const a = packet(PacketType.Log, 3, [0]);
    const b = packet(PacketType.TimeSync, 0, [1, 0, 0, 0]);
    const { packets, error } = splitPackets(Buffer.concat([a, b, Buffer.from([0x9a, 0x00])]));
    expect(packets.map((p) => p.type)).toEqual([PacketType.Log, PacketType.TimeSync]);
    expect(packets[0]!.timeMs).toBe(1234);
    expect(error).toContain("truncated header");
  });

  test("renders without an ELF instead of failing", () => {
    const r = renderPacket(packet(PacketType.Log, 3, [1, 1, 42, 0, 0, 0]), null);
    expect(r.decoded).toBe(false);
    expect(r.message).toBe("<fmt @0x00000000> [u32:42]");
  });

  test("slip round trip", () => {
    const payload = Buffer.from([0x9a, 0xc0, 0xdb, 0xa5, 0x0a, 0x0d, 1, 2]);
    const frames = slipDeframe(Buffer.concat([Buffer.from("noise"), slipFrame(FRAME_ON9LOG, payload)]));
    expect(frames).toHaveLength(1);
    expect(frames[0]!.payload.equals(payload)).toBe(true);
  });
});

describe("format rendering", () => {
  const u32 = (v: number): Arg => ({ kind: "u32", v: v >>> 0 });
  const str = (s: string | null): Arg => ({ kind: "str", v: s === null ? null : Buffer.from(s) });
  const f64 = (x: number): Arg => {
    const v = new DataView(new ArrayBuffer(8));
    v.setFloat64(0, x, true);
    return { kind: "u64", v: v.getBigUint64(0, true) };
  };

  test("printf", () => {
    expect(renderFormat("%d|%5d|%-5d|%05d|%+d", [u32(-7), u32(42), u32(42), u32(-42), u32(3)])).toBe("-7|   42|42   |-0042|+3");
    expect(renderFormat("%x %X %#x %o %#o %lu", [u32(255), u32(255), u32(255), u32(8), u32(8), u32(-1)])).toBe("ff FF 0xff 10 010 4294967295");
    expect(renderFormat("%.2f %8.3f %e %g %g", [f64(3.14159), f64(-2.5), f64(1234.5), f64(0.0001), f64(1e20)])).toBe(
      "3.14   -2.500 1.234500e+03 0.0001 1e+20",
    );
    expect(renderFormat("[%.3s] [%s] [%c]", [str("abcdef"), str(null), u32(65)])).toBe("[abc] [(null)] [A]");
    expect(renderFormat("%d %d", [u32(1)])).toStartWith("<render error: missing argument>");
  });

  test("{} formatting", () => {
    expect(renderFormat("{} {:x} {:>4} {:<4}| {:^5}|", [u32(1), u32(255), u32(7), str("ab"), str("x")])).toBe("1 ff    7 ab  |   x  |");
    expect(renderFormat("{:.3f} {:e} {:g}", [f64(2.71828), f64(1500), f64(0.5)])).toBe("2.718 1.500000e3 0.5");
    expect(renderFormat("{0}{1}{0} {{}}", [u32(1), u32(2)])).toBe("121 {}");
    expect(renderFormat("{} {0}", [u32(1)])).toStartWith("<render error: mixed auto and explicit args>");
    // A `{}`-looking string with a printf conversion stays printf.
    expect(renderFormat("payload={} status=%d", [u32(5)])).toBe("payload={} status=5");
  });
});
