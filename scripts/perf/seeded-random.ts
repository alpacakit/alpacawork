/** MT19937 with Python's integer seeding and sampling, preserving existing synthetic trees. */
export class SeededRandom {
  private readonly state = new Uint32Array(624);
  private index = 624;

  constructor(seed: number) {
    this.state[0] = 19650218;
    for (let i = 1; i < 624; i++) this.state[i] = (Math.imul(this.state[i - 1] ^ (this.state[i - 1] >>> 30), 1812433253) + i) >>> 0;
    let i = 1;
    for (let k = 624; k; k--) {
      this.state[i] = ((this.state[i] ^ Math.imul(this.state[i - 1] ^ (this.state[i - 1] >>> 30), 1664525)) + seed) >>> 0;
      if (++i >= 624) { this.state[0] = this.state[623]; i = 1; }
    }
    for (let k = 623; k; k--) {
      this.state[i] = ((this.state[i] ^ Math.imul(this.state[i - 1] ^ (this.state[i - 1] >>> 30), 1566083941)) - i) >>> 0;
      if (++i >= 624) { this.state[0] = this.state[623]; i = 1; }
    }
    this.state[0] = 0x80000000;
  }

  private word(): number {
    if (this.index >= 624) {
      for (let i = 0; i < 624; i++) {
        const value = (this.state[i] & 0x80000000) | (this.state[(i + 1) % 624] & 0x7fffffff);
        this.state[i] = this.state[(i + 397) % 624] ^ (value >>> 1) ^ (value & 1 ? 0x9908b0df : 0);
      }
      this.index = 0;
    }
    let value = this.state[this.index++];
    value ^= value >>> 11;
    value ^= (value << 7) & 0x9d2c5680;
    value ^= (value << 15) & 0xefc60000;
    value ^= value >>> 18;
    return value >>> 0;
  }

  random(): number {
    return ((this.word() >>> 5) * 67108864 + (this.word() >>> 6)) / 9007199254740992;
  }

  range(start: number, stop: number): number {
    const width = stop - start, bits = Math.floor(Math.log2(width)) + 1;
    let value: number;
    do { value = this.word() >>> (32 - bits); } while (value >= width);
    return start + value;
  }
}
