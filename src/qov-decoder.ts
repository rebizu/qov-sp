// QOV Decoder based on qov-specification.md

import {
  QovHeader,
  QovChunkHeader,
  QovFrame,
  QovAudioFrame,
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
  QOV_CHUNK_FLAG_MOTION,
  QOV_FLAG_HAS_ALPHA,
  QOV_FLAG_LOSSY_MODE,
  QOV_VERSION_LOSSY,
  QOV_OP_DCT_Y,
  QOV_OP_DCT_UV,
  QOV_OP_SKIP_SIMILAR,
  QOV_OP_SKIP_SIMILAR_LONG,
  QOV_CHUNK_FLAG_DCT_BLOCKS,
  QOV_CHUNK_FLAG_EXP_GOLOB,
  QOV_CHUNK_FLAG_REFRESH_BAND,
  QOV_INTRA_REFRESH_BANDS,
  QOV_MAX_DIMENSION,
  QOV_MAX_PIXELS,
  getChunkTypeName,
  chromaPlaneDims,
} from './qov-types';

import {
  DEFAULT_QUANT_LUMA,
  DEFAULT_QUANT_CHROMA,
} from './dct';

import { decodePlaneDctInto, decodeIntraPlaneDctInto } from './dct-decode';

import { lz4Decompress } from './lz4';

import {
  MotionVectors,
  parseMvBlock,
  compensatePlane,
  compensateFrame,
  chromaMotionParams,
} from './motion';

import {
  yuv420PlanesToRgba,
  yuv422PlanesToRgba,
  yuv444PlanesToRgba,
} from './color-utils';

import { QoaDecoder } from './qoa';

export class QovDecoder {
  private data: Uint8Array;
  private pos = 0;
  private header!: QovHeader;
  private index: QovRGBA[] = new Array(64);
  private prevPixel: QovRGBA = { r: 0, g: 0, b: 0, a: 255 };
  private prevFrame: Uint8ClampedArray | null = null;
  private currFrame: Uint8ClampedArray | null = null;
  private use32BitChunkSize = false; // true for version 0x02+
  private headerSize = 24; // 24 bytes for v1/v2, 32 bytes for v3 (lossy)
  private frameCount = 0; // For debug logging

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

  private qoaDecoder = new QoaDecoder();

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
      if (this.activePos >= this.activeData.length) {
        throw new Error(`readU8: activePos ${this.activePos} >= activeData.length ${this.activeData.length}`);
      }
      return this.activeData[this.activePos++];
    }
    if (this.pos >= this.data.length) {
      throw new Error(`readU8: pos ${this.pos} >= data.length ${this.data.length}`);
    }
    return this.data[this.pos++];
  }

  private readU16(): number {
    return (this.readU8() << 8) | this.readU8();
  }

  private readU32(): number {
    return (((this.readU8() << 24) | (this.readU8() << 16) | (this.readU8() << 8) | this.readU8()) >>> 0);
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
    if (version !== 0x01 && version !== 0x02 && version !== 0x03) {
      throw new Error(`Unsupported QOV version: ${version}`);
    }
    // Version 0x02+ uses 32-bit chunk sizes for large frames
    this.use32BitChunkSize = version >= 0x02;
    const isLossyVersion = version === QOV_VERSION_LOSSY;
    console.log(`[Decoder] Version 0x${version.toString(16)}, 32-bit chunks: ${this.use32BitChunkSize}, lossy capable: ${isLossyVersion}`);

    const flags = this.readU8();
    const isLossyMode = (flags & QOV_FLAG_LOSSY_MODE) !== 0;

    this.header = {
      magic,
      version,
      flags,
      width: this.readU16(),
      height: this.readU16(),
      frameRateNum: this.readU16(),
      frameRateDen: this.readU16(),
      totalFrames: this.readU32(),
      audioChannels: this.readU8(),
      audioRate: (this.readU8() << 16) | (this.readU8() << 8) | this.readU8(),
      colorspace: this.readU8(),
    };

    // Validate before allocating frame buffers from untrusted header values
    if (this.header.width === 0 || this.header.height === 0 ||
        this.header.width > QOV_MAX_DIMENSION || this.header.height > QOV_MAX_DIMENSION ||
        this.header.width * this.header.height > QOV_MAX_PIXELS) {
      throw new Error(`Invalid frame dimensions: ${this.header.width}x${this.header.height}`);
    }
    if (this.header.frameRateDen === 0) {
      throw new Error('Invalid frame rate: denominator is 0');
    }

    // Quality byte (offset 23)
    const quality = this.readU8();
    if (isLossyMode) {
      this.header.quality = quality;
    }

    // Extended header for lossy mode (version 0x03, 32 bytes total)
    if (isLossyVersion) {
      this.header.yQuantBase = this.readU8();
      this.header.uvQuantBase = this.readU8();
      this.header.temporalThresh = this.readU8();
      this.header.dctQpBase = this.readU8();
      // Skip reserved bytes (4 bytes)
      this.pos += 4;
    }

    if (isLossyMode) {
      console.log(`[Decoder] Lossy mode: quality=${quality}, yQuant=${this.header.yQuantBase}, uvQuant=${this.header.uvQuantBase}, temporal=${this.header.temporalThresh}`);
    }

    // Set header size based on version
    this.headerSize = isLossyVersion ? 32 : 24;

    // Detect YUV mode from colorspace
    const cs = this.header.colorspace;
    this.isYuvMode = cs >= QOV_COLORSPACE_YUV420 && cs <= QOV_COLORSPACE_YUVA420;
    this.hasYuvAlpha = (this.header.flags & QOV_FLAG_HAS_ALPHA) !== 0 ||
      cs === QOV_COLORSPACE_YUVA420;

    console.log(`[Decoder] Colorspace: 0x${cs.toString(16)}, YUV mode: ${this.isYuvMode}, Has alpha: ${this.hasYuvAlpha}`);

    // Initialize frame buffers with opaque black (alpha = 255)
    // This ensures any undecoded pixels are visible for debugging
    const pixelCount = this.header.width * this.header.height * 4;
    this.prevFrame = new Uint8ClampedArray(pixelCount);
    this.currFrame = new Uint8ClampedArray(pixelCount);

    // Set alpha to 255 for all pixels (every 4th byte starting at index 3)
    for (let i = 3; i < pixelCount; i += 4) {
      this.prevFrame[i] = 255;
      this.currFrame[i] = 255;
    }

    // Initialize YUV plane buffers if needed
    if (this.isYuvMode) {
      const { width, height } = this.header;
      const ySize = width * height;

      // Calculate UV plane sizes based on subsampling
      const { w: uvW, h: uvH } = chromaPlaneDims(cs, width, height);
      const uvSize = uvW * uvH;

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

    // Check if all pixels were decoded
    if (px < pixelCount) {
      console.warn(`[Decoder] Keyframe incomplete: decoded ${px}/${pixelCount} pixels, pos=${this.pos}, dataEnd=${dataEnd}`);
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

    // Check if all pixels were decoded
    if (px < pixelCount) {
      console.warn(`[Decoder] Keyframe incomplete: decoded ${px}/${pixelCount} pixels, activePos=${this.activePos}, dataEnd=${dataEnd}`);
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
    const index: number[] = new Array(64).fill(-1); // Initialize to -1 to avoid false matches with value 0
    let px = 0;

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
        if (prevVal === -1) {
          console.error(`[Decoder] YUV keyframe: INDEX(${idx}) read from uninitialized slot! px=${px}, size=${size}`);
          prevVal = 128; // Use neutral value (128 is neutral for YUV, 0 causes black artifacts)
        }
        plane[px++] = prevVal;
        // Write-back is a no-op on valid streams (prevVal was just read from
        // this slot); it only matters for the uninit fallback above. Kept for
        // parity with qov.h qov__dec_yuv_plane_keyframe.
        index[idx] = prevVal;
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

    return px;
  }

  // Decode a single YUV plane for P-frame (temporal)
  private decodeYuvPlanePFrame(plane: Uint8Array, prevPlane: Uint8Array, size: number): number {
    const index: number[] = new Array(64).fill(-1); // Initialize to -1 to avoid false matches with value 0
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
        // Note: b1 === 0x00 is handled above as SKIP_LONG, so idx here is 1-63
        const idx = b1 & 0x3f;
        if (index[idx] === -1) {
          console.error(`[Decoder] YUV P-frame: INDEX(${idx}) read from uninitialized slot! px=${px}, size=${size}`);
          // This should never happen if encoder/decoder are in sync
          // Use neutral value instead of black
          plane[px++] = 128;
        } else {
          plane[px++] = index[idx];
        }
        // INDEX opcode retrieves a value, it doesn't update the table
        // The table is only updated when TDIFF, TLUMA, or FULL are used
      } else if (b1 === QOV_OP_SKIP_SIMILAR || b1 === QOV_OP_SKIP_SIMILAR_LONG) {
        // Lossy similarity skip (spec §3.4.1): values are close enough to the
        // reference plane, so the decoder copies them from prevPlane
        const count = b1 === QOV_OP_SKIP_SIMILAR ? this.readU8() : this.readU16();
        this.readU8(); // threshold (informational when decoding)
        for (let i = 0; i < count && px < size; i++) {
          plane[px] = prevPlane[px];
          px++;
        }
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
  private decodeYuvPFrameData(chunkSize: number, hasMotion: boolean): boolean {
    const dataEnd = this.pos + chunkSize - 8;
    const { width, height, colorspace } = this.header;
    const ySize = width * height;
    const { w: uvW, h: uvH } = chromaPlaneDims(colorspace, width, height);
    const uvSize = uvW * uvH;

    // A motion chunk's effective reference is the compensated previous plane
    const mv = hasMotion ? parseMvBlock(this.readU8.bind(this), width, height) : null;
    let refY = this.prevYPlane!, refU = this.prevUPlane!, refV = this.prevVPlane!, refA = this.prevAPlane;
    if (mv) {
      const cm = chromaMotionParams(colorspace);
      refY = new Uint8Array(ySize);
      compensatePlane(this.prevYPlane!, width, height, mv, refY, 1, 1, 0, 0);
      refU = new Uint8Array(uvSize);
      compensatePlane(this.prevUPlane!, uvW, uvH, mv, refU, cm.sx, cm.sy, cm.shx, cm.shy);
      refV = new Uint8Array(uvSize);
      compensatePlane(this.prevVPlane!, uvW, uvH, mv, refV, cm.sx, cm.sy, cm.shx, cm.shy);
      if (this.hasYuvAlpha && this.prevAPlane) {
        refA = new Uint8Array(ySize);
        compensatePlane(this.prevAPlane, width, height, mv, refA, 1, 1, 0, 0);
      }
    }

    // Decode Y plane with temporal prediction
    this.decodeYuvPlanePFrame(this.currYPlane!, refY, ySize);

    // Decode U plane
    this.decodeYuvPlanePFrame(this.currUPlane!, refU, uvSize);

    // Decode V plane
    this.decodeYuvPlanePFrame(this.currVPlane!, refV, uvSize);

    // Decode A plane if present
    if (this.hasYuvAlpha && this.currAPlane && refA) {
      this.decodeYuvPlanePFrame(this.currAPlane, refA, ySize);
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
  private decodeYuvPFrameDataFromBuffer(_uncompressedSize: number, hasMotion: boolean): boolean {
    const { width, height, colorspace } = this.header;
    const ySize = width * height;
    const { w: uvW, h: uvH } = chromaPlaneDims(colorspace, width, height);
    const uvSize = uvW * uvH;

    const mv = hasMotion ? parseMvBlock(this.readU8.bind(this), width, height) : null;
    let refY = this.prevYPlane!, refU = this.prevUPlane!, refV = this.prevVPlane!, refA = this.prevAPlane;
    if (mv) {
      const cm = chromaMotionParams(colorspace);
      refY = new Uint8Array(ySize);
      compensatePlane(this.prevYPlane!, width, height, mv, refY, 1, 1, 0, 0);
      refU = new Uint8Array(uvSize);
      compensatePlane(this.prevUPlane!, uvW, uvH, mv, refU, cm.sx, cm.sy, cm.shx, cm.shy);
      refV = new Uint8Array(uvSize);
      compensatePlane(this.prevVPlane!, uvW, uvH, mv, refV, cm.sx, cm.sy, cm.shx, cm.shy);
      if (this.hasYuvAlpha && this.prevAPlane) {
        refA = new Uint8Array(ySize);
        compensatePlane(this.prevAPlane, width, height, mv, refA, 1, 1, 0, 0);
      }
    }

    // Decode Y plane with temporal prediction
    this.decodeYuvPlanePFrame(this.currYPlane!, refY, ySize);

    // Decode U plane
    this.decodeYuvPlanePFrame(this.currUPlane!, refU, uvSize);

    // Decode V plane
    this.decodeYuvPlanePFrame(this.currVPlane!, refV, uvSize);

    // Decode A plane if present
    if (this.hasYuvAlpha && this.currAPlane && refA) {
      this.decodeYuvPlanePFrame(this.currAPlane, refA, ySize);
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

    if (hasMotion) {
      const mv = parseMvBlock(this.readU8.bind(this), this.header.width, this.header.height);
      compensateFrame(this.prevFrame!, this.header.width, this.header.height, mv, this.currFrame!);
    } else {
      this.currFrame!.set(this.prevFrame!);
    }

    let px = 0;
    let indexOpcodeCount = 0; // Track unexpected INDEX opcodes

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
      } else if (b1 === QOV_OP_SKIP_SIMILAR || b1 === QOV_OP_SKIP_SIMILAR_LONG) {
        // Lossy similarity skip (spec §3.4.1): pixels are close enough to the
        // reference frame, so the decoder copies them from prevFrame
        const count = b1 === QOV_OP_SKIP_SIMILAR ? this.readU8() : this.readU16();
        this.readU8(); // threshold (informational when decoding)
        for (let i = 0; i < count && px < pixelCount; i++) {
          const offset = px * 4;
          this.currFrame![offset] = this.prevFrame![offset];
          this.currFrame![offset + 1] = this.prevFrame![offset + 1];
          this.currFrame![offset + 2] = this.prevFrame![offset + 2];
          this.currFrame![offset + 3] = this.prevFrame![offset + 3];
          px++;
        }
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
        // QOV_OP_INDEX - NOTE: encoder never writes this in P-frames!
        // If we get here, something is wrong (data corruption or sync issue)
        const idx = b1 & 0x3f;
        const c = this.index[idx];
        const offset = px * 4;
        this.currFrame![offset] = c.r;
        this.currFrame![offset + 1] = c.g;
        this.currFrame![offset + 2] = c.b;
        this.currFrame![offset + 3] = c.a;
        indexOpcodeCount++;
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

    // Warn if unexpected INDEX opcodes were encountered in P-frame
    if (indexOpcodeCount > 0) {
      console.warn(`[Decoder] P-frame had ${indexOpcodeCount} unexpected INDEX opcodes (encoder bug or data corruption)`);
    }

    // Skip to end of chunk
    this.pos = this.pos + (dataEnd - this.pos) + 8;

    // Swap frame buffers
    const tmp = this.prevFrame;
    this.prevFrame = this.currFrame;
    this.currFrame = tmp;

    this.frameCount++;
    return true;
  }

  // Decode RGB P-frame from decompressed buffer
  private decodePFrameDataFromBuffer(uncompressedSize: number, hasMotion: boolean): boolean {
    const dataEnd = uncompressedSize - 8;
    const pixelCount = this.header.width * this.header.height;

    if (hasMotion) {
      const mv = parseMvBlock(this.readU8.bind(this), this.header.width, this.header.height);
      compensateFrame(this.prevFrame!, this.header.width, this.header.height, mv, this.currFrame!);
    } else {
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
      } else if (b1 === QOV_OP_SKIP_SIMILAR || b1 === QOV_OP_SKIP_SIMILAR_LONG) {
        // Lossy similarity skip (spec §3.4.1): pixels are close enough to the
        // reference frame, so the decoder copies them from prevFrame
        const count = b1 === QOV_OP_SKIP_SIMILAR ? this.readU8() : this.readU16();
        this.readU8(); // threshold (informational when decoding)
        for (let i = 0; i < count && px < pixelCount; i++) {
          const offset = px * 4;
          this.currFrame![offset] = this.prevFrame![offset];
          this.currFrame![offset + 1] = this.prevFrame![offset + 1];
          this.currFrame![offset + 2] = this.prevFrame![offset + 2];
          this.currFrame![offset + 3] = this.prevFrame![offset + 3];
          px++;
        }
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

  private decodeYuvPFrameDataDct(chunkSize: number, hasMotion: boolean, hasBand: boolean, eg: boolean): boolean {
    const dataEnd = this.pos + chunkSize;
    const band = hasBand ? this.readU8() : -1;
    const mv = hasMotion ? parseMvBlock(this.readU8.bind(this), this.header.width, this.header.height) : null;
    this.decodeYuvPFrameDataDctCore(mv, band, eg);
    this.pos = dataEnd;
    return true;
  }

  private decodeYuvKeyframeDataDct(chunkSize: number, eg: boolean): boolean {
    const dataEnd = this.pos + chunkSize;
    this.decodeYuvKeyframeDataDctCore(eg);
    this.pos = dataEnd;
    return true;
  }

  private decodeYuvKeyframeDataDctFromBuffer(eg: boolean): boolean {
    this.decodeYuvKeyframeDataDctCore(eg);
    return true;
  }

  // Intra DCT keyframe (spec §3.4.3): no reference, raster-order
  // reconstruction with DC prediction
  private decodeYuvKeyframeDataDctCore(eg: boolean): void {
    const { width, height, colorspace } = this.header;
    const { w: uvW, h: uvH } = chromaPlaneDims(colorspace, width, height);
    const qpBase = this.header.dctQpBase || 20;
    const readU8 = this.readU8.bind(this);
    const blockBuf = new Float32Array(64);

    decodeIntraPlaneDctInto(readU8, this.currYPlane!, width, height, DEFAULT_QUANT_LUMA, QOV_OP_DCT_Y, qpBase, blockBuf, eg);
    decodeIntraPlaneDctInto(readU8, this.currUPlane!, uvW, uvH, DEFAULT_QUANT_CHROMA, QOV_OP_DCT_UV, qpBase, blockBuf, eg);
    decodeIntraPlaneDctInto(readU8, this.currVPlane!, uvW, uvH, DEFAULT_QUANT_CHROMA, QOV_OP_DCT_UV, qpBase, blockBuf, eg);
    if (this.hasYuvAlpha && this.currAPlane) {
      decodeIntraPlaneDctInto(readU8, this.currAPlane, width, height, DEFAULT_QUANT_LUMA, QOV_OP_DCT_Y, qpBase, blockBuf, eg);
    }

    this.yuvPlanesToRgba();
    // Swap buffers
    [this.prevYPlane, this.currYPlane] = [this.currYPlane, this.prevYPlane];
    [this.prevUPlane, this.currUPlane] = [this.currUPlane, this.prevUPlane];
    [this.prevVPlane, this.currVPlane] = [this.currVPlane, this.prevVPlane];
    if (this.hasYuvAlpha) {
      [this.prevAPlane, this.currAPlane] = [this.currAPlane, this.prevAPlane];
    }
    const tmp = this.prevFrame;
    this.prevFrame = this.currFrame;
    this.currFrame = tmp;
  }

  private decodeYuvPFrameDataDctFromBuffer(_uncompressedSize: number, hasMotion: boolean, hasBand: boolean, eg: boolean): boolean {
    // Data is consumed through activeData via readU8(); the caller has already
    // advanced this.pos past the chunk, so no file-position fixup may run here.
    const band = hasBand ? this.readU8() : -1;
    const mv = hasMotion ? parseMvBlock(this.readU8.bind(this), this.header.width, this.header.height) : null;
    this.decodeYuvPFrameDataDctCore(mv, band, eg);
    return true;
  }

  private decodeYuvPFrameDataDctCore(mv: MotionVectors | null, band: number, eg: boolean): void {
    const { width, height, colorspace } = this.header;
    const yW = width;
    const yH = height;
    const { w: uvW, h: uvH } = chromaPlaneDims(colorspace, width, height);

    // Refresh band rows per plane (spec §3.4.4)
    const rowsY = Math.ceil(height / 8);
    const rowsC = Math.ceil(uvH / 8);
    const yr0 = band < 0 ? -1 : Math.floor(rowsY * band / QOV_INTRA_REFRESH_BANDS);
    const yr1 = band < 0 ? -1 : Math.floor(rowsY * (band + 1) / QOV_INTRA_REFRESH_BANDS);
    const cr0 = band < 0 ? -1 : Math.floor(rowsC * band / QOV_INTRA_REFRESH_BANDS);
    const cr1 = band < 0 ? -1 : Math.floor(rowsC * (band + 1) / QOV_INTRA_REFRESH_BANDS);

    // Copy reference — compensated when the chunk carries motion vectors
    if (mv) {
      const cm = chromaMotionParams(colorspace);
      compensatePlane(this.prevYPlane!, width, height, mv, this.currYPlane!, 1, 1, 0, 0);
      compensatePlane(this.prevUPlane!, uvW, uvH, mv, this.currUPlane!, cm.sx, cm.sy, cm.shx, cm.shy);
      compensatePlane(this.prevVPlane!, uvW, uvH, mv, this.currVPlane!, cm.sx, cm.sy, cm.shx, cm.shy);
      if (this.hasYuvAlpha) compensatePlane(this.prevAPlane!, width, height, mv, this.currAPlane!, 1, 1, 0, 0);
    } else {
      this.currYPlane!.set(this.prevYPlane!);
      this.currUPlane!.set(this.prevUPlane!);
      this.currVPlane!.set(this.prevVPlane!);
      if (this.hasYuvAlpha) this.currAPlane!.set(this.prevAPlane!);
    }

    const blockBuf = new Float32Array(64);

    // Decoding loop for Y
    this.decodePlaneDct(this.currYPlane!, yW, yH, DEFAULT_QUANT_LUMA, QOV_OP_DCT_Y, blockBuf, yr0, yr1, eg);

    // Decoding loop for UV
    this.decodePlaneDct(this.currUPlane!, uvW, uvH, DEFAULT_QUANT_CHROMA, QOV_OP_DCT_UV, blockBuf, cr0, cr1, eg);
    this.decodePlaneDct(this.currVPlane!, uvW, uvH, DEFAULT_QUANT_CHROMA, QOV_OP_DCT_UV, blockBuf, cr0, cr1, eg);

    // The encoder appends alpha DCT blocks (luma dimensions, luma quant table)
    if (this.hasYuvAlpha && this.currAPlane && this.prevAPlane) {
      this.decodePlaneDct(this.currAPlane, width, height, DEFAULT_QUANT_LUMA, QOV_OP_DCT_Y, blockBuf, yr0, yr1, eg);
    }

    this.yuvPlanesToRgba();
    // Swap buffers
    [this.prevYPlane, this.currYPlane] = [this.currYPlane, this.prevYPlane];
    [this.prevUPlane, this.currUPlane] = [this.currUPlane, this.prevUPlane];
    [this.prevVPlane, this.currVPlane] = [this.currVPlane, this.prevVPlane];
    if (this.hasYuvAlpha) {
      [this.prevAPlane, this.currAPlane] = [this.currAPlane, this.prevAPlane];
    }
    const tmp = this.prevFrame;
    this.prevFrame = this.currFrame;
    this.currFrame = tmp;
  }

  private decodePlaneDct(plane: Uint8Array, w: number, h: number, quant: number[], opType: number, blockBuf: Float32Array, bandR0 = -1, bandR1 = -1, eg = false): void {
    const qpBase = this.header.dctQpBase || 20; // Default
    decodePlaneDctInto(this.readU8.bind(this), plane, w, h, quant, opType, qpBase, blockBuf, bandR0, bandR1, eg);
  }

  *decodeFrames(): Generator<QovFrame | QovAudioFrame> {
    if (!this.header) {
      this.decodeHeader();
    }

    this.pos = this.headerSize; // After header
    let frameNumber = 0;

    console.log(`[Decoder] Starting frame decode at pos ${this.pos}, file length: ${this.data.length}`);

    while (this.pos < this.data.length) {
      const chunkHeader = this.readChunkHeader();



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
          const isDctKeyframe = (chunkHeader.chunkFlags & QOV_CHUNK_FLAG_DCT_BLOCKS) !== 0;
          // console.log(`[Decoder] Decoding keyframe ${frameNumber}, YUV: ${isYuvChunk}, Compressed: ${isCompressed}...`);

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
              if (isDctKeyframe) {
                this.decodeYuvKeyframeDataDctFromBuffer(
                  (chunkHeader.chunkFlags & QOV_CHUNK_FLAG_EXP_GOLOB) !== 0);
              } else {
                this.decodeYuvKeyframeDataFromBuffer(chunkHeader.uncompressedSize!);
              }
            } else {
              this.decodeKeyframeDataFromBuffer(chunkHeader.uncompressedSize!);
            }

            this.setActiveData(null);
          } else {
            if (isYuvChunk || this.isYuvMode) {
              if (isDctKeyframe) {
                this.decodeYuvKeyframeDataDct(chunkHeader.chunkSize,
                  (chunkHeader.chunkFlags & QOV_CHUNK_FLAG_EXP_GOLOB) !== 0);
              } else {
                this.decodeYuvKeyframeData(chunkHeader.chunkSize);
              }
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
          const isDctBlocks = (chunkHeader.chunkFlags & QOV_CHUNK_FLAG_DCT_BLOCKS) !== 0;
          const hasMotion = (chunkHeader.chunkFlags & QOV_CHUNK_FLAG_MOTION) !== 0;

          // console.log(`[Decoder] Decoding P-frame ${frameNumber}, YUV: ${isYuvChunk}, Compressed: ${isCompressed}, DCT: ${isDctBlocks}...`);

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
              if (isDctBlocks) {
                this.decodeYuvPFrameDataDctFromBuffer(chunkHeader.uncompressedSize!, hasMotion,
                  (chunkHeader.chunkFlags & QOV_CHUNK_FLAG_REFRESH_BAND) !== 0,
                  (chunkHeader.chunkFlags & QOV_CHUNK_FLAG_EXP_GOLOB) !== 0);
              } else {
                this.decodeYuvPFrameDataFromBuffer(chunkHeader.uncompressedSize!, hasMotion);
              }
            } else {
              this.decodePFrameDataFromBuffer(chunkHeader.uncompressedSize!, hasMotion);
            }

            this.setActiveData(null);
          } else {
            if (isYuvChunk || this.isYuvMode) {
              if (isDctBlocks) {
                this.decodeYuvPFrameDataDct(chunkHeader.chunkSize, hasMotion,
                  (chunkHeader.chunkFlags & QOV_CHUNK_FLAG_REFRESH_BAND) !== 0,
                  (chunkHeader.chunkFlags & QOV_CHUNK_FLAG_EXP_GOLOB) !== 0);
              } else {
                this.decodeYuvPFrameData(chunkHeader.chunkSize, hasMotion);
              }
            } else {
              this.decodePFrameData(chunkHeader.chunkSize, hasMotion);
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

        case QOV_CHUNK_AUDIO: {
          const audioData = this.data.subarray(this.pos, this.pos + chunkHeader.chunkSize);
          const result = this.qoaDecoder.decodeFrame(audioData);
          this.pos += chunkHeader.chunkSize;

          if (result) {
            yield {
              samples: result.samples,
              channels: result.header.channels,
              sampleRate: result.header.samplerate,
              timestamp: chunkHeader.timestamp
            } as QovAudioFrame;
          }
          break;
        }

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

    this.pos = this.headerSize; // After header

    while (this.pos < this.data.length) {
      const offset = this.pos;
      const headerSize = this.use32BitChunkSize ? 10 : 8;

      // Ensure enough bytes for chunk header
      if (this.pos + headerSize > this.data.length) {
        console.warn(`[Decoder] Not enough bytes for chunk header at pos ${this.pos}`);
        break;
      }

      const chunkHeader = this.readChunkHeader();

      // Validate chunk header
      if (chunkHeader.chunkType === undefined) {
        console.warn(`[Decoder] Invalid chunk header at pos ${offset}, stopping scan`);
        break;
      }

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
        // For compressed chunks the 4-byte uncompressedSize field was already
        // consumed by readChunkHeader and counts inside chunkSize, so skipping
        // chunkSize alone would overshoot the stream
        this.pos += isCompressed ? chunkHeader.chunkSize - 4 : chunkHeader.chunkSize;
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
