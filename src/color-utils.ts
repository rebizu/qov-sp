// Color conversion utilities for QOV
// Using BT.601 standard (SD video) coefficients

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

export interface YUV {
  y: number;
  u: number;
  v: number;
}

export interface YUVA {
  y: number;
  u: number;
  v: number;
  a: number;
}

// BT.601 coefficients
const KR = 0.299;
const KG = 0.587;
const KB = 0.114;

/**
 * Convert RGB to YUV (BT.601)
 * Y:  0-255 (luma)
 * U: 0-255 (Cb, centered at 128)
 * V: 0-255 (Cr, centered at 128)
 */
export function rgbToYuv(r: number, g: number, b: number): YUV {
  // Y = 0.299*R + 0.587*G + 0.114*B
  // U = 0.492*(B-Y) + 128 = -0.147*R - 0.289*G + 0.436*B + 128
  // V = 0.877*(R-Y) + 128 = 0.615*R - 0.515*G - 0.100*B + 128
  const y = Math.round(KR * r + KG * g + KB * b);
  const u = Math.round(-0.147 * r - 0.289 * g + 0.436 * b + 128);
  const v = Math.round(0.615 * r - 0.515 * g - 0.100 * b + 128);

  return {
    y: Math.max(0, Math.min(255, y)),
    u: Math.max(0, Math.min(255, u)),
    v: Math.max(0, Math.min(255, v)),
  };
}

/**
 * Convert YUV to RGB (BT.601)
 */
export function yuvToRgb(y: number, u: number, v: number): RGB {
  // R = Y + 1.140*(V-128)
  // G = Y - 0.395*(U-128) - 0.581*(V-128)
  // B = Y + 2.032*(U-128)
  const r = Math.round(y + 1.140 * (v - 128));
  const g = Math.round(y - 0.395 * (u - 128) - 0.581 * (v - 128));
  const b = Math.round(y + 2.032 * (u - 128));

  return {
    r: Math.max(0, Math.min(255, r)),
    g: Math.max(0, Math.min(255, g)),
    b: Math.max(0, Math.min(255, b)),
  };
}

/**
 * Convert RGBA frame to YUV 4:2:0 planes
 * Returns { yPlane, uPlane, vPlane, aPlane? }
 * Y plane: full resolution (width * height)
 * U/V planes: quarter resolution ((width/2) * (height/2))
 * A plane: full resolution if hasAlpha
 */
export function rgbaToYuv420Planes(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  hasAlpha: boolean
): { yPlane: Uint8Array; uPlane: Uint8Array; vPlane: Uint8Array; aPlane?: Uint8Array } {
  const yPlane = new Uint8Array(width * height);
  const uvWidth = Math.ceil(width / 2);
  const uvHeight = Math.ceil(height / 2);
  const uPlane = new Uint8Array(uvWidth * uvHeight);
  const vPlane = new Uint8Array(uvWidth * uvHeight);
  const aPlane = hasAlpha ? new Uint8Array(width * height) : undefined;

  // First pass: compute Y and optionally A for all pixels
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const idx = (py * width + px) * 4;
      const r = pixels[idx];
      const g = pixels[idx + 1];
      const b = pixels[idx + 2];
      const a = pixels[idx + 3];

      const yuv = rgbToYuv(r, g, b);
      yPlane[py * width + px] = yuv.y;

      if (aPlane) {
        aPlane[py * width + px] = a;
      }
    }
  }

  // Second pass: compute U and V with 2x2 subsampling (average of 4 pixels)
  for (let py = 0; py < uvHeight; py++) {
    for (let px = 0; px < uvWidth; px++) {
      let uSum = 0;
      let vSum = 0;
      let count = 0;

      // Sample 2x2 block
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const srcX = px * 2 + dx;
          const srcY = py * 2 + dy;

          if (srcX < width && srcY < height) {
            const idx = (srcY * width + srcX) * 4;
            const r = pixels[idx];
            const g = pixels[idx + 1];
            const b = pixels[idx + 2];

            const yuv = rgbToYuv(r, g, b);
            uSum += yuv.u;
            vSum += yuv.v;
            count++;
          }
        }
      }

      const uvIdx = py * uvWidth + px;
      uPlane[uvIdx] = Math.round(uSum / count);
      vPlane[uvIdx] = Math.round(vSum / count);
    }
  }

  return { yPlane, uPlane, vPlane, aPlane };
}

/**
 * Convert YUV 4:2:0 planes back to RGBA frame
 */
export function yuv420PlanesToRgba(
  yPlane: Uint8Array,
  uPlane: Uint8Array,
  vPlane: Uint8Array,
  aPlane: Uint8Array | null,
  width: number,
  height: number
): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(width * height * 4);
  const uvWidth = Math.ceil(width / 2);

  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const yIdx = py * width + px;
      const uvIdx = Math.floor(py / 2) * uvWidth + Math.floor(px / 2);

      const y = yPlane[yIdx];
      const u = uPlane[uvIdx];
      const v = vPlane[uvIdx];

      const rgb = yuvToRgb(y, u, v);

      const outIdx = yIdx * 4;
      pixels[outIdx] = rgb.r;
      pixels[outIdx + 1] = rgb.g;
      pixels[outIdx + 2] = rgb.b;
      pixels[outIdx + 3] = aPlane ? aPlane[yIdx] : 255;
    }
  }

  return pixels;
}

/**
 * Convert RGBA frame to YUV 4:2:2 planes
 * Y plane: full resolution
 * U/V planes: half horizontal resolution (width/2 * height)
 */
export function rgbaToYuv422Planes(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  hasAlpha: boolean
): { yPlane: Uint8Array; uPlane: Uint8Array; vPlane: Uint8Array; aPlane?: Uint8Array } {
  const yPlane = new Uint8Array(width * height);
  const uvWidth = Math.ceil(width / 2);
  const uPlane = new Uint8Array(uvWidth * height);
  const vPlane = new Uint8Array(uvWidth * height);
  const aPlane = hasAlpha ? new Uint8Array(width * height) : undefined;

  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const idx = (py * width + px) * 4;
      const r = pixels[idx];
      const g = pixels[idx + 1];
      const b = pixels[idx + 2];
      const a = pixels[idx + 3];

      const yuv = rgbToYuv(r, g, b);
      yPlane[py * width + px] = yuv.y;

      if (aPlane) {
        aPlane[py * width + px] = a;
      }
    }

    // Subsample U/V horizontally (average of 2 pixels)
    for (let px = 0; px < uvWidth; px++) {
      let uSum = 0;
      let vSum = 0;
      let count = 0;

      for (let dx = 0; dx < 2; dx++) {
        const srcX = px * 2 + dx;
        if (srcX < width) {
          const idx = (py * width + srcX) * 4;
          const r = pixels[idx];
          const g = pixels[idx + 1];
          const b = pixels[idx + 2];

          const yuv = rgbToYuv(r, g, b);
          uSum += yuv.u;
          vSum += yuv.v;
          count++;
        }
      }

      const uvIdx = py * uvWidth + px;
      uPlane[uvIdx] = Math.round(uSum / count);
      vPlane[uvIdx] = Math.round(vSum / count);
    }
  }

  return { yPlane, uPlane, vPlane, aPlane };
}

/**
 * Convert YUV 4:2:2 planes back to RGBA frame
 */
export function yuv422PlanesToRgba(
  yPlane: Uint8Array,
  uPlane: Uint8Array,
  vPlane: Uint8Array,
  aPlane: Uint8Array | null,
  width: number,
  height: number
): Uint8ClampedArray {
  const pixels = new Uint8ClampedArray(width * height * 4);
  const uvWidth = Math.ceil(width / 2);

  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const yIdx = py * width + px;
      const uvIdx = py * uvWidth + Math.floor(px / 2);

      const y = yPlane[yIdx];
      const u = uPlane[uvIdx];
      const v = vPlane[uvIdx];

      const rgb = yuvToRgb(y, u, v);

      const outIdx = yIdx * 4;
      pixels[outIdx] = rgb.r;
      pixels[outIdx + 1] = rgb.g;
      pixels[outIdx + 2] = rgb.b;
      pixels[outIdx + 3] = aPlane ? aPlane[yIdx] : 255;
    }
  }

  return pixels;
}

/**
 * Convert RGBA frame to YUV 4:4:4 planes (no subsampling)
 * All planes: full resolution
 */
export function rgbaToYuv444Planes(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  hasAlpha: boolean
): { yPlane: Uint8Array; uPlane: Uint8Array; vPlane: Uint8Array; aPlane?: Uint8Array } {
  const size = width * height;
  const yPlane = new Uint8Array(size);
  const uPlane = new Uint8Array(size);
  const vPlane = new Uint8Array(size);
  const aPlane = hasAlpha ? new Uint8Array(size) : undefined;

  for (let i = 0; i < size; i++) {
    const idx = i * 4;
    const r = pixels[idx];
    const g = pixels[idx + 1];
    const b = pixels[idx + 2];
    const a = pixels[idx + 3];

    const yuv = rgbToYuv(r, g, b);
    yPlane[i] = yuv.y;
    uPlane[i] = yuv.u;
    vPlane[i] = yuv.v;

    if (aPlane) {
      aPlane[i] = a;
    }
  }

  return { yPlane, uPlane, vPlane, aPlane };
}

/**
 * Convert YUV 4:4:4 planes back to RGBA frame
 */
export function yuv444PlanesToRgba(
  yPlane: Uint8Array,
  uPlane: Uint8Array,
  vPlane: Uint8Array,
  aPlane: Uint8Array | null,
  width: number,
  height: number
): Uint8ClampedArray {
  const size = width * height;
  const pixels = new Uint8ClampedArray(size * 4);

  for (let i = 0; i < size; i++) {
    const y = yPlane[i];
    const u = uPlane[i];
    const v = vPlane[i];

    const rgb = yuvToRgb(y, u, v);

    const outIdx = i * 4;
    pixels[outIdx] = rgb.r;
    pixels[outIdx + 1] = rgb.g;
    pixels[outIdx + 2] = rgb.b;
    pixels[outIdx + 3] = aPlane ? aPlane[i] : 255;
  }

  return pixels;
}

/**
 * YUV color hash for index cache (similar to RGB but for YUV)
 */
export function yuvHash(y: number, u: number, v: number): number {
  return (y * 3 + u * 5 + v * 7) % 64;
}
