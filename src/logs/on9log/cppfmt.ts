// C++23 std::format-style rendering (`{}`, `{:08x}`, `{:>{}}`, `{0:.{1}f}` ...),
// matching the host decoder's behaviour:
//  - `{}` follows the wire type: string -> text, pointer -> 0x address,
//    32/64-bit -> unsigned decimal (the wire has no signedness or float flag,
//    so a double printed with `{}` shows its raw bit pattern; use `{:f}`);
//  - floats with `e`/`g` use Rust-style exponents (`3.14e0`) like the host tool;
//  - `L`, `a`/`A` and chrono/range formatters are not supported.

import { type Arg, argText } from "./args.ts";
import { MAX_RENDER_COUNT } from "./printf.ts";

type Align = "<" | ">" | "^";
type Count = { kind: "none" } | { kind: "literal"; n: number } | { kind: "auto" } | { kind: "explicit"; id: number };

interface Spec {
  fill?: string;
  align?: Align;
  sign?: "+" | "-" | " ";
  alt: boolean;
  zero: boolean;
  width: Count;
  precision: Count;
  type?: string;
}

interface Field {
  argId?: number;
  spec: Spec;
}

type Piece = string | Field;

class FormatError extends Error {}

const SUPPORTED_TYPES = new Set("bBcdeEfFgGopsxX");
const isDigit = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";

/** True if `fmt` contains an unescaped `{}`-style replacement field. */
export function looksLikeCpp(fmt: string): boolean {
  for (let i = 0; i < fmt.length; i++) {
    const c = fmt[i];
    if (c === "{") {
      if (fmt[i + 1] === "{") {
        i++;
        continue;
      }
      let j = i + 1;
      while (isDigit(fmt[j])) j++;
      if (fmt[j] === ":" || fmt[j] === "}") return true;
    } else if (c === "}" && fmt[i + 1] === "}") {
      i++;
    }
  }
  return false;
}

export function renderCpp(fmt: string, args: Arg[]): string {
  try {
    return render(fmt, args);
  } catch (err) {
    if (err instanceof FormatError) return `<render error: ${err.message}> ${fmt}`;
    throw err;
  }
}

function render(fmt: string, args: Arg[]): string {
  const pieces = parse(fmt);
  let hasAuto = false;
  let hasExplicit = false;
  for (const p of pieces) {
    if (typeof p === "string") continue;
    if (p.argId === undefined) hasAuto = true;
    else hasExplicit = true;
    for (const c of [p.spec.width, p.spec.precision]) {
      if (c.kind === "auto") hasAuto = true;
      if (c.kind === "explicit") hasExplicit = true;
    }
  }
  if (hasAuto && hasExplicit) throw new FormatError("mixed auto and explicit args");

  let out = "";
  let auto = 0;
  const count = (c: Count): number | undefined => {
    switch (c.kind) {
      case "none":
        return undefined;
      case "literal":
        return c.n;
      case "auto":
        return fetchCount(args, auto++);
      case "explicit":
        return fetchCount(args, c.id);
    }
  };
  for (const p of pieces) {
    if (typeof p === "string") {
      out += p;
      continue;
    }
    const valueIdx = p.argId ?? auto++;
    const width = count(p.spec.width);
    const precision = count(p.spec.precision);
    const arg = args[valueIdx];
    if (!arg) throw new FormatError(`missing arg ${valueIdx}`);
    out += renderField(arg, p.spec, width, precision);
  }
  return out;
}

function fetchCount(args: Arg[], idx: number): number {
  const a = args[idx];
  if (!a) throw new FormatError(`missing width/precision arg ${idx}`);
  let v: bigint;
  if (a.kind === "str") throw new FormatError("string used as width/precision");
  if (a.kind === "u64") v = BigInt.asIntN(64, a.v);
  else v = BigInt(a.v | 0);
  if (v < 0n) throw new FormatError("negative dynamic width/precision");
  if (v > BigInt(MAX_RENDER_COUNT)) throw new FormatError(`dynamic width/precision exceeds ${MAX_RENDER_COUNT}`);
  return Number(v);
}

function parse(fmt: string): Piece[] {
  const pieces: Piece[] = [];
  let lit = "";
  let i = 0;
  while (i < fmt.length) {
    const c = fmt[i++]!;
    if (c === "{") {
      if (fmt[i] === "{") {
        lit += "{";
        i++;
        continue;
      }
      if (lit) pieces.push(lit);
      lit = "";
      let id = "";
      while (isDigit(fmt[i])) id += fmt[i++];
      let spec: Spec = { alt: false, zero: false, width: { kind: "none" }, precision: { kind: "none" } };
      if (fmt[i] === ":") {
        i++;
        let body = "";
        let depth = 1;
        for (;;) {
          const ch = fmt[i++];
          if (ch === undefined) throw new FormatError("unterminated field");
          if (ch === "{") depth++;
          if (ch === "}" && --depth === 0) break;
          body += ch;
        }
        spec = parseSpec(body);
      } else if (fmt[i] === "}") {
        i++;
      } else if (i >= fmt.length) {
        throw new FormatError("unterminated field");
      } else {
        throw new FormatError("expected ':' or '}' in field");
      }
      pieces.push({ argId: id ? Number(id) : undefined, spec });
    } else if (c === "}") {
      if (fmt[i] !== "}") throw new FormatError("unmatched '}'");
      lit += "}";
      i++;
    } else {
      lit += c;
    }
  }
  if (lit) pieces.push(lit);
  return pieces;
}

const isAlign = (c: string | undefined): c is Align => c === "<" || c === ">" || c === "^";

function parseSpec(s: string): Spec {
  const chars = [...s];
  let i = 0;
  const spec: Spec = { alt: false, zero: false, width: { kind: "none" }, precision: { kind: "none" } };
  if (isAlign(chars[0])) {
    spec.align = chars[0];
    i = 1;
  } else if (isAlign(chars[1])) {
    if (chars[0] === "{" || chars[0] === "}") throw new FormatError("invalid fill character");
    spec.fill = chars[0];
    spec.align = chars[1];
    i = 2;
  }
  if (chars[i] === "+" || chars[i] === "-" || chars[i] === " ") spec.sign = chars[i++] as Spec["sign"];
  if (chars[i] === "#") {
    spec.alt = true;
    i++;
  }
  if (chars[i] === "0") {
    spec.zero = true;
    i++;
  }
  const parseCount = (): Count => {
    if (chars[i] === "{") {
      i++;
      let id = "";
      while (isDigit(chars[i])) id += chars[i++];
      if (chars[i] !== "}") throw new FormatError("unterminated nested width/precision ref");
      i++;
      return id ? { kind: "explicit", id: Number(id) } : { kind: "auto" };
    }
    let n = "";
    while (isDigit(chars[i])) n += chars[i++];
    return n ? { kind: "literal", n: Number(n) } : { kind: "none" };
  };
  spec.width = parseCount();
  if (chars[i] === ".") {
    i++;
    spec.precision = parseCount();
    if (spec.precision.kind === "none") throw new FormatError("precision without digits");
  }
  const rest = chars.slice(i).join("");
  if (rest.length === 1) {
    if (!SUPPORTED_TYPES.has(rest)) throw new FormatError(`unsupported type '${rest}'`);
    spec.type = rest;
  } else if (rest.length > 1) {
    throw new FormatError(`invalid type '${rest}'`);
  }
  return spec;
}

interface Core {
  numeric: boolean;
  integer: boolean;
  sign: string;
  prefix: string;
  main: string;
}

function renderField(arg: Arg, spec: Spec, width: number | undefined, precision: number | undefined): string {
  const core = renderCore(arg, spec, precision);
  const zeroPad = spec.zero && !spec.align && core.numeric && !(core.integer && precision !== undefined);
  return applyPadding(core, spec, width ?? 0, zeroPad);
}

function renderCore(arg: Arg, spec: Spec, precision: number | undefined): Core {
  switch (arg.kind) {
    case "str": {
      if (spec.type !== undefined && spec.type !== "s") throw new FormatError(`cannot format string as '${spec.type}'`);
      let text = arg.v === null ? "(null)" : argText(arg.v);
      if (precision !== undefined) text = [...text].slice(0, precision).join("");
      return { numeric: false, integer: false, sign: "", prefix: "", main: text };
    }
    case "ptr":
      return renderInt(BigInt(arg.v), spec.type ?? "p", spec, precision, true);
    case "u32":
      return renderInt(BigInt(arg.v), spec.type, spec, precision, false);
    case "u64":
      if (spec.type && "fFeEgG".includes(spec.type)) return renderFloat(arg.v, spec.type, precision, spec.sign);
      return renderInt(arg.v, spec.type, spec, precision, false);
  }
}

function renderInt(v: bigint, type: string | undefined, spec: Spec, precision: number | undefined, isPtr: boolean): Core {
  if (type === "c") {
    const code = Number(BigInt.asUintN(32, v));
    const ch = code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : "�";
    return { numeric: false, integer: false, sign: "", prefix: "", main: ch };
  }
  let digits: string;
  let prefix = "";
  switch (type) {
    case undefined:
    case "d":
      digits = v.toString();
      break;
    case "x":
      digits = v.toString(16);
      if (spec.alt) prefix = "0x";
      break;
    case "X":
      digits = v.toString(16).toUpperCase();
      if (spec.alt) prefix = "0X";
      break;
    case "o":
      digits = v.toString(8);
      if (spec.alt) prefix = "0";
      break;
    case "b":
    case "B":
      digits = v.toString(2);
      if (spec.alt) prefix = type === "b" ? "0b" : "0B";
      break;
    case "p":
      digits = v.toString(16);
      prefix = "0x";
      break;
    case "s":
      throw new FormatError("cannot format integer as string");
    default:
      if (!isPtr && "fFeEgG".includes(type)) throw new FormatError("cannot format 32-bit integer as float");
      throw new FormatError(`unsupported type '${type}'`);
  }
  if (precision !== undefined) {
    if (precision === 0 && v === 0n) digits = "";
    else if (digits.length < precision) digits = digits.padStart(precision, "0");
  }
  const sign = type === "p" ? "" : spec.sign === "+" ? "+" : spec.sign === " " ? " " : "";
  return { numeric: true, integer: true, sign, prefix, main: digits };
}

function renderFloat(bits: bigint, type: string, precision: number | undefined, signFlag: Spec["sign"]): Core {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, bits, true);
  const x = view.getFloat64(0, true);
  const prec = precision ?? 6;
  const negative = (x < 0 || Object.is(x, -0)) && !Number.isNaN(x);
  const a = Math.abs(x);
  let main: string;
  if (Number.isNaN(a)) main = "nan";
  else if (!Number.isFinite(a)) main = "inf";
  else if (type === "f" || type === "F") main = a.toFixed(Math.min(prec, 100));
  else if (type === "e" || type === "E") main = rustExp(a.toExponential(Math.min(prec, 100)));
  else main = rustDebug(a);
  if (type === "F" || type === "E" || type === "G") main = main.toUpperCase();
  const sign = negative ? "-" : signFlag === "+" ? "+" : signFlag === " " ? " " : "";
  return { numeric: true, integer: false, sign, prefix: "", main };
}

/** `1.5e+3` -> `1.5e3`, `1.5e-7` stays: Rust's exponent style. */
function rustExp(s: string): string {
  return s.replace("e+", "e");
}

/** Rust's `{:?}` for f64: shortest round-trip, decimal for 1e-4 <= |x| < 1e16. */
function rustDebug(a: number): string {
  if (a !== 0 && (a < 1e-4 || a >= 1e16)) return rustExp(a.toExponential());
  const s = String(a);
  if (s.includes("e")) {
    // JS switches to exponent form for |x| < 1e-6 or >= 1e21; expand it.
    const [m, e] = s.split("e") as [string, string];
    const exp = Number(e);
    const digits = m.replace(".", "");
    const point = (m.indexOf(".") === -1 ? m.length : m.indexOf(".")) + exp;
    const expanded = point <= 0 ? `0.${"0".repeat(-point)}${digits}` : digits.padEnd(point, "0");
    return expanded.includes(".") ? expanded : `${expanded}.0`;
  }
  return s.includes(".") ? s : `${s}.0`;
}

function applyPadding(core: Core, spec: Spec, width: number, zeroPad: boolean): string {
  const content = core.sign + core.prefix + core.main;
  const len = [...content].length;
  if (width === 0 || len >= width) return content;
  const n = width - len;
  if (zeroPad) return core.sign + core.prefix + "0".repeat(n) + core.main;
  const fill = spec.align ? (spec.fill ?? " ") : " ";
  const align = spec.align ?? (core.numeric ? ">" : "<");
  if (align === "<") return content + fill.repeat(n);
  if (align === ">") return fill.repeat(n) + content;
  const left = Math.floor(n / 2);
  return fill.repeat(left) + content + fill.repeat(n - left);
}
