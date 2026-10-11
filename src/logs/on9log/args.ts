// Log packet payload: u8 arg_count, u8 arg_types[arg_count], then the values.

export type Arg =
  | { kind: "u32"; v: number }
  | { kind: "u64"; v: bigint }
  | { kind: "ptr"; v: number }
  | { kind: "str"; v: Uint8Array | null };

const NULL_STRING = 0xffffffff;

export function decodeArgs(payload: Uint8Array): Arg[] {
  if (payload.length === 0) throw new Error("empty log payload");
  const count = payload[0]!;
  if (1 + count > payload.length) throw new Error("arg type table truncated");
  const v = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  let at = 1 + count;
  const need = (n: number, what: string) => {
    if (at + n > payload.length) throw new Error(`${what} truncated`);
  };

  const args: Arg[] = [];
  for (let i = 0; i < count; i++) {
    const type = payload[1 + i]!;
    switch (type) {
      case 0: // none
        args.push({ kind: "u32", v: 0 });
        break;
      case 1:
        need(4, "u32");
        args.push({ kind: "u32", v: v.getUint32(at, true) });
        at += 4;
        break;
      case 2:
        need(8, "u64");
        args.push({ kind: "u64", v: v.getBigUint64(at, true) });
        at += 8;
        break;
      case 3:
        need(4, "pointer");
        args.push({ kind: "ptr", v: v.getUint32(at, true) });
        at += 4;
        break;
      case 4:
      case 5: {
        need(4, "string length");
        const len = v.getUint32(at, true);
        at += 4;
        if (len === NULL_STRING) {
          args.push({ kind: "str", v: null });
          break;
        }
        need(len, "dynamic string");
        args.push({ kind: "str", v: payload.subarray(at, at + len) });
        at += len;
        break;
      }
      default:
        throw new Error(`unknown arg type 0x${type.toString(16)}`);
    }
  }
  return args;
}

const lossy = new TextDecoder();
export const argText = (bytes: Uint8Array) => lossy.decode(bytes);

/** Compact dump used when the format string is unavailable. */
export function summarizeArgs(args: Arg[]): string {
  const parts = args.map((a) => {
    switch (a.kind) {
      case "u32":
        return `u32:${a.v}`;
      case "u64":
        return `u64:${a.v}`;
      case "ptr":
        return `ptr:0x${a.v.toString(16).padStart(8, "0")}`;
      case "str":
        return a.v === null ? "str:null" : `str:${argText(a.v)}`;
    }
  });
  return `[${parts.join(", ")}]`;
}

/** Signed integer value of an argument used as a `*` width or precision. */
export function intArg(a: Arg | undefined): bigint {
  if (!a) return 0n;
  switch (a.kind) {
    case "u32":
    case "ptr":
      return BigInt(a.v | 0);
    case "u64":
      return BigInt.asIntN(64, a.v);
    case "str":
      return 0n;
  }
}
