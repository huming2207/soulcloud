// Address -> string lookup in a firmware ELF (32- or 64-bit, little-endian).
//
// on9log sends only the addresses of its tag and format strings. Format strings
// live in ELF-only `.noload*` sections; tags live in ordinary read-only data.

interface Section {
  name: string;
  addr: number;
  end: number;
  data: Uint8Array;
}

const SHT_NOBITS = 8;
const utf8 = new TextDecoder("utf-8", { fatal: true });

const isNoload = (name: string) => name.includes(".noload");

export class ElfStrings {
  private readonly sections: Section[];

  private constructor(sections: Section[]) {
    this.sections = sections.sort((a, b) => a.addr - b.addr);
  }

  static parse(bytes: Uint8Array): ElfStrings {
    if (bytes.length < 64 || bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46) {
      throw new Error("not an ELF file");
    }
    const is64 = bytes[4] === 2;
    if (bytes[5] !== 1) throw new Error("only little-endian ELF files are supported");
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const num = (off: number, wide: boolean) => (wide ? Number(v.getBigUint64(off, true)) : v.getUint32(off, true));

    const shoff = num(is64 ? 0x28 : 0x20, is64);
    const shentsize = v.getUint16(is64 ? 0x3a : 0x2e, true);
    const shnum = v.getUint16(is64 ? 0x3c : 0x30, true);
    const shstrndx = v.getUint16(is64 ? 0x3e : 0x32, true);

    const header = (i: number) => {
      const at = shoff + i * shentsize;
      return {
        name: v.getUint32(at, true),
        type: v.getUint32(at + 4, true),
        addr: num(at + (is64 ? 16 : 12), is64),
        offset: num(at + (is64 ? 24 : 16), is64),
        size: num(at + (is64 ? 32 : 20), is64),
      };
    };
    if (shoff + shnum * shentsize > bytes.length) throw new Error("truncated ELF section table");

    const strtab = header(shstrndx);
    const nameAt = (off: number) => {
      const start = strtab.offset + off;
      const end = bytes.indexOf(0, start);
      return new TextDecoder().decode(bytes.subarray(start, end === -1 ? start : end));
    };

    const sections: Section[] = [];
    for (let i = 0; i < shnum; i++) {
      const sh = header(i);
      const name = nameAt(sh.name);
      if (sh.size === 0 || sh.type === SHT_NOBITS) continue;
      // Wire addresses are 32-bit; ESP-IDF no-load sections sit at VMA 0.
      const addr = sh.addr > 0xffffffff ? 0 : sh.addr;
      if (addr === 0 && !isNoload(name)) continue;
      if (sh.offset >= bytes.length || sh.offset + sh.size > bytes.length) continue;
      sections.push({
        name,
        addr,
        end: Math.min(addr + sh.size, 0xffffffff),
        data: bytes.subarray(sh.offset, sh.offset + sh.size),
      });
    }
    return new ElfStrings(sections);
  }

  /** Format strings: the `.noload` sections first, then any section. */
  readFormat(addr: number): string | null {
    return this.read(addr, isNoload) ?? this.read(addr, () => true);
  }

  /** Tag strings live in ordinary sections. */
  readTag(addr: number): string | null {
    return this.read(addr, (name) => !isNoload(name));
  }

  private read(addr: number, matches: (name: string) => boolean): string | null {
    let found: string | null = null;
    for (const s of this.sections) {
      if (!matches(s.name) || addr < s.addr || addr >= s.end) continue;
      const str = cstr(s.data, addr - s.addr);
      if (str === null) return null;
      if (found !== null && found !== str) return null; // ambiguous
      found = str;
    }
    return found;
  }
}

function cstr(data: Uint8Array, offset: number): string | null {
  const end = data.indexOf(0, offset);
  const bytes = data.subarray(offset, end === -1 ? data.length : end);
  if (bytes.length === 0) return null;
  try {
    return utf8.decode(bytes);
  } catch {
    return null;
  }
}
