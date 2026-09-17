// QOV Encoder based on qov-specification.md

import {
  QovHeader,
  QovRGBA,
  LossyParams,
  QOV_COLORSPACE_SRGB,
  QOV_COLORSPACE_YUV420,
  QOV_COLORSPACE_YUV422,
  QOV_COLORSPACE_YUVA420,
  QOV_FLAG_HAS_INDEX,
  QOV_FLAG_HAS_ALPHA,
  QOV_FLAG_LOSSY_MODE,
  QOV_FLAG_INTRA_DCT_KF,
  QOV_FLAG_INTRA_REFRESH,
  QOV_FLAG_EXP_GOLOB,
  QOV_VERSION_LOSSY,
  QOV_CHUNK_SYNC,
  QOV_CHUNK_KEYFRAME,
  QOV_CHUNK_PFRAME,
  QOV_CHUNK_AUDIO,
  QOV_CHUNK_AUDIO_FLAG_OPUS,
  QOV_CHUNK_INDEX,
  QOV_CHUNK_END,
  QOV_CHUNK_FLAG_YUV,
  QOV_CHUNK_FLAG_COMPRESSED,
  QOV_CHUNK_FLAG_REFRESH_BAND,
  QOV_CHUNK_FLAG_EXP_GOLOB,
  QOV_CHUNK_FLAG_STRUCTURED,
  QOV_INTRA_REFRESH_BANDS,
  deriveLossyParams,
} from './qov-types';

import { lz4Compress } from './lz4';
import { rangeEncode } from './range-coder';

import {
  rgbaToYuv420Planes,
  rgbaToYuv422Planes,
  rgbaToYuv444Planes,
} from './color-utils';

import {
  forwardDCT,
  inverseDCTRaw,
  DEFAULT_QUANT_LUMA,
  DEFAULT_QUANT_CHROMA,
  ZIGZAG,
} from './dct';

import {
  intraPred,
} from './dct-decode';

import { BitWriter } from './exp-golomb';

import {
  QOV_OP_DCT_Y,
  QOV_OP_DCT_UV,
  QOV_OP_DCT_SKIP,
  QOV_FLAG_DCT_ENABLED,
  QOV_FLAG_HAS_MOTION,
  QOV_CHUNK_FLAG_DCT_BLOCKS,
  QOV_CHUNK_FLAG_RANGE,
  QOV_CHUNK_FLAG_MOTION,
  chromaPlaneDims,
} from './qov-types';

import {
  MotionVectors,
  estimateMotion,
  compensatePlane,
  compensateFrame,
  writeMvBlock,
  chromaMotionParams,
} from './motion';

import { QoaEncoder } from './qoa';

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

  // Bytes from pos to the end, copied in O(tail) not O(buffer) (streaming hook)
  sliceFrom(pos: number): Uint8Array {
    const out = new Uint8Array(this.totalSize - pos);
    let outPos = 0;
    let offset = 0;
    const scan = (buf: Uint8Array, len: number) => {
      const start = Math.max(pos, offset);
      const end = offset + len;
      if (end > start) {
        out.set(buf.subarray(start - offset, end - offset), outPos);
        outPos += end - start;
      }
      offset = end;
    };
    for (const chunk of this.chunks) scan(chunk, chunk.length);
    scan(this.currentChunk, this.currentPos);
    return out;
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

  // Lossy mode parameters
  private lossyMode = false;
  private quality = 0;
  /** header dctQp: the per-block qp_delta is written relative to this */
  private dctQpBase = 0;
  private lossyParams: LossyParams | null = null;

  private motionEnabled = false;
  private intraDctKeyframes = false;
  private intraRefresh = false;
  private expGolomb = false;
  private structuredPFrames = false;

  private qoaEncoder: QoaEncoder | null = null;

  constructor(
    width: number,
    height: number,
    frameRateNum = 30,
    frameRateDen = 1,
    flags = QOV_FLAG_HAS_INDEX,
    colorspace = QOV_COLORSPACE_SRGB,
    compressionEnabled = true,
    quality?: number,  // Optional quality parameter (0-100, undefined = lossless)
    customParams?: LossyParams,  // Optional custom lossy params (overrides quality-derived)
    audioChannels = 0,
    audioRate = 0,
    rangeCoding = false,
    structuredPFrames = false
  ) {
    this.rangeCoding = rangeCoding;
    this.structuredPFrames = structuredPFrames;
    // Determine if lossy mode is enabled
    this.lossyMode = (quality !== undefined && quality < 100) || customParams !== undefined;
    this.quality = quality ?? 0;

    // If lossy mode, derive or use custom parameters and set flag
    this.lossyParams = customParams ?? deriveLossyParams(this.quality);
    this.dctQpBase = this.lossyParams.dctQp;
    // Enable DCT only if lossy
    if (this.lossyMode) {
      flags |= QOV_FLAG_LOSSY_MODE;
      flags |= QOV_FLAG_DCT_ENABLED;
    } else {
      flags &= ~QOV_FLAG_INTRA_REFRESH; // refresh bands are a lossy-only feature
    }

    this.header = {
      magic: 'qovf',
      // v3.10: version 3 is the only produced version; lossless streams are v3
      // files with quality 0 and LOSSY_MODE off (v1/v2 are deprecated)
      version: QOV_VERSION_LOSSY,
      flags,
      width,
      height,
      frameRateNum,
      frameRateDen,
      totalFrames: 0,
      audioChannels,
      audioRate,
      colorspace,
      quality: this.lossyMode ? this.quality : undefined,
      yQuantBase: this.lossyParams?.yQuant,
      uvQuantBase: this.lossyParams?.uvQuant,
      temporalThresh: this.lossyParams?.temporalThresh,
      dctQpBase: this.lossyParams?.dctQp,
    };

    if (audioChannels > 0 && audioRate > 0) {
      this.qoaEncoder = new QoaEncoder(audioChannels, audioRate);
    }

    this.compressionEnabled = compressionEnabled;

    // Determine mode based on colorspace
    this.isYuvMode = colorspace >= 0x10 && colorspace <= 0x13;
    this.hasAlpha = (flags & QOV_FLAG_HAS_ALPHA) !== 0 ||
      colorspace === QOV_COLORSPACE_YUVA420;
    this.motionEnabled = (flags & QOV_FLAG_HAS_MOTION) !== 0;
    this.intraDctKeyframes = (flags & QOV_FLAG_INTRA_DCT_KF) !== 0;
    this.intraRefresh = (flags & QOV_FLAG_INTRA_REFRESH) !== 0;
    this.expGolomb = (flags & QOV_FLAG_EXP_GOLOB) !== 0;

    console.log(`[Encoder] Created with colorspace: 0x${colorspace.toString(16)}, YUV mode: ${this.isYuvMode}, hasAlpha: ${this.hasAlpha}, compression: ${compressionEnabled}, lossy: ${this.lossyMode}, quality: ${this.quality}`);

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

    const chunkStart = this.buffer.getSize();

    // Get the frame data
    const frameData = this.frameBuffer.toUint8Array();
    const uncompressedSize = frameData.length;
    this.activeBuffer = null;

    // v3.8: lossy DCT chunks may use the adaptive range coder instead of LZ4
    if (this.rangeCoding && (baseFlags & QOV_CHUNK_FLAG_DCT_BLOCKS) !== 0) {
      const rc = rangeEncode(frameData);
      const chunkFlags = (baseFlags | QOV_CHUNK_FLAG_RANGE) & ~QOV_CHUNK_FLAG_COMPRESSED;
      const chunkSize = rc.length + 4;

      this.buffer.writeByte(chunkType);
      this.buffer.writeByte(chunkFlags);
      this.buffer.writeU32(chunkSize);
      this.buffer.writeU32(timestamp);
      this.buffer.writeU32(uncompressedSize);
      for (let i = 0; i < rc.length; i++) this.buffer.writeByte(rc[i]);
      this.emitChunk(chunkStart);
      return;
    }

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
      this.emitChunk(chunkStart);
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
      this.emitChunk(chunkStart);
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

    // Version (0x02 = 32-bit chunk sizes, 0x03 = lossy support)
    this.writeU8(this.header.version);

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

    // Audio
    this.writeU8(this.header.audioChannels); // channels
    this.writeU8((this.header.audioRate >> 16) & 0xff); // rate high
    this.writeU8((this.header.audioRate >> 8) & 0xff);  // rate mid
    this.writeU8(this.header.audioRate & 0xff);         // rate low

    // Colorspace
    this.writeU8(this.header.colorspace);

    // Quality byte (offset 23) - used for lossy mode
    this.writeU8(this.lossyMode ? this.quality : 0x00);

    // Extended header for lossy mode (version 0x03, 32 bytes total)
    if (this.header.version === QOV_VERSION_LOSSY) {
      // Bytes 24-27: lossy parameters
      this.writeU8(this.lossyParams?.yQuant ?? 0);     // y_quant_base
      this.writeU8(this.lossyParams?.uvQuant ?? 0);    // uv_quant_base
      this.writeU8(this.lossyParams?.temporalThresh ?? 0); // temporal_thresh
      this.writeU8(this.lossyParams?.dctQp ?? 0);      // dct_qp_base
      // Bytes 28-31: reserved
      this.writeU32(0);
    }
  }

  // Quantize a plane value for lossy encoding
  private quantizePlaneValue(value: number, quantStep: number): number {
    if (quantStep <= 1) return value;
    return Math.max(0, Math.min(255, Math.round(value / quantStep) * quantStep));
  }

  // Quantize a YUV plane for lossy encoding
  private quantizePlane(plane: Uint8Array, quantStep: number): Uint8Array {
    if (!this.lossyMode || quantStep <= 1) return plane;

    const result = new Uint8Array(plane.length);
    for (let i = 0; i < plane.length; i++) {
      result[i] = this.quantizePlaneValue(plane[i], quantStep);
    }
    return result;
  }

  // Check if two pixel values are similar within threshold (for lossy temporal encoding)
  private valuesAreSimilar(a: number, b: number, threshold: number): boolean {
    return Math.abs(a - b) <= threshold;
  }

  // Check if two pixels are similar within threshold (for lossy P-frames)
  private pixelsAreSimilar(c: QovRGBA, ref: QovRGBA, threshold: number): boolean {
    return this.valuesAreSimilar(c.r, ref.r, threshold) &&
      this.valuesAreSimilar(c.g, ref.g, threshold) &&
      this.valuesAreSimilar(c.b, ref.b, threshold) &&
      this.valuesAreSimilar(c.a, ref.a, Math.floor(threshold / 2));
  }

  // Quantize RGBA pixel for lossy encoding (perceptual quantization via YUV)
  private quantizePixel(c: QovRGBA): QovRGBA {
    if (!this.lossyMode || !this.lossyParams) return c;

    const yQuant = this.lossyParams.yQuant;
    const uvQuant = this.lossyParams.uvQuant;

    // Convert to YUV for perceptual quantization
    let y = Math.floor((66 * c.r + 129 * c.g + 25 * c.b + 128) / 256);
    let cb = Math.floor((-38 * c.r - 74 * c.g + 112 * c.b + 128) / 256);
    let cr = Math.floor((112 * c.r - 94 * c.g - 18 * c.b + 128) / 256);

    y = 16 + y;
    cb = 128 + cb;
    cr = 128 + cr;

    // Quantize (Y less, UV more)
    y = Math.round(y / yQuant) * yQuant;
    cb = Math.round(cb / uvQuant) * uvQuant;
    cr = Math.round(cr / uvQuant) * uvQuant;

    // Convert back to RGB
    const cy = y - 16;
    const d = cb - 128;
    const e = cr - 128;

    return {
      r: Math.max(0, Math.min(255, Math.floor((298 * cy + 409 * e + 128) / 256))),
      g: Math.max(0, Math.min(255, Math.floor((298 * cy - 100 * d - 208 * e + 128) / 256))),
      b: Math.max(0, Math.min(255, Math.floor((298 * cy + 516 * d + 128) / 256))),
      a: c.a, // Alpha unchanged
    };
  }

  private writeSync(frameNumber: number, timestamp: number): void {
    const start = this.buffer.getSize();
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
    this.emitChunk(start);
  }

  // Streaming hook: complete QOV chunk bytes as they are written to the
  // main buffer (sync markers and frame-buffer-path chunks — i.e. all video
  // chunks when compression is enabled). Observers must not modify the array.
  public onChunk?: (chunk: Uint8Array, chunkType: number) => void;

  // v3.8: lossy DCT chunk payloads use the adaptive range coder (flag 0x08)
  private rangeCoding: boolean;

  // The QOV file header bytes (24/32) — call right after writeHeader(),
  // before any frame is encoded (QOV-S CONFIG payload, spec section 2.1).
  public headerBytes(): Uint8Array {
    return this.buffer.sliceFrom(0);
  }

  private emitChunk(start: number): void {
    if (!this.onChunk) return;
    const bytes = this.buffer.sliceFrom(start);
    this.onChunk(bytes, bytes[0]);
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

    // Apply lossy quantization when NOT using intra DCT keyframes (those
    // quantize coefficients instead of pixel values)
    if (this.lossyMode && !this.intraDctKeyframes && this.lossyParams) {
      planes.yPlane = this.quantizePlane(planes.yPlane, this.lossyParams.yQuant);
      planes.uPlane = this.quantizePlane(planes.uPlane, this.lossyParams.uvQuant);
      planes.vPlane = this.quantizePlane(planes.vPlane, this.lossyParams.uvQuant);
      // Alpha plane uses Y quantization (less aggressive)
      if (planes.aPlane) {
        planes.aPlane = this.quantizePlane(planes.aPlane, this.lossyParams.yQuant);
      }
    }

    const kfFlags = this.lossyMode && this.intraDctKeyframes
      ? QOV_CHUNK_FLAG_YUV | QOV_CHUNK_FLAG_DCT_BLOCKS | (this.expGolomb ? QOV_CHUNK_FLAG_EXP_GOLOB : 0)
      : QOV_CHUNK_FLAG_YUV;

    if (this.compressionEnabled) {
      // Compression mode: encode to temp buffer, then compress
      this.startFrameData();

      // Encode planes to frame buffer
      if (this.lossyMode && this.intraDctKeyframes) {
        const { w: uvW, h: uvH } = chromaPlaneDims(colorspace, width, height);
        this.encodeIntraPlaneDct(planes.yPlane, width, height, DEFAULT_QUANT_LUMA, QOV_OP_DCT_Y, this.expGolomb);
        this.encodeIntraPlaneDct(planes.uPlane, uvW, uvH, DEFAULT_QUANT_CHROMA, QOV_OP_DCT_UV, this.expGolomb);
        this.encodeIntraPlaneDct(planes.vPlane, uvW, uvH, DEFAULT_QUANT_CHROMA, QOV_OP_DCT_UV, this.expGolomb);
        if (planes.aPlane) {
          this.encodeIntraPlaneDct(planes.aPlane, width, height, DEFAULT_QUANT_LUMA, QOV_OP_DCT_Y, this.expGolomb);
        }
      } else {
        this.encodeYuvPlaneKeyframe(planes.yPlane);
        this.encodeYuvPlaneKeyframe(planes.uPlane);
        this.encodeYuvPlaneKeyframe(planes.vPlane);
        if (planes.aPlane) {
          this.encodeYuvPlaneKeyframe(planes.aPlane);
        }
      }
      this.writeEndMarker();

      // Compress and write to main buffer
      this.finishFrameData(QOV_CHUNK_KEYFRAME, kfFlags, timestamp);
    } else {
      // No compression: write directly
      const headerPos = this.buffer.getSize();
      this.writeU8(QOV_CHUNK_KEYFRAME);
      this.writeU8(kfFlags);
      this.writeU32(0); // size placeholder
      this.writeU32(timestamp);

      const dataStart = this.buffer.getSize();

      if (this.lossyMode && this.intraDctKeyframes) {
        const { w: uvW, h: uvH } = chromaPlaneDims(colorspace, width, height);
        this.encodeIntraPlaneDct(planes.yPlane, width, height, DEFAULT_QUANT_LUMA, QOV_OP_DCT_Y, this.expGolomb);
        this.encodeIntraPlaneDct(planes.uPlane, uvW, uvH, DEFAULT_QUANT_CHROMA, QOV_OP_DCT_UV, this.expGolomb);
        this.encodeIntraPlaneDct(planes.vPlane, uvW, uvH, DEFAULT_QUANT_CHROMA, QOV_OP_DCT_UV, this.expGolomb);
        if (planes.aPlane) {
          this.encodeIntraPlaneDct(planes.aPlane, width, height, DEFAULT_QUANT_LUMA, QOV_OP_DCT_Y, this.expGolomb);
        }
      } else {
        this.encodeYuvPlaneKeyframe(planes.yPlane);
        this.encodeYuvPlaneKeyframe(planes.uPlane);
        this.encodeYuvPlaneKeyframe(planes.vPlane);
        if (planes.aPlane) {
          this.encodeYuvPlaneKeyframe(planes.aPlane);
        }
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
    const index: number[] = new Array(64).fill(-1); // Initialize to -1 to avoid false matches with value 0

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
        if (index[idx] === -1) {
          console.error(`[Encoder] YUV keyframe: Emitting INDEX(${idx}) for uninitialized slot! val=${val}, i=${i}`);
        }
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
  private encodeYuvPlanePFrame(plane: Uint8Array, prevPlane: Uint8Array, temporalThresh = 0): void {
    const size = plane.length;
    let skip = 0;
    const index: number[] = new Array(64).fill(-1); // Initialize to -1 to avoid false matches with value 0

    for (let i = 0; i < size; i++) {
      const val = plane[i];
      const refVal = prevPlane[i];

      // Check if unchanged or similar enough (lossy mode)
      const isSimilar = temporalThresh > 0
        ? Math.abs(val - refVal) <= temporalThresh
        : val === refVal;

      if (isSimilar) {
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
        // Note: idx === 0 cannot be used in P-frames because 0x00 is reserved for SKIP_LONG
        if (index[idx] === val && idx !== 0) {
          // INDEX: value already cached, just reference it
          this.writeU8(idx);
        } else {
          // FULL: emit literal value and cache it
          this.writeU8(0xfe);
          this.writeU8(val);
          index[idx] = val;
        }
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

  // Intra DCT plane coding (spec §3.4.3): DC-predicted 8x8 blocks. `plane`
  // doubles as the reconstruction buffer and ends up holding the decoded
  // values, so the caller can use it directly as the P-frame reference.
  private dctCoeffs = new Float32Array(64);
  private dctRec = new Float32Array(64);
  private dctOut = new Float32Array(64);
  private dctQv = new Int32Array(64);

  /**
   * Quantizes one 8x8 residual block from blockBuf, writes the op/delta/DC/AC
   * stream (spec §3.4.2) and returns the IDCT'd reconstruction. Shared by the
   * inter, intra-keyframe and refresh-band block coders; mirrors
   * qov__enc_dct_emit. The returned buffer is reused until the next call.
   */
  private writeDctBlock(blockBuf: Float32Array, quant: number[], opType: number, scale: number, eg = false, bare = false): Float32Array {
    const coeffs = this.dctCoeffs;
    forwardDCT(blockBuf, coeffs);

    // structured grammar (spec §3.4.6): opcode and qp live at plane level,
    // the bare section starts directly at the coefficient data
    if (!bare) {
      this.writeU8(opType);
      // qp delta (spec 3.4.2): bias-64 delta from the header base QP; zero
      // unless qov_set_quality moved the working dctQp mid-stream
      this.writeU8(0x40 + (this.lossyParams!.dctQp - this.dctQpBase));
    }

    if (eg) {
      // Exp-Golomb coefficient section (spec 3.4.5)
      const qv = this.dctQv;
      qv[0] = Math.round(coeffs[0] * scale / quant[0]);
      for (let k = 1; k < 64; k++) {
        const prod = coeffs[ZIGZAG[k]] * scale / quant[ZIGZAG[k]];
        qv[k] = prod > -0.75 && prod < 0.75 ? 0 : Math.round(prod);
      }
      const w = new BitWriter();
      w.se(qv[0]);
      let k = 1;
      for (;;) {
        let run = 0;
        while (k + run < 64 && qv[k + run] === 0) run++;
        if (k + run >= 64) { w.ue(64 - k); break; }
        w.ue(run);
        w.se(qv[k + run]);
        k += run + 1;
      }
      for (const b of w.flush()) this.writeU8(b);

      const recCoeffs = this.dctRec;
      recCoeffs[0] = qv[0] * quant[0] / scale;
      for (let k2 = 1; k2 < 64; k2++) recCoeffs[ZIGZAG[k2]] = qv[k2] * quant[ZIGZAG[k2]] / scale;
      const rec = this.dctOut;
      inverseDCTRaw(recCoeffs, rec);
      return rec;
    }

    const dcVal = Math.round(coeffs[0] * scale / quant[0]);
    this.writeU16(dcVal & 0xffff);

    let zeroRun = 0;
    for (let k = 1; k < 64; k++) {
      const zigzagIdx = ZIGZAG[k];
      const prod = coeffs[zigzagIdx] * scale / quant[zigzagIdx];
      // Dead-zone (spec §3.4.2): suppress |level| < 0.75 to kill noise
      // dithering between 0 and ±1
      const qVal = prod > -0.75 && prod < 0.75 ? 0 : Math.round(prod);

      if (qVal === 0) {
        zeroRun++;
      } else {
        while (zeroRun >= 16) {
          this.writeU8(0xF0);
          zeroRun -= 16;
        }

        let size = 0;
        if (qVal >= -128 && qVal <= 127) size = 1;
        else if (qVal >= -32768 && qVal <= 32767) size = 2;
        else if (qVal >= -8388608 && qVal <= 8388607) size = 3;
        else size = 4;

        this.writeU8((zeroRun << 4) | size);
        for (let sh = size - 1; sh >= 0; sh--) {
          this.writeU8((qVal >> (8 * sh)) & 0xff);
        }
        zeroRun = 0;
      }
    }
    this.writeU8(0x00); // EOB

    const recCoeffs = this.dctRec;
    recCoeffs[0] = dcVal * quant[0] / scale;
    for (let k = 1; k < 64; k++) {
      const z = ZIGZAG[k];
      const prod = coeffs[z] * scale / quant[z];
      const qVal = prod > -0.75 && prod < 0.75 ? 0 : Math.round(prod);
      recCoeffs[z] = qVal * quant[z] / scale;
    }
    const rec = this.dctOut;
    inverseDCTRaw(recCoeffs, rec);
    return rec;
  }

  private encodeIntraPlaneDct(plane: Uint8Array, w: number, h: number, quant: number[], opType: number, eg = false): void {
    const qpBase = this.lossyParams?.dctQp ?? 20;
    const scale = 1.0 / (0.1 + qpBase * 0.1);
    const blocksX = Math.ceil(w / 8);
    const blocksY = Math.ceil(h / 8);
    let skipCount = 0;

    for (let by = 0; by < blocksY; by++) {
      for (let bx = 0; bx < blocksX; bx++) {
        const x0 = bx * 8;
        const y0 = by * 8;
        const pred = intraPred(plane, w, h, x0, y0);

        const blockBuf = new Float32Array(64);
        let diffSum = 0;
        for (let y = 0; y < 8; y++) {
          for (let x = 0; x < 8; x++) {
            const px = x0 + x;
            const py = y0 + y;
            if (px >= w || py >= h) { blockBuf[y * 8 + x] = 0; continue; }
            const res = plane[py * w + px] - pred;
            blockBuf[y * 8 + x] = res;
            diffSum += Math.abs(res);
          }
        }

        if (diffSum < 32 + qpBase * 8) {
          // prediction-only block: store pred as the reconstruction
          for (let y = 0; y < 8; y++) {
            if (y0 + y >= h) break;
            for (let x = 0; x < 8; x++) {
              if (x0 + x >= w) break;
              plane[(y0 + y) * w + x0 + x] = pred;
            }
          }
          skipCount++;
          continue;
        }

        // Flush skips
        while (skipCount > 0) {
          this.writeU8(QOV_OP_DCT_SKIP);
          const count = Math.min(skipCount, 255);
          this.writeU8(count);
          skipCount -= count;
        }

        const rec = this.writeDctBlock(blockBuf, quant, opType, scale, eg);
        for (let y = 0; y < 8; y++) {
          if (y0 + y >= h) break;
          for (let x = 0; x < 8; x++) {
            if (x0 + x >= w) break;
            const idx = (y0 + y) * w + x0 + x;
            plane[idx] = Math.max(0, Math.min(255, pred + rec[y * 8 + x]));
          }
        }
      }
    }

    // Flush final skips
    while (skipCount > 0) {
      this.writeU8(QOV_OP_DCT_SKIP);
      const count = Math.min(skipCount, 255);
      this.writeU8(count);
      skipCount -= count;
    }
  }

  private flushDctSkips(skipCount: number, structured = false): void {
    if (structured) {
      // spec §3.4.6: bare count chain, 255 = "chain continues"; the final
      // byte (<255, 0 when nothing is pending) terminates the plane
      while (skipCount >= 255) { this.writeU8(255); skipCount -= 255; }
      this.writeU8(skipCount);
      return;
    }
    while (skipCount > 0) {
      this.writeU8(QOV_OP_DCT_SKIP);
      const count = Math.min(skipCount, 255);
      this.writeU8(count);
      skipCount -= count;
    }
  }

  private encodePlaneDct(curr: Uint8Array, prev: Uint8Array, next: Uint8Array, w: number, h: number, quant: number[], opType: number, blockBuf: Float32Array, bandR0 = -1, bandR1 = -1, eg = false, structured = false): void {
    const qpBase = this.lossyParams?.dctQp ?? 20;
    const scale = 1.0 / (0.1 + (qpBase * 0.1));
    const blocksX = Math.ceil(w / 8);
    const blocksY = Math.ceil(h / 8);
    let skipCount = 0;

    // structured grammar (spec §3.4.6): one qp byte leads each plane
    if (structured) {
      this.writeU8(0x40 + (this.lossyParams!.dctQp - this.dctQpBase));
    }

    for (let by = 0; by < blocksY; by++) {
      const inBand = by >= bandR0 && by < bandR1;
      for (let bx = 0; bx < blocksX; bx++) {
        const x0 = bx * 8;
        const y0 = by * 8;

        if (inBand) {
          // refresh band block (spec §3.4.4): intra semantics — predict from
          // already-reconstructed pixels of the current frame so fresh data
          // never copies a damaged reference
          const pred = intraPred(next, w, h, x0, y0);
          let diffSum = 0;
          for (let y = 0; y < 8; y++) {
            const py = y0 + y;
            for (let x = 0; x < 8; x++) {
              const px = x0 + x;
              // padding must be zeroed: blockBuf is shared across blocks, and
              // stale residuals would leak into partial blocks' coefficients
              if (px >= w || py >= h) { blockBuf[y * 8 + x] = 0; continue; }
              const res = curr[py * w + px] - pred;
              blockBuf[y * 8 + x] = res;
              diffSum += Math.abs(res);
            }
          }

          if (diffSum < 32 + qpBase * 8) {
            // prediction-only block inside the band
            for (let y = 0; y < 8; y++) {
              const py = y0 + y;
              if (py >= h) continue;
              for (let x = 0; x < 8; x++) {
                const px = x0 + x;
                if (px >= w) continue;
                next[py * w + px] = pred;
              }
            }
            skipCount++;
            continue;
          }

          // Flush skips
          this.flushDctSkips(skipCount, structured);
          skipCount = 0;

          const rec = this.writeDctBlock(blockBuf, quant, opType, scale, eg, structured);
          for (let y = 0; y < 8; y++) {
            const py = y0 + y;
            if (py >= h) continue;
            for (let x = 0; x < 8; x++) {
              const px = x0 + x;
              if (px >= w) continue;
              const idx = py * w + px;
              next[idx] = Math.max(0, Math.min(255, pred + rec[y * 8 + x]));
            }
          }
          continue;
        }

        // 1. Extract Block & Calculate Residual
        let hasContent = false;
        let diffSum = 0;

        for (let y = 0; y < 8; y++) {
          const py = y0 + y;
          for (let x = 0; x < 8; x++) {
            const px = x0 + x;
            // zero padding like the band path: shared blockBuf must not leak
            // stale residuals into partial blocks' coefficients
            if (px >= w || py >= h) { blockBuf[y * 8 + x] = 0; continue; }

            const idx = py * w + px;
            const res = curr[idx] - prev[idx];
            blockBuf[y * 8 + x] = res;
            diffSum += Math.abs(res);
          }
        }

        // 2. Threshold check (simulated 'Zero' block if residuals are small);
        // scales with QP so low-quality streams skip more aggressively
        if (diffSum < 32 + qpBase * 8) {
          hasContent = false;
        } else {
          hasContent = true;
        }

        if (!hasContent) {
          skipCount++;
          // Reconstruct: just copy previous
          for (let y = 0; y < 8; y++) {
            const py = y0 + y;
            if (py >= h) continue;
            for (let x = 0; x < 8; x++) {
              const px = x0 + x;
              if (px >= w) continue;
              const idx = py * w + px;
              next[idx] = prev[idx];
            }
          }
          continue;
        }

        // Flush skips
        this.flushDctSkips(skipCount, structured);
        skipCount = 0;

        // 3-5. DCT transform, quantize + write, reconstruct
        const rec = this.writeDctBlock(blockBuf, quant, opType, scale, eg, structured);

        // Add to prev and store in next
        for (let y = 0; y < 8; y++) {
          const py = y0 + y;
          if (py >= h) continue;
          for (let x = 0; x < 8; x++) {
            const px = x0 + x;
            if (px >= w) continue;

            const idx = py * w + px;
            const res = rec[y * 8 + x];
            next[idx] = Math.max(0, Math.min(255, prev[idx] + res));
          }
        }
      }
    }

    // Flush final skips
    this.flushDctSkips(skipCount, structured);
    skipCount = 0;
  }

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

    // Apply lossy quantization if enabled
    if (this.lossyMode && this.lossyParams) {
      planes.yPlane = this.quantizePlane(planes.yPlane, this.lossyParams.yQuant);
      planes.uPlane = this.quantizePlane(planes.uPlane, this.lossyParams.uvQuant);
      planes.vPlane = this.quantizePlane(planes.vPlane, this.lossyParams.uvQuant);
      if (planes.aPlane) {
        planes.aPlane = this.quantizePlane(planes.aPlane, this.lossyParams.yQuant);
      }
    }

    // Get temporal threshold for lossy mode
    const temporalThresh = this.lossyMode && this.lossyParams ? this.lossyParams.temporalThresh : 0;

    // Motion estimation on the quantized luma plane vs the stored reference
    let mv: MotionVectors | null = null;
    let refY = this.prevYPlane!, refU = this.prevUPlane!, refV = this.prevVPlane!, refA = this.prevAPlane;
    if (this.motionEnabled) {
      mv = estimateMotion(planes.yPlane, this.prevYPlane!, width, height, {
        sadSkipThreshold: temporalThresh > 0 ? temporalThresh * 5 : 0,
        useDiamond: this.lossyMode,
        minMovedBlocks: Math.max(4, Math.ceil(0.005 * Math.ceil(width / 16) * Math.ceil(height / 16))),
        halfPel: this.lossyMode && this.isYuvMode,
      });
      if (mv) {
        const cm = chromaMotionParams(colorspace);
        const { w: mvUvW, h: mvUvH } = chromaPlaneDims(colorspace, width, height);
        refY = new Uint8Array(width * height);
        compensatePlane(this.prevYPlane!, width, height, mv, refY, 1, 1, 0, 0);
        refU = new Uint8Array(mvUvW * mvUvH);
        compensatePlane(this.prevUPlane!, mvUvW, mvUvH, mv, refU, cm.sx, cm.sy, cm.shx, cm.shy);
        refV = new Uint8Array(mvUvW * mvUvH);
        compensatePlane(this.prevVPlane!, mvUvW, mvUvH, mv, refV, cm.sx, cm.sy, cm.shx, cm.shy);
        if (planes.aPlane && this.prevAPlane) {
          refA = new Uint8Array(width * height);
          compensatePlane(this.prevAPlane, width, height, mv, refA, 1, 1, 0, 0);
        }
      }
    }
    const motionFlag = mv ? QOV_CHUNK_FLAG_MOTION : 0;

    // Check if we should use DCT
    const useDct = (this.header.flags & QOV_FLAG_DCT_ENABLED) !== 0;
    // Refresh band (spec §3.4.4): the band byte leads the payload, before MV data
    const refresh = useDct && this.intraRefresh;
    const band = refresh ? this.frameCount % QOV_INTRA_REFRESH_BANDS : -1;
    const refreshFlag = refresh ? QOV_CHUNK_FLAG_REFRESH_BAND : 0;

    if (useDct) {
      let chunkHeaderPos = -1;
      let chunkDataStart = -1;
      if (this.compressionEnabled) {
        // Compression mode: encode to temp buffer, then compress
        this.startFrameData();
        if (refresh) this.writeU8(band);
        if (mv) writeMvBlock(mv, (v) => this.writeU8(v), (v) => this.writeU16(v));
      } else {
        // DCT_BLOCKS does not require compression: write the chunk directly
        chunkHeaderPos = this.buffer.getSize();
        this.writeU8(QOV_CHUNK_PFRAME);
        this.writeU8(QOV_CHUNK_FLAG_YUV | QOV_CHUNK_FLAG_DCT_BLOCKS | motionFlag | refreshFlag | (this.expGolomb ? QOV_CHUNK_FLAG_EXP_GOLOB : 0) | (this.structuredPFrames ? QOV_CHUNK_FLAG_STRUCTURED : 0));
        this.writeU32(0);   // size placeholder
        this.writeU32(timestamp);

        // band + MV count toward chunkSize (decoders walk the payload by
        // chunkSize, and the compressed path embeds them in the payload too)
        chunkDataStart = this.buffer.getSize();
        if (refresh) this.writeU8(band);
        if (mv) writeMvBlock(mv, (v) => this.writeU8(v), (v) => this.writeU16(v));
      }

      // DCT Encoding
      const blockBuf = new Float32Array(64);
      const nextY = new Uint8Array(planes.yPlane.length);
      const nextU = new Uint8Array(planes.uPlane.length);
      const nextV = new Uint8Array(planes.vPlane.length);

      // Band block rows per plane (spec §3.4.4): [rows*band/BANDS, rows*(band+1)/BANDS)
      const { h: uvHb } = chromaPlaneDims(colorspace, width, height);
      const rowsY = Math.ceil(height / 8);
      const rowsC = Math.ceil(uvHb / 8);
      const yr0 = band < 0 ? -1 : Math.floor(rowsY * band / QOV_INTRA_REFRESH_BANDS);
      const yr1 = band < 0 ? -1 : Math.floor(rowsY * (band + 1) / QOV_INTRA_REFRESH_BANDS);
      const cr0 = band < 0 ? -1 : Math.floor(rowsC * band / QOV_INTRA_REFRESH_BANDS);
      const cr1 = band < 0 ? -1 : Math.floor(rowsC * (band + 1) / QOV_INTRA_REFRESH_BANDS);

      // Encode and reconstruct planes (to avoid drift); the effective
      // reference is the motion-compensated copy when vectors were emitted
      this.encodePlaneDct(planes.yPlane, refY, nextY, width, height, DEFAULT_QUANT_LUMA, QOV_OP_DCT_Y, blockBuf, yr0, yr1, this.expGolomb, this.structuredPFrames);

      const { w: uvW, h: uvH } = chromaPlaneDims(colorspace, width, height);
      this.encodePlaneDct(planes.uPlane, refU, nextU, uvW, uvH, DEFAULT_QUANT_CHROMA, QOV_OP_DCT_UV, blockBuf, cr0, cr1, this.expGolomb, this.structuredPFrames);
      this.encodePlaneDct(planes.vPlane, refV, nextV, uvW, uvH, DEFAULT_QUANT_CHROMA, QOV_OP_DCT_UV, blockBuf, cr0, cr1, this.expGolomb, this.structuredPFrames);

      // Update reference planes to RECONSTRUCTED versions
      this.prevYPlane = nextY;
      this.prevUPlane = nextU;
      this.prevVPlane = nextV;

      // Alpha uses luma dimensions and the luma quant table
      if (planes.aPlane && refA) {
        const nextA = new Uint8Array(planes.aPlane.length);
        this.encodePlaneDct(planes.aPlane, refA, nextA, width, height, DEFAULT_QUANT_LUMA, QOV_OP_DCT_Y, blockBuf, yr0, yr1, this.expGolomb, this.structuredPFrames);
        this.prevAPlane = nextA;
      }

      this.writeEndMarker();

      if (this.compressionEnabled) {
        this.finishFrameData(QOV_CHUNK_PFRAME, QOV_CHUNK_FLAG_YUV | QOV_CHUNK_FLAG_DCT_BLOCKS | motionFlag | refreshFlag | (this.expGolomb ? QOV_CHUNK_FLAG_EXP_GOLOB : 0) | (this.structuredPFrames ? QOV_CHUNK_FLAG_STRUCTURED : 0), timestamp);
      } else {
        const chunkSize = this.buffer.getSize() - chunkDataStart;
        this.buffer.setByte(chunkHeaderPos + 2, (chunkSize >> 24) & 0xff);
        this.buffer.setByte(chunkHeaderPos + 3, (chunkSize >> 16) & 0xff);
        this.buffer.setByte(chunkHeaderPos + 4, (chunkSize >> 8) & 0xff);
        this.buffer.setByte(chunkHeaderPos + 5, chunkSize & 0xff);
      }
    } else if (this.compressionEnabled) {
      // Legacy DPCM Encoding
      this.startFrameData();
      if (mv) writeMvBlock(mv, (v) => this.writeU8(v), (v) => this.writeU16(v));
      this.encodeYuvPlanePFrame(planes.yPlane, refY, temporalThresh);
      this.encodeYuvPlanePFrame(planes.uPlane, refU, temporalThresh);
      this.encodeYuvPlanePFrame(planes.vPlane, refV, temporalThresh);
      if (planes.aPlane && refA) {
        this.encodeYuvPlanePFrame(planes.aPlane, refA, Math.floor(temporalThresh / 2));
      }
      this.writeEndMarker();
      this.finishFrameData(QOV_CHUNK_PFRAME, QOV_CHUNK_FLAG_YUV | motionFlag, timestamp);

      // Store planes for next P-frame (raw, assuming lossless DPCM or close enough)
      this.prevYPlane = planes.yPlane;
      this.prevUPlane = planes.uPlane;
      this.prevVPlane = planes.vPlane;
      this.prevAPlane = planes.aPlane || null;
    } else {
      // No compression: write directly with a proper chunk header.
      const headerPos = this.buffer.getSize();
      this.writeU8(QOV_CHUNK_PFRAME);
      this.writeU8(QOV_CHUNK_FLAG_YUV | motionFlag);
      this.writeU32(0);   // size placeholder
      this.writeU32(timestamp);

      // the MV block counts toward chunkSize (see the DCT path above)
      const dataStart = this.buffer.getSize();
      if (mv) writeMvBlock(mv, (v) => this.writeU8(v), (v) => this.writeU16(v));
      this.encodeYuvPlanePFrame(planes.yPlane, refY, temporalThresh);
      this.encodeYuvPlanePFrame(planes.uPlane, refU, temporalThresh);
      this.encodeYuvPlanePFrame(planes.vPlane, refV, temporalThresh);
      if (planes.aPlane && refA) {
        this.encodeYuvPlanePFrame(planes.aPlane, refA, Math.floor(temporalThresh / 2));
      }
      this.writeEndMarker();

      const chunkSize = this.buffer.getSize() - dataStart;
      this.buffer.setByte(headerPos + 2, (chunkSize >> 24) & 0xff);
      this.buffer.setByte(headerPos + 3, (chunkSize >> 16) & 0xff);
      this.buffer.setByte(headerPos + 4, (chunkSize >> 8) & 0xff);
      this.buffer.setByte(headerPos + 5, chunkSize & 0xff);

      this.prevYPlane = planes.yPlane;
      this.prevUPlane = planes.uPlane;
      this.prevVPlane = planes.vPlane;
      if (planes.aPlane && this.prevAPlane) {
        this.prevAPlane = planes.aPlane;
      }
    }

    this.prevFrame = new Uint8ClampedArray(pixels);
  }

  /**
   * Adaptive streaming API (spec v3.6 §4.1): change the encoder quality
   * mid-stream. The file header keeps the start-time quality; the new quality
   * becomes decoder-visible through the per-block qp_delta of subsequently
   * coded DCT blocks. Lossy streams only (quality 1-99); switches to the
   * standard §6.2 quality derivation.
   */
  setQuality(quality: number): void {
    if (!this.lossyMode) throw new Error('setQuality: stream is not lossy');
    if (!Number.isInteger(quality) || quality < 1 || quality > 99) {
      throw new Error(`setQuality: quality ${quality} outside lossy range 1-99`);
    }
    this.lossyParams = deriveLossyParams(quality);
    this.quality = quality;
  }

  /**
   * Adaptive streaming API: drop the stored reference frame. The next
   * encodePFrame call automatically emits a keyframe instead. Use when a
   * receiver reports unrecoverable loss or before resuming after a pause.
   */
  dropReference(): void {
    this.prevFrame = null;
    this.prevYPlane = null;
    this.prevUPlane = null;
    this.prevVPlane = null;
    this.prevAPlane = null;
  }

  encodeKeyframe(pixels: Uint8ClampedArray, timestamp: number): void {
    if (this.isYuvMode) {
      this.encodeYuvKeyframe(pixels, timestamp);
      return;
    }

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

    // Build quantized frame buffer for accurate P-frame reference in lossy mode
    const quantizedFrame = this.lossyMode ? new Uint8ClampedArray(pixels.length) : null;

    // Encode frame data
    const encodeRgbKeyframeData = () => {
      let run = 0;

      for (let px = 0; px < pixelCount; px++) {
        const offset = px * 4;
        // Apply lossy quantization if enabled
        const c: QovRGBA = this.quantizePixel({
          r: pixels[offset],
          g: pixels[offset + 1],
          b: pixels[offset + 2],
          a: pixels[offset + 3],
        });

        // Store quantized pixel for P-frame reference
        if (quantizedFrame) {
          quantizedFrame[offset] = c.r;
          quantizedFrame[offset + 1] = c.g;
          quantizedFrame[offset + 2] = c.b;
          quantizedFrame[offset + 3] = c.a;
        }

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

    // Store frame for P-frame reference (use quantized pixels in lossy mode
    // so reference matches what the decoder reconstructs)
    this.prevFrame = quantizedFrame || new Uint8ClampedArray(pixels);
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

    // Get temporal threshold for lossy mode
    const temporalThresh = this.lossyMode && this.lossyParams ? this.lossyParams.temporalThresh : 0;

    // Motion estimation on luma vs the reference frame
    let mv: MotionVectors | null = null;
    let refFrame = this.prevFrame;
    if (this.motionEnabled && refFrame) {
      const currLuma = new Uint8Array(pixelCount);
      const prevLuma = new Uint8Array(pixelCount);
      for (let i = 0; i < pixelCount; i++) {
        const o = i * 4;
        currLuma[i] = (pixels[o] * 299 + pixels[o + 1] * 587 + pixels[o + 2] * 114) / 1000 | 0;
        prevLuma[i] = (refFrame[o] * 299 + refFrame[o + 1] * 587 + refFrame[o + 2] * 114) / 1000 | 0;
      }
      mv = estimateMotion(currLuma, prevLuma, this.header.width, this.header.height, {
        sadSkipThreshold: temporalThresh > 0 ? temporalThresh * 5 : 0,
        useDiamond: this.lossyMode,
        minMovedBlocks: Math.max(4, Math.ceil(0.005 * Math.ceil(this.header.width / 16) * Math.ceil(this.header.height / 16))),
        halfPel: false, // half-pel is YUV-mode only (spec v3.6 §5.2)
      });
      if (mv) {
        const comp = new Uint8ClampedArray(refFrame.length);
        compensateFrame(refFrame, this.header.width, this.header.height, mv, comp);
        refFrame = comp;
      }
    }
    const motionFlag = mv ? QOV_CHUNK_FLAG_MOTION : 0;

    // Build quantized frame buffer for accurate next P-frame reference in lossy mode
    const quantizedFrame = this.lossyMode ? new Uint8ClampedArray(pixels.length) : null;

    // Encode frame data
    const encodeRgbPFrameData = () => {
      let skip = 0;
      if (mv) writeMvBlock(mv, (v) => this.writeU8(v), (v) => this.writeU16(v));

      for (let px = 0; px < pixelCount; px++) {
        const offset = px * 4;
        // Apply lossy quantization if enabled
        const c: QovRGBA = this.quantizePixel({
          r: pixels[offset],
          g: pixels[offset + 1],
          b: pixels[offset + 2],
          a: pixels[offset + 3],
        });

        const ref: QovRGBA = {
          r: refFrame[offset],
          g: refFrame[offset + 1],
          b: refFrame[offset + 2],
          a: refFrame[offset + 3],
        };

        // Check if pixel unchanged or similar enough (lossy mode)
        const isSimilar = temporalThresh > 0
          ? this.pixelsAreSimilar(c, ref, temporalThresh)
          : (c.r === ref.r && c.g === ref.g && c.b === ref.b && c.a === ref.a);

        if (isSimilar) {
          // Decoder retains the reference pixel when skipping, so store ref
          if (quantizedFrame) {
            quantizedFrame[offset] = ref.r;
            quantizedFrame[offset + 1] = ref.g;
            quantizedFrame[offset + 2] = ref.b;
            quantizedFrame[offset + 3] = ref.a;
          }
          skip++;
          if (skip === 62 || px === pixelCount - 1) {
            this.writeU8(0xc0 | (skip - 1)); // QOV_OP_SKIP
            skip = 0;
          }
          continue;
        }

        // Store quantized pixel for next P-frame reference
        if (quantizedFrame) {
          quantizedFrame[offset] = c.r;
          quantizedFrame[offset + 1] = c.g;
          quantizedFrame[offset + 2] = c.b;
          quantizedFrame[offset + 3] = c.a;
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
      this.finishFrameData(QOV_CHUNK_PFRAME, motionFlag, timestamp);
    } else {
      // No compression: write directly
      const headerPos = this.buffer.getSize();
      this.writeU8(QOV_CHUNK_PFRAME);
      this.writeU8(motionFlag); // flags
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

    // Store frame for next P-frame reference (use quantized pixels in lossy mode
    // so reference matches what the decoder reconstructs)
    this.prevFrame = quantizedFrame || new Uint8ClampedArray(pixels);
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

  // Alternate-codec passthrough (spec §5.3): payload is one Opus packet.
  // No QOA state involved; usable even when the header has no audio.
  encodeAudioOpus(packet: Uint8Array, timestamp: number): void {
    const start = this.buffer.getSize();
    this.buffer.writeByte(QOV_CHUNK_AUDIO);
    this.buffer.writeByte(QOV_CHUNK_AUDIO_FLAG_OPUS);
    this.buffer.writeU32(packet.length);
    this.buffer.writeU32(timestamp);
    for (let i = 0; i < packet.length; i++) {
      this.buffer.writeByte(packet[i]);
    }
    this.emitChunk(start);
  }

  encodeAudio(samples: Float32Array, timestamp: number): void {
    if (!this.qoaEncoder) {
      console.warn("Audio encoding requested but not initialized (channels/rate=0)");
      return;
    }

    const encodedData = this.qoaEncoder.encodeFrame(samples);
    const chunkStart = this.buffer.getSize();

    // QOV_CHUNK_AUDIO using imported constant
    const chunkType = QOV_CHUNK_AUDIO;
    const chunkSize = encodedData.length;
    const chunkFlags = 0; // No extra flags for audio yet

    this.buffer.writeByte(chunkType);
    this.buffer.writeByte(chunkFlags);
    this.buffer.writeU32(chunkSize);
    this.buffer.writeU32(timestamp);

    for (let i = 0; i < encodedData.length; i++) {
      this.buffer.writeByte(encodedData[i]);
    }
    this.emitChunk(chunkStart);
  }
}
