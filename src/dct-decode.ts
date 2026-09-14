// Shared DCT block-stream decoding (spec §3.4.2), used by both the full
// decoder and the streaming decoder. Arithmetic here must stay bit-exact
// with qov.h and the C# implementation.

import { ZIGZAG, inverseDCTRaw } from './dct';
import { QOV_OP_DCT_SKIP, QOV_OP_DCT_ZERO } from './qov-types';

/**
 * Decodes one DCT block (QP delta + DC + run-level AC pairs) and writes the
 * dequantized, inverse-transformed residual into `out` (64 floats).
 */
export function decodeDctBlockInto(
  readU8: () => number,
  quantTable: number[],
  qpBase: number,
  out: Float32Array,
): void {
  // 1. QP delta (1 byte: | 0 | delta (7 bits, bias 64) | )
  const qpByte = readU8();
  const qpDelta = (qpByte & 0x7F) - 64;
  const finalQp = Math.max(0, Math.min(100, qpBase + qpDelta));

  // Inverse of the encoder's quantization scale (encoder divides by this).
  const scale = 0.1 + (finalQp * 0.1);

  // 2. DC Coeff (2 bytes, signed 16-bit)
  const dcRaw = (readU8() << 8) | readU8();
  const dc = (dcRaw & 0x8000) ? dcRaw - 65536 : dcRaw;

  const coeffs = new Float32Array(64);
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
 * added to the reference copy already present in `plane`).
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
): void {
  const blocksX = Math.ceil(w / 8);
  const blocksY = Math.ceil(h / 8);
  let blockIdx = 0;
  const totalBlocks = blocksX * blocksY;

  while (blockIdx < totalBlocks) {
    const b1 = readU8();
    if (b1 === QOV_OP_DCT_SKIP) {
      // QOV_OP_DCT_SKIP: run of blocks copied from the reference
      blockIdx += readU8();
    } else if (b1 === QOV_OP_DCT_ZERO) {
      // QOV_OP_DCT_ZERO: zero residual = reference copy (already in place)
      blockIdx += readU8();
    } else if (b1 === opType) {
      decodeDctBlockInto(readU8, quant, qpBase, blockBuf);
      const bx = (blockIdx % blocksX) * 8;
      const by = Math.floor(blockIdx / blocksX) * 8;

      for (let y = 0; y < 8; y++) {
        if (by + y >= h) break;
        for (let x = 0; x < 8; x++) {
          if (bx + x >= w) break;
          const idx = (by + y) * w + (bx + x);
          const res = blockBuf[y * 8 + x];
          plane[idx] = Math.max(0, Math.min(255, plane[idx] + res));
        }
      }
      blockIdx++;
    } else {
      console.warn(`Unexpected opcode 0x${b1.toString(16)} in DCT block stream at block ${blockIdx}`);
      blockIdx++;
    }
  }
}
