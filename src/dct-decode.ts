// Shared DCT block-stream decoding (spec §3.4.2), used by both the full
// decoder and the streaming decoder. Arithmetic here must stay bit-exact
// with qov.h and the C# implementation.

import { ZIGZAG, inverseDCTRaw } from './dct';
import { QOV_OP_DCT_SKIP, QOV_OP_DCT_ZERO } from './qov-types';
import { BitReader } from './exp-golomb';

/**
 * Intra DC prediction (spec §3.4.3): mean of the reconstructed left column /
 * top row, integer round-half-up throughout, 128 with no neighbor. Pure
 * integer math = bit-exact across implementations.
 */
export function intraPred(plane: Uint8Array, w: number, h: number, x0: number, y0: number): number {
  let lsum = 0, tsum = 0;
  let lcount = 0, tcount = 0;
  if (x0 > 0) {
    for (let yy = 0; yy < 8 && y0 + yy < h; yy++) { lsum += plane[(y0 + yy) * w + x0 - 1]; lcount++; }
  }
  if (y0 > 0) {
    for (let xx = 0; xx < 8 && x0 + xx < w; xx++) { tsum += plane[(y0 - 1) * w + x0 + xx]; tcount++; }
  }
  if (lcount && tcount) {
    const lm = Math.floor((2 * lsum + lcount) / (2 * lcount));
    const tm = Math.floor((2 * tsum + tcount) / (2 * tcount));
    return (lm + tm + 1) >> 1;
  }
  if (lcount) return Math.floor((2 * lsum + lcount) / (2 * lcount));
  if (tcount) return Math.floor((2 * tsum + tcount) / (2 * tcount));
  return 128;
}

/**
 * Decodes one DCT block (QP delta + DC + run-level AC pairs) and writes the
 * dequantized, inverse-transformed residual into `out` (64 floats).
 */
export function decodeDctBlockInto(
  readU8: () => number,
  quantTable: number[],
  qpBase: number,
  out: Float32Array,
  eg = false,
): void {
  // 1. QP delta (1 byte: | 0 | delta (7 bits, bias 64) | )
  const qpByte = readU8();
  const qpDelta = (qpByte & 0x7F) - 64;
  const finalQp = Math.max(0, Math.min(100, qpBase + qpDelta));

  // Inverse of the encoder's quantization scale (encoder divides by this).
  const scale = 0.1 + (finalQp * 0.1);

  const coeffs = new Float32Array(64);

  if (eg) {
    // Exp-Golomb coefficient section (spec 3.4.5)
    const r = new BitReader(readU8);
    coeffs[0] = r.se() * quantTable[0] * scale;
    let k = 1;
    for (;;) {
      const run = r.ue();
      if (run >= 64 - k) break; // EOB sentinel ue(64-k)
      k += run;
      const level = r.se();
      coeffs[ZIGZAG[k]] = level * quantTable[ZIGZAG[k]] * scale;
      k++;
      if (k >= 64) break; // defensive; canonical streams hit the sentinel
    }
    inverseDCTRaw(coeffs, out);
    return;
  }

  // 2. DC Coeff (2 bytes, signed 16-bit)
  const dcRaw = (readU8() << 8) | readU8();
  const dc = (dcRaw & 0x8000) ? dcRaw - 65536 : dcRaw;

  coeffs[0] = dc * quantTable[0] * scale;

  // 3. AC Coeffs (Run-Level)
  let k = 1;
  while (k < 64) {
    const b1 = readU8();

    if (b1 === 0x00) {
      // EOB
      break;
    }
    if (b1 === 0xF0) {
      // Zero run of 16
      k += 16;
      continue;
    }

    const run = (b1 >> 4) & 0x0F;
    const size = b1 & 0x0F;

    k += run;
    if (k >= 64) break;

    // Level: 'size' big-endian bytes, signed
    let level = 0;
    if (size > 0) {
      let rawLevel = 0;
      for (let i = 0; i < size; i++) {
        rawLevel = (rawLevel << 8) | readU8();
      }
      if (size === 1) level = (rawLevel & 0x80) ? rawLevel - 256 : rawLevel;
      else if (size === 2) level = (rawLevel & 0x8000) ? rawLevel - 65536 : rawLevel;
      else if (size === 3) level = (rawLevel & 0x800000) ? rawLevel - 16777216 : rawLevel;
      else level = rawLevel; // size 4: JS bitwise ops already produce a signed int32
    }

    coeffs[ZIGZAG[k]] = level * quantTable[ZIGZAG[k]] * scale;
    k++;
  }

  inverseDCTRaw(coeffs, out);
}

/**
 * Decodes a full plane of DCT blocks (SKIP/ZERO runs + per-block residuals
 * added to the reference copy already present in `plane`). Blocks whose row
 * lies inside [bandR0, bandR1) are refresh-band blocks (spec §3.4.4): skips
 * fill them with the DC prediction instead of the reference, and coded
 * blocks add the residual to the prediction.
 */
export function decodePlaneDctInto(
  readU8: () => number,
  plane: Uint8Array,
  w: number,
  h: number,
  quant: number[],
  opType: number,
  qpBase: number,
  blockBuf: Float32Array,
  bandR0 = -1,
  bandR1 = -1,
  eg = false,
): void {
  const blocksX = Math.ceil(w / 8);
  const blocksY = Math.ceil(h / 8);
  let blockIdx = 0;
  const totalBlocks = blocksX * blocksY;

  while (blockIdx < totalBlocks) {
    const b1 = readU8();
    if (b1 === QOV_OP_DCT_SKIP) {
      // QOV_OP_DCT_SKIP: run of blocks copied from the reference — except
      // inside a refresh band, where each skipped block is a prediction fill
      // (a single run may straddle a band boundary)
      const count = readU8();
      for (let n = 0; n < count && blockIdx < totalBlocks; n++, blockIdx++) {
        const blockRow = Math.floor(blockIdx / blocksX);
        if (blockRow < bandR0 || blockRow >= bandR1) continue;
        const bx = (blockIdx % blocksX) * 8;
        const by = blockRow * 8;
        const pred = intraPred(plane, w, h, bx, by);
        for (let y = 0; y < 8; y++) {
          if (by + y >= h) break;
          for (let x = 0; x < 8; x++) {
            if (bx + x >= w) break;
            plane[(by + y) * w + bx + x] = pred;
          }
        }
      }
    } else if (b1 === QOV_OP_DCT_ZERO) {
      // QOV_OP_DCT_ZERO: zero residual = reference copy (already in place)
      blockIdx += readU8();
    } else if (b1 === opType) {
      const bx = (blockIdx % blocksX) * 8;
      const by = Math.floor(blockIdx / blocksX) * 8;
      const blockRow = Math.floor(blockIdx / blocksX);
      const inBand = blockRow >= bandR0 && blockRow < bandR1;
      const pred = inBand ? intraPred(plane, w, h, bx, by) : 0;
      decodeDctBlockInto(readU8, quant, qpBase, blockBuf, eg);

      for (let y = 0; y < 8; y++) {
        if (by + y >= h) break;
        for (let x = 0; x < 8; x++) {
          if (bx + x >= w) break;
          const idx = (by + y) * w + (bx + x);
          const res = blockBuf[y * 8 + x];
          const base = inBand ? pred : plane[idx];
          plane[idx] = Math.max(0, Math.min(255, base + res));
        }
      }
      blockIdx++;
    } else {
      console.warn(`Unexpected opcode 0x${b1.toString(16)} in DCT block stream at block ${blockIdx}`);
      blockIdx++;
    }
  }
}

/**
 * Intra DCT plane decoder (spec §3.4.3): raster-order reconstruction. The
 * skip opcodes fill the block with the DC prediction; coded blocks add the
 * residual to it. `plane` must be writable scratch (fully overwritten).
 */
export function decodeIntraPlaneDctInto(
  readU8: () => number,
  plane: Uint8Array,
  w: number,
  h: number,
  quant: number[],
  opType: number,
  qpBase: number,
  blockBuf: Float32Array,
  eg = false,
): void {
  const blocksX = Math.ceil(w / 8);
  const blocksY = Math.ceil(h / 8);
  let blockIdx = 0;
  const totalBlocks = blocksX * blocksY;

  while (blockIdx < totalBlocks) {
    const b1 = readU8();
    if (b1 === QOV_OP_DCT_SKIP || b1 === QOV_OP_DCT_ZERO) {
      const count = readU8();
      for (let n = 0; n < count && blockIdx < totalBlocks; n++, blockIdx++) {
        const bx = (blockIdx % blocksX) * 8;
        const by = Math.floor(blockIdx / blocksX) * 8;
        const pred = intraPred(plane, w, h, bx, by);
        for (let y = 0; y < 8; y++) {
          if (by + y >= h) break;
          for (let x = 0; x < 8; x++) {
            if (bx + x >= w) break;
            plane[(by + y) * w + bx + x] = pred;
          }
        }
      }
    } else if (b1 === opType) {
      const bx = (blockIdx % blocksX) * 8;
      const by = Math.floor(blockIdx / blocksX) * 8;
      const pred = intraPred(plane, w, h, bx, by);
      decodeDctBlockInto(readU8, quant, qpBase, blockBuf, eg);
      for (let y = 0; y < 8; y++) {
        if (by + y >= h) break;
        for (let x = 0; x < 8; x++) {
          if (bx + x >= w) break;
          const idx = (by + y) * w + bx + x;
          // mirror TS decoder semantics: double-precision add, truncate
          plane[idx] = Math.max(0, Math.min(255, pred + blockBuf[y * 8 + x]));
        }
      }
      blockIdx++;
    } else {
      console.warn(`Unexpected opcode 0x${b1.toString(16)} in intra DCT block stream at block ${blockIdx}`);
      blockIdx++;
    }
  }
}
