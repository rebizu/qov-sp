export const DCT_SIZE = 8;
const PI = Math.PI;

// Standard ZigZag order
export const ZIGZAG = [
    0, 1, 5, 6, 14, 15, 27, 28,
    2, 4, 7, 13, 16, 26, 29, 42,
    3, 8, 12, 17, 25, 30, 41, 43,
    9, 11, 18, 24, 31, 40, 44, 53,
    10, 19, 23, 32, 39, 45, 52, 54,
    20, 22, 33, 38, 46, 51, 55, 60,
    21, 34, 37, 47, 50, 56, 59, 61,
    35, 36, 48, 49, 57, 58, 62, 63
];

// Standard JPEG Luminance Quantization Table (Quality 50)
export const DEFAULT_QUANT_LUMA = [
    16, 11, 10, 16, 24, 40, 51, 61,
    12, 12, 14, 19, 26, 58, 60, 55,
    14, 13, 16, 24, 40, 57, 69, 56,
    14, 17, 22, 29, 51, 87, 80, 62,
    18, 22, 37, 56, 68, 109, 103, 77,
    24, 35, 55, 64, 81, 104, 113, 92,
    49, 64, 78, 87, 103, 121, 120, 101,
    72, 92, 95, 98, 112, 100, 103, 99
];

// Standard JPEG Chrominance Quantization Table (Quality 50)
export const DEFAULT_QUANT_CHROMA = [
    17, 18, 24, 47, 99, 99, 99, 99,
    18, 21, 26, 66, 99, 99, 99, 99,
    24, 26, 56, 99, 99, 99, 99, 99,
    47, 66, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99,
    99, 99, 99, 99, 99, 99, 99, 99
];

// Precomputed COS tables for FDCT/IDCT
const COS_TABLE: number[][] = [];
for (let i = 0; i < 8; i++) {
    COS_TABLE[i] = [];
    for (let j = 0; j < 8; j++) {
        COS_TABLE[i][j] = Math.cos(((2 * i + 1) * j * PI) / 16);
    }
}

const C0 = 1 / Math.sqrt(2);

// Naive O(N^4) FDCT - simplest to implement correct
export function forwardDCT(block: Float32Array | Int16Array, out: Float32Array): void {
    for (let v = 0; v < 8; v++) {
        const Cv = v === 0 ? C0 : 1;
        for (let u = 0; u < 8; u++) {
            const Cu = u === 0 ? C0 : 1;
            let sum = 0;

            for (let y = 0; y < 8; y++) {
                for (let x = 0; x < 8; x++) {
                    sum += block[y * 8 + x] * COS_TABLE[x][u] * COS_TABLE[y][v];
                }
            }

            out[v * 8 + u] = 0.25 * Cu * Cv * sum;
        }
    }
}

// Naive O(N^4) IDCT
export function inverseDCT(coeffs: Float32Array | Int16Array, out: Uint8Array | Uint8ClampedArray): void {
    for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
            let sum = 0;

            for (let v = 0; v < 8; v++) {
                const Cv = v === 0 ? C0 : 1;
                for (let u = 0; u < 8; u++) {
                    const Cu = u === 0 ? C0 : 1;
                    sum += Cu * Cv * coeffs[v * 8 + u] * COS_TABLE[x][u] * COS_TABLE[y][v];
                }
            }

            // Level shift +128 and clamp
            const val = (0.25 * sum) + 128;
            out[y * 8 + x] = Math.max(0, Math.min(255, Math.round(val)));
        }
    }
}

// Naive IDCT for residuals (no level shift, no clamp, specific for P-frames)
export function inverseDCTRaw(coeffs: Float32Array | Int16Array, out: Int16Array | Float32Array): void {
    for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
            let sum = 0;

            for (let v = 0; v < 8; v++) {
                const Cv = v === 0 ? C0 : 1;
                for (let u = 0; u < 8; u++) {
                    const Cu = u === 0 ? C0 : 1;
                    sum += Cu * Cv * coeffs[v * 8 + u] * COS_TABLE[x][u] * COS_TABLE[y][v];
                }
            }

            // No level shift, no clamp
            out[y * 8 + x] = 0.25 * sum;
        }
    }
}

// Helper to copy simple block to/from image buffer
export function getBlock8x8(pixels: Uint8Array | Uint8ClampedArray, width: number, bx: number, by: number, out: Float32Array): void {
    for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
            // Level shift -128 for DCT
            out[y * 8 + x] = pixels[(by + y) * width + (bx + x)] - 128;
        }
    }
}

export function putBlock8x8(pixels: Uint8Array | Uint8ClampedArray, width: number, bx: number, by: number, block: Uint8Array): void {
    for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
            pixels[(by + y) * width + (bx + x)] = block[y * 8 + x];
        }
    }
}
