// C printf rendering for on9log arguments. The wire carries raw 32/64-bit
// values without signedness, so the conversion character and length modifier
// decide how each value is interpreted (ESP32 is 32-bit: long, size_t and
// ptrdiff_t are 32 bits wide). A rendering problem never loses the line: the
// format string is returned with a `<render error: ...>` marker.

import { type Arg, argText, intArg } from "./args.ts";

export const MAX_RENDER_COUNT = 4096;

type Length = "" | "hh" | "h" | "l" | "ll" | "z" | "j" | "t" | "L";

class RenderError extends Error {}

const CONVERSIONS = new Set("diouxXeEfFgGcspn");

/** True if `fmt` contains an active printf conversion (not `%%`). */
export function hasPrintfConversion(fmt: string): boolean {
  let i = 0;
  while (i < fmt.length) {
    if (fmt[i] !== "%") {
      i++;
      continue;
    }
    i++;
    if (i >= fmt.length) break;
    if (fmt[i] === "%") {
      i++;
      continue;
    }
    while (i < fmt.length && "-+ #0".includes(fmt[i]!)) i++;
    if (fmt[i] === "*") i++;
    else while (i < fmt.length && isDigit(fmt[i]!)) i++;
    if (fmt[i] === ".") {
      i++;
      if (fmt[i] === "*") i++;
      else while (i < fmt.length && isDigit(fmt[i]!)) i++;
    }
    while (i < fmt.length && "hljztL".includes(fmt[i]!)) i++;
    if (i < fmt.length && CONVERSIONS.has(fmt[i]!)) return true;
  }
  return false;
}

const isDigit = (c: string) => c >= "0" && c <= "9";

interface Spec {
  minus: boolean;
  plus: boolean;
  space: boolean;
  alt: boolean;
  zero: boolean;
  width: number;
  precision: number | undefined;
  length: Length;
  conv: string;
}

export function renderPrintf(fmt: string, args: Arg[]): string {
  try {
    return render(fmt, args);
  } catch (err) {
    if (err instanceof RenderError) return `<render error: ${err.message}> ${fmt}`;
    throw err;
  }
}

function render(fmt: string, args: Arg[]): string {
  let out = "";
  let ai = 0;
  let i = 0;
  const next = () => (ai < args.length ? args[ai++] : undefined);

  while (i < fmt.length) {
    const c = fmt[i++]!;
    if (c !== "%") {
      out += c;
      continue;
    }
    if (fmt[i] === "%") {
      out += "%";
      i++;
      continue;
    }
    const spec: Spec = { minus: false, plus: false, space: false, alt: false, zero: false, width: 0, precision: undefined, length: "", conv: "" };
    for (;;) {
      const f = fmt[i];
      if (f === "-") spec.minus = true;
      else if (f === "+") spec.plus = true;
      else if (f === " ") spec.space = true;
      else if (f === "#") spec.alt = true;
      else if (f === "0") spec.zero = true;
      else break;
      i++;
    }
    if (fmt[i] === "*") {
      i++;
      const w = intArg(next());
      if (w < 0n) spec.minus = true;
      spec.width = Math.min(Number(w < 0n ? -w : w), MAX_RENDER_COUNT);
    } else {
      while (i < fmt.length && isDigit(fmt[i]!)) spec.width = Math.min(spec.width * 10 + Number(fmt[i++]), MAX_RENDER_COUNT);
    }
    if (fmt[i] === ".") {
      i++;
      if (fmt[i] === "*") {
        i++;
        const p = intArg(next());
        spec.precision = p < 0n ? undefined : Math.min(Number(p), MAX_RENDER_COUNT);
      } else {
        let p = 0;
        while (i < fmt.length && isDigit(fmt[i]!)) p = Math.min(p * 10 + Number(fmt[i++]), MAX_RENDER_COUNT);
        spec.precision = p;
      }
    }
    for (const len of ["hh", "ll", "h", "l", "z", "j", "t", "L"] as const) {
      if (fmt.startsWith(len, i)) {
        spec.length = len;
        i += len.length;
        break;
      }
    }
    if (i >= fmt.length) throw new RenderError("incomplete conversion");
    spec.conv = fmt[i++]!;
    if (!CONVERSIONS.has(spec.conv)) throw new RenderError(`unsupported conversion '${spec.conv}'`);
    if (spec.conv === "n") continue;
    const arg = next();
    if (!arg) throw new RenderError("missing argument");
    out += convert(spec, arg);
  }
  return out;
}

function rawBits(arg: Arg): bigint {
  switch (arg.kind) {
    case "u32":
    case "ptr":
      return BigInt(arg.v);
    case "u64":
      return arg.v;
    case "str":
      throw new RenderError("string passed to a numeric conversion");
  }
}

function signedValue(v: bigint, len: Length): bigint {
  if (len === "hh") return BigInt.asIntN(8, v);
  if (len === "h") return BigInt.asIntN(16, v);
  if (len === "ll" || len === "j") return BigInt.asIntN(64, v);
  return BigInt.asIntN(32, v);
}

function unsignedValue(v: bigint, len: Length): bigint {
  if (len === "hh") return BigInt.asUintN(8, v);
  if (len === "h") return BigInt.asUintN(16, v);
  if (len === "ll" || len === "j") return BigInt.asUintN(64, v);
  return BigInt.asUintN(32, v);
}

function convert(spec: Spec, arg: Arg): string {
  switch (spec.conv) {
    case "s": {
      if (arg.kind !== "str") throw new RenderError("non-string passed to %s");
      let text = arg.v === null ? "(null)" : argText(arg.v);
      if (spec.precision !== undefined) text = [...text].slice(0, spec.precision).join("");
      return pad(text, spec, false);
    }
    case "c": {
      const code = Number(BigInt.asUintN(32, rawBits(arg)));
      const ch = code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : "�";
      return pad(ch, spec, false);
    }
    case "p":
      return pad("0x" + rawBits(arg).toString(16), spec, false);
    case "d":
    case "i": {
      const v = signedValue(rawBits(arg), spec.length);
      const sign = v < 0n ? "-" : spec.plus ? "+" : spec.space ? " " : "";
      return integer(sign, "", (v < 0n ? -v : v).toString(), v === 0n, spec);
    }
    case "u":
    case "x":
    case "X":
    case "o": {
      const v = unsignedValue(rawBits(arg), spec.length);
      let digits = spec.conv === "u" ? v.toString() : spec.conv === "o" ? v.toString(8) : v.toString(16);
      if (spec.conv === "X") digits = digits.toUpperCase();
      let prefix = "";
      if (spec.alt && v !== 0n && spec.conv === "x") prefix = "0x";
      if (spec.alt && v !== 0n && spec.conv === "X") prefix = "0X";
      if (spec.alt && spec.conv === "o" && !digits.startsWith("0")) digits = "0" + digits;
      return integer("", prefix, digits, v === 0n, spec);
    }
    default: {
      // Floating point: floats are promoted to double, so the value is 64-bit.
      if (arg.kind !== "u64") throw new RenderError("non-double passed to a float conversion");
      const view = new DataView(new ArrayBuffer(8));
      view.setBigUint64(0, arg.v, true);
      return float(view.getFloat64(0, true), spec);
    }
  }
}

function integer(sign: string, prefix: string, digits: string, isZero: boolean, spec: Spec): string {
  if (spec.precision !== undefined) {
    if (spec.precision === 0 && isZero) digits = "";
    else if (digits.length < spec.precision) digits = digits.padStart(spec.precision, "0");
  }
  const body = sign + prefix + digits;
  if (spec.zero && !spec.minus && spec.precision === undefined && body.length < spec.width) {
    return sign + prefix + digits.padStart(spec.width - sign.length - prefix.length, "0");
  }
  return pad(body, spec, true);
}

function pad(text: string, spec: Spec, _numeric: boolean): string {
  const len = [...text].length;
  if (len >= spec.width) return text;
  const fill = " ".repeat(spec.width - len);
  return spec.minus ? text + fill : fill + text;
}

function float(x: number, spec: Spec): string {
  const upper = spec.conv === "F" || spec.conv === "E" || spec.conv === "G";
  const negative = x < 0 || Object.is(x, -0);
  const sign = negative ? "-" : spec.plus ? "+" : spec.space ? " " : "";
  const a = Math.abs(x);
  let body: string;
  if (!Number.isFinite(a)) {
    body = Number.isNaN(a) ? "nan" : "inf";
    if (upper) body = body.toUpperCase();
    return pad(sign + body, { ...spec, zero: false }, true);
  }
  const prec = spec.precision ?? 6;
  switch (spec.conv.toLowerCase()) {
    case "f":
      body = fixed(a, prec);
      break;
    case "e":
      body = exponential(a, prec);
      break;
    default: {
      // %g: shortest of %e / %f with `prec` significant digits, trailing zeros removed.
      const p = prec === 0 ? 1 : prec;
      const exp = a === 0 ? 0 : Number(a.toExponential(p - 1).split("e")[1]);
      body = exp < -4 || exp >= p ? exponential(a, p - 1) : fixed(a, p - 1 - exp);
      if (!spec.alt && body.includes(".")) body = body.replace(/\.?0+(e|$)/, "$1");
    }
  }
  if (spec.alt && !body.includes(".") && !body.includes("e")) body += ".";
  if (upper) body = body.toUpperCase();
  if (spec.zero && !spec.minus && sign.length + body.length < spec.width) {
    return sign + body.padStart(spec.width - sign.length, "0");
  }
  return pad(sign + body, spec, true);
}

function fixed(a: number, prec: number): string {
  if (a < 1e21) return a.toFixed(Math.min(prec, 100));
  // toFixed switches to exponent notation above 1e21; expand the integer part.
  const int = BigInt(Math.round(a)).toString();
  return prec > 0 ? `${int}.${"0".repeat(prec)}` : int;
}

function exponential(a: number, prec: number): string {
  const [mantissa, exp] = a.toExponential(Math.min(prec, 100)).split("e") as [string, string];
  const n = Number(exp);
  return `${mantissa}e${n < 0 ? "-" : "+"}${String(Math.abs(n)).padStart(2, "0")}`;
}
