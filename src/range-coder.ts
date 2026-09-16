// Order-0 adaptive range coder (spec v3.8 section 2.2, chunk flag 0x08).
// Byte-oriented adaptive model: 256 frequencies starting at 1, +32 per
// symbol, halved when the total passes 65536. LZMA-style 32-bit range with
// carry cache; `low` stays <= 2^40 so plain numbers stay exact. Integer
// math only — must mirror qov.h / QovRangeCoder.cs bit-exactly.

const RC_TOP = 1 << 24;
const RC_STEP = 32;
const RC_LIMIT = 1 << 16;

class RcModel {
  freq = new Uint32Array(256).fill(1);
  cum = new Uint32Array(257);
  total = 256;

  constructor() {
    for (let i = 0; i <= 256; i++) this.cum[i] = i;
  }

  update(s: number): void {
    this.freq[s] += RC_STEP;
    this.total += RC_STEP;
    if (this.total > RC_LIMIT) {
      this.total = 0;
      for (let i = 0; i < 256; i++) {
        this.freq[i] = (this.freq[i] + 1) >>> 1;
        this.total += this.freq[i];
      }
    }
    this.cum[0] = 0;
    for (let i = 0; i < 256; i++) this.cum[i + 1] = this.cum[i] + this.freq[i];
  }
}

export function rangeEncode(input: Uint8Array): Uint8Array {
  const model = new RcModel();
  const out: number[] = [];
  let low = 0;          // <= 2^40, exact as a Number
  let range = 0xFFFFFFFF;
  let cache = 0;
  let cacheSize = 1;

  const shiftLow = (): void => {
    if (low % 4294967296 < 0xFF000000 || low >= 4294967296) {
      const carry = Math.floor(low / 4294967296);
      let temp = cache;
      do {
        out.push((temp + carry) & 0xFF);
        temp = 0xFF;
      } while (--cacheSize !== 0);
      cache = Math.floor(low / 16777216) & 0xFF;
    }
    cacheSize++;
    // C semantics: (uint32_t)low << 8 — the shift truncates to 32 bits
    low = ((low % 4294967296) * 256) % 4294967296;
  };

  for (let i = 0; i < input.length; i++) {
    const s = input[i];
    range = Math.floor(range / model.total);
    low += model.cum[s] * range;
    range = range * model.freq[s];
    while (range < RC_TOP) { shiftLow(); range = range * 256; }
    model.update(s);
  }
  for (let i = 0; i < 5; i++) shiftLow();

  return Uint8Array.from(out);
}

export function rangeDecode(input: Uint8Array, rawLen: number): Uint8Array {
  const model = new RcModel();
  const out = new Uint8Array(rawLen);
  let pos = 0;
  const next = (): number => (pos < input.length ? input[pos++] : 0);

  let range = 0xFFFFFFFF;
  pos++; // first encoder byte is the initial cache
  let code = 0;
  for (let i = 0; i < 4; i++) code = code * 256 + next();

  for (let i = 0; i < rawLen; i++) {
    range = Math.floor(range / model.total);
    let v = Math.floor(code / range);
    if (v >= model.total) v = model.total - 1;
    let s = 0;
    while (model.cum[s + 1] <= v) s++;
    code -= model.cum[s] * range;
    range = range * model.freq[s];
    while (range < RC_TOP) { code = code * 256 + next(); range = range * 256; }
    model.update(s);
    out[i] = s;
  }
  return out;
}
