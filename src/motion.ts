// Motion estimation and compensation for QOV motion P-frames (spec v3.2 §5.2)

import {
  QOV_COLORSPACE_YUV420,
  QOV_COLORSPACE_YUV422,
  QOV_COLORSPACE_YUVA420,
} from './qov-types';

export interface MotionVectors {
  blockSize: number;      // 8, 16, or 32
  gridW: number;
  gridH: number;
  vx: Int8Array;          // row-major over the grid, unwritten entries are (0,0);
  vy: Int8Array;          // half-pel mode: u = 2*vx + hx displacement in half-pel units
  halfPel: boolean;       // true when vectors are in half-pel units (MV id 3)
}

export interface MotionEstimateOptions {
  sadSkipThreshold: number;  // sampled SAD below this treats a block as unmoved
  useDiamond: boolean;       // allow local diamond search (lossy mode)
  minMovedBlocks: number;    // below this many moved blocks, estimation returns null
  halfPel: boolean;          // refine vectors to half-pel with full-block SAD (lossy YUV mode)
}

const BLOCK_SIZE = 16;
const MAX_VECTOR = 127;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// How chroma planes sample the luma vector field: scale maps a chroma pixel to
// its corresponding luma pixel, shift is the per-axis mv_luma >> shift derivation.
export function chromaMotionParams(colorspace: number): { sx: number; sy: number; shx: number; shy: number } {
  if (colorspace === QOV_COLORSPACE_YUV420 || colorspace === QOV_COLORSPACE_YUVA420) return { sx: 2, sy: 2, shx: 1, shy: 1 };
  if (colorspace === QOV_COLORSPACE_YUV422) return { sx: 2, sy: 1, shx: 1, shy: 0 };
  return { sx: 1, sy: 1, shx: 0, shy: 0 };
}

// Sampled SAD of the block at (bx,by) between two planes, comparing curr(bx,by)
// against prev(bx+dx, by+dy) with border clamping.
function sadAt(curr: Uint8Array, prev: Uint8Array, w: number, h: number, bx: number, by: number, bw: number, bh: number, dx: number, dy: number): number {
  const pts = [[0, 0], [bw - 1, 0], [0, bh - 1], [bw - 1, bh - 1], [bw >> 1, bh >> 1]];
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const px = clamp(bx + pts[i][0], 0, w - 1);
    const py = clamp(by + pts[i][1], 0, h - 1);
    const sx = clamp(bx + pts[i][0] + dx, 0, w - 1);
    const sy = clamp(by + pts[i][1] + dy, 0, h - 1);
    sum += Math.abs(curr[py * w + px] - prev[sy * w + sx]);
  }
  return sum;
}

function blockHash(plane: Uint8Array, w: number, bx: number, by: number, bw: number, bh: number): number {
  const pts = [[0, 0], [bw - 1, 0], [0, bh - 1], [bw - 1, bh - 1], [bw >> 1, bh >> 1]];
  let key = 0;
  for (let i = 0; i < pts.length; i++) {
    key = (key * 31 + plane[(by + pts[i][1]) * w + (bx + pts[i][0])]) | 0;
  }
  return key;
}

// Full-block SAD at a displacement given in half-pel units (u, v): the integer
// part floors (u >> 1) and the odd bit selects bilinear interpolation between
// neighbouring reference pixels. Border-clamped on all four taps. This is the
// normative refinement metric (spec v3.6 §5.2): candidates are scored against
// the true block residual, not the sampled search SAD.
function sadFullAt(curr: Uint8Array, prev: Uint8Array, w: number, h: number, bx: number, by: number, bw: number, bh: number, u: number, v: number): number {
  const fx = u >> 1, fy = v >> 1;
  const hx = u & 1, hy = v & 1;
  let sum = 0;
  for (let y = 0; y < bh; y++) {
    const baseY = by + y + fy;
    const sy0 = clamp(baseY, 0, h - 1);
    const sy1 = clamp(baseY + 1, 0, h - 1);
    for (let x = 0; x < bw; x++) {
      const baseX = bx + x + fx;
      const sx0 = clamp(baseX, 0, w - 1);
      const sx1 = clamp(baseX + 1, 0, w - 1);
      const a = prev[sy0 * w + sx0];
      let s: number;
      if (hx === 0 && hy === 0) {
        s = a;
      } else if (hx === 0) {
        s = (a + prev[sy1 * w + sx0] + 1) >> 1;
      } else if (hy === 0) {
        s = (a + prev[sy0 * w + sx1] + 1) >> 1;
      } else {
        s = (a + prev[sy0 * w + sx1] + prev[sy1 * w + sx0] + prev[sy1 * w + sx1] + 2) >> 2;
      }
      const d = curr[(by + y) * w + (bx + x)] - s;
      sum += d < 0 ? -d : d;
    }
  }
  return sum;
}

// Estimate 16x16 motion vectors between two single-channel planes.
// Returns null when too few blocks move — the caller should emit a plain P-frame.
export function estimateMotion(curr: Uint8Array, prev: Uint8Array, w: number, h: number, opts: MotionEstimateOptions): MotionVectors | null {
  const gridW = Math.ceil(w / BLOCK_SIZE);
  const gridH = Math.ceil(h / BLOCK_SIZE);
  const vx = new Int8Array(gridW * gridH);
  const vy = new Int8Array(gridW * gridH);

  // Hash every previous-frame block by its sampled content
  const table = new Map<number, number[]>();
  for (let gbY = 0; gbY < gridH; gbY++) {
    for (let gbX = 0; gbX < gridW; gbX++) {
      const bw = Math.min(BLOCK_SIZE, w - gbX * BLOCK_SIZE);
      const bh = Math.min(BLOCK_SIZE, h - gbY * BLOCK_SIZE);
      const key = blockHash(prev, w, gbX * BLOCK_SIZE, gbY * BLOCK_SIZE, bw, bh);
      const list = table.get(key);
      if (list) list.push(gbY * gridW + gbX); else table.set(key, [gbY * gridW + gbX]);
    }
  }

  let moved = 0;
  for (let gbY = 0; gbY < gridH; gbY++) {
    for (let gbX = 0; gbX < gridW; gbX++) {
      const bx = gbX * BLOCK_SIZE, by = gbY * BLOCK_SIZE;
      const bw = Math.min(BLOCK_SIZE, w - bx);
      const bh = Math.min(BLOCK_SIZE, h - by);

      const sad0 = sadAt(curr, prev, w, h, bx, by, bw, bh, 0, 0);
      if (sad0 <= opts.sadSkipThreshold) continue;

      let bestVx = 0, bestVy = 0, bestSad = sad0;

      // Exact-content candidates from the previous frame
      const key = blockHash(curr, w, bx, by, bw, bh);
      const candidates = table.get(key);
      if (candidates) {
        for (const cand of candidates) {
          const cx = cand % gridW, cy = Math.floor(cand / gridW);
          const dx = cx * BLOCK_SIZE - bx, dy = cy * BLOCK_SIZE - by;
          if (Math.abs(dx) > MAX_VECTOR || Math.abs(dy) > MAX_VECTOR) continue;
          const s = sadAt(curr, prev, w, h, bx, by, bw, bh, dx, dy);
          if (s < bestSad) { bestSad = s; bestVx = dx; bestVy = dy; }
        }
      }

      // Small local search around the best candidate (lossy mode)
      if (opts.useDiamond && bestSad > opts.sadSkipThreshold) {
        const baseX = bestVx, baseY = bestVy;
        for (let r = 4; r >= 2; r -= 2) {
          for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
              if (Math.abs(dx) + Math.abs(dy) > r) continue;
              const nvx = baseX + dx, nvy = baseY + dy;
              if (nvx === bestVx && nvy === bestVy) continue;
              if (Math.abs(nvx) > MAX_VECTOR || Math.abs(nvy) > MAX_VECTOR) continue;
              const s = sadAt(curr, prev, w, h, bx, by, bw, bh, nvx, nvy);
              if (s < bestSad) { bestSad = s; bestVx = nvx; bestVy = nvy; }
            }
          }
        }
      }

      if (opts.halfPel) {
        // Half-pel refinement (spec v3.6 §5.2): rescore the chosen integer
        // vector, the (0,0) prediction, and its eight half-pel neighbours with
        // the full-block SAD; strict improvement only, center first, so ties
        // keep the integer vector. u/v stay inside the signed-byte range.
        const cu = clamp(bestVx * 2, -127, 127);
        const cv = clamp(bestVy * 2, -127, 127);
        let bestU = cu, bestV = cv;
        let bestFull = sadFullAt(curr, prev, w, h, bx, by, bw, bh, cu, cv);
        const s00 = sadFullAt(curr, prev, w, h, bx, by, bw, bh, 0, 0);
        if (s00 < bestFull) { bestFull = s00; bestU = 0; bestV = 0; }
        for (let hv = -1; hv <= 1; hv++) {
          for (let hu = -1; hu <= 1; hu++) {
            if (hu === 0 && hv === 0) continue;
            const u = cu + hu, v = cv + hv;
            if (u < -127 || u > 127 || v < -127 || v > 127) continue;
            const s = sadFullAt(curr, prev, w, h, bx, by, bw, bh, u, v);
            if (s < bestFull) { bestFull = s; bestU = u; bestV = v; }
          }
        }
        bestVx = bestU;
        bestVy = bestV;
      }

      if (bestVx !== 0 || bestVy !== 0) {
        vx[gbY * gridW + gbX] = bestVx;
        vy[gbY * gridW + gbX] = bestVy;
        moved++;
      }
    }
  }

  if (moved < opts.minMovedBlocks) return null;
  return { blockSize: BLOCK_SIZE, gridW, gridH, vx, vy, halfPel: opts.halfPel };
}

// Serialize the MV block: id, count (prefix up to the last moved block), vectors.
// id 3 = 16x16 with half-pel-unit vectors (spec v3.6 §5.2).
export function writeMvBlock(mv: MotionVectors, writeU8: (v: number) => void, writeU16: (v: number) => void): void {
  const id = mv.blockSize === 8 ? 0 : mv.blockSize === 32 ? 2 : mv.halfPel ? 3 : 1;
  writeU8(id);
  let last = 0;
  for (let i = 0; i < mv.vx.length; i++) {
    if (mv.vx[i] !== 0 || mv.vy[i] !== 0) last = i;
  }
  const count = last + 1;
  writeU16(count);
  for (let i = 0; i < count; i++) {
    writeU8(mv.vx[i] & 0xff);
    writeU8(mv.vy[i] & 0xff);
  }
}

// Parse an MV block using the caller's byte reader (activeData-aware in both decoders).
// Extra vectors beyond the grid are consumed but discarded, keeping the stream in sync.
export function parseMvBlock(readU8: () => number, width: number, height: number): MotionVectors {
  const id = readU8();
  const halfPel = id === 3;
  const blockSize = id === 0 ? 8 : id === 2 ? 32 : 16;
  const count = (readU8() << 8) | readU8();
  const gridW = Math.ceil(width / blockSize);
  const gridH = Math.ceil(height / blockSize);
  const total = gridW * gridH;
  const vx = new Int8Array(total);
  const vy = new Int8Array(total);
  for (let i = 0; i < count; i++) {
    const bx = readU8(), by = readU8();
    if (i < total) {
      vx[i] = (bx << 24) >> 24;
      vy[i] = (by << 24) >> 24;
    }
  }
  return { blockSize, gridW, gridH, vx, vy, halfPel };
}

// Bilinear half-pel sample of prev at (sx0,sy0)+(hx,hy); all four taps are
// border-clamped. Matches sadFullAt's arithmetic exactly (spec v3.6 §5.2).
function halfPelSample(prev: Uint8Array, w: number, h: number, sx: number, sy: number, hx: number, hy: number): number {
  const sx0 = clamp(sx, 0, w - 1), sx1 = clamp(sx + 1, 0, w - 1);
  const sy0 = clamp(sy, 0, h - 1), sy1 = clamp(sy + 1, 0, h - 1);
  const a = prev[sy0 * w + sx0];
  if (hx === 0 && hy === 0) return a;
  if (hx === 0) return (a + prev[sy1 * w + sx0] + 1) >> 1;
  if (hy === 0) return (a + prev[sy0 * w + sx1] + 1) >> 1;
  return (a + prev[sy0 * w + sx1] + prev[sy1 * w + sx0] + prev[sy1 * w + sx1] + 2) >> 2;
}

// Build the motion-compensated copy of a single-channel plane.
// sampleScaleX/Y map a plane pixel to its corresponding luma pixel; shiftX/Y
// are the per-axis chroma vector derivation (mv_luma >> shift). Half-pel
// compensation applies only on luma-resolution calls (shift 0); chroma keeps
// whole-pel vectors via u >> (shift + 1).
export function compensatePlane(prev: Uint8Array, w: number, h: number, mv: MotionVectors, out: Uint8Array, sampleScaleX: number, sampleScaleY: number, shiftX: number, shiftY: number): void {
  const B = mv.blockSize;
  const gw = Math.ceil(w / B), gh = Math.ceil(h / B);
  const luma = shiftX === 0 && shiftY === 0;
  for (let gbY = 0; gbY < gh; gbY++) {
    for (let gbX = 0; gbX < gw; gbX++) {
      const lumX = Math.min(mv.gridW - 1, Math.floor((gbX * B * sampleScaleX) / mv.blockSize));
      const lumY = Math.min(mv.gridH - 1, Math.floor((gbY * B * sampleScaleY) / mv.blockSize));
      const li = lumY * mv.gridW + lumX;
      const u = mv.vx[li], v = mv.vy[li];
      const hx = luma && mv.halfPel ? (u & 1) : 0;
      const hy = luma && mv.halfPel ? (v & 1) : 0;
      const vx = mv.halfPel ? (u >> (shiftX + 1)) : (u >> shiftX);
      const vy = mv.halfPel ? (v >> (shiftY + 1)) : (v >> shiftY);
      const bw = Math.min(B, w - gbX * B), bh = Math.min(B, h - gbY * B);
      const half = hx !== 0 || hy !== 0;
      for (let y = 0; y < bh; y++) {
        const oRow = (gbY * B + y) * w + gbX * B;
        if (!half) {
          const sy = clamp(gbY * B + y + vy, 0, h - 1);
          const sRow = sy * w;
          for (let x = 0; x < bw; x++) {
            const sx = clamp(gbX * B + x + vx, 0, w - 1);
            out[oRow + x] = prev[sRow + sx];
          }
        } else {
          for (let x = 0; x < bw; x++) {
            out[oRow + x] = halfPelSample(prev, w, h, gbX * B + x + vx, gbY * B + y + vy, hx, hy);
          }
        }
      }
    }
  }
}

// Motion-compensated copy of an RGBA frame (stride 4, luma vectors unshifted).
export function compensateFrame(prev: Uint8ClampedArray, w: number, h: number, mv: MotionVectors, out: Uint8ClampedArray): void {
  const B = mv.blockSize;
  const gw = Math.ceil(w / B), gh = Math.ceil(h / B);
  for (let gbY = 0; gbY < gh; gbY++) {
    for (let gbX = 0; gbX < gw; gbX++) {
      const li = gbY * mv.gridW + gbX;
      const u = mv.vx[li], v = mv.vy[li];
      const hx = mv.halfPel ? (u & 1) : 0, hy = mv.halfPel ? (v & 1) : 0;
      const vx = mv.halfPel ? (u >> 1) : u;
      const vy = mv.halfPel ? (v >> 1) : v;
      const bw = Math.min(B, w - gbX * B), bh = Math.min(B, h - gbY * B);
      const half = hx !== 0 || hy !== 0;
      for (let y = 0; y < bh; y++) {
        const oRow = ((gbY * B + y) * w + gbX * B) * 4;
        for (let x = 0; x < bw; x++) {
          const o = oRow + x * 4;
          if (!half) {
            const sy = clamp(gbY * B + y + vy, 0, h - 1);
            const sx = clamp(gbX * B + x + vx, 0, w - 1);
            const s = (sy * w) * 4 + sx * 4;
            out[o] = prev[s];
            out[o + 1] = prev[s + 1];
            out[o + 2] = prev[s + 2];
            out[o + 3] = prev[s + 3];
          } else {
            for (let ch = 0; ch < 4; ch++) {
              // per-channel bilinear over the interleaved plane
              const sx0 = clamp(gbX * B + x + vx, 0, w - 1), sx1 = clamp(gbX * B + x + vx + 1, 0, w - 1);
              const sy0 = clamp(gbY * B + y + vy, 0, h - 1), sy1 = clamp(gbY * B + y + vy + 1, 0, h - 1);
              const a = prev[(sy0 * w + sx0) * 4 + ch];
              const b = prev[(sy0 * w + sx1) * 4 + ch];
              const c = prev[(sy1 * w + sx0) * 4 + ch];
              const d = prev[(sy1 * w + sx1) * 4 + ch];
              out[o + ch] = hx === 0 ? (a + c + 1) >> 1 : hy === 0 ? (a + b + 1) >> 1 : (a + b + c + d + 2) >> 2;
            }
          }
        }
      }
    }
  }
}
