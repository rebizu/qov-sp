/**
 * QOV Lossy Encoder
 *
 * Implements lossy video encoding for QOV format with configurable quality.
 * Supports three encoding modes:
 * 1. Quantized Pixel Mode - Pre-quantize pixels before standard encoding
 * 2. Quantized YUV Mode - Per-plane quantization (Y light, UV aggressive)
 * 3. Temporal Lossy Mode - Skip similar pixels in P-frames
 *
 * Based on qov-lossy-specification.md
 */

import {
  QovHeader,
  QovRGBA,
  QovLossyParams,
  QovLossyStats,
  QovQualityPreset,
  QOV_QUALITY_PRESETS,
  QOV_COLORSPACE_YUV420,
  QOV_COLORSPACE_YUV422,
  QOV_COLORSPACE_YUVA420,
  QOV_FLAG_HAS_INDEX,
  QOV_FLAG_HAS_ALPHA,
  QOV_FLAG_LOSSY_MODE,
  QOV_CHUNK_SYNC,
  QOV_CHUNK_KEYFRAME,
  QOV_CHUNK_PFRAME,
  QOV_CHUNK_INDEX,
  QOV_CHUNK_END,
  QOV_CHUNK_FLAG_YUV,
  QOV_CHUNK_FLAG_COMPRESSED,
  deriveLossyParams,
} from './qov-types';

import { lz4Compress } from './lz4';

import {
  rgbaToYuv420Planes,
  rgbaToYuv422Planes,
  rgbaToYuv444Planes,
} from './color-utils';

interface KeyframeInfo {
  frameNumber: number;
  offset: number;
  timestamp: number;
}

/**
 * Growable buffer for efficient byte writing
 */
class GrowableBuffer {
  private chunks: Uint8Array[] = [];
  private currentChunk: Uint8Array;
  private currentPos = 0;
  private totalSize = 0;
  private chunkSize: number;

  constructor(initialChunkSize = 1024 * 1024) {
    this.chunkSize = initialChunkSize;
    this.currentChunk = new Uint8Array(this.chunkSize);
  }

  writeByte(v: number): void {
    if (this.currentPos >= this.currentChunk.length) {
      this.chunks.push(this.currentChunk);
      this.currentChunk = new Uint8Array(this.chunkSize);
      this.currentPos = 0;
    }
    this.currentChunk[this.currentPos++] = v & 0xff;
    this.totalSize++;
  }

  writeU16(v: number): void {
    this.writeByte((v >> 8) & 0xff);
    this.writeByte(v & 0xff);
  }

  writeU32(v: number): void {
    this.writeByte((v >> 24) & 0xff);
    this.writeByte((v >> 16) & 0xff);
    this.writeByte((v >> 8) & 0xff);
    this.writeByte(v & 0xff);
  }

  getSize(): number {
    return this.totalSize;
  }

  setByte(pos: number, v: number): void {
    let offset = 0;
    for (const chunk of this.chunks) {
      if (pos < offset + chunk.length) {
        chunk[pos - offset] = v & 0xff;
        return;
      }
      offset += chunk.length;
    }
    if (pos < this.totalSize) {
      this.currentChunk[pos - offset] = v & 0xff;
    }
  }

  toUint8Array(): Uint8Array {
    const result = new Uint8Array(this.totalSize);
    let offset = 0;
    for (const chunk of this.chunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }
    result.set(this.currentChunk.subarray(0, this.currentPos), offset);
    return result;
  }
}

/**
 * Lossy QOV Encoder
 *
 * Provides lossy video encoding with configurable quality levels.
 */
export class QovLossyEncoder {
  private header: QovHeader;
  private buffer: GrowableBuffer;
  private compressionEnabled: boolean;
  private frameBuffer: GrowableBuffer | null = null;

  // Lossy parameters
  private lossyParams: QovLossyParams;

  // RGB mode state
  private rgbIndex: QovRGBA[] = new Array(64);
  private prevPixel: QovRGBA = { r: 0, g: 0, b: 0, a: 255 };

  // Reference frames
  private prevFrame: Uint8ClampedArray | null = null;
  private prevYPlane: Uint8Array | null = null;
  private prevUPlane: Uint8Array | null = null;
  private prevVPlane: Uint8Array | null = null;
  private prevAPlane: Uint8Array | null = null;

  // Quantized reference planes (for temporal comparison)
  private quantizedPrevYPlane: Uint8Array | null = null;
  private quantizedPrevUPlane: Uint8Array | null = null;
  private quantizedPrevVPlane: Uint8Array | null = null;

  private keyframes: KeyframeInfo[] = [];
  private frameCount = 0;
  private isYuvMode = false;
  private hasAlpha = false;

  // Statistics
  private stats: QovLossyStats = {
    totalPixels: 0,
    skippedPixels: 0,
    quantizedPixels: 0,
    uncompressedSize: 0,
    compressedSize: 0,
    compressionRatio: 1,
  };

  private activeBuffer: GrowableBuffer | null = null;

  /**
   * Create a new lossy encoder
   *
   * @param width Video width
   * @param height Video height
   * @param quality Quality level 0-100 (or use preset)
   * @param options Additional encoder options
   */
  constructor(
    width: number,
    height: number,
    quality: number | QovQualityPreset = 75,
    options: {
      frameRateNum?: number;
      frameRateDen?: number;
      colorspace?: number;
      compressionEnabled?: boolean;
      hasAlpha?: boolean;
    } = {}
  ) {
    // Resolve quality preset if string
    const qualityValue = typeof quality === 'string'
      ? QOV_QUALITY_PRESETS[quality]
      : quality;

    // Derive lossy parameters from quality
    this.lossyParams = deriveLossyParams(qualityValue);

    const {
      frameRateNum = 30,
      frameRateDen = 1,
      colorspace = QOV_COLORSPACE_YUV420,
      compressionEnabled = true,
      hasAlpha = false,
    } = options;

    // Build flags
    let flags = QOV_FLAG_HAS_INDEX | QOV_FLAG_LOSSY_MODE;
    if (hasAlpha || colorspace === QOV_COLORSPACE_YUVA420) {
      flags |= QOV_FLAG_HAS_ALPHA;
    }

    this.header = {
      magic: 'qovf',
      version: 0x03, // Lossy version
      flags,
      width,
      height,
      frameRateNum,
      frameRateDen,
      totalFrames: 0,
      audioChannels: 0,
      audioRate: 0,
      colorspace,
    };

    this.compressionEnabled = compressionEnabled;
    this.isYuvMode = colorspace >= 0x10 && colorspace <= 0x13;
    this.hasAlpha = hasAlpha || colorspace === QOV_COLORSPACE_YUVA420;

    console.log(`[LossyEncoder] Created with quality=${qualityValue}, colorspace=0x${colorspace.toString(16)}`);
    console.log(`[LossyEncoder] Params: yQuant=${this.lossyParams.yQuant}, uvQuant=${this.lossyParams.uvQuant}, temporalThreshold=${this.lossyParams.temporalThreshold}`);

    // Initialize buffers
    const pixelsPerFrame = width * height;
    const estimatedBytesPerFrame = Math.max(pixelsPerFrame / 4, 10000);
    this.buffer = new GrowableBuffer(Math.max(estimatedBytesPerFrame * 10, 1024 * 1024));

    if (compressionEnabled) {
      this.frameBuffer = new GrowableBuffer(Math.max(estimatedBytesPerFrame * 2, 256 * 1024));
    }

    this.resetRgbIndex();
  }

  private resetRgbIndex(): void {
    for (let i = 0; i < 64; i++) {
      this.rgbIndex[i] = { r: 0, g: 0, b: 0, a: 0 };
    }
    this.prevPixel = { r: 0, g: 0, b: 0, a: 255 };
  }

  private getWriteBuffer(): GrowableBuffer {
    return this.activeBuffer || this.buffer;
  }

  private writeU8(v: number): void {
    this.getWriteBuffer().writeByte(v);
  }

  private writeU16(v: number): void {
    this.getWriteBuffer().writeU16(v);
  }

  private writeU32(v: number): void {
    this.getWriteBuffer().writeU32(v);
  }

  private startFrameData(): void {
    if (this.compressionEnabled && this.frameBuffer) {
      this.frameBuffer = new GrowableBuffer(256 * 1024);
      this.activeBuffer = this.frameBuffer;
    }
  }

  private finishFrameData(chunkType: number, baseFlags: number, timestamp: number): void {
    if (!this.compressionEnabled || !this.frameBuffer) {
      return;
    }

    const frameData = this.frameBuffer.toUint8Array();
    const uncompressedSize = frameData.length;
    this.activeBuffer = null;

    const compressed = lz4Compress(frameData);

    if (compressed) {
      const chunkFlags = baseFlags | QOV_CHUNK_FLAG_COMPRESSED;
      const chunkSize = compressed.length + 4;

      this.buffer.writeByte(chunkType);
      this.buffer.writeByte(chunkFlags);
      this.buffer.writeU32(chunkSize);
      this.buffer.writeU32(timestamp);
      this.buffer.writeU32(uncompressedSize);

      for (let i = 0; i < compressed.length; i++) {
        this.buffer.writeByte(compressed[i]);
      }
    } else {
      const chunkFlags = baseFlags;
      const chunkSize = uncompressedSize;

      this.buffer.writeByte(chunkType);
      this.buffer.writeByte(chunkFlags);
      this.buffer.writeU32(chunkSize);
      this.buffer.writeU32(timestamp);

      for (let i = 0; i < frameData.length; i++) {
        this.buffer.writeByte(frameData[i]);
      }
    }
  }

  private colorHash(c: QovRGBA): number {
    return (c.r * 3 + c.g * 5 + c.b * 7 + c.a * 11) % 64;
  }

  // ==========================================================================
  // Quantization Functions
  // ==========================================================================

  /**
   * Quantize a single value to the nearest quantization level
   */
  private quantizeValue(value: number, quantStep: number): number {
    if (quantStep <= 1) return value;
    return Math.round(value / quantStep) * quantStep;
  }

  /**
   * Quantize Y plane value (luminance - less aggressive)
   */
  private quantizeY(value: number): number {
    return this.quantizeValue(value, this.lossyParams.yQuant);
  }

  /**
   * Quantize UV plane value (chrominance - more aggressive)
   */
  private quantizeUV(value: number): number {
    return this.quantizeValue(value, this.lossyParams.uvQuant);
  }

  /**
   * Quantize an entire plane
   */
  private quantizePlane(plane: Uint8Array, isChroma: boolean): Uint8Array {
    const quantStep = isChroma ? this.lossyParams.uvQuant : this.lossyParams.yQuant;
    if (quantStep <= 1) return plane; // No quantization needed

    const quantized = new Uint8Array(plane.length);
    for (let i = 0; i < plane.length; i++) {
      quantized[i] = Math.min(255, Math.max(0, this.quantizeValue(plane[i], quantStep)));
    }
    return quantized;
  }

  /**
   * Check if two values are similar within temporal threshold
   */
  private valuesSimilar(a: number, b: number): boolean {
    return Math.abs(a - b) <= this.lossyParams.temporalThreshold;
  }

  /**
   * Check if two pixels are similar within temporal threshold
   */
  private pixelsSimilar(curr: QovRGBA, ref: QovRGBA): boolean {
    const threshold = this.lossyParams.temporalThreshold;
    return Math.abs(curr.r - ref.r) <= threshold &&
           Math.abs(curr.g - ref.g) <= threshold &&
           Math.abs(curr.b - ref.b) <= threshold &&
           Math.abs(curr.a - ref.a) <= Math.max(1, threshold / 2);
  }

  // ==========================================================================
  // Header Writing
  // ==========================================================================

  /**
   * Write the extended lossy header (32 bytes for v0x03)
   */
  writeHeader(): void {
    // Magic "qovf"
    this.writeU8(0x71); // 'q'
    this.writeU8(0x6f); // 'o'
    this.writeU8(0x76); // 'v'
    this.writeU8(0x66); // 'f'

    // Version (0x03 for lossy)
    this.writeU8(0x03);

    // Flags
    this.writeU8(this.header.flags);

    // Dimensions
    this.writeU16(this.header.width);
    this.writeU16(this.header.height);

    // Frame rate
    this.writeU16(this.header.frameRateNum);
    this.writeU16(this.header.frameRateDen);

    // Total frames (placeholder)
    this.writeU32(0);

    // Audio (none)
    this.writeU8(0);
    this.writeU8(0);
    this.writeU8(0);
    this.writeU8(0);

    // Colorspace
    this.writeU8(this.header.colorspace);

    // Quality (byte 23)
    this.writeU8(this.lossyParams.quality);

    // Extended lossy parameters (bytes 24-27)
    this.writeU8(this.lossyParams.yQuant);
    this.writeU8(this.lossyParams.uvQuant);
    this.writeU8(this.lossyParams.temporalThreshold);
    this.writeU8(this.lossyParams.dctQp);

    // Reserved (bytes 28-31)
    this.writeU32(0);
  }

  private writeSync(frameNumber: number, timestamp: number): void {
    this.writeU8(QOV_CHUNK_SYNC);
    this.writeU8(0x00);
    this.writeU32(8);
    this.writeU32(timestamp);

    this.writeU8(0x51); // 'Q'
    this.writeU8(0x4f); // 'O'
    this.writeU8(0x56); // 'V'
    this.writeU8(0x53); // 'S'
    this.writeU32(frameNumber);
  }

  private writeEndMarker(): void {
    for (let i = 0; i < 7; i++) this.writeU8(0x00);
    this.writeU8(0x01);
  }

  // ==========================================================================
  // YUV Plane Encoding (Lossy)
  // ==========================================================================

  /**
   * Encode a single plane for keyframe with quantization
   */
  private encodeYuvPlaneKeyframeLossy(plane: Uint8Array, isChroma: boolean): void {
    // Quantize the plane first
    const quantized = this.quantizePlane(plane, isChroma);

    const size = quantized.length;
    let prevVal = 0;
    let run = 0;
    const index: number[] = new Array(64).fill(-1);

    for (let i = 0; i < size; i++) {
      const val = quantized[i];

      // Check for run
      if (val === prevVal) {
        run++;
        if (run === 62 || i === size - 1) {
          this.writeU8(0xc0 | (run - 1));
          run = 0;
        }
        continue;
      }

      // Flush pending run
      if (run > 0) {
        this.writeU8(0xc0 | (run - 1));
        run = 0;
      }

      // Check index
      const idx = (val * 3) % 64;
      if (index[idx] === val && i > 0) {
        this.writeU8(idx);
      } else {
        // Try diff
        const d = val - prevVal;
        if (d >= -8 && d <= 7) {
          this.writeU8(0x40 | ((d + 8) & 0x0f));
        } else if (d >= -32 && d <= 31) {
          this.writeU8(0x80 | (d + 32));
        } else {
          this.writeU8(0xfe);
          this.writeU8(val);
        }
      }

      index[idx] = val;
      prevVal = val;
    }

    this.stats.quantizedPixels += size;
  }

  /**
   * Encode a single plane for P-frame with temporal similarity
   */
  private encodeYuvPlanePFrameLossy(
    plane: Uint8Array,
    prevPlane: Uint8Array,
    isChroma: boolean
  ): void {
    // Quantize current plane
    const quantized = this.quantizePlane(plane, isChroma);

    const size = quantized.length;
    let skip = 0;
    const index: number[] = new Array(64).fill(-1);
    const threshold = this.lossyParams.temporalThreshold;

    for (let i = 0; i < size; i++) {
      const val = quantized[i];
      const refVal = prevPlane[i];

      // Check if similar enough to skip (lossy temporal compression)
      if (Math.abs(val - refVal) <= threshold) {
        skip++;
        this.stats.skippedPixels++;
        if (skip === 62 || i === size - 1) {
          this.writeU8(0xc0 | (skip - 1));
          skip = 0;
        }
        continue;
      }

      // Flush skip
      if (skip > 0) {
        if (skip <= 62) {
          this.writeU8(0xc0 | (skip - 1));
        } else {
          this.writeU8(0x00);
          this.writeU16(skip);
        }
        skip = 0;
      }

      // Encode the difference
      const d = val - refVal;
      const idx = (val * 3) % 64;

      if (d >= -8 && d <= 7) {
        this.writeU8(0x40 | ((d + 8) & 0x0f));
        index[idx] = val;
      } else if (d >= -32 && d <= 31) {
        this.writeU8(0x80 | (d + 32));
        index[idx] = val;
      } else {
        if (index[idx] === val && idx !== 0) {
          this.writeU8(idx);
        } else {
          this.writeU8(0xfe);
          this.writeU8(val);
          index[idx] = val;
        }
      }

      this.stats.quantizedPixels++;
    }

    // Flush final skip
    if (skip > 0) {
      if (skip <= 62) {
        this.writeU8(0xc0 | (skip - 1));
      } else {
        this.writeU8(0x00);
        this.writeU16(skip);
      }
    }
  }

  // ==========================================================================
  // Frame Encoding
  // ==========================================================================

  /**
   * Encode a keyframe with lossy compression
   */
  encodeKeyframe(pixels: Uint8ClampedArray, timestamp: number): void {
    if (this.isYuvMode) {
      this.encodeYuvKeyframeLossy(pixels, timestamp);
      return;
    }

    // RGB mode with pre-quantization
    this.encodeRgbKeyframeLossy(pixels, timestamp);
  }

  /**
   * Encode YUV keyframe with lossy compression
   */
  private encodeYuvKeyframeLossy(pixels: Uint8ClampedArray, timestamp: number): void {
    const frameNumber = this.frameCount++;
    const { width, height, colorspace } = this.header;

    // Record keyframe for index
    if (this.header.flags & QOV_FLAG_HAS_INDEX) {
      this.keyframes.push({
        frameNumber,
        offset: this.buffer.getSize(),
        timestamp,
      });
    }

    // Write sync marker
    this.writeSync(frameNumber, timestamp);

    // Convert to YUV planes
    let planes: { yPlane: Uint8Array; uPlane: Uint8Array; vPlane: Uint8Array; aPlane?: Uint8Array };

    if (colorspace === QOV_COLORSPACE_YUV420 || colorspace === QOV_COLORSPACE_YUVA420) {
      planes = rgbaToYuv420Planes(pixels, width, height, this.hasAlpha);
    } else if (colorspace === QOV_COLORSPACE_YUV422) {
      planes = rgbaToYuv422Planes(pixels, width, height, this.hasAlpha);
    } else {
      planes = rgbaToYuv444Planes(pixels, width, height, this.hasAlpha);
    }

    this.stats.totalPixels += planes.yPlane.length + planes.uPlane.length + planes.vPlane.length;

    if (this.compressionEnabled) {
      this.startFrameData();

      this.encodeYuvPlaneKeyframeLossy(planes.yPlane, false);
      this.encodeYuvPlaneKeyframeLossy(planes.uPlane, true);
      this.encodeYuvPlaneKeyframeLossy(planes.vPlane, true);
      if (planes.aPlane) {
        this.encodeYuvPlaneKeyframeLossy(planes.aPlane, false);
      }
      this.writeEndMarker();

      this.finishFrameData(QOV_CHUNK_KEYFRAME, QOV_CHUNK_FLAG_YUV, timestamp);
    } else {
      const headerPos = this.buffer.getSize();
      this.writeU8(QOV_CHUNK_KEYFRAME);
      this.writeU8(QOV_CHUNK_FLAG_YUV);
      this.writeU32(0);
      this.writeU32(timestamp);

      const dataStart = this.buffer.getSize();

      this.encodeYuvPlaneKeyframeLossy(planes.yPlane, false);
      this.encodeYuvPlaneKeyframeLossy(planes.uPlane, true);
      this.encodeYuvPlaneKeyframeLossy(planes.vPlane, true);
      if (planes.aPlane) {
        this.encodeYuvPlaneKeyframeLossy(planes.aPlane, false);
      }
      this.writeEndMarker();

      const chunkSize = this.buffer.getSize() - dataStart;
      this.buffer.setByte(headerPos + 2, (chunkSize >> 24) & 0xff);
      this.buffer.setByte(headerPos + 3, (chunkSize >> 16) & 0xff);
      this.buffer.setByte(headerPos + 4, (chunkSize >> 8) & 0xff);
      this.buffer.setByte(headerPos + 5, chunkSize & 0xff);
    }

    // Store quantized planes for P-frame reference
    this.prevYPlane = this.quantizePlane(planes.yPlane, false);
    this.prevUPlane = this.quantizePlane(planes.uPlane, true);
    this.prevVPlane = this.quantizePlane(planes.vPlane, true);
    this.prevAPlane = planes.aPlane ? this.quantizePlane(planes.aPlane, false) : null;
    this.prevFrame = new Uint8ClampedArray(pixels);
  }

  /**
   * Encode RGB keyframe with pre-quantization
   */
  private encodeRgbKeyframeLossy(pixels: Uint8ClampedArray, timestamp: number): void {
    const frameNumber = this.frameCount++;
    const pixelCount = this.header.width * this.header.height;

    // Record keyframe for index
    if (this.header.flags & QOV_FLAG_HAS_INDEX) {
      this.keyframes.push({
        frameNumber,
        offset: this.buffer.getSize(),
        timestamp,
      });
    }

    this.writeSync(frameNumber, timestamp);
    this.resetRgbIndex();

    // Pre-quantize pixels in YUV space for perceptual quality
    const quantizedPixels = this.quantizePixelsPerceptual(pixels);

    this.stats.totalPixels += pixelCount;

    const encodeRgbKeyframeData = () => {
      let run = 0;

      for (let px = 0; px < pixelCount; px++) {
        const offset = px * 4;
        const c: QovRGBA = {
          r: quantizedPixels[offset],
          g: quantizedPixels[offset + 1],
          b: quantizedPixels[offset + 2],
          a: quantizedPixels[offset + 3],
        };

        if (c.r === this.prevPixel.r && c.g === this.prevPixel.g &&
            c.b === this.prevPixel.b && c.a === this.prevPixel.a) {
          run++;
          if (run === 62 || px === pixelCount - 1) {
            this.writeU8(0xc0 | (run - 1));
            run = 0;
          }
          continue;
        }

        if (run > 0) {
          this.writeU8(0xc0 | (run - 1));
          run = 0;
        }

        const idx = this.colorHash(c);
        const indexed = this.rgbIndex[idx];
        if (indexed.r === c.r && indexed.g === c.g &&
            indexed.b === c.b && indexed.a === c.a) {
          this.writeU8(idx);
        } else {
          const dr = c.r - this.prevPixel.r;
          const dg = c.g - this.prevPixel.g;
          const db = c.b - this.prevPixel.b;
          const da = c.a - this.prevPixel.a;

          if (da === 0) {
            if (dr >= -2 && dr <= 1 && dg >= -2 && dg <= 1 && db >= -2 && db <= 1) {
              this.writeU8(0x40 | ((dr + 2) << 4) | ((dg + 2) << 2) | (db + 2));
            } else if (dg >= -32 && dg <= 31) {
              const dr_dg = dr - dg;
              const db_dg = db - dg;
              if (dr_dg >= -8 && dr_dg <= 7 && db_dg >= -8 && db_dg <= 7) {
                this.writeU8(0x80 | (dg + 32));
                this.writeU8(((dr_dg + 8) << 4) | (db_dg + 8));
              } else {
                this.writeU8(0xfe);
                this.writeU8(c.r);
                this.writeU8(c.g);
                this.writeU8(c.b);
              }
            } else {
              this.writeU8(0xfe);
              this.writeU8(c.r);
              this.writeU8(c.g);
              this.writeU8(c.b);
            }
          } else {
            this.writeU8(0xff);
            this.writeU8(c.r);
            this.writeU8(c.g);
            this.writeU8(c.b);
            this.writeU8(c.a);
          }
        }

        this.rgbIndex[idx] = c;
        this.prevPixel = c;
        this.stats.quantizedPixels++;
      }

      this.writeEndMarker();
    };

    if (this.compressionEnabled) {
      this.startFrameData();
      encodeRgbKeyframeData();
      this.finishFrameData(QOV_CHUNK_KEYFRAME, 0x00, timestamp);
    } else {
      const headerPos = this.buffer.getSize();
      this.writeU8(QOV_CHUNK_KEYFRAME);
      this.writeU8(0x00);
      this.writeU32(0);
      this.writeU32(timestamp);

      const dataStart = this.buffer.getSize();
      encodeRgbKeyframeData();

      const chunkSize = this.buffer.getSize() - dataStart;
      this.buffer.setByte(headerPos + 2, (chunkSize >> 24) & 0xff);
      this.buffer.setByte(headerPos + 3, (chunkSize >> 16) & 0xff);
      this.buffer.setByte(headerPos + 4, (chunkSize >> 8) & 0xff);
      this.buffer.setByte(headerPos + 5, chunkSize & 0xff);
    }

    this.prevFrame = quantizedPixels;
  }

  /**
   * Quantize pixels in YUV space for perceptual quality
   */
  private quantizePixelsPerceptual(pixels: Uint8ClampedArray): Uint8ClampedArray {
    const result = new Uint8ClampedArray(pixels.length);
    const yQuant = this.lossyParams.yQuant;
    const uvQuant = this.lossyParams.uvQuant;

    if (yQuant <= 1 && uvQuant <= 1) {
      result.set(pixels);
      return result;
    }

    for (let i = 0; i < pixels.length; i += 4) {
      const r = pixels[i];
      const g = pixels[i + 1];
      const b = pixels[i + 2];
      const a = pixels[i + 3];

      // Convert to YUV (BT.601)
      let y = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
      let u = Math.round(-0.169 * r - 0.331 * g + 0.500 * b + 128);
      let v = Math.round(0.500 * r - 0.419 * g - 0.081 * b + 128);

      // Quantize
      y = this.quantizeValue(y, yQuant);
      u = this.quantizeValue(u, uvQuant);
      v = this.quantizeValue(v, uvQuant);

      // Clamp
      y = Math.min(255, Math.max(0, y));
      u = Math.min(255, Math.max(0, u));
      v = Math.min(255, Math.max(0, v));

      // Convert back to RGB
      const c = y;
      const d = u - 128;
      const e = v - 128;

      result[i] = Math.min(255, Math.max(0, Math.round(c + 1.402 * e)));
      result[i + 1] = Math.min(255, Math.max(0, Math.round(c - 0.344 * d - 0.714 * e)));
      result[i + 2] = Math.min(255, Math.max(0, Math.round(c + 1.772 * d)));
      result[i + 3] = a; // Alpha unchanged
    }

    return result;
  }

  /**
   * Encode a P-frame with lossy temporal compression
   */
  encodePFrame(pixels: Uint8ClampedArray, timestamp: number): void {
    if (this.isYuvMode) {
      this.encodeYuvPFrameLossy(pixels, timestamp);
      return;
    }

    this.encodeRgbPFrameLossy(pixels, timestamp);
  }

  /**
   * Encode YUV P-frame with lossy compression
   */
  private encodeYuvPFrameLossy(pixels: Uint8ClampedArray, timestamp: number): void {
    if (!this.prevYPlane || !this.prevUPlane || !this.prevVPlane) {
      this.encodeYuvKeyframeLossy(pixels, timestamp);
      return;
    }

    this.frameCount++;
    const { width, height, colorspace } = this.header;

    // Convert to YUV planes
    let planes: { yPlane: Uint8Array; uPlane: Uint8Array; vPlane: Uint8Array; aPlane?: Uint8Array };

    if (colorspace === QOV_COLORSPACE_YUV420 || colorspace === QOV_COLORSPACE_YUVA420) {
      planes = rgbaToYuv420Planes(pixels, width, height, this.hasAlpha);
    } else if (colorspace === QOV_COLORSPACE_YUV422) {
      planes = rgbaToYuv422Planes(pixels, width, height, this.hasAlpha);
    } else {
      planes = rgbaToYuv444Planes(pixels, width, height, this.hasAlpha);
    }

    this.stats.totalPixels += planes.yPlane.length + planes.uPlane.length + planes.vPlane.length;

    if (this.compressionEnabled) {
      this.startFrameData();

      this.encodeYuvPlanePFrameLossy(planes.yPlane, this.prevYPlane, false);
      this.encodeYuvPlanePFrameLossy(planes.uPlane, this.prevUPlane, true);
      this.encodeYuvPlanePFrameLossy(planes.vPlane, this.prevVPlane, true);
      if (planes.aPlane && this.prevAPlane) {
        this.encodeYuvPlanePFrameLossy(planes.aPlane, this.prevAPlane, false);
      }
      this.writeEndMarker();

      this.finishFrameData(QOV_CHUNK_PFRAME, QOV_CHUNK_FLAG_YUV, timestamp);
    } else {
      const headerPos = this.buffer.getSize();
      this.writeU8(QOV_CHUNK_PFRAME);
      this.writeU8(QOV_CHUNK_FLAG_YUV);
      this.writeU32(0);
      this.writeU32(timestamp);

      const dataStart = this.buffer.getSize();

      this.encodeYuvPlanePFrameLossy(planes.yPlane, this.prevYPlane, false);
      this.encodeYuvPlanePFrameLossy(planes.uPlane, this.prevUPlane, true);
      this.encodeYuvPlanePFrameLossy(planes.vPlane, this.prevVPlane, true);
      if (planes.aPlane && this.prevAPlane) {
        this.encodeYuvPlanePFrameLossy(planes.aPlane, this.prevAPlane, false);
      }
      this.writeEndMarker();

      const chunkSize = this.buffer.getSize() - dataStart;
      this.buffer.setByte(headerPos + 2, (chunkSize >> 24) & 0xff);
      this.buffer.setByte(headerPos + 3, (chunkSize >> 16) & 0xff);
      this.buffer.setByte(headerPos + 4, (chunkSize >> 8) & 0xff);
      this.buffer.setByte(headerPos + 5, chunkSize & 0xff);
    }

    // Store quantized planes for next P-frame
    this.prevYPlane = this.quantizePlane(planes.yPlane, false);
    this.prevUPlane = this.quantizePlane(planes.uPlane, true);
    this.prevVPlane = this.quantizePlane(planes.vPlane, true);
    this.prevAPlane = planes.aPlane ? this.quantizePlane(planes.aPlane, false) : null;
    this.prevFrame = new Uint8ClampedArray(pixels);
  }

  /**
   * Encode RGB P-frame with lossy temporal compression
   */
  private encodeRgbPFrameLossy(pixels: Uint8ClampedArray, timestamp: number): void {
    if (!this.prevFrame) {
      this.encodeRgbKeyframeLossy(pixels, timestamp);
      return;
    }

    this.frameCount++;
    const pixelCount = this.header.width * this.header.height;
    const prevFrameRef = this.prevFrame;
    const threshold = this.lossyParams.temporalThreshold;

    // Pre-quantize current frame
    const quantizedPixels = this.quantizePixelsPerceptual(pixels);

    this.stats.totalPixels += pixelCount;

    const encodeRgbPFrameData = () => {
      let skip = 0;

      for (let px = 0; px < pixelCount; px++) {
        const offset = px * 4;
        const c: QovRGBA = {
          r: quantizedPixels[offset],
          g: quantizedPixels[offset + 1],
          b: quantizedPixels[offset + 2],
          a: quantizedPixels[offset + 3],
        };
        const ref: QovRGBA = {
          r: prevFrameRef[offset],
          g: prevFrameRef[offset + 1],
          b: prevFrameRef[offset + 2],
          a: prevFrameRef[offset + 3],
        };

        // Check if similar enough to skip (lossy)
        if (this.pixelsSimilar(c, ref)) {
          skip++;
          this.stats.skippedPixels++;
          if (skip === 62 || px === pixelCount - 1) {
            this.writeU8(0xc0 | (skip - 1));
            skip = 0;
          }
          continue;
        }

        // Flush skip
        if (skip > 0) {
          if (skip <= 62) {
            this.writeU8(0xc0 | (skip - 1));
          } else {
            this.writeU8(0x00);
            this.writeU16(skip);
          }
          skip = 0;
        }

        // Encode temporal difference
        const dr = c.r - ref.r;
        const dg = c.g - ref.g;
        const db = c.b - ref.b;
        const da = c.a - ref.a;

        if (da === 0 && dr >= -2 && dr <= 1 && dg >= -2 && dg <= 1 && db >= -2 && db <= 1) {
          this.writeU8(0x40 | ((dr + 2) << 4) | ((dg + 2) << 2) | (db + 2));
        } else if (da === 0 && dg >= -32 && dg <= 31) {
          const dr_dg = dr - dg;
          const db_dg = db - dg;
          if (dr_dg >= -8 && dr_dg <= 7 && db_dg >= -8 && db_dg <= 7) {
            this.writeU8(0x80 | (dg + 32));
            this.writeU8(((dr_dg + 8) << 4) | (db_dg + 8));
          } else {
            this.writeU8(0xfe);
            this.writeU8(c.r);
            this.writeU8(c.g);
            this.writeU8(c.b);
          }
        } else if (da === 0) {
          this.writeU8(0xfe);
          this.writeU8(c.r);
          this.writeU8(c.g);
          this.writeU8(c.b);
        } else {
          this.writeU8(0xff);
          this.writeU8(c.r);
          this.writeU8(c.g);
          this.writeU8(c.b);
          this.writeU8(c.a);
        }

        const idx = this.colorHash(c);
        this.rgbIndex[idx] = c;
        this.stats.quantizedPixels++;
      }

      this.writeEndMarker();
    };

    if (this.compressionEnabled) {
      this.startFrameData();
      encodeRgbPFrameData();
      this.finishFrameData(QOV_CHUNK_PFRAME, 0x00, timestamp);
    } else {
      const headerPos = this.buffer.getSize();
      this.writeU8(QOV_CHUNK_PFRAME);
      this.writeU8(0x00);
      this.writeU32(0);
      this.writeU32(timestamp);

      const dataStart = this.buffer.getSize();
      encodeRgbPFrameData();

      const chunkSize = this.buffer.getSize() - dataStart;
      this.buffer.setByte(headerPos + 2, (chunkSize >> 24) & 0xff);
      this.buffer.setByte(headerPos + 3, (chunkSize >> 16) & 0xff);
      this.buffer.setByte(headerPos + 4, (chunkSize >> 8) & 0xff);
      this.buffer.setByte(headerPos + 5, chunkSize & 0xff);
    }

    this.prevFrame = quantizedPixels;
  }

  // ==========================================================================
  // Finalization
  // ==========================================================================

  private writeIndex(): void {
    if (!(this.header.flags & QOV_FLAG_HAS_INDEX) || this.keyframes.length === 0) {
      return;
    }

    this.writeU8(QOV_CHUNK_INDEX);
    this.writeU8(0x00);
    const size = 4 + this.keyframes.length * 16;
    this.writeU32(size);
    this.writeU32(0);

    this.writeU32(this.keyframes.length);

    for (const kf of this.keyframes) {
      this.writeU32(kf.frameNumber);
      this.writeU32(0);
      this.writeU32(kf.offset);
      this.writeU32(kf.timestamp);
    }
  }

  private writeEnd(): void {
    this.writeU8(QOV_CHUNK_END);
    this.writeU8(0x00);
    this.writeU32(0);
    this.writeU32(0);
    this.writeEndMarker();
  }

  /**
   * Finish encoding and return the encoded video data
   */
  finish(): Uint8Array {
    this.writeIndex();
    this.writeEnd();

    // Update total frame count in header
    this.buffer.setByte(14, (this.frameCount >> 24) & 0xff);
    this.buffer.setByte(15, (this.frameCount >> 16) & 0xff);
    this.buffer.setByte(16, (this.frameCount >> 8) & 0xff);
    this.buffer.setByte(17, this.frameCount & 0xff);

    const result = this.buffer.toUint8Array();

    // Update stats
    this.stats.compressedSize = result.length;
    this.stats.uncompressedSize = this.header.width * this.header.height * 4 * this.frameCount;
    this.stats.compressionRatio = this.stats.uncompressedSize / this.stats.compressedSize;

    return result;
  }

  /**
   * Get encoding statistics
   */
  getStats(): QovLossyStats {
    return { ...this.stats };
  }

  /**
   * Get the current frame count
   */
  getFrameCount(): number {
    return this.frameCount;
  }

  /**
   * Get the lossy parameters being used
   */
  getLossyParams(): QovLossyParams {
    return { ...this.lossyParams };
  }
}

/**
 * Calculate PSNR between original and decoded frames
 */
export function calculatePsnr(
  original: Uint8ClampedArray,
  decoded: Uint8ClampedArray
): number {
  if (original.length !== decoded.length) {
    throw new Error('Frame sizes do not match');
  }

  let mse = 0;
  const pixelCount = original.length / 4;

  for (let i = 0; i < original.length; i += 4) {
    const dr = original[i] - decoded[i];
    const dg = original[i + 1] - decoded[i + 1];
    const db = original[i + 2] - decoded[i + 2];
    mse += dr * dr + dg * dg + db * db;
  }

  mse /= (pixelCount * 3);

  if (mse === 0) return Infinity;

  return 10 * Math.log10(255 * 255 / mse);
}
