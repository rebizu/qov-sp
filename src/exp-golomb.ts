// Exp-Golomb bit I/O over byte closures (spec §3.4.5).
// ue(v): v+1 in binary prefixed with bitlength(v+1)-1 zeros;
// se(v): v>0 -> ue(2v-1), else ue(-2v).
// MSB-first, zero-padded to a byte boundary at the end of each DCT block's
// coefficient section so opcode framing stays byte-aligned. Integer-only;
// must stay bit-exact with qov.h and the C# implementation.

export class BitWriter {
  readonly bytes: number[] = [];
  private acc = 0;
  private nbits = 0;

  private bit(b: number): void {
    this.acc = ((this.acc << 1) | b) & 0xff;
    if (++this.nbits === 8) {
      this.bytes.push(this.acc);
      this.acc = 0;
      this.nbits = 0;
    }
  }

  put(v: number, n: number): void {
    for (let i = n - 1; i >= 0; i--) this.bit((v >>> i) & 1);
  }

  ue(v: number): void {
    const x = v + 1;
    let n = 0;
    while (Math.floor(x / (2 ** (n + 1))) !== 0) n++;
    for (let i = 0; i < n; i++) this.bit(0);
    this.put(x, n + 1);
  }

  se(v: number): void {
    this.ue(v <= 0 ? -2 * v : 2 * v - 1);
  }

  flush(): number[] {
    while (this.nbits !== 0) this.bit(0);
    return this.bytes;
  }
}

export class BitReader {
  private acc = 0;
  private nbits = 0;

  constructor(private readonly readU8: () => number) {}

  private bit(): number {
    if (this.nbits === 0) {
      this.acc = this.readU8();
      this.nbits = 8;
    }
    this.nbits--;
    return (this.acc >>> this.nbits) & 1;
  }

  ue(): number {
    let zeros = 0;
    while (this.bit() === 0) {
      if (++zeros > 31) return 0xffffffff;
    }
    let v = 1;
    for (let i = 0; i < zeros; i++) v = (v << 1) | this.bit();
    return v - 1;
  }

  se(): number {
    const u = this.ue();
    return (u & 1) ? (u >> 1) + 1 : -(u >> 1);
  }
}
