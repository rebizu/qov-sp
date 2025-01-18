// QOV Encoder based on qov-specification.md

import {
  QovHeader,
  QovRGBA,
  QOV_COLORSPACE_SRGB,
  QOV_COLORSPACE_YUV420,
  QOV_COLORSPACE_YUV422,
  QOV_COLORSPACE_YUVA420,
  QOV_FLAG_HAS_INDEX,
  QOV_FLAG_HAS_ALPHA,
  QOV_CHUNK_SYNC,
  QOV_CHUNK_KEYFRAME,
  QOV_CHUNK_PFRAME,
  QOV_CHUNK_INDEX,
  QOV_CHUNK_END,
  QOV_CHUNK_FLAG_YUV,
  QOV_CHUNK_FLAG_COMPRESSED,
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

// Growable buffer for efficient byte writing
class GrowableBuffer {
  private chunks: Uint8Array[] = [];
  private currentChunk: Uint8Array;
  private currentPos = 0;
  private totalSize = 0;
  private chunkSize: number;

  constructor(initialChunkSize = 1024 * 1024) { // 1MB chunks
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

  // Set byte at position (for patching header)
  setByte(pos: number, v: number): void {
    let offset = 0;
    for (const chunk of this.chunks) {
      if (pos < offset + chunk.length) {
        chunk[pos - offset] = v & 0xff;
        return;
      }
      offset += chunk.length;
    }
    // Must be in current chunk
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
    // Copy used portion of current chunk
    result.set(this.currentChunk.subarray(0, this.currentPos), offset);
    return result;
  }
}

export class QovEncoder {
  private header: QovHeader;
  private buffer: GrowableBuffer;
  private compressionEnabled: boolean;

  // Temporary buffer for frame encoding before compression
  private frameBuffer: GrowableBuffer | null = null;

  // RGB mode state
  private rgbIndex: QovRGBA[] = new Array(64);
  private prevPixel: QovRGBA = { r: 0, g: 0, b: 0, a: 255 };

  // Reference frames
  private prevFrame: Uint8ClampedArray | null = null;
  private prevYPlane: Uint8Array | null = null;
  private prevUPlane: Uint8Array | null = null;
  private prevVPlane: Uint8Array | null = null;
  private prevAPlane: Uint8Array | null = null;

  private keyframes: KeyframeInfo[] = [];
  private frameCount = 0;
  private isYuvMode = false;
  private hasAlpha = false;

  constructor(
    width: number,
    height: number,
    frameRateNum = 30,
    frameRateDen = 1,
    flags = QOV_FLAG_HAS_INDEX,
    colorspace = QOV_COLORSPACE_SRGB,
    compressionEnabled = true
  ) {
    this.header = {
      magic: 'qovf',
      version: 0x01,
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

    // Determine mode based on colorspace
    this.isYuvMode = colorspace >= 0x10 && colorspace <= 0x13;
    this.hasAlpha = (flags & QOV_FLAG_HAS_ALPHA) !== 0 ||
                    colorspace === QOV_COLORSPACE_YUVA420;

    console.log(`[Encoder] Created with colorspace: 0x${colorspace.toString(16)}, YUV mode: ${this.isYuvMode}, hasAlpha: ${this.hasAlpha}, compression: ${compressionEnabled}`);

    // Initialize buffer with appropriate chunk size based on resolution
    const pixelsPerFrame = width * height;
    const estimatedBytesPerFrame = Math.max(pixelsPerFrame / 4, 10000);
    this.buffer = new GrowableBuffer(Math.max(estimatedBytesPerFrame * 10, 1024 * 1024));

    // Initialize frame buffer for compression if enabled
    if (compressionEnabled) {
      this.frameBuffer = new GrowableBuffer(Math.max(estimatedBytesPerFrame * 2, 256 * 1024));
    }

    // Initialize color indices
    this.resetRgbIndex();
  }

  private resetRgbIndex(): void {
    for (let i = 0; i < 64; i++) {
      this.rgbIndex[i] = { r: 0, g: 0, b: 0, a: 0 };
    }
    this.prevPixel = { r: 0, g: 0, b: 0, a: 255 };
  }

  // Current write target (main buffer or frame buffer for compression)
  private activeBuffer: GrowableBuffer | null = null;

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

  // Start encoding frame data to temporary buffer (for compression)
  private startFrameData(): void {
    if (this.compressionEnabled && this.frameBuffer) {
      // Reset frame buffer for new frame
      this.frameBuffer = new GrowableBuffer(256 * 1024);
      this.activeBuffer = this.frameBuffer;
    }
  }

  // Finish frame data and write compressed/uncompressed chunk to main buffer
  private finishFrameData(chunkType: number, baseFlags: number, timestamp: number): void {
    if (!this.compressionEnabled || !this.frameBuffer) {
      // No compression, data already written to main buffer
      return;
    }

    // Get the frame data
    const frameData = this.frameBuffer.toUint8Array();
    const uncompressedSize = frameData.length;
    this.activeBuffer = null;

    // Try to compress
    const compressed = lz4Compress(frameData);

    if (compressed) {
      // Compression was effective, write compressed chunk
      const chunkFlags = baseFlags | QOV_CHUNK_FLAG_COMPRESSED;
      const chunkSize = compressed.length + 4; // +4 for uncompressed size

      // Write chunk header
      this.buffer.writeByte(chunkType);
      this.buffer.writeByte(chunkFlags);
      this.buffer.writeU32(chunkSize);
      this.buffer.writeU32(timestamp);

      // Write uncompressed size (before compressed data)
      this.buffer.writeU32(uncompressedSize);

      // Write compressed data
      for (let i = 0; i < compressed.length; i++) {
        this.buffer.writeByte(compressed[i]);
      }
    } else {
      // Compression not effective, write uncompressed
      const chunkFlags = baseFlags;
      const chunkSize = uncompressedSize;

      // Write chunk header
      this.buffer.writeByte(chunkType);
      this.buffer.writeByte(chunkFlags);
      this.buffer.writeU32(chunkSize);
      this.buffer.writeU32(timestamp);

      // Write uncompressed data
      for (let i = 0; i < frameData.length; i++) {
        this.buffer.writeByte(frameData[i]);
      }
    }
  }

  private colorHash(c: QovRGBA): number {
    return (c.r * 3 + c.g * 5 + c.b * 7 + c.a * 11) % 64;
  }

  writeHeader(): void {
    // Magic "qovf"
    this.writeU8(0x71); // 'q'
    this.writeU8(0x6f); // 'o'
    this.writeU8(0x76); // 'v'
    this.writeU8(0x66); // 'f'

    // Version (0x02 = 32-bit chunk sizes)
    this.writeU8(0x02);

    // Flags
    this.writeU8(this.header.flags);

    // Dimensions
    this.writeU16(this.header.width);
    this.writeU16(this.header.height);

    // Frame rate
    this.writeU16(this.header.frameRateNum);
    this.writeU16(this.header.frameRateDen);

    // Total frames (placeholder - updated at finish)
    this.writeU32(0);

    // Audio (none for now)
    this.writeU8(0); // channels
    this.writeU8(0); // rate high
    this.writeU8(0); // rate mid
    this.writeU8(0); // rate low

    // Colorspace and reserved
    this.writeU8(this.header.colorspace);
    this.writeU8(0x00);
  }

  private writeSync(frameNumber: number, timestamp: number): void {
    this.writeU8(QOV_CHUNK_SYNC); // type
    this.writeU8(0x00);           // flags
    this.writeU32(8);             // size (32-bit)
    this.writeU32(timestamp);

    // Sync data "QOVS"
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

  // Encode keyframe in YUV mode
  private encodeYuvKeyframe(pixels: Uint8ClampedArray, timestamp: number): void {
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

    // Write sync marker before keyframe (always to main buffer)
    this.writeSync(frameNumber, timestamp);

    // Convert to YUV planes based on colorspace
    let planes: { yPlane: Uint8Array; uPlane: Uint8Array; vPlane: Uint8Array; aPlane?: Uint8Array };

    if (colorspace === QOV_COLORSPACE_YUV420 || colorspace === QOV_COLORSPACE_YUVA420) {
      planes = rgbaToYuv420Planes(pixels, width, height, this.hasAlpha);
    } else if (colorspace === QOV_COLORSPACE_YUV422) {
      planes = rgbaToYuv422Planes(pixels, width, height, this.hasAlpha);
    } else {
      planes = rgbaToYuv444Planes(pixels, width, height, this.hasAlpha);
    }

    if (this.compressionEnabled) {
      // Compression mode: encode to temp buffer, then compress
      this.startFrameData();

      // Encode planes to frame buffer
      this.encodeYuvPlaneKeyframe(planes.yPlane);
      this.encodeYuvPlaneKeyframe(planes.uPlane);
      this.encodeYuvPlaneKeyframe(planes.vPlane);
      if (planes.aPlane) {
        this.encodeYuvPlaneKeyframe(planes.aPlane);
      }
      this.writeEndMarker();

      // Compress and write to main buffer
      this.finishFrameData(QOV_CHUNK_KEYFRAME, QOV_CHUNK_FLAG_YUV, timestamp);
    } else {
      // No compression: write directly
      const headerPos = this.buffer.getSize();
      this.writeU8(QOV_CHUNK_KEYFRAME);
      this.writeU8(QOV_CHUNK_FLAG_YUV);
      this.writeU32(0); // size placeholder
      this.writeU32(timestamp);

      const dataStart = this.buffer.getSize();

      this.encodeYuvPlaneKeyframe(planes.yPlane);
      this.encodeYuvPlaneKeyframe(planes.uPlane);
      this.encodeYuvPlaneKeyframe(planes.vPlane);
      if (planes.aPlane) {
        this.encodeYuvPlaneKeyframe(planes.aPlane);
      }
      this.writeEndMarker();

      // Update chunk size
      const chunkSize = this.buffer.getSize() - dataStart;
      this.buffer.setByte(headerPos + 2, (chunkSize >> 24) & 0xff);
      this.buffer.setByte(headerPos + 3, (chunkSize >> 16) & 0xff);
      this.buffer.setByte(headerPos + 4, (chunkSize >> 8) & 0xff);
      this.buffer.setByte(headerPos + 5, chunkSize & 0xff);
    }

    // Store planes for P-frame reference
    this.prevYPlane = planes.yPlane;
    this.prevUPlane = planes.uPlane;
    this.prevVPlane = planes.vPlane;
    this.prevAPlane = planes.aPlane || null;
    this.prevFrame = new Uint8ClampedArray(pixels);
  }

  // Encode a single plane for keyframe
  private encodeYuvPlaneKeyframe(plane: Uint8Array): void {
    const size = plane.length;
    let prevVal = 0;
    let run = 0;
    const index: number[] = new Array(64).fill(0);

    for (let i = 0; i < size; i++) {
      const val = plane[i];

      // Check for run
      if (val === prevVal) {
        run++;
        if (run === 62 || i === size - 1) {
          this.writeU8(0xc0 | (run - 1)); // RUN
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
        this.writeU8(idx); // INDEX
      } else {
        // Try diff
        const d = val - prevVal;
        if (d >= -8 && d <= 7) {
          // DIFF: encode in 4 bits
          this.writeU8(0x40 | ((d + 8) & 0x0f));
        } else if (d >= -32 && d <= 31) {
          // LUMA-style: 6-bit diff
          this.writeU8(0x80 | (d + 32));
        } else {
          // FULL: literal value
          this.writeU8(0xfe);
          this.writeU8(val);
        }
      }

      index[idx] = val;
      prevVal = val;
    }
  }

  // Encode a single plane for P-frame (temporal)
  private encodeYuvPlanePFrame(plane: Uint8Array, prevPlane: Uint8Array): void {
    const size = plane.length;
    let skip = 0;
    const index: number[] = new Array(64).fill(0);

    for (let i = 0; i < size; i++) {
      const val = plane[i];
      const refVal = prevPlane[i];

      // Check if unchanged
      if (val === refVal) {
        skip++;
        if (skip === 62 || i === size - 1) {
          this.writeU8(0xc0 | (skip - 1)); // SKIP
          skip = 0;
        }
        continue;
      }

      // Flush skip
      if (skip > 0) {
        if (skip <= 62) {
          this.writeU8(0xc0 | (skip - 1));
        } else {
          this.writeU8(0x00); // SKIP_LONG
          this.writeU16(skip);
        }
        skip = 0;
      }

      // Try temporal diff
      const d = val - refVal;
      const idx = (val * 3) % 64;

      if (d >= -8 && d <= 7) {
        // TDIFF
        this.writeU8(0x40 | ((d + 8) & 0x0f));
        index[idx] = val;
      } else if (d >= -32 && d <= 31) {
        // TLUMA-style
        this.writeU8(0x80 | (d + 32));
        index[idx] = val;
      } else {
        // Check index
        if (index[idx] === val) {
          this.writeU8(idx);
        } else {
          // FULL
          this.writeU8(0xfe);
          this.writeU8(val);
        }
        index[idx] = val;
      }
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

  // Encode P-frame in YUV mode
  private encodeYuvPFrame(pixels: Uint8ClampedArray, timestamp: number): void {
    if (!this.prevYPlane || !this.prevUPlane || !this.prevVPlane) {
      this.encodeYuvKeyframe(pixels, timestamp);
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

    if (this.compressionEnabled) {
      // Compression mode: encode to temp buffer, then compress
      this.startFrameData();

      // Encode planes with temporal prediction
      this.encodeYuvPlanePFrame(planes.yPlane, this.prevYPlane);
      this.encodeYuvPlanePFrame(planes.uPlane, this.prevUPlane);
      this.encodeYuvPlanePFrame(planes.vPlane, this.prevVPlane);
      if (planes.aPlane && this.prevAPlane) {
        this.encodeYuvPlanePFrame(planes.aPlane, this.prevAPlane);
      }
      this.writeEndMarker();

      // Compress and write to main buffer
      this.finishFrameData(QOV_CHUNK_PFRAME, QOV_CHUNK_FLAG_YUV, timestamp);
    } else {
      // No compression: write directly
      const headerPos = this.buffer.getSize();
      this.writeU8(QOV_CHUNK_PFRAME);
      this.writeU8(QOV_CHUNK_FLAG_YUV);
      this.writeU32(0); // size placeholder
      this.writeU32(timestamp);

      const dataStart = this.buffer.getSize();

      this.encodeYuvPlanePFrame(planes.yPlane, this.prevYPlane);
      this.encodeYuvPlanePFrame(planes.uPlane, this.prevUPlane);
      this.encodeYuvPlanePFrame(planes.vPlane, this.prevVPlane);
      if (planes.aPlane && this.prevAPlane) {
        this.encodeYuvPlanePFrame(planes.aPlane, this.prevAPlane);
      }
      this.writeEndMarker();

      // Update chunk size
      const chunkSize = this.buffer.getSize() - dataStart;
      this.buffer.setByte(headerPos + 2, (chunkSize >> 24) & 0xff);
      this.buffer.setByte(headerPos + 3, (chunkSize >> 16) & 0xff);
      this.buffer.setByte(headerPos + 4, (chunkSize >> 8) & 0xff);
      this.buffer.setByte(headerPos + 5, chunkSize & 0xff);
    }

    // Store planes for next P-frame
    this.prevYPlane = planes.yPlane;
    this.prevUPlane = planes.uPlane;
    this.prevVPlane = planes.vPlane;
    this.prevAPlane = planes.aPlane || null;
    this.prevFrame = new Uint8ClampedArray(pixels);
  }

  encodeKeyframe(pixels: Uint8ClampedArray, timestamp: number): void {
    if (this.isYuvMode) {
      console.log(`[Encoder] Encoding YUV keyframe ${this.frameCount}`);
      this.encodeYuvKeyframe(pixels, timestamp);
      return;
    }
    console.log(`[Encoder] Encoding RGB keyframe ${this.frameCount}`);

    // RGB mode encoding
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

    // Write sync marker before keyframe (always to main buffer)
    this.writeSync(frameNumber, timestamp);

    // Reset encoder state
    this.resetRgbIndex();

    // Encode frame data
    const encodeRgbKeyframeData = () => {
      let run = 0;

      for (let px = 0; px < pixelCount; px++) {
        const offset = px * 4;
        const c: QovRGBA = {
          r: pixels[offset],
          g: pixels[offset + 1],
          b: pixels[offset + 2],
          a: pixels[offset + 3],
        };

        // Check for run
        if (c.r === this.prevPixel.r && c.g === this.prevPixel.g &&
            c.b === this.prevPixel.b && c.a === this.prevPixel.a) {
          run++;
          if (run === 62 || px === pixelCount - 1) {
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
        const idx = this.colorHash(c);
        const indexed = this.rgbIndex[idx];
        if (indexed.r === c.r && indexed.g === c.g &&
            indexed.b === c.b && indexed.a === c.a) {
          this.writeU8(idx);
        } else {
          // Try diff
          const dr = c.r - this.prevPixel.r;
          const dg = c.g - this.prevPixel.g;
          const db = c.b - this.prevPixel.b;
          const da = c.a - this.prevPixel.a;

          if (da === 0) {
            if (dr >= -2 && dr <= 1 && dg >= -2 && dg <= 1 && db >= -2 && db <= 1) {
              // QOV_OP_DIFF
              this.writeU8(0x40 | ((dr + 2) << 4) | ((dg + 2) << 2) | (db + 2));
            } else if (dg >= -32 && dg <= 31) {
              const dr_dg = dr - dg;
              const db_dg = db - dg;
              if (dr_dg >= -8 && dr_dg <= 7 && db_dg >= -8 && db_dg <= 7) {
                // QOV_OP_LUMA
                this.writeU8(0x80 | (dg + 32));
                this.writeU8(((dr_dg + 8) << 4) | (db_dg + 8));
              } else {
                // QOV_OP_RGB
                this.writeU8(0xfe);
                this.writeU8(c.r);
                this.writeU8(c.g);
                this.writeU8(c.b);
              }
            } else {
              // QOV_OP_RGB
              this.writeU8(0xfe);
              this.writeU8(c.r);
              this.writeU8(c.g);
              this.writeU8(c.b);
            }
          } else {
            // QOV_OP_RGBA
            this.writeU8(0xff);
            this.writeU8(c.r);
            this.writeU8(c.g);
            this.writeU8(c.b);
            this.writeU8(c.a);
          }
        }

        this.rgbIndex[idx] = c;
        this.prevPixel = c;
      }

      // End marker
      this.writeEndMarker();
    };

    if (this.compressionEnabled) {
      // Compression mode: encode to temp buffer, then compress
      this.startFrameData();
      encodeRgbKeyframeData();
      this.finishFrameData(QOV_CHUNK_KEYFRAME, 0x00, timestamp);
    } else {
      // No compression: write directly
      const headerPos = this.buffer.getSize();
      this.writeU8(QOV_CHUNK_KEYFRAME);
      this.writeU8(0x00); // flags (RGB mode)
      this.writeU32(0);   // size placeholder
      this.writeU32(timestamp);

      const dataStart = this.buffer.getSize();
      encodeRgbKeyframeData();

      // Update chunk size
      const chunkSize = this.buffer.getSize() - dataStart;
      this.buffer.setByte(headerPos + 2, (chunkSize >> 24) & 0xff);
      this.buffer.setByte(headerPos + 3, (chunkSize >> 16) & 0xff);
      this.buffer.setByte(headerPos + 4, (chunkSize >> 8) & 0xff);
      this.buffer.setByte(headerPos + 5, chunkSize & 0xff);
    }

    // Store frame for P-frame reference
    this.prevFrame = new Uint8ClampedArray(pixels);
  }

  encodePFrame(pixels: Uint8ClampedArray, timestamp: number): void {
    if (this.isYuvMode) {
      this.encodeYuvPFrame(pixels, timestamp);
      return;
    }

    if (!this.prevFrame) {
      this.encodeKeyframe(pixels, timestamp);
      return;
    }

    // RGB mode P-frame encoding
    this.frameCount++;
    const pixelCount = this.header.width * this.header.height;
    const prevFrameRef = this.prevFrame;

    // Encode frame data
    const encodeRgbPFrameData = () => {
      let skip = 0;

      for (let px = 0; px < pixelCount; px++) {
        const offset = px * 4;
        const c: QovRGBA = {
          r: pixels[offset],
          g: pixels[offset + 1],
          b: pixels[offset + 2],
          a: pixels[offset + 3],
        };
        const ref: QovRGBA = {
          r: prevFrameRef[offset],
          g: prevFrameRef[offset + 1],
          b: prevFrameRef[offset + 2],
          a: prevFrameRef[offset + 3],
        };

        // Check if pixel unchanged from reference
        if (c.r === ref.r && c.g === ref.g && c.b === ref.b && c.a === ref.a) {
          skip++;
          if (skip === 62 || px === pixelCount - 1) {
            this.writeU8(0xc0 | (skip - 1)); // QOV_OP_SKIP
            skip = 0;
          }
          continue;
        }

        // Flush skip
        if (skip > 0) {
          if (skip <= 62) {
            this.writeU8(0xc0 | (skip - 1));
          } else {
            this.writeU8(0x00); // QOV_OP_SKIP_LONG
            this.writeU16(skip);
          }
          skip = 0;
        }

        // Try temporal diff
        const dr = c.r - ref.r;
        const dg = c.g - ref.g;
        const db = c.b - ref.b;
        const da = c.a - ref.a;

        if (da === 0 && dr >= -2 && dr <= 1 && dg >= -2 && dg <= 1 && db >= -2 && db <= 1) {
          // QOV_OP_TDIFF
          this.writeU8(0x40 | ((dr + 2) << 4) | ((dg + 2) << 2) | (db + 2));
        } else if (da === 0 && dg >= -32 && dg <= 31) {
          const dr_dg = dr - dg;
          const db_dg = db - dg;
          if (dr_dg >= -8 && dr_dg <= 7 && db_dg >= -8 && db_dg <= 7) {
            // QOV_OP_TLUMA
            this.writeU8(0x80 | (dg + 32));
            this.writeU8(((dr_dg + 8) << 4) | (db_dg + 8));
          } else {
            // QOV_OP_RGB
            this.writeU8(0xfe);
            this.writeU8(c.r);
            this.writeU8(c.g);
            this.writeU8(c.b);
          }
        } else if (da === 0) {
          // QOV_OP_RGB
          this.writeU8(0xfe);
          this.writeU8(c.r);
          this.writeU8(c.g);
          this.writeU8(c.b);
        } else {
          // QOV_OP_RGBA
          this.writeU8(0xff);
          this.writeU8(c.r);
          this.writeU8(c.g);
          this.writeU8(c.b);
          this.writeU8(c.a);
        }

        const idx = this.colorHash(c);
        this.rgbIndex[idx] = c;
      }

      // End marker
      this.writeEndMarker();
    };

    if (this.compressionEnabled) {
      // Compression mode: encode to temp buffer, then compress
      this.startFrameData();
      encodeRgbPFrameData();
      this.finishFrameData(QOV_CHUNK_PFRAME, 0x00, timestamp);
    } else {
      // No compression: write directly
      const headerPos = this.buffer.getSize();
      this.writeU8(QOV_CHUNK_PFRAME);
      this.writeU8(0x00); // flags (no motion)
      this.writeU32(0);   // size placeholder
      this.writeU32(timestamp);

      const dataStart = this.buffer.getSize();
      encodeRgbPFrameData();

      // Update chunk size
      const chunkSize = this.buffer.getSize() - dataStart;
      this.buffer.setByte(headerPos + 2, (chunkSize >> 24) & 0xff);
      this.buffer.setByte(headerPos + 3, (chunkSize >> 16) & 0xff);
      this.buffer.setByte(headerPos + 4, (chunkSize >> 8) & 0xff);
      this.buffer.setByte(headerPos + 5, chunkSize & 0xff);
    }

    // Store frame for next P-frame reference
    this.prevFrame = new Uint8ClampedArray(pixels);
  }

  private writeIndex(): void {
    if (!(this.header.flags & QOV_FLAG_HAS_INDEX) || this.keyframes.length === 0) {
      return;
    }

    // Chunk header
    this.writeU8(QOV_CHUNK_INDEX); // type
    this.writeU8(0x00);            // flags
    const size = 4 + this.keyframes.length * 16;
    this.writeU32(size);           // size
    this.writeU32(0);              // timestamp (not used)

    // Entry count
    this.writeU32(this.keyframes.length);

    // Index entries
    for (const kf of this.keyframes) {
      this.writeU32(kf.frameNumber);
      // 8-byte offset
      this.writeU32(0);
      this.writeU32(kf.offset);
      this.writeU32(kf.timestamp);
    }
  }

  private writeEnd(): void {
    this.writeU8(QOV_CHUNK_END); // type
    this.writeU8(0x00);          // flags
    this.writeU32(0);            // size
    this.writeU32(0);            // timestamp

    // End pattern
    this.writeEndMarker();
  }

  finish(): Uint8Array {
    // Write index table
    this.writeIndex();

    // Write end marker
    this.writeEnd();

    // Update total frame count in header (offset 14-17)
    this.buffer.setByte(14, (this.frameCount >> 24) & 0xff);
    this.buffer.setByte(15, (this.frameCount >> 16) & 0xff);
    this.buffer.setByte(16, (this.frameCount >> 8) & 0xff);
    this.buffer.setByte(17, this.frameCount & 0xff);

    return this.buffer.toUint8Array();
  }

  getFrameCount(): number {
    return this.frameCount;
  }
}
