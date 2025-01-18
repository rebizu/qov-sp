// QOV Decoder based on qov-specification.md

import {
  QovHeader,
  QovChunkHeader,
  QovFrame,
  QovFileStats,
  QovChunkInfo,
  QovIndexEntry,
  QovRGBA,
  QOV_CHUNK_SYNC,
  QOV_CHUNK_KEYFRAME,
  QOV_CHUNK_PFRAME,
  QOV_CHUNK_BFRAME,
  QOV_CHUNK_AUDIO,
  QOV_CHUNK_INDEX,
  QOV_CHUNK_END,
  QOV_COLORSPACE_YUV420,
  QOV_COLORSPACE_YUV422,
  QOV_COLORSPACE_YUVA420,
  QOV_CHUNK_FLAG_COMPRESSED,
  getChunkTypeName,
} from './qov-types';

import { lz4Decompress } from './lz4';

import {
  yuv420PlanesToRgba,
  yuv422PlanesToRgba,
  yuv444PlanesToRgba,
} from './color-utils';

export class QovDecoder {
  private data: Uint8Array;
  private pos = 0;
  private header!: QovHeader;
  private index: QovRGBA[] = new Array(64);
  private prevPixel: QovRGBA = { r: 0, g: 0, b: 0, a: 255 };
  private prevFrame: Uint8ClampedArray | null = null;
  private currFrame: Uint8ClampedArray | null = null;
  private use32BitChunkSize = false; // true for version 0x02+

  // YUV mode state
  private isYuvMode = false;
  private hasYuvAlpha = false;
  private prevYPlane: Uint8Array | null = null;
  private prevUPlane: Uint8Array | null = null;
  private prevVPlane: Uint8Array | null = null;
  private prevAPlane: Uint8Array | null = null;
  private currYPlane: Uint8Array | null = null;
  private currUPlane: Uint8Array | null = null;
  private currVPlane: Uint8Array | null = null;
  private currAPlane: Uint8Array | null = null;

  // For decompression - allow reading from a temporary buffer
  private activeData: Uint8Array | null = null;
  private activePos = 0;

  constructor(data: Uint8Array) {
    this.data = data;
    this.resetIndex();
  }

  private resetIndex(): void {
    for (let i = 0; i < 64; i++) {
      this.index[i] = { r: 0, g: 0, b: 0, a: 0 };
    }
  }

  private readU8(): number {
    if (this.activeData) {
      return this.activeData[this.activePos++];
    }
    return this.data[this.pos++];
  }

  private readU16(): number {
    return (this.readU8() << 8) | this.readU8();
  }

  private readU32(): number {
    return (this.readU8() << 24) | (this.readU8() << 16) | (this.readU8() << 8) | this.readU8();
  }

  // Setup to read from decompressed data
  private setActiveData(data: Uint8Array | null): void {
    this.activeData = data;
    this.activePos = 0;
  }


  private colorHash(c: QovRGBA): number {
    return (c.r * 3 + c.g * 5 + c.b * 7 + c.a * 11) % 64;
  }

  decodeHeader(): QovHeader {
    this.pos = 0;

    // Check magic
    const magic = String.fromCharCode(
      this.data[0], this.data[1], this.data[2], this.data[3]
    );
    if (magic !== 'qovf') {
      throw new Error(`Invalid QOV magic: ${magic}`);
    }
    this.pos = 4;

    const version = this.readU8();
    if (version !== 0x01 && version !== 0x02) {
      throw new Error(`Unsupported QOV version: ${version}`);
    }
    // Version 0x02 uses 32-bit chunk sizes for large frames
    this.use32BitChunkSize = version >= 0x02;
    console.log(`[Decoder] Version 0x${version.toString(16)}, 32-bit chunks: ${this.use32BitChunkSize}`);

    this.header = {
      magic,
      version,
      flags: this.readU8(),
      width: this.readU16(),
      height: this.readU16(),
      frameRateNum: this.readU16(),
      frameRateDen: this.readU16(),
      totalFrames: this.readU32(),
      audioChannels: this.readU8(),
      audioRate: (this.readU8() << 16) | (this.readU8() << 8) | this.readU8(),
      colorspace: this.readU8(),
    };

    // Skip reserved byte
    this.pos++;

    // Detect YUV mode from colorspace
    const cs = this.header.colorspace;
    this.isYuvMode = cs >= QOV_COLORSPACE_YUV420 && cs <= QOV_COLORSPACE_YUVA420;
    this.hasYuvAlpha = cs === QOV_COLORSPACE_YUVA420;

    console.log(`[Decoder] Colorspace: 0x${cs.toString(16)}, YUV mode: ${this.isYuvMode}, Has alpha: ${this.hasYuvAlpha}`);

    // Initialize frame buffers
    const pixelCount = this.header.width * this.header.height * 4;
    this.prevFrame = new Uint8ClampedArray(pixelCount);
    this.currFrame = new Uint8ClampedArray(pixelCount);

    // Initialize YUV plane buffers if needed
    if (this.isYuvMode) {
      const { width, height } = this.header;
      const ySize = width * height;

      // Calculate UV plane sizes based on subsampling
      let uvSize: number;
      if (cs === QOV_COLORSPACE_YUV420 || cs === QOV_COLORSPACE_YUVA420) {
        uvSize = Math.ceil(width / 2) * Math.ceil(height / 2);
      } else if (cs === QOV_COLORSPACE_YUV422) {
        uvSize = Math.ceil(width / 2) * height;
      } else {
        uvSize = ySize; // 4:4:4
      }

      this.prevYPlane = new Uint8Array(ySize);
      this.prevUPlane = new Uint8Array(uvSize);
      this.prevVPlane = new Uint8Array(uvSize);
      this.currYPlane = new Uint8Array(ySize);
      this.currUPlane = new Uint8Array(uvSize);
      this.currVPlane = new Uint8Array(uvSize);

      if (this.hasYuvAlpha) {
        this.prevAPlane = new Uint8Array(ySize);
        this.currAPlane = new Uint8Array(ySize);
      }
    }

    return this.header;
  }

  private readChunkHeader(): QovChunkHeader {
    const chunkType = this.readU8();
    const chunkFlags = this.readU8();
    // Version 0x02+ uses 32-bit chunk size, older versions use 16-bit
    const chunkSize = this.use32BitChunkSize ? this.readU32() : this.readU16();
    const timestamp = this.readU32();

    // If compressed, read the uncompressed size (it's stored at start of chunk data)
    let uncompressedSize: number | undefined;
    if (chunkFlags & QOV_CHUNK_FLAG_COMPRESSED) {
      uncompressedSize = this.readU32();
    }

    return { chunkType, chunkFlags, chunkSize, timestamp, uncompressedSize };
  }

  private decodeKeyframeData(chunkSize: number): boolean {
    const dataEnd = this.pos + chunkSize - 8; // Exclude end marker
    const pixelCount = this.header.width * this.header.height;
    let px = 0;

    // Reset state
    this.resetIndex();
    this.prevPixel = { r: 0, g: 0, b: 0, a: 255 };

    while (px < pixelCount && this.pos < dataEnd) {
      const b1 = this.readU8();

      if (b1 === 0xfe) {
        // QOV_OP_RGB
        this.prevPixel.r = this.readU8();
        this.prevPixel.g = this.readU8();
        this.prevPixel.b = this.readU8();
      } else if (b1 === 0xff) {
        // QOV_OP_RGBA
        this.prevPixel.r = this.readU8();
        this.prevPixel.g = this.readU8();
        this.prevPixel.b = this.readU8();
        this.prevPixel.a = this.readU8();
      } else if ((b1 & 0xc0) === 0x00) {
        // QOV_OP_INDEX
        const idx = b1 & 0x3f;
        this.prevPixel = { ...this.index[idx] };
      } else if ((b1 & 0xc0) === 0x40) {
        // QOV_OP_DIFF
        this.prevPixel.r = (this.prevPixel.r + ((b1 >> 4) & 0x03) - 2) & 0xff;
        this.prevPixel.g = (this.prevPixel.g + ((b1 >> 2) & 0x03) - 2) & 0xff;
        this.prevPixel.b = (this.prevPixel.b + (b1 & 0x03) - 2) & 0xff;
      } else if ((b1 & 0xc0) === 0x80) {
        // QOV_OP_LUMA
        const b2 = this.readU8();
        const dg = (b1 & 0x3f) - 32;
        const dr_dg = ((b2 >> 4) & 0x0f) - 8;
        const db_dg = (b2 & 0x0f) - 8;
        this.prevPixel.r = (this.prevPixel.r + dg + dr_dg) & 0xff;
        this.prevPixel.g = (this.prevPixel.g + dg) & 0xff;
        this.prevPixel.b = (this.prevPixel.b + dg + db_dg) & 0xff;
      } else if ((b1 & 0xc0) === 0xc0) {
        // QOV_OP_RUN
        const run = (b1 & 0x3f) + 1;
        for (let i = 0; i < run && px < pixelCount; i++) {
          const offset = px * 4;
          this.currFrame![offset] = this.prevPixel.r;
          this.currFrame![offset + 1] = this.prevPixel.g;
          this.currFrame![offset + 2] = this.prevPixel.b;
          this.currFrame![offset + 3] = this.prevPixel.a;
          px++;
        }
        continue;
      }

      // Update color cache and store pixel
      this.index[this.colorHash(this.prevPixel)] = { ...this.prevPixel };
      const offset = px * 4;
      this.currFrame![offset] = this.prevPixel.r;
      this.currFrame![offset + 1] = this.prevPixel.g;
      this.currFrame![offset + 2] = this.prevPixel.b;
      this.currFrame![offset + 3] = this.prevPixel.a;
      px++;
    }

    // Skip to end of chunk (past end marker)
    this.pos = this.pos + (dataEnd - this.pos) + 8;

    // Swap frame buffers
    const tmp = this.prevFrame;
    this.prevFrame = this.currFrame;
    this.currFrame = tmp;

    return px === pixelCount;
  }

  // Decode RGB keyframe from decompressed buffer
  private decodeKeyframeDataFromBuffer(uncompressedSize: number): boolean {
    const dataEnd = uncompressedSize - 8; // Exclude end marker
    const pixelCount = this.header.width * this.header.height;
    let px = 0;

    // Reset state
    this.resetIndex();
    this.prevPixel = { r: 0, g: 0, b: 0, a: 255 };

    while (px < pixelCount && this.activePos < dataEnd) {
      const b1 = this.readU8();

      if (b1 === 0xfe) {
        // QOV_OP_RGB
        this.prevPixel.r = this.readU8();
        this.prevPixel.g = this.readU8();
        this.prevPixel.b = this.readU8();
      } else if (b1 === 0xff) {
        // QOV_OP_RGBA
        this.prevPixel.r = this.readU8();
        this.prevPixel.g = this.readU8();
        this.prevPixel.b = this.readU8();
        this.prevPixel.a = this.readU8();
      } else if ((b1 & 0xc0) === 0x00) {
        // QOV_OP_INDEX
        const idx = b1 & 0x3f;
        this.prevPixel = { ...this.index[idx] };
      } else if ((b1 & 0xc0) === 0x40) {
        // QOV_OP_DIFF
        this.prevPixel.r = (this.prevPixel.r + ((b1 >> 4) & 0x03) - 2) & 0xff;
        this.prevPixel.g = (this.prevPixel.g + ((b1 >> 2) & 0x03) - 2) & 0xff;
        this.prevPixel.b = (this.prevPixel.b + (b1 & 0x03) - 2) & 0xff;
      } else if ((b1 & 0xc0) === 0x80) {
        // QOV_OP_LUMA
        const b2 = this.readU8();
        const dg = (b1 & 0x3f) - 32;
        const dr_dg = ((b2 >> 4) & 0x0f) - 8;
        const db_dg = (b2 & 0x0f) - 8;
        this.prevPixel.r = (this.prevPixel.r + dg + dr_dg) & 0xff;
        this.prevPixel.g = (this.prevPixel.g + dg) & 0xff;
        this.prevPixel.b = (this.prevPixel.b + dg + db_dg) & 0xff;
      } else if ((b1 & 0xc0) === 0xc0) {
        // QOV_OP_RUN
        const run = (b1 & 0x3f) + 1;
        for (let i = 0; i < run && px < pixelCount; i++) {
          const offset = px * 4;
          this.currFrame![offset] = this.prevPixel.r;
          this.currFrame![offset + 1] = this.prevPixel.g;
          this.currFrame![offset + 2] = this.prevPixel.b;
          this.currFrame![offset + 3] = this.prevPixel.a;
          px++;
        }
        continue;
      }

      // Update color cache and store pixel
      this.index[this.colorHash(this.prevPixel)] = { ...this.prevPixel };
      const offset = px * 4;
      this.currFrame![offset] = this.prevPixel.r;
      this.currFrame![offset + 1] = this.prevPixel.g;
      this.currFrame![offset + 2] = this.prevPixel.b;
      this.currFrame![offset + 3] = this.prevPixel.a;
      px++;
    }

    // Swap frame buffers
    const tmp = this.prevFrame;
    this.prevFrame = this.currFrame;
    this.currFrame = tmp;

    return px === pixelCount;
  }

  // Decode a single YUV plane for keyframe
  private decodeYuvPlaneKeyframe(plane: Uint8Array, size: number): number {
    let prevVal = 0;
    const index: number[] = new Array(64).fill(0);
    let px = 0;
    const startPos = this.pos;

    while (px < size) {
      const b1 = this.readU8();

      if ((b1 & 0xc0) === 0xc0 && b1 < 0xfe) {
        // RUN: repeat previous value
        const run = (b1 & 0x3f) + 1;
        for (let i = 0; i < run && px < size; i++) {
          plane[px++] = prevVal;
        }
      } else if ((b1 & 0xc0) === 0x00) {
        // INDEX: lookup from cache
        const idx = b1 & 0x3f;
        prevVal = index[idx];
        plane[px++] = prevVal;
      } else if ((b1 & 0xc0) === 0x40) {
        // DIFF: small difference (4-bit)
        const d = (b1 & 0x0f) - 8;
        prevVal = (prevVal + d) & 0xff;
        const idx = (prevVal * 3) % 64;
        index[idx] = prevVal;
        plane[px++] = prevVal;
      } else if ((b1 & 0xc0) === 0x80) {
        // LUMA-style: 6-bit difference
        const d = (b1 & 0x3f) - 32;
        prevVal = (prevVal + d) & 0xff;
        const idx = (prevVal * 3) % 64;
        index[idx] = prevVal;
        plane[px++] = prevVal;
      } else if (b1 === 0xfe) {
        // FULL: literal value
        prevVal = this.readU8();
        const idx = (prevVal * 3) % 64;
        index[idx] = prevVal;
        plane[px++] = prevVal;
      } else {
        // Unknown opcode
        console.warn(`[Decoder] Unknown YUV keyframe opcode: 0x${b1.toString(16)} at px=${px}`);
        break;
      }
    }

    console.log(`[Decoder] Decoded YUV plane: ${px} pixels, ${this.pos - startPos} bytes`);
    return px;
  }

  // Decode a single YUV plane for P-frame (temporal)
  private decodeYuvPlanePFrame(plane: Uint8Array, prevPlane: Uint8Array, size: number): number {
    const index: number[] = new Array(64).fill(0);
    let px = 0;
    const startPos = this.pos;

    // Start with copy of previous plane
    plane.set(prevPlane);

    while (px < size) {
      const b1 = this.readU8();

      if (b1 === 0x00) {
        // SKIP_LONG: skip many pixels
        const skip = this.readU16();
        px += skip;
      } else if ((b1 & 0xc0) === 0xc0 && b1 < 0xfe) {
        // SKIP: unchanged from reference
        const skip = (b1 & 0x3f) + 1;
        px += skip;
      } else if ((b1 & 0xc0) === 0x00) {
        // INDEX: lookup from cache
        const idx = b1 & 0x3f;
        plane[px++] = index[idx];
      } else if ((b1 & 0xc0) === 0x40) {
        // TDIFF: small temporal difference
        const d = (b1 & 0x0f) - 8;
        plane[px] = (prevPlane[px] + d) & 0xff;
        const idx = (plane[px] * 3) % 64;
        index[idx] = plane[px];
        px++;
      } else if ((b1 & 0xc0) === 0x80) {
        // TLUMA-style: 6-bit temporal difference
        const d = (b1 & 0x3f) - 32;
        plane[px] = (prevPlane[px] + d) & 0xff;
        const idx = (plane[px] * 3) % 64;
        index[idx] = plane[px];
        px++;
      } else if (b1 === 0xfe) {
        // FULL: literal value
        plane[px] = this.readU8();
        const idx = (plane[px] * 3) % 64;
        index[idx] = plane[px];
        px++;
      } else {
        // Unknown opcode
        console.warn(`[Decoder] Unknown YUV P-frame opcode: 0x${b1.toString(16)} at px=${px}`);
        break;
      }
    }

    return this.pos - startPos;
  }

  // Convert YUV planes to RGBA frame
  private yuvPlanesToRgba(): void {
    if (!this.currYPlane || !this.currUPlane || !this.currVPlane) return;

    const { width, height, colorspace } = this.header;
    const aPlane = this.hasYuvAlpha ? this.currAPlane : null;

    let pixels: Uint8ClampedArray;
    if (colorspace === QOV_COLORSPACE_YUV420 || colorspace === QOV_COLORSPACE_YUVA420) {
      pixels = yuv420PlanesToRgba(this.currYPlane, this.currUPlane, this.currVPlane, aPlane, width, height);
    } else if (colorspace === QOV_COLORSPACE_YUV422) {
      pixels = yuv422PlanesToRgba(this.currYPlane, this.currUPlane, this.currVPlane, aPlane, width, height);
    } else {
      pixels = yuv444PlanesToRgba(this.currYPlane, this.currUPlane, this.currVPlane, aPlane, width, height);
    }

    this.currFrame!.set(pixels);
  }

  // Decode YUV keyframe
  private decodeYuvKeyframeData(chunkSize: number): boolean {
    const dataEnd = this.pos + chunkSize - 8;
    const { width, height, colorspace } = this.header;
    const ySize = width * height;

    // Calculate UV sizes
    let uvSize: number;
    if (colorspace === QOV_COLORSPACE_YUV420 || colorspace === QOV_COLORSPACE_YUVA420) {
      uvSize = Math.ceil(width / 2) * Math.ceil(height / 2);
    } else if (colorspace === QOV_COLORSPACE_YUV422) {
      uvSize = Math.ceil(width / 2) * height;
    } else {
      uvSize = ySize;
    }

    // Decode Y plane
    this.decodeYuvPlaneKeyframe(this.currYPlane!, ySize);

    // Decode U plane
    this.decodeYuvPlaneKeyframe(this.currUPlane!, uvSize);

    // Decode V plane
    this.decodeYuvPlaneKeyframe(this.currVPlane!, uvSize);

    // Decode A plane if present
    if (this.hasYuvAlpha && this.currAPlane) {
      this.decodeYuvPlaneKeyframe(this.currAPlane, ySize);
    }

    // Skip to end of chunk (past end marker)
    this.pos = dataEnd + 8;

    // Convert to RGBA
    this.yuvPlanesToRgba();

    // Swap plane buffers
    [this.prevYPlane, this.currYPlane] = [this.currYPlane, this.prevYPlane];
    [this.prevUPlane, this.currUPlane] = [this.currUPlane, this.prevUPlane];
    [this.prevVPlane, this.currVPlane] = [this.currVPlane, this.prevVPlane];
    if (this.hasYuvAlpha) {
      [this.prevAPlane, this.currAPlane] = [this.currAPlane, this.prevAPlane];
    }

    // Swap frame buffers
    const tmp = this.prevFrame;
    this.prevFrame = this.currFrame;
    this.currFrame = tmp;

    return true;
  }

  // Decode YUV keyframe from decompressed buffer
  private decodeYuvKeyframeDataFromBuffer(_uncompressedSize: number): boolean {
    const { width, height, colorspace } = this.header;
    const ySize = width * height;

    // Calculate UV sizes
    let uvSize: number;
    if (colorspace === QOV_COLORSPACE_YUV420 || colorspace === QOV_COLORSPACE_YUVA420) {
      uvSize = Math.ceil(width / 2) * Math.ceil(height / 2);
    } else if (colorspace === QOV_COLORSPACE_YUV422) {
      uvSize = Math.ceil(width / 2) * height;
    } else {
      uvSize = ySize;
    }

    // Decode Y plane
    this.decodeYuvPlaneKeyframe(this.currYPlane!, ySize);

    // Decode U plane
    this.decodeYuvPlaneKeyframe(this.currUPlane!, uvSize);

    // Decode V plane
    this.decodeYuvPlaneKeyframe(this.currVPlane!, uvSize);

    // Decode A plane if present
    if (this.hasYuvAlpha && this.currAPlane) {
      this.decodeYuvPlaneKeyframe(this.currAPlane, ySize);
    }

    // Convert to RGBA
    this.yuvPlanesToRgba();

    // Swap plane buffers
    [this.prevYPlane, this.currYPlane] = [this.currYPlane, this.prevYPlane];
    [this.prevUPlane, this.currUPlane] = [this.currUPlane, this.prevUPlane];
    [this.prevVPlane, this.currVPlane] = [this.currVPlane, this.prevVPlane];
    if (this.hasYuvAlpha) {
      [this.prevAPlane, this.currAPlane] = [this.currAPlane, this.prevAPlane];
    }

    // Swap frame buffers
    const tmp = this.prevFrame;
    this.prevFrame = this.currFrame;
    this.currFrame = tmp;

    return true;
  }

  // Decode YUV P-frame
  private decodeYuvPFrameData(chunkSize: number): boolean {
    const dataEnd = this.pos + chunkSize - 8;
    const { width, height, colorspace } = this.header;
    const ySize = width * height;

    // Calculate UV sizes
    let uvSize: number;
    if (colorspace === QOV_COLORSPACE_YUV420 || colorspace === QOV_COLORSPACE_YUVA420) {
      uvSize = Math.ceil(width / 2) * Math.ceil(height / 2);
    } else if (colorspace === QOV_COLORSPACE_YUV422) {
      uvSize = Math.ceil(width / 2) * height;
    } else {
      uvSize = ySize;
    }

    // Decode Y plane with temporal prediction
    this.decodeYuvPlanePFrame(this.currYPlane!, this.prevYPlane!, ySize);

    // Decode U plane
    this.decodeYuvPlanePFrame(this.currUPlane!, this.prevUPlane!, uvSize);

    // Decode V plane
    this.decodeYuvPlanePFrame(this.currVPlane!, this.prevVPlane!, uvSize);

    // Decode A plane if present
    if (this.hasYuvAlpha && this.currAPlane && this.prevAPlane) {
      this.decodeYuvPlanePFrame(this.currAPlane, this.prevAPlane, ySize);
    }

    // Skip to end of chunk
    this.pos = dataEnd + 8;

    // Convert to RGBA
    this.yuvPlanesToRgba();

    // Swap plane buffers
    [this.prevYPlane, this.currYPlane] = [this.currYPlane, this.prevYPlane];
    [this.prevUPlane, this.currUPlane] = [this.currUPlane, this.prevUPlane];
    [this.prevVPlane, this.currVPlane] = [this.currVPlane, this.prevVPlane];
    if (this.hasYuvAlpha) {
      [this.prevAPlane, this.currAPlane] = [this.currAPlane, this.prevAPlane];
    }

    // Swap frame buffers
    const tmp = this.prevFrame;
    this.prevFrame = this.currFrame;
    this.currFrame = tmp;

    return true;
  }

  // Decode YUV P-frame from decompressed buffer
  private decodeYuvPFrameDataFromBuffer(_uncompressedSize: number): boolean {
    const { width, height, colorspace } = this.header;
    const ySize = width * height;

    // Calculate UV sizes
    let uvSize: number;
    if (colorspace === QOV_COLORSPACE_YUV420 || colorspace === QOV_COLORSPACE_YUVA420) {
      uvSize = Math.ceil(width / 2) * Math.ceil(height / 2);
    } else if (colorspace === QOV_COLORSPACE_YUV422) {
      uvSize = Math.ceil(width / 2) * height;
    } else {
      uvSize = ySize;
    }

    // Decode Y plane with temporal prediction
    this.decodeYuvPlanePFrame(this.currYPlane!, this.prevYPlane!, ySize);

    // Decode U plane
    this.decodeYuvPlanePFrame(this.currUPlane!, this.prevUPlane!, uvSize);

    // Decode V plane
    this.decodeYuvPlanePFrame(this.currVPlane!, this.prevVPlane!, uvSize);

    // Decode A plane if present
    if (this.hasYuvAlpha && this.currAPlane && this.prevAPlane) {
      this.decodeYuvPlanePFrame(this.currAPlane, this.prevAPlane, ySize);
    }

    // Convert to RGBA
    this.yuvPlanesToRgba();

    // Swap plane buffers
    [this.prevYPlane, this.currYPlane] = [this.currYPlane, this.prevYPlane];
    [this.prevUPlane, this.currUPlane] = [this.currUPlane, this.prevUPlane];
    [this.prevVPlane, this.currVPlane] = [this.currVPlane, this.prevVPlane];
    if (this.hasYuvAlpha) {
      [this.prevAPlane, this.currAPlane] = [this.currAPlane, this.prevAPlane];
    }

    // Swap frame buffers
    const tmp = this.prevFrame;
    this.prevFrame = this.currFrame;
    this.currFrame = tmp;

    return true;
  }

  private decodePFrameData(chunkSize: number, hasMotion: boolean): boolean {
    const dataEnd = this.pos + chunkSize - 8;
    const pixelCount = this.header.width * this.header.height;

    // Copy previous frame as base (no motion vectors)
    if (!hasMotion) {
      this.currFrame!.set(this.prevFrame!);
    }

    let px = 0;

    while (px < pixelCount && this.pos < dataEnd) {
      const b1 = this.readU8();

      if (b1 === 0x00) {
        // QOV_OP_SKIP_LONG
        const skip = this.readU16();
        px += skip;
      } else if ((b1 & 0xc0) === 0xc0 && b1 < 0xfe) {
        // QOV_OP_SKIP
        const skip = (b1 & 0x3f) + 1;
        px += skip;
      } else if ((b1 & 0xc0) === 0x40) {
        // QOV_OP_TDIFF
        const offset = px * 4;
        this.currFrame![offset] = (this.currFrame![offset] + ((b1 >> 4) & 0x03) - 2) & 0xff;
        this.currFrame![offset + 1] = (this.currFrame![offset + 1] + ((b1 >> 2) & 0x03) - 2) & 0xff;
        this.currFrame![offset + 2] = (this.currFrame![offset + 2] + (b1 & 0x03) - 2) & 0xff;

        const c: QovRGBA = {
          r: this.currFrame![offset],
          g: this.currFrame![offset + 1],
          b: this.currFrame![offset + 2],
          a: this.currFrame![offset + 3],
        };
        this.index[this.colorHash(c)] = c;
        px++;
      } else if ((b1 & 0xc0) === 0x80) {
        // QOV_OP_TLUMA
        const b2 = this.readU8();
        const offset = px * 4;
        const dg = (b1 & 0x3f) - 32;
        const dr_dg = ((b2 >> 4) & 0x0f) - 8;
        const db_dg = (b2 & 0x0f) - 8;

        this.currFrame![offset] = (this.currFrame![offset] + dg + dr_dg) & 0xff;
        this.currFrame![offset + 1] = (this.currFrame![offset + 1] + dg) & 0xff;
        this.currFrame![offset + 2] = (this.currFrame![offset + 2] + dg + db_dg) & 0xff;

        const c: QovRGBA = {
          r: this.currFrame![offset],
          g: this.currFrame![offset + 1],
          b: this.currFrame![offset + 2],
          a: this.currFrame![offset + 3],
        };
        this.index[this.colorHash(c)] = c;
        px++;
      } else if ((b1 & 0xc0) === 0x00) {
        // QOV_OP_INDEX
        const idx = b1 & 0x3f;
        const c = this.index[idx];
        const offset = px * 4;
        this.currFrame![offset] = c.r;
        this.currFrame![offset + 1] = c.g;
        this.currFrame![offset + 2] = c.b;
        this.currFrame![offset + 3] = c.a;
        px++;
      } else if (b1 === 0xfe) {
        // QOV_OP_RGB
        const offset = px * 4;
        this.currFrame![offset] = this.readU8();
        this.currFrame![offset + 1] = this.readU8();
        this.currFrame![offset + 2] = this.readU8();

        const c: QovRGBA = {
          r: this.currFrame![offset],
          g: this.currFrame![offset + 1],
          b: this.currFrame![offset + 2],
          a: this.currFrame![offset + 3],
        };
        this.index[this.colorHash(c)] = c;
        px++;
      } else if (b1 === 0xff) {
        // QOV_OP_RGBA
        const offset = px * 4;
        this.currFrame![offset] = this.readU8();
        this.currFrame![offset + 1] = this.readU8();
        this.currFrame![offset + 2] = this.readU8();
        this.currFrame![offset + 3] = this.readU8();

        const c: QovRGBA = {
          r: this.currFrame![offset],
          g: this.currFrame![offset + 1],
          b: this.currFrame![offset + 2],
          a: this.currFrame![offset + 3],
        };
        this.index[this.colorHash(c)] = c;
        px++;
      }
    }

    // Skip to end of chunk
    this.pos = this.pos + (dataEnd - this.pos) + 8;

    // Swap frame buffers
    const tmp = this.prevFrame;
    this.prevFrame = this.currFrame;
    this.currFrame = tmp;

    return true;
  }

  // Decode RGB P-frame from decompressed buffer
  private decodePFrameDataFromBuffer(uncompressedSize: number, hasMotion: boolean): boolean {
    const dataEnd = uncompressedSize - 8;
    const pixelCount = this.header.width * this.header.height;

    // Copy previous frame as base (no motion vectors)
    if (!hasMotion) {
      this.currFrame!.set(this.prevFrame!);
    }

    let px = 0;

    while (px < pixelCount && this.activePos < dataEnd) {
      const b1 = this.readU8();

      if (b1 === 0x00) {
        // QOV_OP_SKIP_LONG
        const skip = this.readU16();
        px += skip;
      } else if ((b1 & 0xc0) === 0xc0 && b1 < 0xfe) {
        // QOV_OP_SKIP
        const skip = (b1 & 0x3f) + 1;
        px += skip;
      } else if ((b1 & 0xc0) === 0x40) {
        // QOV_OP_TDIFF
        const offset = px * 4;
        this.currFrame![offset] = (this.currFrame![offset] + ((b1 >> 4) & 0x03) - 2) & 0xff;
        this.currFrame![offset + 1] = (this.currFrame![offset + 1] + ((b1 >> 2) & 0x03) - 2) & 0xff;
        this.currFrame![offset + 2] = (this.currFrame![offset + 2] + (b1 & 0x03) - 2) & 0xff;

        const c: QovRGBA = {
          r: this.currFrame![offset],
          g: this.currFrame![offset + 1],
          b: this.currFrame![offset + 2],
          a: this.currFrame![offset + 3],
        };
        this.index[this.colorHash(c)] = c;
        px++;
      } else if ((b1 & 0xc0) === 0x80) {
        // QOV_OP_TLUMA
        const b2 = this.readU8();
        const offset = px * 4;
        const dg = (b1 & 0x3f) - 32;
        const dr_dg = ((b2 >> 4) & 0x0f) - 8;
        const db_dg = (b2 & 0x0f) - 8;

        this.currFrame![offset] = (this.currFrame![offset] + dg + dr_dg) & 0xff;
        this.currFrame![offset + 1] = (this.currFrame![offset + 1] + dg) & 0xff;
        this.currFrame![offset + 2] = (this.currFrame![offset + 2] + dg + db_dg) & 0xff;

        const c: QovRGBA = {
          r: this.currFrame![offset],
          g: this.currFrame![offset + 1],
          b: this.currFrame![offset + 2],
          a: this.currFrame![offset + 3],
        };
        this.index[this.colorHash(c)] = c;
        px++;
      } else if ((b1 & 0xc0) === 0x00) {
        // QOV_OP_INDEX
        const idx = b1 & 0x3f;
        const c = this.index[idx];
        const offset = px * 4;
        this.currFrame![offset] = c.r;
        this.currFrame![offset + 1] = c.g;
        this.currFrame![offset + 2] = c.b;
        this.currFrame![offset + 3] = c.a;
        px++;
      } else if (b1 === 0xfe) {
        // QOV_OP_RGB
        const offset = px * 4;
        this.currFrame![offset] = this.readU8();
        this.currFrame![offset + 1] = this.readU8();
        this.currFrame![offset + 2] = this.readU8();

        const c: QovRGBA = {
          r: this.currFrame![offset],
          g: this.currFrame![offset + 1],
          b: this.currFrame![offset + 2],
          a: this.currFrame![offset + 3],
        };
        this.index[this.colorHash(c)] = c;
        px++;
      } else if (b1 === 0xff) {
        // QOV_OP_RGBA
        const offset = px * 4;
        this.currFrame![offset] = this.readU8();
        this.currFrame![offset + 1] = this.readU8();
        this.currFrame![offset + 2] = this.readU8();
        this.currFrame![offset + 3] = this.readU8();

        const c: QovRGBA = {
          r: this.currFrame![offset],
          g: this.currFrame![offset + 1],
          b: this.currFrame![offset + 2],
          a: this.currFrame![offset + 3],
        };
        this.index[this.colorHash(c)] = c;
        px++;
      }
    }

    // Swap frame buffers
    const tmp = this.prevFrame;
    this.prevFrame = this.currFrame;
    this.currFrame = tmp;

    return true;
  }

  *decodeFrames(): Generator<QovFrame> {
    if (!this.header) {
      this.decodeHeader();
    }

    this.pos = 24; // After header
    let frameNumber = 0;

    console.log(`[Decoder] Starting frame decode at pos ${this.pos}, file length: ${this.data.length}`);

    while (this.pos < this.data.length) {
      const chunkStartPos = this.pos;
      const chunkHeader = this.readChunkHeader();

      console.log(`[Decoder] Chunk at ${chunkStartPos}: type=0x${chunkHeader.chunkType.toString(16)}, size=${chunkHeader.chunkSize}, timestamp=${chunkHeader.timestamp}`);

      // Sanity check - if chunk size would go past end of file, there's likely a problem
      if (this.pos + chunkHeader.chunkSize > this.data.length) {
        console.error(`[Decoder] Chunk size ${chunkHeader.chunkSize} exceeds remaining data (${this.data.length - this.pos} bytes left)`);
        break;
      }

      switch (chunkHeader.chunkType) {
        case QOV_CHUNK_SYNC:
          // Skip sync marker data
          this.pos += chunkHeader.chunkSize;
          break;

        case QOV_CHUNK_KEYFRAME: {
          const isYuvChunk = (chunkHeader.chunkFlags & 0x01) !== 0;
          const isCompressed = (chunkHeader.chunkFlags & QOV_CHUNK_FLAG_COMPRESSED) !== 0;
          console.log(`[Decoder] Decoding keyframe ${frameNumber}, YUV: ${isYuvChunk}, Compressed: ${isCompressed}...`);

          // Determine the effective chunk size (excluding uncompressed_size if compressed)
          let effectiveChunkSize = chunkHeader.chunkSize;
          if (isCompressed) {
            // uncompressed_size was already read as part of header, adjust chunk size
            effectiveChunkSize -= 4;

            // Read compressed data and decompress
            const compressedData = this.data.subarray(this.pos, this.pos + effectiveChunkSize);
            this.pos += effectiveChunkSize;

            const decompressedData = lz4Decompress(compressedData, chunkHeader.uncompressedSize!);
            this.setActiveData(decompressedData);

            if (isYuvChunk || this.isYuvMode) {
              this.decodeYuvKeyframeDataFromBuffer(chunkHeader.uncompressedSize!);
            } else {
              this.decodeKeyframeDataFromBuffer(chunkHeader.uncompressedSize!);
            }

            this.setActiveData(null);
          } else {
            if (isYuvChunk || this.isYuvMode) {
              this.decodeYuvKeyframeData(chunkHeader.chunkSize);
            } else {
              this.decodeKeyframeData(chunkHeader.chunkSize);
            }
          }

          yield {
            pixels: new Uint8ClampedArray(this.prevFrame!),
            timestamp: chunkHeader.timestamp,
            isKeyframe: true,
            frameNumber: frameNumber++,
          };
          break;
        }

        case QOV_CHUNK_PFRAME: {
          const isYuvChunk = (chunkHeader.chunkFlags & 0x01) !== 0;
          const isCompressed = (chunkHeader.chunkFlags & QOV_CHUNK_FLAG_COMPRESSED) !== 0;
          console.log(`[Decoder] Decoding P-frame ${frameNumber}, YUV: ${isYuvChunk}, Compressed: ${isCompressed}...`);

          // Determine the effective chunk size (excluding uncompressed_size if compressed)
          let effectiveChunkSize = chunkHeader.chunkSize;
          if (isCompressed) {
            // uncompressed_size was already read as part of header, adjust chunk size
            effectiveChunkSize -= 4;

            // Read compressed data and decompress
            const compressedData = this.data.subarray(this.pos, this.pos + effectiveChunkSize);
            this.pos += effectiveChunkSize;

            const decompressedData = lz4Decompress(compressedData, chunkHeader.uncompressedSize!);
            this.setActiveData(decompressedData);

            if (isYuvChunk || this.isYuvMode) {
              this.decodeYuvPFrameDataFromBuffer(chunkHeader.uncompressedSize!);
            } else {
              this.decodePFrameDataFromBuffer(chunkHeader.uncompressedSize!, (chunkHeader.chunkFlags & 0x02) !== 0);
            }

            this.setActiveData(null);
          } else {
            if (isYuvChunk || this.isYuvMode) {
              this.decodeYuvPFrameData(chunkHeader.chunkSize);
            } else {
              this.decodePFrameData(chunkHeader.chunkSize, (chunkHeader.chunkFlags & 0x02) !== 0);
            }
          }

          yield {
            pixels: new Uint8ClampedArray(this.prevFrame!),
            timestamp: chunkHeader.timestamp,
            isKeyframe: false,
            frameNumber: frameNumber++,
          };
          break;
        }

        case QOV_CHUNK_BFRAME:
          // B-frames not implemented yet, skip
          this.pos += chunkHeader.chunkSize;
          break;

        case QOV_CHUNK_AUDIO:
          // Audio not implemented yet, skip
          this.pos += chunkHeader.chunkSize;
          break;

        case QOV_CHUNK_INDEX:
          // Skip index table
          this.pos += chunkHeader.chunkSize;
          break;

        case QOV_CHUNK_END:
          console.log(`[Decoder] Reached END chunk, total frames: ${frameNumber}`);
          return;

        default:
          // Unknown chunk, skip
          console.warn(`[Decoder] Unknown chunk type: 0x${chunkHeader.chunkType.toString(16)}`);
          this.pos += chunkHeader.chunkSize;
          break;
      }
    }

    console.log(`[Decoder] Finished, decoded ${frameNumber} frames`);
  }

  getFileStats(): QovFileStats {
    if (!this.header) {
      this.decodeHeader();
    }

    const chunks: QovChunkInfo[] = [];
    const keyframeIndices: number[] = [];
    const indexTable: QovIndexEntry[] = [];
    let frameIndex = 0;
    let lastTimestamp = 0;

    this.pos = 24; // After header

    while (this.pos < this.data.length) {
      const offset = this.pos;
      const chunkHeader = this.readChunkHeader();

      const headerSize = this.use32BitChunkSize ? 10 : 8;
      const isCompressed = (chunkHeader.chunkFlags & QOV_CHUNK_FLAG_COMPRESSED) !== 0;
      const chunkInfo: QovChunkInfo = {
        type: chunkHeader.chunkType,
        typeName: getChunkTypeName(chunkHeader.chunkType),
        offset,
        size: chunkHeader.chunkSize + headerSize,
        timestamp: chunkHeader.timestamp,
        isKeyframe: chunkHeader.chunkType === QOV_CHUNK_KEYFRAME,
        isCompressed,
        uncompressedSize: isCompressed ? chunkHeader.uncompressedSize : undefined,
      };
      chunks.push(chunkInfo);

      if (chunkHeader.chunkType === QOV_CHUNK_KEYFRAME) {
        keyframeIndices.push(frameIndex);
        frameIndex++;
      } else if (chunkHeader.chunkType === QOV_CHUNK_PFRAME ||
                 chunkHeader.chunkType === QOV_CHUNK_BFRAME) {
        frameIndex++;
      }

      if (chunkHeader.timestamp > lastTimestamp) {
        lastTimestamp = chunkHeader.timestamp;
      }

      // Parse index table if present
      if (chunkHeader.chunkType === QOV_CHUNK_INDEX) {
        const entryCount = this.readU32();
        for (let i = 0; i < entryCount; i++) {
          const frameNum = this.readU32();
          const offsetHigh = this.readU32();
          const offsetLow = this.readU32();
          const timestamp = this.readU32();
          indexTable.push({
            frameNum,
            fileOffset: BigInt(offsetHigh) << 32n | BigInt(offsetLow),
            timestamp,
          });
        }
      } else if (chunkHeader.chunkType === QOV_CHUNK_END) {
        break;
      } else {
        this.pos += chunkHeader.chunkSize;
      }
    }

    return {
      header: this.header,
      fileSize: this.data.length,
      chunks,
      keyframeIndices,
      indexTable,
      duration: lastTimestamp,
    };
  }

  getHeader(): QovHeader {
    if (!this.header) {
      this.decodeHeader();
    }
    return this.header;
  }
}
